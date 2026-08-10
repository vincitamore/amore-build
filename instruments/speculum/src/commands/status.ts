import { statSync } from "node:fs";
import { openDb, type Db } from "../store/db";
import { PROBES } from "../probes";
import { defaultDbPath } from "../paths";
import { buildOriginsReport, type OriginsReport } from "../cwd-class";

const STALE_THRESHOLD_HOURS = 24;

export interface StatusReport {
  generatedAt: string;
  db: { path: string; sizeBytes: number };
  counts: {
    sessions: number;
    events: number;
    usageRows: number;
    eventsByKind: Record<string, number>;
    /** Events with sensitive=1 (recomputed from index; not denormalized). */
    sensitiveEvents: number;
    /** Distinct sessions with at least one sensitive event. */
    sensitiveSessions: number;
  };
  /**
   * Session rows / distinct project_path roots by cwd origin
   * (operator · experiment · harness · unknown). Additive field —
   * existing consumers ignore it.
   */
  origins: OriginsReport;
  ingest: {
    trackedFiles: number;
    forgottenFiles: number;
    lastIngestedAt: string | null;
    oldestSessionStartedAt: string | null;
    newestSessionStartedAt: string | null;
  };
  probes: { registered: number; names: string[] };
  staleness: {
    thresholdHours: number;
    hoursSinceNewestSession: number | null;
    stale: boolean;
    message: string;
  };
}

export function buildStatusReport(db: Db, dbPath: string = defaultDbPath()): StatusReport {
  const generatedAt = new Date().toISOString();
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(dbPath).size;
  } catch {
    sizeBytes = 0;
  }

  const sessions =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n ?? 0;
  const events =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
  const usageRows =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage").get()?.n ?? 0;

  const eventsByKind: Record<string, number> = {};
  for (const r of db
    .query<{ kind: string; n: number }, []>(
      "SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC",
    )
    .all()) {
    eventsByKind[r.kind] = r.n;
  }

  const sensitiveEvents =
    db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE sensitive = 1")
      .get()?.n ?? 0;
  const sensitiveSessions =
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE sensitive = 1",
      )
      .get()?.n ?? 0;

  const range = db
    .query<{ oldest: string | null; newest: string | null }, []>(
      "SELECT MIN(started_at) AS oldest, MAX(started_at) AS newest FROM sessions",
    )
    .get();

  const trackedFiles =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_state").get()?.n ?? 0;
  const forgottenFiles =
    db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_state WHERE forgotten = 1")
      .get()?.n ?? 0;
  const lastIngestedAt =
    db
      .query<{ latest: string | null }, []>("SELECT MAX(last_ingested) AS latest FROM ingest_state")
      .get()?.latest ?? null;

  const newest = range?.newest ?? null;
  let hoursSinceNewestSession: number | null = null;
  let stale = false;
  let message: string;
  if (newest) {
    hoursSinceNewestSession = (Date.now() - new Date(newest).getTime()) / (3600 * 1000);
    stale = hoursSinceNewestSession > STALE_THRESHOLD_HOURS;
    message = stale
      ? `newest ingested session is ${hoursSinceNewestSession.toFixed(1)}h old — run 'speculum ingest' to refresh`
      : `newest ingested session is ${hoursSinceNewestSession.toFixed(1)}h old`;
  } else {
    message = "no ingested sessions — run 'speculum ingest'";
  }

  const originRows = db
    .query<{ project_path: string; agent: string }, []>(
      "SELECT project_path, agent FROM sessions",
    )
    .all();
  const origins = buildOriginsReport(originRows);

  return {
    generatedAt,
    db: { path: dbPath, sizeBytes },
    counts: { sessions, events, usageRows, eventsByKind, sensitiveEvents, sensitiveSessions },
    origins,
    ingest: {
      trackedFiles,
      forgottenFiles,
      lastIngestedAt,
      oldestSessionStartedAt: range?.oldest ?? null,
      newestSessionStartedAt: newest,
    },
    probes: { registered: Object.keys(PROBES).length, names: Object.keys(PROBES) },
    staleness: {
      thresholdHours: STALE_THRESHOLD_HOURS,
      hoursSinceNewestSession,
      stale,
      message,
    },
  };
}

export async function statusCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const dbPath = defaultDbPath();
  const db = openDb(dbPath);
  try {
    const report = buildStatusReport(db, dbPath);
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log("");
    console.log("speculum status");
    console.log("─".repeat(60));
    console.log(`  db: ${report.db.path} (${report.db.sizeBytes} bytes)`);
    console.log(
      `  sessions: ${report.counts.sessions}  events: ${report.counts.events}  usage rows: ${report.counts.usageRows}`,
    );
    const o = report.origins;
    console.log(
      `  origins: ${o.operator.rows} operator · ${o.experiment.rows} experiment · ${o.harness.rows} harness · ${o.unknown.rows} unknown` +
        `  (roots: ${o.operator.roots}/${o.experiment.roots}/${o.harness.roots}/${o.unknown.roots})`,
    );
    const kinds = Object.entries(report.counts.eventsByKind)
      .map(([k, n]) => `${k}=${n}`)
      .join("  ");
    if (kinds) console.log(`  events by kind: ${kinds}`);
    console.log(
      `  sensitive: events=${report.counts.sensitiveEvents} sessions=${report.counts.sensitiveSessions}`,
    );
    console.log(
      `  ingest: tracked=${report.ingest.trackedFiles} forgotten=${report.ingest.forgottenFiles}`,
    );
    console.log(`  last ingested: ${report.ingest.lastIngestedAt ?? "(never)"}`);
    console.log(`  probes: ${report.probes.registered} (${report.probes.names.join(", ")})`);
    console.log(`  ${report.staleness.message}`);
    console.log("");
  } finally {
    db.close();
  }
}
