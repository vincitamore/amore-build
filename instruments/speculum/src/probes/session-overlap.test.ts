import { describe, expect, test } from "bun:test";
import { openDb } from "../store/db";
import {
  findOverlappingPairs,
  intervalsOverlap,
  sessionOverlap,
} from "./session-overlap";

describe("intervalsOverlap (pure)", () => {
  test("detects concurrent ranges", () => {
    expect(
      intervalsOverlap(
        "2026-06-01T10:00:00.000Z",
        "2026-06-01T12:00:00.000Z",
        "2026-06-01T11:00:00.000Z",
        "2026-06-01T13:00:00.000Z",
      ),
    ).toBe(true);
  });

  test("touching endpoints are not overlap", () => {
    expect(
      intervalsOverlap(
        "2026-06-01T10:00:00.000Z",
        "2026-06-01T11:00:00.000Z",
        "2026-06-01T11:00:00.000Z",
        "2026-06-01T12:00:00.000Z",
      ),
    ).toBe(false);
  });

  test("findOverlappingPairs returns both session ids", () => {
    const pairs = findOverlappingPairs([
      {
        id: "a",
        projectPath: "/p",
        startedAt: "2026-06-01T10:00:00.000Z",
        endedAt: "2026-06-01T12:00:00.000Z",
      },
      {
        id: "b",
        projectPath: "/p",
        startedAt: "2026-06-01T11:00:00.000Z",
        endedAt: "2026-06-01T13:00:00.000Z",
      },
      {
        id: "c",
        projectPath: "/p",
        startedAt: "2026-06-01T14:00:00.000Z",
        endedAt: "2026-06-01T15:00:00.000Z",
      },
    ]);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.sessionIdA).toBe("a");
    expect(pairs[0]!.sessionIdB).toBe("b");
    expect(pairs[0]!.overlapMs).toBeGreaterThan(0);
  });
});

describe("session-overlap probe", () => {
  test("flags two overlapping primary sessions", () => {
    const db = openDb(":memory:");
    try {
      const project = "C:\\Users\\Synthetic\\overlap";
      db.run(
        `INSERT INTO sessions (id, project_path, agent, started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count)
         VALUES
           ('sess-a', ?, 'primary', '2026-06-01T10:00:00.000Z', '2026-06-01T12:00:00.000Z', 1, 1, 0, 0),
           ('sess-b', ?, 'primary', '2026-06-01T11:00:00.000Z', '2026-06-01T13:00:00.000Z', 1, 1, 0, 0),
           ('sess-c', ?, 'primary', '2026-06-01T14:00:00.000Z', '2026-06-01T15:00:00.000Z', 1, 1, 0, 0)`,
        [project, project, project],
      );

      const result = sessionOverlap(db, {});
      expect(result.heuristic).toBe(true);
      expect(result.probe).toBe("session-overlap");
      expect(result.value).toBe(2); // a and b involved
      expect(result.n).toBe(3);
      expect(result.summary).toContain("[heuristic]");
      const data = result.data as { pairCount: number; pairs: Array<{ sessionIds: string[] }> };
      expect(data.pairCount).toBe(1);
      expect(data.pairs[0]!.sessionIds).toEqual(["sess-a", "sess-b"]);
      expect(result.hits?.length).toBe(1);
      expect(result.hits![0]!.evidence).toContain("sess-b");
    } finally {
      db.close();
    }
  });
});
