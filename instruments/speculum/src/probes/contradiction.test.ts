import { describe, expect, test } from "bun:test";
import { openDb } from "../store/db";
import { contradiction, detectContradictions } from "./contradiction";

describe("detectContradictions (pure)", () => {
  test("flags status-flip with both event ids", () => {
    const pairs = detectContradictions("s1", "/p", [
      {
        id: 10,
        ts: "2026-06-01T12:00:00.000Z",
        role: "assistant",
        text: "That is fixed now — should be working.",
      },
      {
        id: 11,
        ts: "2026-06-01T12:05:00.000Z",
        role: "user",
        text: "It is still broken on my end.",
      },
    ]);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.kind).toBe("status-flip");
    expect(pairs[0]!.earlierEventId).toBe(10);
    expect(pairs[0]!.laterEventId).toBe(11);
  });

  test("flags correction-after-done", () => {
    const pairs = detectContradictions("s2", "/p", [
      {
        id: 20,
        ts: "2026-06-01T12:00:00.000Z",
        role: "assistant",
        text: "All done, the problem is solved.",
      },
      {
        id: 21,
        ts: "2026-06-01T12:01:00.000Z",
        role: "user",
        text: "Nope, you failed to apply the fix.",
      },
    ]);
    expect(pairs.some((p) => p.kind === "correction-after-done")).toBe(true);
  });

  test("stays quiet on calm turns (conservative)", () => {
    const pairs = detectContradictions("s3", "/p", [
      {
        id: 30,
        ts: "2026-06-01T12:00:00.000Z",
        role: "user",
        text: "Please list the files in src.",
      },
      {
        id: 31,
        ts: "2026-06-01T12:01:00.000Z",
        role: "assistant",
        text: "Here is the directory listing.",
      },
    ]);
    expect(pairs).toEqual([]);
  });
});

describe("contradiction probe", () => {
  test("planted contradiction yields hit with both eventIds", () => {
    const db = openDb(":memory:");
    try {
      const sid = "contra-session";
      const project = "C:\\Users\\Synthetic\\contra";
      db.run(
        `INSERT INTO sessions (id, project_path, agent, started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count)
         VALUES (?, ?, 'primary', '2026-06-01T12:00:00.000Z', '2026-06-01T12:10:00.000Z', 2, 1, 0, 0)`,
        [sid, project],
      );
      db.run(
        `INSERT INTO events (session_id, project_path, agent, ts, kind, text, is_boilerplate, sensitive, raw)
         VALUES (?, ?, 'primary', '2026-06-01T12:00:00.000Z', 'assistant', ?, 0, 0, '{}')`,
        [sid, project, "Looks good now — that is fixed."],
      );
      db.run(
        `INSERT INTO events (session_id, project_path, agent, ts, kind, text, is_boilerplate, sensitive, raw)
         VALUES (?, ?, 'primary', '2026-06-01T12:05:00.000Z', 'user', ?, 0, 0, '{}')`,
        [sid, project, "Still failing the same way."],
      );

      const result = contradiction(db, {});
      expect(result.heuristic).toBe(true);
      expect(result.probe).toBe("contradiction");
      expect(result.value).toBe(1);
      expect(result.hits?.length).toBeGreaterThanOrEqual(1);
      const hit = result.hits![0]!;
      expect(hit.eventIds?.length).toBe(2);
      expect(hit.eventIds).toContain(1);
      expect(hit.eventIds).toContain(2);
      expect(hit.sourceQuote).toBeDefined();
      expect(result.summary).toContain("[heuristic]");
    } finally {
      db.close();
    }
  });
});
