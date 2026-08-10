/**
 * Contradiction probe. Flags operator/agent statements that appear to reverse
 * earlier claims within a session. Flag-not-overwrite: never mutates events;
 * hits carry both sides' event ids as evidence.
 *
 * Conservative: only clear status-flip pairs and correction-after-done arcs.
 * Free-text contradiction detection is inherently fuzzy — results are heuristic.
 */

import type { Db } from "../store/db";
import { wilson95 } from "../stats";
import { normalizeForProbe } from "./normalize";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";
import { severityFromWeight, weightForEvidence } from "./weights";

/** Claim that work is finished / healthy. */
const DONE_RE =
  /\b(fixed|resolved|all (set|done)|should (be )?(work|good|fine) now|that('?s| is) (it|fixed|done|working)|problem (is |was )?(solved|fixed)|looks good( now)?)\b/i;

/** Claim that work is still broken / reopened. */
const REOPEN_RE =
  /\b(still (broken|failing|wrong|not working)|not (fixed|working|resolved)|still doesn'?t|it'?s still|this is still|still seeing|still getting)\b/i;

/** Operator correction openers (subset — high precision). */
const CORRECTION_RE =
  /^[ ]*([Nn]ope|[Nn]ah)[, .]|^[ ]*([Aa]ctually|[Ww]ait[, ])|\bI (literally |already |just )?(said|told you|meant)\b|\byou (fail(ed|ing)?|miss(ed|ing)?|are wrong)\b/i;

export type ContradictionKind = "status-flip" | "correction-after-done";

export interface ContradictionPair {
  kind: ContradictionKind;
  sessionId: string;
  projectPath: string;
  earlierEventId: number;
  laterEventId: number;
  earlierTs: string;
  laterTs: string;
  earlierRole: "user" | "assistant";
  laterRole: "user" | "assistant";
  earlierQuote: string;
  laterQuote: string;
}

interface TurnRow {
  id: number;
  session_id: string;
  project_path: string;
  ts: string;
  kind: string;
  text: string;
}

function clipQuote(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/**
 * Detect conservative contradiction pairs in an ordered turn list.
 * Pure; exported for fixtures.
 */
export function detectContradictions(
  sessionId: string,
  projectPath: string,
  turns: Array<{
    id: number;
    ts: string;
    role: "user" | "assistant";
    text: string;
  }>,
): ContradictionPair[] {
  const pairs: ContradictionPair[] = [];
  const doneClaims: Array<{
    id: number;
    ts: string;
    role: "user" | "assistant";
    quote: string;
  }> = [];

  // Cap pairs per session to keep noise bounded.
  const MAX_PAIRS = 5;

  for (const t of turns) {
    if (pairs.length >= MAX_PAIRS) break;
    const folded = normalizeForProbe(t.text);
    if (!folded.trim()) continue;

    const isDone = DONE_RE.test(folded);
    const isReopen = REOPEN_RE.test(folded);
    const isCorrection = t.role === "user" && CORRECTION_RE.test(folded);

    if (isDone) {
      doneClaims.push({
        id: t.id,
        ts: t.ts,
        role: t.role,
        quote: clipQuote(t.text),
      });
    }

    // Status flip: any earlier done claim, later reopen (prefer user reopen).
    if (isReopen && doneClaims.length > 0) {
      const earlier = doneClaims[doneClaims.length - 1]!;
      if (earlier.id !== t.id && earlier.ts <= t.ts) {
        pairs.push({
          kind: "status-flip",
          sessionId,
          projectPath,
          earlierEventId: earlier.id,
          laterEventId: t.id,
          earlierTs: earlier.ts,
          laterTs: t.ts,
          earlierRole: earlier.role,
          laterRole: t.role,
          earlierQuote: earlier.quote,
          laterQuote: clipQuote(t.text),
        });
      }
    }

    // Correction-after-done: user correction after an assistant done claim.
    if (isCorrection && doneClaims.length > 0) {
      const earlier = [...doneClaims].reverse().find((c) => c.role === "assistant");
      if (earlier && earlier.id !== t.id && earlier.ts <= t.ts) {
        // Avoid double-counting if this turn already formed a status-flip pair.
        const already = pairs.some(
          (p) => p.laterEventId === t.id && p.earlierEventId === earlier.id,
        );
        if (!already) {
          pairs.push({
            kind: "correction-after-done",
            sessionId,
            projectPath,
            earlierEventId: earlier.id,
            laterEventId: t.id,
            earlierTs: earlier.ts,
            laterTs: t.ts,
            earlierRole: earlier.role,
            laterRole: t.role,
            earlierQuote: earlier.quote,
            laterQuote: clipQuote(t.text),
          });
        }
      }
    }
  }

  return pairs;
}

export const contradiction: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  const filterParts: string[] = [
    "kind IN ('user', 'assistant')",
    "text IS NOT NULL",
    "is_boilerplate = 0",
    "agent = 'primary'",
  ];
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

  const rows = db
    .query<TurnRow, (string | number)[]>(
      `SELECT id, session_id, project_path, ts, kind, text
       FROM events
       WHERE ${filterParts.join(" AND ")}
       ORDER BY session_id, ts, id`,
    )
    .all(...params);

  const bySession = new Map<
    string,
    {
      projectPath: string;
      turns: Array<{ id: number; ts: string; role: "user" | "assistant"; text: string }>;
    }
  >();
  for (const r of rows) {
    const role = r.kind === "user" ? "user" : "assistant";
    let entry = bySession.get(r.session_id);
    if (!entry) {
      entry = { projectPath: r.project_path, turns: [] };
      bySession.set(r.session_id, entry);
    }
    entry.turns.push({ id: r.id, ts: r.ts, role, text: r.text });
  }

  const allPairs: ContradictionPair[] = [];
  const sessionsFlagged = new Set<string>();
  const byKind = new Map<ContradictionKind, number>();

  for (const [sessionId, entry] of bySession) {
    const pairs = detectContradictions(sessionId, entry.projectPath, entry.turns);
    for (const p of pairs) {
      allPairs.push(p);
      sessionsFlagged.add(sessionId);
      byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
    }
  }

  const totalSessions = bySession.size;
  const flagged = sessionsFlagged.size;
  const ci = wilson95(flagged, totalSessions);
  const message =
    totalSessions === 0
      ? "no sessions to scan"
      : `${flagged} of ${totalSessions} sessions with contradiction signals (${allPairs.length} pairs) [heuristic]`;

  const sev = severityFromWeight(weightForEvidence("contradiction"));

  return {
    probe: "contradiction",
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
      totalPairs: allPairs.length,
      byKind: Array.from(byKind.entries())
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count),
      severity: sev,
      message,
      pairs: allPairs.slice(0, 50).map((p) => ({
        kind: p.kind,
        sessionId: p.sessionId,
        earlierEventId: p.earlierEventId,
        laterEventId: p.laterEventId,
        earlierQuote: p.earlierQuote,
        laterQuote: p.laterQuote,
      })),
    },
    hits: allPairs.map<HitDetail>((p) => ({
      sessionId: p.sessionId,
      ts: p.laterTs,
      evidence: `${p.kind}: "${p.earlierQuote}" → "${p.laterQuote}"`,
      category: p.kind,
      eventId: p.laterEventId,
      eventIds: [p.earlierEventId, p.laterEventId],
      sourceQuote: p.laterQuote,
    })),
    heuristic: true,
  };
};
