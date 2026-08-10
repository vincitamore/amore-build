/**
 * Heuristic decision extraction from events.
 *
 * Every decision carries a required `method` banner — these are derived
 * signals, not ground-truth decision records. Re-run after every ingest.
 */

import { detectOperatorCorrection } from "../probes/operator-correction";
import type { LinkEvent } from "./links";

export type DecisionCategory =
  | "operator_correction"
  | "plan_step"
  | "task_outcome"
  | "tool_recovery";

export interface DerivedDecision {
  id: string;
  sessionId: string;
  projectPath: string;
  ts: string;
  category: DecisionCategory;
  scenario: string | null;
  reasoning: string | null;
  outcome: string | null;
  confidence: number;
  decisionMaker: string;
  sourceEventId: number;
  /** Required heuristic banner (never empty). */
  method: string;
  metadata: string | null;
}

export interface ExtractEvent extends LinkEvent {
  projectPath: string;
  toolError: number | null;
}

/** Stable primary key so re-derive replaces the same row. */
export function decisionId(sourceEventId: number, category: DecisionCategory): string {
  return `dec:${sourceEventId}:${category}`;
}

/**
 * Extract decisions from an ordered event list. Pure — no I/O.
 */
export function extractDecisions(events: readonly ExtractEvent[]): DerivedDecision[] {
  const out: DerivedDecision[] = [];
  const seen = new Set<string>();

  const push = (d: DerivedDecision) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    out.push(d);
  };

  // Group by session for tool_recovery windowing.
  const bySession = new Map<string, ExtractEvent[]>();
  for (const ev of events) {
    let list = bySession.get(ev.sessionId);
    if (!list) {
      list = [];
      bySession.set(ev.sessionId, list);
    }
    list.push(ev);
  }

  for (const [, sessionEvents] of bySession) {
    sessionEvents.sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return a.id - b.id;
    });

    for (const ev of sessionEvents) {
      // operator_correction — user turns matching the shared bank
      if (ev.kind === "user" && ev.text) {
        const matches = detectOperatorCorrection(ev.text);
        if (matches.length > 0) {
          const cats = matches.map((m) => m.category).join(",");
          push({
            id: decisionId(ev.id, "operator_correction"),
            sessionId: ev.sessionId,
            projectPath: ev.projectPath,
            ts: ev.ts,
            category: "operator_correction",
            scenario: truncate(ev.text, 240),
            reasoning: truncate(matches.map((m) => m.evidence).join(" | "), 240),
            outcome: "redirect",
            confidence: 0.6,
            decisionMaker: "operator",
            sourceEventId: ev.id,
            method: "heuristic:operator-correction-bank",
            metadata: JSON.stringify({ categories: cats }),
          });
        }
      }

      // plan_step — plan events
      if (ev.kind === "plan") {
        push({
          id: decisionId(ev.id, "plan_step"),
          sessionId: ev.sessionId,
          projectPath: ev.projectPath,
          ts: ev.ts,
          category: "plan_step",
          scenario: truncate(ev.text ?? "plan", 240),
          reasoning: null,
          outcome: "planned",
          confidence: 0.75,
          decisionMaker: "agent",
          sourceEventId: ev.id,
          method: "heuristic:kind:plan",
          metadata: null,
        });
      }

      // task_outcome — task_completed / task_backgrounded
      if (ev.kind === "task") {
        const label = (ev.text ?? "task").toLowerCase();
        const outcome = label.includes("background")
          ? "backgrounded"
          : label.includes("complete")
            ? "completed"
            : "task";
        push({
          id: decisionId(ev.id, "task_outcome"),
          sessionId: ev.sessionId,
          projectPath: ev.projectPath,
          ts: ev.ts,
          category: "task_outcome",
          scenario: truncate(ev.text ?? "task", 240),
          reasoning: null,
          outcome,
          confidence: 0.85,
          decisionMaker: "system",
          sourceEventId: ev.id,
          method: "heuristic:kind:task",
          metadata: null,
        });
      }
    }

    // tool_recovery — error result followed by same tool_name retry
    for (let i = 0; i < sessionEvents.length; i++) {
      const ev = sessionEvents[i]!;
      if (ev.kind !== "tool_result" || ev.toolError !== 1) continue;
      const toolName = ev.toolName;
      if (!toolName) continue;
      // Look ahead for a later tool_use with the same tool name.
      let retry: ExtractEvent | null = null;
      for (let j = i + 1; j < sessionEvents.length; j++) {
        const later = sessionEvents[j]!;
        if (later.kind === "tool_use" && later.toolName === toolName) {
          retry = later;
          break;
        }
        // Stop scanning far past the error (same session is fine; keep window tight).
        if (later.kind === "user") break;
      }
      if (!retry) continue;
      push({
        id: decisionId(ev.id, "tool_recovery"),
        sessionId: ev.sessionId,
        projectPath: ev.projectPath,
        ts: ev.ts,
        category: "tool_recovery",
        scenario: `tool_error on ${toolName}`,
        reasoning: truncate(ev.toolOutput ?? ev.text ?? "tool_error", 240),
        outcome: "retry",
        confidence: 0.65,
        decisionMaker: "agent",
        sourceEventId: ev.id,
        method: "heuristic:tool-error-retry",
        metadata: JSON.stringify({
          toolName,
          retryEventId: retry.id,
          toolCallId: ev.toolCallId,
        }),
      });
    }
  }

  return out;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}
