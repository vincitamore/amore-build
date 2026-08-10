/**
 * Evidence spine : HitDetail.eventId + events.sensitive at ingest.
 */

import { describe, expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, getUserVersion } from "./store/db";
import { ingest } from "./ingest";
import { userTurns, assistantTurns } from "./store/queries";
import { buildStatusReport } from "./commands/status";
import { PROBES } from "./probes";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  CWD_ENC,
  makeUsage,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  userChunk,
  writeCorpus,
  writeTripwireCorpus,
} from "./test/fixtures";

describe("evidence spine: eventId on hits", () => {
  test("turn helpers project events.id and probes attach eventId", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const turns = [...userTurns(db, {})];
      expect(turns.length).toBeGreaterThan(0);
      for (const t of turns) {
        expect(typeof t.id).toBe("number");
        expect(t.id).toBeGreaterThan(0);
      }

      const assistants = [...assistantTurns(db, {})];
      expect(assistants.length).toBeGreaterThan(0);
      for (const t of assistants) {
        expect(typeof t.id).toBe("number");
        expect(t.id).toBeGreaterThan(0);
      }

      for (const name of [
        "rage-rate",
        "frustration-markers",
        "operator-correction",
        "apology-rate",
      ] as const) {
        const result = PROBES[name]!(db, {});
        expect(result.hits?.length).toBeGreaterThan(0);
        for (const h of result.hits!) {
          expect(typeof h.eventId).toBe("number");
          const row = db
            .query<{ session_id: string }, [number]>(
              "SELECT session_id FROM events WHERE id = ?",
            )
            .get(h.eventId!);
          expect(row?.session_id).toBe(h.sessionId);
        }
      }

      const sens = PROBES["sensitive-content"]!(db, {});
      expect(sens.hits?.length).toBeGreaterThan(0);
      for (const h of sens.hits!) {
        expect(typeof h.eventId).toBe("number");
        expect(Array.isArray(h.eventIds)).toBe(true);
        expect(h.eventIds!.length).toBeGreaterThan(0);
        expect(h.eventIds![0]).toBe(h.eventId);
      }
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});

describe("evidence spine: sensitive at ingest", () => {
  test("tool_output secret sets sensitive=1; raw stays byte-identical", () => {
    const id = "dddddddd-eeee-ffff-0000-111111111111";
    const secretOut = "file contents: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const corpus = writeCorpus([
      {
        id,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          userChunk("Please read .env.local and summarize."),
          agentChunk("Reading the file."),
          toolCall("t1", "read_file", { target_file: ".env.local" }),
          toolCallUpdate("t1", "read_file", secretOut),
          turnCompleted(makeUsage("grok-4", { inputTokens: 100, outputTokens: 20 })),
        ],
      },
    ]);
    const db = openDb(":memory:");
    try {
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
      ingest(db, { sessionsDir: corpus.root });

      const flagged =
        db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE sensitive = 1")
          .get()?.n ?? 0;
      expect(flagged).toBeGreaterThanOrEqual(1);

      const hit = db
        .query<{ id: number; tool_output: string | null; sensitive: number; raw: string }, []>(
          `SELECT id, tool_output, sensitive, raw FROM events
           WHERE sensitive = 1 AND tool_output IS NOT NULL LIMIT 1`,
        )
        .get();
      expect(hit).toBeTruthy();
      expect(hit!.sensitive).toBe(1);
      expect(hit!.tool_output).toContain("ghp_");
      // Flag-not-transform: stored raw still contains the secret-shaped string.
      expect(hit!.raw).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");

      const clean =
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM events WHERE sensitive = 0 AND kind = 'user'",
          )
          .get()?.n ?? 0;
      expect(clean).toBeGreaterThanOrEqual(1);

      const status = buildStatusReport(db, ":memory:");
      expect(status.counts.sensitiveEvents).toBe(flagged);
      expect(status.counts.sensitiveSessions).toBe(1);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("clean corpus leaves sensitive counts at zero", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const flagged =
        db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE sensitive = 1")
          .get()?.n ?? 0;
      expect(flagged).toBe(0);
      const status = buildStatusReport(db, ":memory:");
      expect(status.counts.sensitiveEvents).toBe(0);
      expect(status.counts.sensitiveSessions).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
