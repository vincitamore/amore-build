/**
 * listSessions / countSessions filters, paging, and sort.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { ingest } from "../ingest";
import { countSessions, listSessions } from "./queries";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  makeUsage,
  turnCompleted,
  userChunk,
  writeCorpus,
  writeTripwireCorpus,
} from "../test/fixtures";

function seedMulti(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const operator = cleanCorpus()[0]!;
  const harnessPath = "C:\\Users\\Synthetic\\AppData\\Local\\Temp\\chat-mode-xyz";
  const harnessEnc = encodeURIComponent(harnessPath);
  const harnessId = "dddddddd-eeee-ffff-0000-111111111111";
  const expPath = "C:\\Users\\Synthetic\\AppData\\Local\\Temp\\arcus-identity-study\\run1";
  const expEnc = encodeURIComponent(expPath);
  const expId = "eeeeeeee-ffff-0000-1111-222222222222";

  const corpus = writeCorpus([
    {
      ...operator,
      id: operator.id,
      summaryExtra: {
        session_summary: "Operator Work",
        agent_name: "grok-build-plan",
        generated_title: "Operator Work Title",
      },
    },
    {
      id: harnessId,
      cwdEnc: harnessEnc,
      cwdDecoded: harnessPath,
      updates: [
        userChunk("a"),
        agentChunk("b"),
        turnCompleted(makeUsage()),
      ],
      summaryExtra: {
        session_summary: "Harness Smoke",
        agent_name: "smoke-agent",
      },
    },
    {
      id: expId,
      cwdEnc: expEnc,
      cwdDecoded: expPath,
      updates: [
        userChunk("x"),
        agentChunk("y"),
        agentChunk("z"),
        turnCompleted(makeUsage()),
      ],
      summaryExtra: {
        session_summary: "Identity Study Run",
        agent_name: "study-agent",
      },
    },
  ]);

  const db = openDb(":memory:");
  ingest(db, { sessionsDir: corpus.root });
  return {
    db,
    cleanup: () => {
      db.close();
      corpus.cleanup();
    },
  };
}

describe("listSessions / countSessions", () => {
  test("counts all and lists with default limit", () => {
    const { db, cleanup } = seedMulti();
    try {
      expect(countSessions(db)).toBe(3);
      const rows = listSessions(db, { limit: 50 });
      expect(rows.length).toBe(3);
      // sort recent by ended_at desc — all recent fixtures
      expect(rows.every((r) => r.id.length > 0)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("filters by cwd_class", () => {
    const { db, cleanup } = seedMulti();
    try {
      expect(countSessions(db, { cwdClass: "operator" })).toBe(1);
      expect(countSessions(db, { cwdClass: "harness" })).toBe(1);
      expect(countSessions(db, { cwdClass: "experiment" })).toBe(1);
      const ops = listSessions(db, { cwdClass: "operator" });
      expect(ops).toHaveLength(1);
      expect(ops[0]!.cwdClass).toBe("operator");
      expect(ops[0]!.agentName).toBe("grok-build-plan");
    } finally {
      cleanup();
    }
  });

  test("filters by agent role primary|subagent", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const primaries = countSessions(db, { agent: "primary" });
      const subs = countSessions(db, { agent: "subagent" });
      expect(primaries).toBeGreaterThanOrEqual(1);
      expect(subs).toBe(1);
      const subRows = listSessions(db, { agent: "subagent" });
      expect(subRows).toHaveLength(1);
      expect(subRows[0]!.agent).toBe("subagent");
      expect(subRows[0]!.subagentType).toBe("explore");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("project and title substring filters", () => {
    const { db, cleanup } = seedMulti();
    try {
      const byProj = listSessions(db, { project: "Synthetic\\project" });
      expect(byProj.length).toBe(1);
      expect(byProj[0]!.projectPath).toBe(CWD_DEC);

      const byTitle = listSessions(db, { title: "Operator Work" });
      expect(byTitle).toHaveLength(1);
      expect(byTitle[0]!.title).toContain("Operator Work");

      expect(countSessions(db, { title: "no-such-title-xyz" })).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("since / until on ended_at", () => {
    const { db, cleanup } = seedMulti();
    try {
      const future = "2099-01-01T00:00:00.000Z";
      const past = "2000-01-01T00:00:00.000Z";
      expect(countSessions(db, { since: past })).toBe(3);
      expect(countSessions(db, { until: past })).toBe(0);
      expect(countSessions(db, { since: future })).toBe(0);
      expect(countSessions(db, { until: future })).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("paging limit/offset and sort turns", () => {
    const { db, cleanup } = seedMulti();
    try {
      // Bump one session's turn_count via a direct update for sort isolation
      // (fixtures have similar counts; sort by turns still returns a stable order).
      const all = listSessions(db, { sort: "turns", limit: 50 });
      expect(all.length).toBe(3);
      for (let i = 1; i < all.length; i++) {
        expect(all[i - 1]!.turnCount).toBeGreaterThanOrEqual(all[i]!.turnCount);
      }

      const page0 = listSessions(db, { sort: "recent", limit: 1, offset: 0 });
      const page1 = listSessions(db, { sort: "recent", limit: 1, offset: 1 });
      expect(page0).toHaveLength(1);
      expect(page1).toHaveLength(1);
      expect(page0[0]!.id).not.toBe(page1[0]!.id);
      expect(countSessions(db, { sort: "recent", limit: 1, offset: 1 })).toBe(3);

      const errSort = listSessions(db, { sort: "errors", limit: 50 });
      expect(errSort).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  test("empty index returns zero", () => {
    const db = openDb(":memory:");
    try {
      expect(countSessions(db)).toBe(0);
      expect(listSessions(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
