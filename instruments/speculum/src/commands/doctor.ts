/**
 * Operational health checks against the local derived index.
 * Local reads only — no network, no model.
 *
 * Spine: pure `buildDoctorReport` + thin TTY/JSON render in the command.
 */

import { openDb, SCHEMA_VERSION, type Db } from "../store/db";
import { PROBES } from "../probes";
import { defaultDbPath } from "../paths";

const STALE_THRESHOLD_HOURS = 24;

export type DoctorCheckStatus = "pass" | "fail" | "warn";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  /** When true, a fail sets report.ok false and the command exits non-zero. */
  fatal: boolean;
  message: string;
  hint: string | null;
}

export interface DoctorReport {
  generatedAt: string;
  ok: boolean;
  dbPath: string;
  checks: DoctorCheck[];
  summary: { pass: number; fail: number; warn: number };
}

export interface DoctorOpts {
  dbPath?: string;
  staleThresholdHours?: number;
  /** Injectable clock for tests (ms since epoch). */
  nowMs?: number;
}

function check(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  fatal: boolean,
  message: string,
  hint: string | null = null,
): DoctorCheck {
  return { id, label, status, fatal, message, hint };
}

/**
 * Pure builder: run local index health checks against an already-open db.
 * Does not open/close the database and never touches the network.
 */
export function buildDoctorReport(db: Db, opts: DoctorOpts = {}): DoctorReport {
  const generatedAt = new Date().toISOString();
  const dbPath = opts.dbPath ?? defaultDbPath();
  const staleThresholdHours = opts.staleThresholdHours ?? STALE_THRESHOLD_HOURS;
  const nowMs = opts.nowMs ?? Date.now();
  const checks: DoctorCheck[] = [];

  // 1. DB queryable
  try {
    const row = db.query<{ n: number }, []>("SELECT 1 AS n").get();
    if (row?.n === 1) {
      checks.push(
        check("db_queryable", "DB queryable", "pass", true, "SELECT 1 succeeded"),
      );
    } else {
      checks.push(
        check(
          "db_queryable",
          "DB queryable",
          "fail",
          true,
          "SELECT 1 returned unexpected result",
          "delete the index and re-run 'speculum ingest' (session files are the source of truth)",
        ),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push(
      check(
        "db_queryable",
        "DB queryable",
        "fail",
        true,
        `query failed: ${msg}`,
        "delete the index and re-run 'speculum ingest' (session files are the source of truth)",
      ),
    );
  }

  // 2. PRAGMA integrity_check
  try {
    const rows = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    const texts = rows.map((r) => r.integrity_check);
    const ok = texts.length === 1 && texts[0] === "ok";
    if (ok) {
      checks.push(
        check("db_integrity", "SQLite integrity", "pass", true, "PRAGMA integrity_check = ok"),
      );
    } else {
      checks.push(
        check(
          "db_integrity",
          "SQLite integrity",
          "fail",
          true,
          `integrity_check: ${texts.join("; ") || "(empty)"}`,
          "delete the index and re-run 'speculum ingest'",
        ),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push(
      check(
        "db_integrity",
        "SQLite integrity",
        "fail",
        true,
        `integrity_check failed: ${msg}`,
        "delete the index and re-run 'speculum ingest'",
      ),
    );
  }

  // 3. Schema version vs compiled constant
  try {
    const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const version = row?.user_version ?? -1;
    if (version === SCHEMA_VERSION) {
      checks.push(
        check(
          "schema_version",
          "Schema version",
          "pass",
          true,
          `user_version=${version} matches SCHEMA_VERSION=${SCHEMA_VERSION}`,
        ),
      );
    } else {
      checks.push(
        check(
          "schema_version",
          "Schema version",
          "fail",
          true,
          `user_version=${version} does not match SCHEMA_VERSION=${SCHEMA_VERSION}`,
          "rebuild the index with a matching speculum binary ('speculum ingest --full' after removing the stale db if needed)",
        ),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push(
      check(
        "schema_version",
        "Schema version",
        "fail",
        true,
        `could not read user_version: ${msg}`,
        "rebuild the index with a matching speculum binary",
      ),
    );
  }

  // 4. Ingest freshness (staleness is warn, not fatal — same posture as status)
  try {
    const range = db
      .query<{ newest: string | null }, []>(
        "SELECT MAX(started_at) AS newest FROM sessions",
      )
      .get();
    const lastIngested =
      db
        .query<{ latest: string | null }, []>(
          "SELECT MAX(last_ingested) AS latest FROM ingest_state",
        )
        .get()?.latest ?? null;
    const newest = range?.newest ?? null;

    if (!newest && !lastIngested) {
      checks.push(
        check(
          "ingest_freshness",
          "Ingest freshness",
          "warn",
          false,
          "no ingested sessions",
          "run 'speculum ingest'",
        ),
      );
    } else {
      // Prefer newest session wall-clock; fall back to last ingest cursor stamp.
      const anchor = newest ?? lastIngested!;
      const hoursSince = (nowMs - new Date(anchor).getTime()) / (3600 * 1000);
      const stale = hoursSince > staleThresholdHours;
      if (stale) {
        checks.push(
          check(
            "ingest_freshness",
            "Ingest freshness",
            "warn",
            false,
            `newest corpus signal is ${hoursSince.toFixed(1)}h old (threshold ${staleThresholdHours}h)`,
            "run 'speculum ingest' to refresh",
          ),
        );
      } else {
        checks.push(
          check(
            "ingest_freshness",
            "Ingest freshness",
            "pass",
            false,
            `newest corpus signal is ${hoursSince.toFixed(1)}h old`,
          ),
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push(
      check(
        "ingest_freshness",
        "Ingest freshness",
        "fail",
        true,
        `could not read ingest/session timestamps: ${msg}`,
        "run 'speculum ingest' after verifying the index opens",
      ),
    );
  }

  // 5. Probe registry loads
  try {
    const names = Object.keys(PROBES);
    if (names.length === 0) {
      checks.push(
        check(
          "probe_registry",
          "Probe registry",
          "fail",
          true,
          "no probes registered",
          "this build is incomplete — reinstall/rebuild speculum",
        ),
      );
    } else {
      checks.push(
        check(
          "probe_registry",
          "Probe registry",
          "pass",
          true,
          `${names.length} probe(s) registered (${names.join(", ")})`,
        ),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push(
      check(
        "probe_registry",
        "Probe registry",
        "fail",
        true,
        `probe registry failed to load: ${msg}`,
        "reinstall/rebuild speculum",
      ),
    );
  }

  const summary = { pass: 0, fail: 0, warn: 0 };
  for (const c of checks) {
    if (c.status === "pass") summary.pass += 1;
    else if (c.status === "fail") summary.fail += 1;
    else summary.warn += 1;
  }

  const ok = !checks.some((c) => c.fatal && c.status === "fail");

  return { generatedAt, ok, dbPath, checks, summary };
}

function statusGlyph(status: DoctorCheckStatus): string {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  return "WARN";
}

export function formatDoctorReportTty(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("speculum doctor");
  lines.push("─".repeat(60));
  lines.push(`  db: ${report.dbPath}`);
  lines.push("");
  const labelWidth = Math.max(...report.checks.map((c) => c.label.length), 12);
  for (const c of report.checks) {
    const pad = c.label.padEnd(labelWidth);
    lines.push(`  ${statusGlyph(c.status).padEnd(4)}  ${pad}  ${c.message}`);
    if (c.hint && c.status !== "pass") {
      lines.push(`${"".padStart(10)}hint: ${c.hint}`);
    }
  }
  lines.push("");
  lines.push(
    `  summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail — ${report.ok ? "ok" : "not ok"}`,
  );
  lines.push("");
  return lines.join("\n");
}

export async function doctorCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const dbPath = defaultDbPath();

  let db: Db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const openFail: DoctorReport = {
      generatedAt: new Date().toISOString(),
      ok: false,
      dbPath,
      checks: [
        check(
          "db_open",
          "DB open",
          "fail",
          true,
          `could not open database: ${msg}`,
          "check SPECULUM_DB / permissions, or delete a corrupt index and re-run 'speculum ingest'",
        ),
      ],
      summary: { pass: 0, fail: 1, warn: 0 },
    };
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(openFail, null, 2));
    } else {
      process.stdout.write(formatDoctorReportTty(openFail));
    }
    process.exit(1);
  }

  try {
    const report = buildDoctorReport(db, { dbPath });
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatDoctorReportTty(report));
    }
    if (!report.ok) process.exit(1);
  } finally {
    db.close();
  }
}
