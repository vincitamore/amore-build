/**
 * Export verb — durable, evidence-bearing snapshots of local index surfaces.
 *
 * Reads the derived sqlite index only (no network, no model). Builders stay
 * pure; this command is a thin shell: assemble envelope + payload, render,
 * write to stdout or --output path.
 */

import { writeFileSync } from "node:fs";
import { openDb, type Db } from "../store/db";
import { defaultAuditPath, defaultDbPath } from "../paths";
import { SPECULUM_VERSION } from "../version";
import {
  listProbeNames,
  runAllProbes,
  runProbe,
  type ProbeOptions,
  type ProbeResult,
} from "../probes";
import { buildStatusReport, type StatusReport } from "./status";
import { buildUsageReport, type UsageReport } from "./usage";
import {
  renderExport,
  type ExportDocument,
  type ExportFormat,
  type ExportSurface,
  type ExportWindow,
  type SessionExportData,
} from "../export";

const SURFACES: ExportSurface[] = ["scan", "status", "usage", "session"];
const FORMATS: ExportFormat[] = ["json", "csv", "md"];

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Parse --since / --until as local calendar dates (YYYY-MM-DD) or full ISO. */
function parseBound(s: string | undefined, endOfDay: boolean): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseFormat(raw: string | undefined): ExportFormat {
  const f = (raw ?? "json").toLowerCase();
  if (f === "json" || f === "csv" || f === "md" || f === "markdown") {
    return f === "markdown" ? "md" : f;
  }
  console.error(`unknown --format: ${raw}\nexpected: ${FORMATS.join("|")}`);
  process.exit(1);
}

function parseSurface(raw: string | undefined): ExportSurface {
  if (!raw || !(SURFACES as string[]).includes(raw)) {
    console.error(
      `export requires a surface: ${SURFACES.join("|")}${raw ? `\nunknown surface: ${raw}` : ""}`,
    );
    process.exit(1);
  }
  return raw as ExportSurface;
}

/** First non-flag token, skipping values of known option flags. */
function firstPositional(args: string[]): string | undefined {
  const valueFlags = new Set([
    "--format",
    "--output",
    "--project",
    "--since",
    "--until",
    "--probe",
    "--model",
    "--session",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i += 1;
      continue;
    }
    return a;
  }
  return undefined;
}

/**
 * Flag-only: true when any events.sensitive=1 row falls in the window.
 * Never mutates payload data.
 */
export function windowContainsSensitive(
  db: Db,
  window: {
    since?: string | null;
    until?: string | null;
    project?: string | null;
    sessionId?: string | null;
  },
): boolean {
  const wheres: string[] = ["sensitive = 1"];
  const params: (string | number)[] = [];
  if (window.project) {
    wheres.push("project_path = ?");
    params.push(window.project);
  }
  if (window.sessionId) {
    wheres.push("session_id = ?");
    params.push(window.sessionId);
  }
  if (window.since) {
    wheres.push("ts >= ?");
    params.push(window.since);
  }
  if (window.until) {
    wheres.push("ts <= ?");
    params.push(window.until);
  }
  const n =
    db
      .query<{ n: number }, (string | number)[]>(
        `SELECT COUNT(*) AS n FROM events WHERE ${wheres.join(" AND ")}`,
      )
      .get(...params)?.n ?? 0;
  return n > 0;
}

export function buildSessionExport(
  db: Db,
  sessionId: string,
): SessionExportData {
  const sess = db
    .query<
      { project_path: string | null; started_at: string | null },
      [string]
    >(
      "SELECT project_path, started_at FROM sessions WHERE id = ? LIMIT 1",
    )
    .get(sessionId);

  const rows = db
    .query<
      {
        id: number;
        ts: string;
        kind: string;
        agent: string;
        sensitive: number;
        tool_name: string | null;
        text: string | null;
      },
      [string]
    >(
      `SELECT id, ts, kind, agent, sensitive, tool_name, text
       FROM events WHERE session_id = ?
       ORDER BY ts, id`,
    )
    .all(sessionId);

  return {
    sessionId,
    projectPath: sess?.project_path ?? null,
    startedAt: sess?.started_at ?? null,
    events: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      agent: r.agent,
      sensitive: r.sensitive,
      toolName: r.tool_name,
      text: r.text,
    })),
  };
}

export interface BuildExportOpts {
  surface: ExportSurface;
  since?: string | null;
  until?: string | null;
  project?: string | null;
  probe?: string | null;
  model?: string | null;
  sessionId?: string | null;
  dbPath?: string;
  auditPath?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Pure-ish builder: open data already provided; assembles envelope + payload.
 * Does not write files or touch the network.
 */
export function buildExportDocument(
  db: Db,
  opts: BuildExportOpts,
): ExportDocument {
  const now = opts.now ?? (() => new Date());
  const exportedAt = now().toISOString();
  const dbPath = opts.dbPath ?? defaultDbPath();
  const auditPath = opts.auditPath ?? defaultAuditPath();

  const window: ExportWindow = {
    since: opts.since ?? null,
    until: opts.until ?? null,
    project: opts.project ?? null,
  };
  if (opts.probe) window.probe = opts.probe;
  if (opts.model) window.model = opts.model;
  if (opts.sessionId) window.sessionId = opts.sessionId;

  const containsSensitive = windowContainsSensitive(db, {
    since: window.since,
    until: window.until,
    project: window.project,
    sessionId: window.sessionId ?? null,
  });

  let data: ProbeResult[] | StatusReport | UsageReport | SessionExportData;

  switch (opts.surface) {
    case "scan": {
      const probeOpts: ProbeOptions = {};
      if (opts.project) probeOpts.project = opts.project;
      if (opts.since) probeOpts.since = new Date(opts.since);
      if (opts.until) probeOpts.until = new Date(opts.until);
      if (opts.probe) {
        const one = runProbe(db, opts.probe, probeOpts);
        if (!one) {
          throw new Error(
            `unknown probe: ${opts.probe}\navailable: ${listProbeNames().join(", ")}`,
          );
        }
        data = [one];
      } else {
        data = runAllProbes(db, probeOpts);
      }
      break;
    }
    case "status":
      data = buildStatusReport(db, dbPath);
      break;
    case "usage":
      data = buildUsageReport(db, {
        since: opts.since ?? null,
        until: opts.until ?? null,
        model: opts.model ?? undefined,
      });
      break;
    case "session": {
      if (!opts.sessionId) {
        throw new Error("export session requires --session <id>");
      }
      data = buildSessionExport(db, opts.sessionId);
      break;
    }
    default: {
      const _exhaustive: never = opts.surface;
      throw new Error(`unsupported surface: ${String(_exhaustive)}`);
    }
  }

  return {
    exportedAt,
    speculumVersion: SPECULUM_VERSION,
    surface: opts.surface,
    window,
    source: { db: dbPath, auditPath },
    containsSensitive,
    data,
  };
}

export function exportHelpText(): string {
  return `speculum export — write a durable snapshot of a local index surface

Usage:
  speculum export <surface> [options]

Surfaces:
  scan                  Probe results with hit evidence (eventId when present)
  status                Corpus counts, ingest freshness, probe registry
  usage                 Per-model token and turn aggregation
  session               Events for one session (--session required)

Options:
  --format json|csv|md  Output format (default: json)
  --output <path>       Write to file (default: stdout)
  --project P           Filter by project path (scan / sensitive window)
  --since D             Inclusive lower bound (ISO or YYYY-MM-DD)
  --until D             Inclusive upper bound (ISO or YYYY-MM-DD)
  --probe <name>        Scan: limit to one probe
  --model M             Usage: substring filter on model id
  --session <id>        Session surface: session id
  --json                Alias for --format json

Envelope fields (every export):
  exportedAt, speculumVersion, surface, window, source.{db,auditPath},
  containsSensitive (flag-only from events.sensitive — never redacts data)

Local only — no network, no model.
`;
}

export async function exportCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(exportHelpText());
    return;
  }

  const surface = parseSurface(firstPositional(args));

  const format = args.includes("--json")
    ? ("json" as const)
    : parseFormat(opt(args, "--format"));
  const outputPath = opt(args, "--output");
  const project = opt(args, "--project") ?? null;
  const since = parseBound(opt(args, "--since"), false);
  const until = parseBound(opt(args, "--until"), true);
  const probe = opt(args, "--probe") ?? null;
  const model = opt(args, "--model") ?? null;
  const sessionId = opt(args, "--session") ?? null;

  if (since === null && opt(args, "--since")) {
    console.error(`invalid --since: ${opt(args, "--since")}`);
    process.exit(1);
  }
  if (until === null && opt(args, "--until")) {
    console.error(`invalid --until: ${opt(args, "--until")}`);
    process.exit(1);
  }

  const dbPath = defaultDbPath();
  const db = openDb(dbPath);
  try {
    let doc: ExportDocument;
    try {
      doc = buildExportDocument(db, {
        surface,
        since,
        until,
        project,
        probe,
        model,
        sessionId,
        dbPath,
        auditPath: defaultAuditPath(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      process.exit(1);
    }

    const body = renderExport(doc, format);
    if (outputPath) {
      writeFileSync(outputPath, body, "utf-8");
    } else {
      process.stdout.write(body);
    }
  } finally {
    db.close();
  }
}
