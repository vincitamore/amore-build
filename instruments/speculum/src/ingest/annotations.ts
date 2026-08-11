/**
 * Per-session derived annotations (phase class, error density, probe-hit
 * counts, usage rollups, duration) into session_annotations.
 * Re-derived on every ingest rebuild; every row carries a method banner.
 */

import type { Db } from "../store/db";
import { detect as detectRage } from "../probes/rage/detector";
import { detectOperatorCorrection } from "../probes/operator-correction";
import { detectAgentSelfCorrection } from "../probes/apology-rate";
import { computeFingerprint } from "../probes/stuck-loop";
import {
  detectPhasesForSession,
  type SessionPhaseKind,
  type PhaseSpan,
} from "../probes/session-phase";

/** Probe names included in probe_hits JSON (cheap SQL/regex over events). */
export const ANNOTATION_PROBE_HITS = [
  "rage",
  "stuck-loop",
  "operator-correction",
  "apology",
] as const;

/**
 * Method banner stamped on every annotation row. Names the phase classifier
 * and the probe families counted in probe_hits.
 */
export const ANNOTATION_METHOD =
  "phase=session-phase-v1; hits=rage,stuck-loop,operator-correction,apology; heuristic";

/** Tie-break order when multiple phase kinds share the same span count. */
const PHASE_PRIORITY: readonly SessionPhaseKind[] = [
  "error-cluster",
  "stall",
  "burst",
  "cool-down",
  "ramp",
];

const STUCK_WINDOW = 6;
const STUCK_THRESHOLD = 3;

interface SessionRow {
  id: string;
  project_path: string;
  started_at: string;
  ended_at: string;
  turn_count: number;
  tool_error_count: number;
}

interface UsageRollup {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface EventPhaseRow {
  id: number;
  session_id: string;
  project_path: string;
  ts: string;
  kind: string;
  tool_error: number | null;
}

interface TextEventRow {
  session_id: string;
  kind: string;
  text: string | null;
  is_boilerplate: number;
}

interface ToolUseRow {
  session_id: string;
  tool_name: string;
  tool_input: string | null;
}

/**
 * Dominant phase for a session: most frequent kind among detected spans;
 * ties break by PHASE_PRIORITY. Empty string when no phase markers.
 */
export function dominantPhaseClass(phases: PhaseSpan[]): string {
  if (phases.length === 0) return "";
  const counts = new Map<SessionPhaseKind, number>();
  for (const p of phases) {
    counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  }
  let best: SessionPhaseKind | null = null;
  let bestCount = -1;
  let bestPri = PHASE_PRIORITY.length + 1;
  for (const [kind, count] of counts) {
    const pri = PHASE_PRIORITY.indexOf(kind);
    const p = pri === -1 ? PHASE_PRIORITY.length : pri;
    if (count > bestCount || (count === bestCount && p < bestPri)) {
      best = kind;
      bestCount = count;
      bestPri = p;
    }
  }
  return best ?? "";
}

function parseMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** ended_at − started_at in seconds; 0 when either timestamp is unusable. */
export function durationSec(startedAt: string, endedAt: string): number {
  const a = parseMs(startedAt);
  const b = parseMs(endedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 1000);
}

/** tool_error_count / max(1, turn_count). */
export function errorDensity(toolErrorCount: number, turnCount: number): number {
  return toolErrorCount / Math.max(1, turnCount);
}

function parseToolInput(toolInputJson: string | null): unknown {
  if (toolInputJson === null) return null;
  try {
    return JSON.parse(toolInputJson);
  } catch {
    return null;
  }
}

/**
 * Count distinct stuck-loop fingerprints in one session's tool_use stream.
 * Mirrors the stuck-loop probe window/threshold (no recovery-credit path
 * simplification: recovery credit needs target paths; we keep the same
 * computeFingerprint + sliding window count).
 */
function countStuckLoops(
  calls: Array<{ toolName: string; toolInput: string | null }>,
): number {
  if (calls.length < STUCK_THRESHOLD) return 0;

  const emitted = new Set<string>();
  const fpCounts = new Map<string, number>();
  const recentWindow: string[] = [];
  let loops = 0;

  for (const c of calls) {
    const input = parseToolInput(c.toolInput);
    const fp = computeFingerprint(c.toolName, input);
    if (fp === null) continue;

    recentWindow.push(fp);
    if (recentWindow.length > STUCK_WINDOW) {
      const dropped = recentWindow.shift()!;
      fpCounts.set(dropped, Math.max(0, (fpCounts.get(dropped) ?? 0) - 1));
    }
    fpCounts.set(fp, (fpCounts.get(fp) ?? 0) + 1);

    const count = fpCounts.get(fp) ?? 0;
    if (count >= STUCK_THRESHOLD && !emitted.has(fp)) {
      emitted.add(fp);
      loops++;
    }
  }
  return loops;
}

/** Wipe + re-derive session_annotations from the settled index. */
export function rebuildSessionAnnotations(db: Db): void {
  db.run("DELETE FROM session_annotations");

  const sessions = db
    .query<SessionRow, []>(
      `SELECT id, project_path, started_at, ended_at, turn_count, tool_error_count
       FROM sessions`,
    )
    .all();

  if (sessions.length === 0) return;

  // Usage rollups — one GROUP BY for the whole corpus.
  const usageBySession = new Map<string, UsageRollup>();
  for (const u of db
    .query<UsageRollup, []>(
      `SELECT session_id,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM usage
       GROUP BY session_id`,
    )
    .all()) {
    usageBySession.set(u.session_id, u);
  }

  // Phase events (primary agent only — matches session-phase probe filter).
  const phaseBySession = new Map<
    string,
    {
      projectPath: string;
      events: Array<{ id: number; ts: string; kind: string; toolError: number }>;
    }
  >();
  for (const r of db
    .query<EventPhaseRow, []>(
      `SELECT id, session_id, project_path, ts, kind, tool_error
       FROM events
       WHERE agent = 'primary'
       ORDER BY session_id, ts, id`,
    )
    .all()) {
    let entry = phaseBySession.get(r.session_id);
    if (!entry) {
      entry = { projectPath: r.project_path, events: [] };
      phaseBySession.set(r.session_id, entry);
    }
    entry.events.push({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      toolError: r.tool_error === 1 ? 1 : 0,
    });
  }

  // Text probe hits: one scan of non-boilerplate user/assistant rows.
  const rageHits = new Map<string, number>();
  const operatorHits = new Map<string, number>();
  const apologyHits = new Map<string, number>();

  for (const r of db
    .query<TextEventRow, []>(
      `SELECT session_id, kind, text, is_boilerplate
       FROM events
       WHERE kind IN ('user', 'assistant')
         AND text IS NOT NULL
         AND is_boilerplate = 0`,
    )
    .all()) {
    const text = r.text ?? "";
    if (text.length === 0) continue;

    if (r.kind === "user") {
      if (detectRage(text).count > 0) {
        rageHits.set(r.session_id, (rageHits.get(r.session_id) ?? 0) + 1);
      }
      if (detectOperatorCorrection(text).length > 0) {
        operatorHits.set(r.session_id, (operatorHits.get(r.session_id) ?? 0) + 1);
      }
    } else if (r.kind === "assistant") {
      if (detectAgentSelfCorrection(text).length > 0) {
        apologyHits.set(r.session_id, (apologyHits.get(r.session_id) ?? 0) + 1);
      }
    }
  }

  // Stuck-loop: tool_use stream per session (include subagents — same as probe).
  const toolsBySession = new Map<
    string,
    Array<{ toolName: string; toolInput: string | null }>
  >();
  for (const r of db
    .query<ToolUseRow, []>(
      `SELECT session_id, tool_name, tool_input
       FROM events
       WHERE kind = 'tool_use' AND tool_name IS NOT NULL
       ORDER BY session_id, ts, id`,
    )
    .all()) {
    let arr = toolsBySession.get(r.session_id);
    if (!arr) {
      arr = [];
      toolsBySession.set(r.session_id, arr);
    }
    arr.push({ toolName: r.tool_name, toolInput: r.tool_input });
  }

  const stuckHits = new Map<string, number>();
  for (const [sid, calls] of toolsBySession) {
    const n = countStuckLoops(calls);
    if (n > 0) stuckHits.set(sid, n);
  }

  const insert = db.prepare(
    `INSERT INTO session_annotations (
       session_id, phase_class, error_density, probe_hits,
       input_tokens, output_tokens, total_tokens, duration_sec, method
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const writeAll = db.transaction(() => {
    for (const s of sessions) {
      const phaseEntry = phaseBySession.get(s.id);
      let phaseClass = "";
      if (phaseEntry) {
        const phases = detectPhasesForSession(
          s.id,
          phaseEntry.projectPath,
          phaseEntry.events,
        );
        phaseClass = dominantPhaseClass(phases);
      }

      const density = errorDensity(s.tool_error_count, s.turn_count);
      const usage = usageBySession.get(s.id);
      const inputTokens = usage?.input_tokens ?? 0;
      const outputTokens = usage?.output_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? 0;
      const dur = durationSec(s.started_at, s.ended_at);

      const probeHits: Record<string, number> = {};
      const rage = rageHits.get(s.id) ?? 0;
      const stuck = stuckHits.get(s.id) ?? 0;
      const op = operatorHits.get(s.id) ?? 0;
      const apology = apologyHits.get(s.id) ?? 0;
      if (rage > 0) probeHits.rage = rage;
      if (stuck > 0) probeHits["stuck-loop"] = stuck;
      if (op > 0) probeHits["operator-correction"] = op;
      if (apology > 0) probeHits.apology = apology;

      insert.run(
        s.id,
        phaseClass,
        density,
        JSON.stringify(probeHits),
        inputTokens,
        outputTokens,
        totalTokens,
        dur,
        ANNOTATION_METHOD,
      );
    }
  });

  writeAll();
}
