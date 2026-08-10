import { describe, expect, test } from "bun:test";
import { openDb } from "../store/db";
import {
  detectPhasesForSession,
  PHASE_THRESHOLDS,
  sessionPhase,
} from "./session-phase";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("detectPhasesForSession (pure)", () => {
  test("classifies a burst from short inter-event deltas", () => {
    const t0 = Date.parse("2026-06-01T12:00:00.000Z");
    // 6 events, 5s apart → inside burstMaxDeltaMs (15s), count ≥ 5
    const events = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      ts: iso(t0 + i * 5_000),
      kind: "tool_use",
      toolError: 0,
    }));
    const phases = detectPhasesForSession("s-burst", "/p", events);
    const bursts = phases.filter((p) => p.kind === "burst");
    expect(bursts.length).toBeGreaterThanOrEqual(1);
    expect(bursts[0]!.eventIds.length).toBeGreaterThanOrEqual(PHASE_THRESHOLDS.burstMinEvents);
  });

  test("classifies a stall from a long gap", () => {
    const t0 = Date.parse("2026-06-01T12:00:00.000Z");
    const events = [
      { id: 1, ts: iso(t0), kind: "user", toolError: 0 },
      { id: 2, ts: iso(t0 + 10_000), kind: "assistant", toolError: 0 },
      { id: 3, ts: iso(t0 + 10_000 + 6 * 60_000), kind: "user", toolError: 0 },
    ];
    const phases = detectPhasesForSession("s-stall", "/p", events);
    expect(phases.some((p) => p.kind === "stall")).toBe(true);
  });

  test("classifies an error-cluster", () => {
    const t0 = Date.parse("2026-06-01T12:00:00.000Z");
    const events = [
      { id: 1, ts: iso(t0), kind: "tool_result", toolError: 1 },
      { id: 2, ts: iso(t0 + 20_000), kind: "tool_result", toolError: 1 },
      { id: 3, ts: iso(t0 + 40_000), kind: "tool_result", toolError: 1 },
      { id: 4, ts: iso(t0 + 50_000), kind: "user", toolError: 0 },
    ];
    const phases = detectPhasesForSession("s-err", "/p", events);
    expect(phases.some((p) => p.kind === "error-cluster")).toBe(true);
  });
});

describe("session-phase probe", () => {
  test("flags a session with a planted burst and returns heuristic + eventIds", () => {
    const db = openDb(":memory:");
    try {
      const t0 = Date.parse("2026-06-01T15:00:00.000Z");
      const sid = "phase-burst-session";
      const project = "C:\\Users\\Synthetic\\phase";

      db.run(
        `INSERT INTO sessions (id, project_path, agent, started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count)
         VALUES (?, ?, 'primary', ?, ?, 6, 0, 6, 0)`,
        [sid, project, iso(t0), iso(t0 + 25_000)],
      );

      for (let i = 0; i < 6; i++) {
        db.run(
          `INSERT INTO events (session_id, project_path, agent, ts, kind, text, tool_error, is_boilerplate, sensitive, raw)
           VALUES (?, ?, 'primary', ?, 'tool_use', NULL, 0, 0, 0, '{}')`,
          [sid, project, iso(t0 + i * 5_000)],
        );
      }

      const result = sessionPhase(db, {});
      expect(result.heuristic).toBe(true);
      expect(result.probe).toBe("session-phase");
      expect(result.value).toBeGreaterThanOrEqual(1);
      expect(result.summary).toContain("[heuristic]");
      expect(result.hits?.some((h) => h.category === "burst")).toBe(true);
      const burstHit = result.hits?.find((h) => h.category === "burst");
      expect(burstHit?.eventIds?.length).toBeGreaterThanOrEqual(5);
      expect(burstHit?.sessionId).toBe(sid);
    } finally {
      db.close();
    }
  });
});
