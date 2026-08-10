/**
 * Session-overlap probe. Flags primary sessions whose time ranges overlap
 * (concurrent sessions). Report-only: never merges or mutates session rows.
 * Blocking key is time-interval overlap; optional project scoping via opts.
 */

import type { Db } from "../store/db";
import { wilson95 } from "../stats";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";
import { severityFromWeight, weightForEvidence } from "./weights";

export interface SessionInterval {
  id: string;
  projectPath: string;
  startedAt: string;
  endedAt: string;
}

export interface OverlapPair {
  sessionIdA: string;
  sessionIdB: string;
  projectPathA: string;
  projectPathB: string;
  startedAtA: string;
  endedAtA: string;
  startedAtB: string;
  endedAtB: string;
  /** Overlap duration in ms (clamped ≥ 0). */
  overlapMs: number;
}

function parseMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * True when half-open-ish closed intervals [start, end] overlap.
 * Touching endpoints (A ends exactly when B starts) does not count.
 */
export function intervalsOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): boolean {
  const a0 = parseMs(startA);
  const a1 = parseMs(endA);
  const b0 = parseMs(startB);
  const b1 = parseMs(endB);
  return a0 < b1 && b0 < a1;
}

export function overlapDurationMs(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): number {
  const a0 = parseMs(startA);
  const a1 = parseMs(endA);
  const b0 = parseMs(startB);
  const b1 = parseMs(endB);
  const start = Math.max(a0, b0);
  const end = Math.min(a1, b1);
  return Math.max(0, end - start);
}

/**
 * Pairwise concurrent sessions. O(n²) over primary sessions in the window —
 * fine for local corpora. Pure; exported for tests.
 */
export function findOverlappingPairs(sessions: SessionInterval[]): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  const sorted = [...sessions].sort((a, b) => {
    const c = a.startedAt.localeCompare(b.startedAt);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      // Early exit: later sessions start after A ends → no more overlaps with A.
      if (parseMs(b.startedAt) >= parseMs(a.endedAt)) break;
      if (!intervalsOverlap(a.startedAt, a.endedAt, b.startedAt, b.endedAt)) continue;
      pairs.push({
        sessionIdA: a.id,
        sessionIdB: b.id,
        projectPathA: a.projectPath,
        projectPathB: b.projectPath,
        startedAtA: a.startedAt,
        endedAtA: a.endedAt,
        startedAtB: b.startedAt,
        endedAtB: b.endedAt,
        overlapMs: overlapDurationMs(a.startedAt, a.endedAt, b.startedAt, b.endedAt),
      });
    }
  }
  return pairs;
}

export const sessionOverlap: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  const filterParts: string[] = ["agent = 'primary'"];
  const params: (string | number)[] = [];
  if (opts.project) {
    filterParts.push("project_path = ?");
    params.push(opts.project);
  }
  if (opts.since) {
    filterParts.push("ended_at >= ?");
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    filterParts.push("started_at < ?");
    params.push(opts.until.toISOString());
  }

  const rows = db
    .query<
      {
        id: string;
        project_path: string;
        started_at: string;
        ended_at: string;
      },
      (string | number)[]
    >(
      `SELECT id, project_path, started_at, ended_at
       FROM sessions
       WHERE ${filterParts.join(" AND ")}
       ORDER BY started_at, id`,
    )
    .all(...params);

  const sessions: SessionInterval[] = rows.map((r) => ({
    id: r.id,
    projectPath: r.project_path,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));

  const pairs = findOverlappingPairs(sessions);
  const involved = new Set<string>();
  for (const p of pairs) {
    involved.add(p.sessionIdA);
    involved.add(p.sessionIdB);
  }

  const totalSessions = sessions.length;
  const flagged = involved.size;
  const ci = wilson95(flagged, totalSessions);
  const message =
    totalSessions === 0
      ? "no sessions to check"
      : `${pairs.length} overlapping pair(s) involving ${flagged} of ${totalSessions} sessions [heuristic]`;

  const sev = severityFromWeight(weightForEvidence("session-overlap"));

  return {
    probe: "session-overlap",
    value: flagged,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: totalSessions,
    partial: false,
    unit: "session",
    summary: message,
    data: {
      totalSessions,
      flaggedSessions: flagged,
      pairCount: pairs.length,
      severity: sev,
      message,
      pairs: pairs.slice(0, 50).map((p) => ({
        sessionIds: [p.sessionIdA, p.sessionIdB],
        projectPaths: [p.projectPathA, p.projectPathB],
        overlapMs: p.overlapMs,
        ranges: [
          { id: p.sessionIdA, startedAt: p.startedAtA, endedAt: p.endedAtA },
          { id: p.sessionIdB, startedAt: p.startedAtB, endedAt: p.endedAtB },
        ],
      })),
    },
    hits: pairs.map<HitDetail>((p) => ({
      sessionId: p.sessionIdA,
      ts: p.startedAtA < p.startedAtB ? p.startedAtB : p.startedAtA,
      evidence: `overlaps ${p.sessionIdB} for ${p.overlapMs}ms`,
      category: "concurrent",
      // No single source event — both session ids live in evidence + data.
    })),
    heuristic: true,
  };
};
