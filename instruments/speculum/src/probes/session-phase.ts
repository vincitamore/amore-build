/**
 * Session-phase probe. Classifies a session's arc from event timing and density:
 * ramp, burst, stall, cool-down, error-cluster.
 *
 * Shape inspired by a pattern-engine event detector (inter-event deltas, density
 * windows) — not corporate event types. All results are heuristic.
 */

import type { Db } from "../store/db";
import { wilson95 } from "../stats";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";
import { severityFromWeight, weightForEvidence } from "./weights";

/** Tunable thresholds. Chosen for synthetic fixtures; keep heuristic banner. */
export const PHASE_THRESHOLDS = {
  /** Max inter-event gap (ms) that still counts as inside a burst run. */
  burstMaxDeltaMs: 15_000,
  /** Min events in a short-delta run to call a burst. */
  burstMinEvents: 5,
  /** Min inter-event gap (ms) that counts as a stall. */
  stallMinGapMs: 5 * 60_000,
  /** Sliding window (ms) for tool-error density. */
  errorWindowMs: 2 * 60_000,
  /** Min tool_error=1 events in the error window. */
  errorMinCount: 3,
  /** Min events required before classifying any phase. */
  minEvents: 3,
  /**
   * Cool-down: final third mean inter-event gap must exceed this multiple of
   * the densest third's mean gap (when densest mean > 0).
   */
  coolDownGapRatio: 2.5,
  /**
   * Ramp: first third mean gap must exceed this multiple of the densest later
   * third's mean gap.
   */
  rampGapRatio: 2.0,
} as const;

export type SessionPhaseKind =
  | "ramp"
  | "burst"
  | "stall"
  | "cool-down"
  | "error-cluster";

export interface PhaseSpan {
  kind: SessionPhaseKind;
  sessionId: string;
  projectPath: string;
  startTs: string;
  endTs: string;
  eventIds: number[];
  /** Short machine-readable detail (counts, gap ms). */
  detail: string;
}

interface EventRow {
  id: number;
  session_id: string;
  project_path: string;
  ts: string;
  kind: string;
  tool_error: number | null;
}

function parseMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

/**
 * Detect phases for one ordered event list. Pure; exported for unit tests.
 */
export function detectPhasesForSession(
  sessionId: string,
  projectPath: string,
  events: Array<{ id: number; ts: string; kind: string; toolError: number }>,
  thr = PHASE_THRESHOLDS,
): PhaseSpan[] {
  if (events.length < thr.minEvents) return [];

  const phases: PhaseSpan[] = [];
  const times = events.map((e) => parseMs(e.ts));
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    deltas.push(Math.max(0, times[i]! - times[i - 1]!));
  }

  // Burst: consecutive short deltas covering ≥ burstMinEvents events.
  let runStart = 0;
  for (let i = 0; i <= deltas.length; i++) {
    const endRun = i === deltas.length || deltas[i]! > thr.burstMaxDeltaMs;
    if (endRun) {
      const eventCount = i - runStart + 1;
      if (eventCount >= thr.burstMinEvents) {
        const slice = events.slice(runStart, i + 1);
        phases.push({
          kind: "burst",
          sessionId,
          projectPath,
          startTs: slice[0]!.ts,
          endTs: slice[slice.length - 1]!.ts,
          eventIds: slice.map((e) => e.id),
          detail: `events=${slice.length};maxΔt=${thr.burstMaxDeltaMs}ms`,
        });
      }
      runStart = i + 1;
    }
  }

  // Stall: single large inter-event gap.
  for (let i = 0; i < deltas.length; i++) {
    if (deltas[i]! >= thr.stallMinGapMs) {
      const a = events[i]!;
      const b = events[i + 1]!;
      phases.push({
        kind: "stall",
        sessionId,
        projectPath,
        startTs: a.ts,
        endTs: b.ts,
        eventIds: [a.id, b.id],
        detail: `gapMs=${Math.round(deltas[i]!)}`,
      });
    }
  }

  // Error-cluster: ≥ errorMinCount tool_error=1 within errorWindowMs.
  const errorEvents = events.filter((e) => e.toolError === 1);
  if (errorEvents.length >= thr.errorMinCount) {
    let left = 0;
    for (let right = 0; right < errorEvents.length; right++) {
      const tRight = parseMs(errorEvents[right]!.ts);
      while (tRight - parseMs(errorEvents[left]!.ts) > thr.errorWindowMs) left++;
      const window = errorEvents.slice(left, right + 1);
      if (window.length >= thr.errorMinCount) {
        phases.push({
          kind: "error-cluster",
          sessionId,
          projectPath,
          startTs: window[0]!.ts,
          endTs: window[window.length - 1]!.ts,
          eventIds: window.map((e) => e.id),
          detail: `errors=${window.length};windowMs=${thr.errorWindowMs}`,
        });
        // Advance past this cluster to avoid dense re-emission.
        left = right + 1;
      }
    }
  }

  // Ramp / cool-down from thirded gap means (need enough deltas).
  if (deltas.length >= 6) {
    const third = Math.max(1, Math.floor(deltas.length / 3));
    const first = deltas.slice(0, third);
    const mid = deltas.slice(third, third * 2);
    const last = deltas.slice(third * 2);
    const mFirst = mean(first);
    const mMid = mean(mid);
    const mLast = mean(last);
    const densestLater = Math.min(mMid || Infinity, mLast || Infinity);

    if (
      densestLater > 0 &&
      densestLater < Infinity &&
      mFirst >= thr.rampGapRatio * densestLater
    ) {
      const endIdx = third;
      const slice = events.slice(0, endIdx + 1);
      phases.push({
        kind: "ramp",
        sessionId,
        projectPath,
        startTs: slice[0]!.ts,
        endTs: slice[slice.length - 1]!.ts,
        eventIds: slice.map((e) => e.id),
        detail: `meanGapFirst=${Math.round(mFirst)};meanGapLater=${Math.round(densestLater)}`,
      });
    }

    const densestEarlier = Math.min(mFirst || Infinity, mMid || Infinity);
    if (
      densestEarlier > 0 &&
      densestEarlier < Infinity &&
      mLast >= thr.coolDownGapRatio * densestEarlier
    ) {
      const startIdx = third * 2;
      const slice = events.slice(startIdx);
      if (slice.length >= 2) {
        phases.push({
          kind: "cool-down",
          sessionId,
          projectPath,
          startTs: slice[0]!.ts,
          endTs: slice[slice.length - 1]!.ts,
          eventIds: slice.map((e) => e.id),
          detail: `meanGapLast=${Math.round(mLast)};meanGapEarlier=${Math.round(densestEarlier)}`,
        });
      }
    }
  }

  return phases;
}

export const sessionPhase: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  const filterParts: string[] = ["agent = 'primary'"];
  const params: (string | number)[] = [];
  if (opts.project) {
    filterParts.push("project_path = ?");
    params.push(opts.project);
  }
  if (opts.since) {
    filterParts.push("ts >= ?");
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    filterParts.push("ts < ?");
    params.push(opts.until.toISOString());
  }
  const where = filterParts.join(" AND ");

  const rows = db
    .query<EventRow, (string | number)[]>(
      `SELECT id, session_id, project_path, ts, kind, tool_error
       FROM events
       WHERE ${where}
       ORDER BY session_id, ts, id`,
    )
    .all(...params);

  const bySession = new Map<
    string,
    { projectPath: string; events: Array<{ id: number; ts: string; kind: string; toolError: number }> }
  >();
  for (const r of rows) {
    let entry = bySession.get(r.session_id);
    if (!entry) {
      entry = { projectPath: r.project_path, events: [] };
      bySession.set(r.session_id, entry);
    }
    entry.events.push({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      toolError: r.tool_error === 1 ? 1 : 0,
    });
  }

  const allPhases: PhaseSpan[] = [];
  const sessionsWithPhase = new Set<string>();
  const byType = new Map<SessionPhaseKind, number>();

  for (const [sessionId, entry] of bySession) {
    const phases = detectPhasesForSession(sessionId, entry.projectPath, entry.events);
    for (const p of phases) {
      allPhases.push(p);
      sessionsWithPhase.add(sessionId);
      byType.set(p.kind, (byType.get(p.kind) ?? 0) + 1);
    }
  }

  const totalSessions = bySession.size;
  const flagged = sessionsWithPhase.size;
  const ci = wilson95(flagged, totalSessions);
  const message =
    totalSessions === 0
      ? "no sessions to classify"
      : `${flagged} of ${totalSessions} sessions show phase markers (${allPhases.length} spans) [heuristic]`;

  const phaseSeverity = severityFromWeight(weightForEvidence("session-phase"));

  return {
    probe: "session-phase",
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
      totalSpans: allPhases.length,
      byType: Array.from(byType.entries())
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count),
      thresholds: { ...PHASE_THRESHOLDS },
      severity: phaseSeverity,
      message,
      spans: allPhases.slice(0, 50),
    },
    hits: allPhases.map<HitDetail>((p) => ({
      sessionId: p.sessionId,
      ts: p.startTs,
      evidence: `${p.kind}: ${p.detail}`,
      category: p.kind,
      eventId: p.eventIds[0],
      eventIds: p.eventIds.length > 0 ? p.eventIds : undefined,
    })),
    heuristic: true,
  };
};
