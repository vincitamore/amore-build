/**
 * FTS5 search + RRF . Exercises CREATE VIRTUAL TABLE + MATCH + bm25
 * so instruments-ci (ubuntu/windows/macos) confirms G4 cross-platform.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDb,
  SCHEMA_VERSION,
  getUserVersion,
  setUserVersion,
} from "./store/db";
import {
  clearEventsFts,
  createSearchBackend,
  prepareFtsQuery,
  reciprocalRankFusion,
  rebuildEventsFts,
  searchEvents,
  upsertEventFts,
  RRF_K,
} from "./store/search";
import { ingest } from "./ingest";
import { forgetSession } from "./ingest/forget";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  CWD_ENC,
  makeUsage,
  turnCompleted,
  userChunk,
  writeCorpus,
} from "./test/fixtures";

function scratchDbPath(): { path: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `speculum-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return {
    path: join(dir, "index.sqlite"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/** Seed a v2-shaped DB (sensitive present, no events_fts) for v2→v3 migration. */
function seedV2Db(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      project_path    TEXT NOT NULL,
      agent           TEXT NOT NULL,
      parent_session  TEXT,
      ts              TEXT NOT NULL,
      kind            TEXT NOT NULL,
      text            TEXT,
      tool_name       TEXT,
      tool_input      TEXT,
      tool_output     TEXT,
      tool_error      INTEGER,
      tool_call_id    TEXT,
      is_boilerplate  INTEGER NOT NULL DEFAULT 0,
      sensitive       INTEGER NOT NULL DEFAULT 0,
      raw             TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id               TEXT PRIMARY KEY,
      project_path     TEXT NOT NULL,
      agent            TEXT NOT NULL,
      parent_session   TEXT,
      model_id         TEXT,
      started_at       TEXT NOT NULL,
      ended_at         TEXT NOT NULL,
      turn_count       INTEGER NOT NULL,
      user_msg_count   INTEGER NOT NULL,
      tool_call_count  INTEGER NOT NULL,
      tool_error_count INTEGER NOT NULL
    );
    CREATE TABLE usage (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id          TEXT NOT NULL,
      project_path        TEXT NOT NULL,
      ts                  TEXT NOT NULL,
      model_id            TEXT,
      input_tokens        INTEGER NOT NULL DEFAULT 0,
      output_tokens       INTEGER NOT NULL DEFAULT 0,
      cached_read_tokens  INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
      total_tokens        INTEGER NOT NULL DEFAULT 0,
      num_turns           INTEGER NOT NULL DEFAULT 0,
      model_calls         INTEGER NOT NULL DEFAULT 0,
      raw                 TEXT NOT NULL
    );
    CREATE TABLE ingest_state (
      file_path     TEXT PRIMARY KEY,
      size_bytes    INTEGER NOT NULL,
      mtime         TEXT NOT NULL,
      byte_offset   INTEGER NOT NULL,
      last_ingested TEXT NOT NULL,
      forgotten     INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version = 2;
  `);
  db.run(
    `INSERT INTO events (session_id, project_path, agent, ts, kind, text, is_boilerplate, sensitive, raw)
     VALUES ('sess-v2', '/proj', 'primary', '2026-01-01T00:00:00.000Z', 'user', 'migrate-me junction path', 0, 0, '{}')`,
  );
  db.run(
    `INSERT INTO sessions (id, project_path, agent, started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count)
     VALUES ('sess-v2', '/proj', 'primary', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 1, 1, 0, 0)`,
  );
  db.close();
}

function insertEvent(
  db: Database,
  row: {
    session_id: string;
    project_path?: string;
    ts: string;
    kind?: string;
    text: string | null;
    tool_name?: string | null;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO events (session_id, project_path, agent, ts, kind, text, tool_name, is_boilerplate, sensitive, raw)
       VALUES (?, ?, 'primary', ?, ?, ?, ?, 0, 0, '{}')`,
    )
    .run(
      row.session_id,
      row.project_path ?? "/proj",
      row.ts,
      row.kind ?? "user",
      row.text,
      row.tool_name ?? null,
    );
  const id = Number(info.lastInsertRowid);
  upsertEventFts(db as never, id, {
    text: row.text,
    tool_name: row.tool_name ?? null,
    tool_input: null,
    tool_output: null,
  });
  return id;
}

describe("FTS5 primitives (G4 / instruments-ci)", () => {
  test("CREATE VIRTUAL TABLE + MATCH + bm25 + 6-arg snippet", () => {
    const db = new Database(":memory:");
    try {
      db.run("CREATE VIRTUAL TABLE t USING fts5(body)");
      db.run("INSERT INTO t(body) VALUES ('alpha bravo charlie')");
      db.run("INSERT INTO t(body) VALUES ('delta echo foxtrot')");
      db.run("INSERT INTO t(body) VALUES ('alpha alpha alpha')");

      const rows = db
        .query<
          { rowid: number; body: string; score: number; snip: string },
          []
        >(
          `SELECT rowid, body, bm25(t) AS score,
                  snippet(t, 0, '[', ']', '...', 8) AS snip
           FROM t WHERE t MATCH 'alpha' ORDER BY bm25(t)`,
        )
        .all();

      expect(rows.length).toBe(2);
      // Lower bm25 = better; the triple-alpha row should rank first.
      expect(rows[0]!.body).toContain("alpha alpha");
      expect(rows[0]!.score).toBeLessThanOrEqual(rows[1]!.score);
      expect(rows[0]!.snip).toContain("[alpha]");
    } finally {
      db.close();
    }
  });
});

describe("search backend", () => {
  test("fresh index creates events_fts; search finds known event", () => {
    const db = openDb(":memory:");
    try {
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(6);

      const fts = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE name = 'events_fts'`,
        )
        .get();
      expect(fts?.name).toBe("events_fts");

      insertEvent(db, {
        session_id: "s1",
        ts: "2026-06-01T12:00:00.000Z",
        text: "stuck on NTFS junction path resolution",
      });
      insertEvent(db, {
        session_id: "s1",
        ts: "2026-06-01T12:01:00.000Z",
        text: "unrelated weather chat",
      });

      const backend = createSearchBackend(db);
      const hits = backend.search("junction", { ftsOnly: true, limit: 10 });
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.snippet.toLowerCase()).toContain("junction");
      expect(hits[0]!.sessionId).toBe("s1");
      expect(typeof hits[0]!.eventId).toBe("number");
      expect(hits[0]!.backend).toBe("fts");
    } finally {
      db.close();
    }
  });

  test("bm25 orders more relevant hit first (fts-only)", () => {
    const db = openDb(":memory:");
    try {
      const weak = insertEvent(db, {
        session_id: "s1",
        ts: "2026-06-01T10:00:00.000Z",
        text: "the word schema appears once here",
      });
      const strong = insertEvent(db, {
        session_id: "s1",
        ts: "2026-06-01T11:00:00.000Z",
        text: "schema schema schema migration version schema",
      });

      const hits = searchEvents(db, "schema", { ftsOnly: true, limit: 5 });
      expect(hits.length).toBe(2);
      expect(hits[0]!.eventId).toBe(strong);
      expect(hits[1]!.eventId).toBe(weak);
      expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    } finally {
      db.close();
    }
  });

  test("RRF fuses recency so a fresh off-topic hit can surface with relevant old", () => {
    const db = openDb(":memory:");
    try {
      const oldRelevant = insertEvent(db, {
        session_id: "old",
        ts: "2020-01-01T00:00:00.000Z",
        text: "discussion of zebra taxonomy and zebra stripes",
      });
      // Recent off-topic (no zebra)
      const freshOff = insertEvent(db, {
        session_id: "new",
        ts: "2026-08-01T00:00:00.000Z",
        text: "hello world trivial note",
      });
      // Mid irrelevant filler so recency list is non-trivial
      insertEvent(db, {
        session_id: "mid",
        ts: "2025-01-01T00:00:00.000Z",
        text: "filler event about nothing special",
      });

      const fused = searchEvents(db, "zebra", {
        ftsOnly: false,
        limit: 10,
        candidateLimit: 20,
      });
      const ids = fused.map((h) => h.eventId);
      expect(ids).toContain(oldRelevant);
      expect(ids).toContain(freshOff);

      const oldHit = fused.find((h) => h.eventId === oldRelevant)!;
      const freshHit = fused.find((h) => h.eventId === freshOff)!;
      // Old relevant gets FTS rank credit; fresh gets recency credit.
      expect(oldHit.backend === "fts" || oldHit.backend === "hybrid").toBe(true);
      expect(freshHit.backend).toBe("recency");
      expect(oldHit.score).toBeGreaterThan(0);
      expect(freshHit.score).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("reciprocalRankFusion pure unit (k=60)", () => {
    const scores = reciprocalRankFusion(
      [
        [10, 20, 30],
        [20, 40, 10],
      ],
      RRF_K,
    );
    // id 20: rank1 in list2 (1/61) + rank2 in list1 (1/62)
    expect(scores.get(20)!).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(scores.get(10)!).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(scores.get(40)!).toBeCloseTo(1 / 62, 10);
  });

  test("prepareFtsQuery strips operators", () => {
    expect(prepareFtsQuery('  hello "world" (x)  ')).toBe('"hello" "world" "x"');
    expect(prepareFtsQuery("***")).toBe("");
  });

  test("since/until filters bound results", () => {
    const db = openDb(":memory:");
    try {
      insertEvent(db, {
        session_id: "s",
        ts: "2024-01-01T00:00:00.000Z",
        text: "needle early",
      });
      insertEvent(db, {
        session_id: "s",
        ts: "2026-06-15T00:00:00.000Z",
        text: "needle late",
      });
      const hits = searchEvents(db, "needle", {
        ftsOnly: true,
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T23:59:59.999Z",
      });
      expect(hits.length).toBe(1);
      expect(hits[0]!.snippet).toContain("late");
    } finally {
      db.close();
    }
  });
});

describe("v2→current migration keeps rows and builds FTS", () => {
  test("existing v2 DB migrates to SCHEMA_VERSION; search finds pre-migration text", () => {
    const scratch = scratchDbPath();
    try {
      seedV2Db(scratch.path);
      const probe = new Database(scratch.path);
      expect(getUserVersion(probe as never)).toBe(2);
      const preFts = probe
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'events_fts'`,
        )
        .get()?.n;
      expect(preFts).toBe(0);
      probe.close();

      const db = openDb(scratch.path);
      try {
        expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
        expect(SCHEMA_VERSION).toBe(6);
        const row = db
          .query<{ text: string }, []>(
            "SELECT text FROM events WHERE session_id = 'sess-v2'",
          )
          .get();
        expect(row?.text).toContain("junction");

        const hits = searchEvents(db, "junction", { ftsOnly: true });
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0]!.snippet.toLowerCase()).toContain("junction");
      } finally {
        db.close();
      }
    } finally {
      scratch.cleanup();
    }
  });
});

describe("ingest / forget maintain FTS", () => {
  test("ingest populates FTS; forget removes FTS rows", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      const stats = ingest(db, { sessionsDir: corpus.root });
      expect(stats.eventsAppended).toBeGreaterThan(0);

      const hits = searchEvents(db, "directory", { ftsOnly: true, limit: 20 });
      expect(hits.length).toBeGreaterThanOrEqual(1);

      const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const before =
        db
          .query<{ n: number }, [string]>(
            `SELECT COUNT(*) AS n FROM events_fts
             WHERE rowid IN (SELECT id FROM events WHERE session_id = ?)`,
          )
          .get(sessionId)?.n ?? 0;
      expect(before).toBeGreaterThan(0);

      const result = forgetSession(db, sessionId, { skipAudit: true });
      expect(result.ok).toBe(true);
      expect(result.eventsDeleted).toBeGreaterThan(0);

      const after =
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'directory'`,
          )
          .get()?.n ?? 0;
      expect(after).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("ingest --full rebuilds FTS via wipe + re-insert", () => {
    const id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const corpus = writeCorpus([
      {
        id,
        cwdEnc: CWD_ENC,
        cwdDecoded: CWD_DEC,
        modelId: "grok-4",
        updates: [
          userChunk("uniquephrase alpha rebuild"),
          agentChunk("acknowledged uniquephrase"),
          turnCompleted(makeUsage("grok-4")),
        ],
      },
    ]);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      expect(searchEvents(db, "uniquephrase", { ftsOnly: true }).length).toBeGreaterThan(0);

      const second = ingest(db, { sessionsDir: corpus.root, full: true });
      expect(second.eventsAppended).toBeGreaterThan(0);
      const hits = searchEvents(db, "uniquephrase", { ftsOnly: true });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("clear + rebuildEventsFts round-trip", () => {
    const db = openDb(":memory:");
    try {
      insertEvent(db, {
        session_id: "s",
        ts: "2026-01-01T00:00:00.000Z",
        text: "roundtrip token xyzzy",
      });
      clearEventsFts(db);
      expect(searchEvents(db, "xyzzy", { ftsOnly: true }).length).toBe(0);
      rebuildEventsFts(db);
      expect(searchEvents(db, "xyzzy", { ftsOnly: true }).length).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("schema version pin", () => {
  test("SCHEMA_VERSION is 6 after session facets, links and annotations", () => {
    expect(SCHEMA_VERSION).toBe(6);
    const db = openDb(":memory:");
    try {
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
      // Stamp current; reopen path is a no-op when already at SCHEMA_VERSION
      setUserVersion(db, SCHEMA_VERSION);
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
