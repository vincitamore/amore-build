import type { Db } from "../store/db";
import { wilson95 } from "../stats";
import type { Probe, ProbeOptions, ProbeResult } from "./types";

const DEFAULT_FRESHNESS_DAYS = 30;

export const staleCorpus: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  void opts;
  const thresholdDays = DEFAULT_FRESHNESS_DAYS;
  const cutoffIso = new Date(Date.now() - thresholdDays * 24 * 3600 * 1000).toISOString();

  const totalCount =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions WHERE agent = 'primary'").get()
      ?.n ?? 0;

  const staleCount =
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM sessions WHERE agent = 'primary' AND started_at < ?`,
      )
      .get(cutoffIso)?.n ?? 0;

  const oldest = db
    .query<{ id: string; started_at: string }, []>(
      `SELECT id, started_at FROM sessions WHERE agent = 'primary' ORDER BY started_at ASC LIMIT 1`,
    )
    .get();

  let oldestStaleSession: { sessionId: string; daysOld: number } | null = null;
  if (oldest) {
    const daysOld = Math.floor(
      (Date.now() - new Date(oldest.started_at).getTime()) / (24 * 3600 * 1000),
    );
    if (daysOld > thresholdDays) {
      oldestStaleSession = { sessionId: oldest.id, daysOld };
    }
  }

  const message =
    totalCount === 0
      ? "no sessions in corpus"
      : `${staleCount} of ${totalCount} primary sessions older than ${thresholdDays}d [heuristic]`;

  const ci = wilson95(staleCount, totalCount);
  return {
    probe: "stale-corpus",
    value: staleCount,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: totalCount,
    partial: false,
    unit: "session",
    summary: message,
    data: {
      totalSessions: totalCount,
      staleSessions: staleCount,
      thresholdDays,
      severity: "info" as const,
      message,
      oldestStaleSession,
    },
    heuristic: true,
  };
};
