/**
 * `speculum sessions` — filtered, paged session listing over the derived index.
 * Local only; never egresses.
 */

import { openDb } from "../store/db";
import {
  countSessions,
  listSessions,
  type SessionListOpts,
  type SessionListRow,
  type SessionSort,
} from "../store/queries";

const CWD_CLASSES = new Set(["operator", "experiment", "harness", "unknown"]);
const AGENTS = new Set(["primary", "subagent"]);
const SORTS = new Set<SessionSort>(["recent", "turns", "errors"]);

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Parse --since / --until as YYYY-MM-DD (UTC day) or full ISO. */
function parseBound(s: string | undefined, endOfDay: boolean): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parsePositiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function failUsage(msg: string): never {
  console.error(msg);
  process.exit(64);
}

export function parseSessionsArgs(args: string[]): SessionListOpts & {
  countOnly: boolean;
  json: boolean;
} {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`speculum sessions [options]

List sessions with filters and paging (local only).

Options:
  --class C      operator|experiment|harness|unknown
  --agent A      primary|subagent
  --project P    Substring filter on project path
  --since D      ISO / YYYY-MM-DD floor
  --until D      Inclusive ceiling
  --title T      Substring filter on resolved title
  --sort S       recent|turns|errors (default recent)
  --limit N      Page size (default 50)
  --offset N     Page start (default 0)
  --count        Print the matching total only
  --json         Machine-readable rows + total
`);
    process.exit(0);
  }

  const classRaw = opt(args, "--class");
  if (classRaw !== undefined && !CWD_CLASSES.has(classRaw)) {
    failUsage(
      `sessions: invalid --class '${classRaw}' (expected operator|experiment|harness|unknown)`,
    );
  }

  const agentRaw = opt(args, "--agent");
  if (agentRaw !== undefined && !AGENTS.has(agentRaw)) {
    failUsage(`sessions: invalid --agent '${agentRaw}' (expected primary|subagent)`);
  }

  const sortRaw = opt(args, "--sort") ?? "recent";
  if (!SORTS.has(sortRaw as SessionSort)) {
    failUsage(`sessions: invalid --sort '${sortRaw}' (expected recent|turns|errors)`);
  }

  const sinceRaw = opt(args, "--since");
  const untilRaw = opt(args, "--until");
  let since: string | undefined;
  let until: string | undefined;
  if (sinceRaw !== undefined) {
    const parsed = parseBound(sinceRaw, false);
    if (!parsed) failUsage(`sessions: invalid --since '${sinceRaw}'`);
    since = parsed;
  }
  if (untilRaw !== undefined) {
    const parsed = parseBound(untilRaw, true);
    if (!parsed) failUsage(`sessions: invalid --until '${untilRaw}'`);
    until = parsed;
  }

  const limit = parsePositiveInt(opt(args, "--limit"), 50);
  if (limit === null) failUsage(`sessions: invalid --limit '${opt(args, "--limit")}'`);
  const offset = parsePositiveInt(opt(args, "--offset"), 0);
  if (offset === null) failUsage(`sessions: invalid --offset '${opt(args, "--offset")}'`);

  return {
    cwdClass: classRaw,
    agent: agentRaw,
    project: opt(args, "--project"),
    since,
    until,
    title: opt(args, "--title"),
    sort: sortRaw as SessionSort,
    limit,
    offset,
    countOnly: hasFlag(args, "--count"),
    json: hasFlag(args, "--json"),
  };
}

/** Compact relative age from an ISO timestamp to now. */
export function formatAge(iso: string, nowMs: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "?";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 60) return `${day}d`;
  const mo = Math.floor(day / 30);
  return `${mo}mo`;
}

function agentLabel(row: SessionListRow): string {
  if (row.agentName) return row.agentName;
  if (row.subagentType) return row.subagentType;
  return row.agent;
}

function displayTitle(row: SessionListRow): string {
  const t = (row.title || "").replace(/\s+/g, " ").trim();
  if (t) return t.length > 48 ? `${t.slice(0, 45)}…` : t;
  return row.id.slice(0, 8);
}

function printTable(rows: SessionListRow[], total: number, limit: number, offset: number): void {
  console.log("");
  console.log("title · class · agent · age · turns · errors");
  console.log("─".repeat(72));
  if (rows.length === 0) {
    console.log("(no matching sessions)");
  } else {
    for (const r of rows) {
      const title = displayTitle(r).padEnd(48).slice(0, 48);
      const cls = (r.cwdClass || "—").padEnd(10).slice(0, 10);
      const agent = agentLabel(r).padEnd(18).slice(0, 18);
      const age = formatAge(r.endedAt).padStart(4);
      const turns = String(r.turnCount).padStart(5);
      const errors = String(r.toolErrorCount).padStart(4);
      console.log(`${title} ${cls} ${agent} ${age} ${turns} ${errors}`);
    }
  }
  const shown = rows.length;
  const from = shown === 0 ? 0 : offset + 1;
  const to = offset + shown;
  console.log("");
  console.log(`${shown} of ${total}  (rows ${from}–${to}, limit ${limit}, offset ${offset})`);
  console.log("");
}

export async function sessionsCommand(args: string[]): Promise<void> {
  const parsed = parseSessionsArgs(args);
  const opts: SessionListOpts = {
    cwdClass: parsed.cwdClass,
    agent: parsed.agent,
    project: parsed.project,
    since: parsed.since,
    until: parsed.until,
    title: parsed.title,
    sort: parsed.sort,
    limit: parsed.limit,
    offset: parsed.offset,
  };

  const db = openDb();
  try {
    const total = countSessions(db, opts);
    if (parsed.countOnly) {
      if (parsed.json) {
        console.log(JSON.stringify({ total }));
      } else {
        console.log(String(total));
      }
      return;
    }

    const rows = listSessions(db, opts);
    if (parsed.json) {
      console.log(
        JSON.stringify({
          rows,
          total,
          limit: opts.limit ?? 50,
          offset: opts.offset ?? 0,
        }),
      );
      return;
    }

    printTable(rows, total, opts.limit ?? 50, opts.offset ?? 0);
  } finally {
    db.close();
  }
}
