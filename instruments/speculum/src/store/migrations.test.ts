/**
 * Migration framework coverage (WU-07 framework + WU-08 v2 product step).
 * File-backed fixtures under OS temp — never a real instrument home.
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
  applyMigrations,
  isFreshDb,
} from "./db";
import { MIGRATIONS, type Migration } from "./migrations";
import { buildDoctorReport } from "../commands/doctor";

function scratchDbPath(): { path: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `speculum-mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/** Hand-built v1 shape (no events.sensitive) so v1→v2 migration can be exercised. */
function seedV1Db(path: string): void {
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
    PRAGMA user_version = 1;
  `);
  db.run(
    `INSERT INTO events (session_id, project_path, agent, ts, kind, text, is_boilerplate, raw)
     VALUES ('sess-v1', '/proj', 'primary', '2026-01-01T00:00:00.000Z', 'user', 'survive-me', 0, '{}')`,
  );
  db.close();
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

describe("migrations framework", () => {
  test("fresh create opens at SCHEMA_VERSION with greenfield tables", () => {
    const db = openDb(":memory:");
    try {
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(2);
      expect(isFreshDb(db)).toBe(false);

      const tables = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('events', 'sessions', 'usage', 'ingest_state')
           ORDER BY name`,
        )
        .all()
        .map((r) => r.name);
      expect(tables).toEqual(["events", "ingest_state", "sessions", "usage"]);
      expect(tableHasColumn(db, "events", "sensitive")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("existing reopen keeps rows and user_version (VERIFY V4)", () => {
    const scratch = scratchDbPath();
    try {
      const db1 = openDb(scratch.path);
      db1.run(
        `INSERT INTO events (session_id, project_path, agent, ts, kind, text, is_boilerplate, raw)
         VALUES ('sess-v2', '/proj', 'primary', '2026-01-01T00:00:00.000Z', 'user', 'survive-me', 0, '{}')`,
      );
      expect(getUserVersion(db1)).toBe(SCHEMA_VERSION);
      db1.close();

      const db2 = openDb(scratch.path);
      try {
        expect(getUserVersion(db2)).toBe(SCHEMA_VERSION);
        const row = db2
          .query<{ text: string; session_id: string }, []>(
            "SELECT session_id, text FROM events WHERE session_id = 'sess-v2'",
          )
          .get();
        expect(row?.text).toBe("survive-me");
        expect(row?.session_id).toBe("sess-v2");

        const count =
          db2.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
        expect(count).toBe(1);
      } finally {
        db2.close();
      }
    } finally {
      scratch.cleanup();
    }
  });

  test("v1→v2 migration adds sensitive column and preserves rows", () => {
    const scratch = scratchDbPath();
    try {
      seedV1Db(scratch.path);
      const probe = new Database(scratch.path);
      expect(getUserVersion(probe as never)).toBe(1);
      expect(tableHasColumn(probe, "events", "sensitive")).toBe(false);
      probe.close();

      const db = openDb(scratch.path);
      try {
        expect(getUserVersion(db)).toBe(2);
        expect(SCHEMA_VERSION).toBe(2);
        expect(tableHasColumn(db, "events", "sensitive")).toBe(true);
        const row = db
          .query<{ text: string; sensitive: number }, []>(
            "SELECT text, sensitive FROM events WHERE session_id = 'sess-v1'",
          )
          .get();
        expect(row?.text).toBe("survive-me");
        expect(row?.sensitive).toBe(0);
        const count =
          db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
        expect(count).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      scratch.cleanup();
    }
  });

  test("synthetic downgrade to user_version 0 reopens via migrations to current", () => {
    const scratch = scratchDbPath();
    try {
      // Start from historical v1 shape (no sensitive column), stamp below baseline.
      seedV1Db(scratch.path);
      const db1 = new Database(scratch.path);
      db1.run(
        `INSERT INTO sessions (id, project_path, agent, started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count)
         VALUES ('s0', '/p', 'primary', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 1, 1, 0, 0)`,
      );
      setUserVersion(db1 as never, 0);
      expect(getUserVersion(db1 as never)).toBe(0);
      db1.close();

      const db2 = openDb(scratch.path);
      try {
        expect(getUserVersion(db2)).toBe(SCHEMA_VERSION);
        const row = db2
          .query<{ id: string }, []>("SELECT id FROM sessions WHERE id = 's0'")
          .get();
        expect(row?.id).toBe("s0");
        expect(tableHasColumn(db2, "events", "sensitive")).toBe(true);
        const event = db2
          .query<{ text: string }, []>(
            "SELECT text FROM events WHERE session_id = 'sess-v1'",
          )
          .get();
        expect(event?.text).toBe("survive-me");
      } finally {
        db2.close();
      }
    } finally {
      scratch.cleanup();
    }
  });

  test("applyMigrations runs injected future steps (prove-before-ship helper)", () => {
    const db = openDb(":memory:");
    try {
      // Synthetic earlier stamp; inject a step beyond current SCHEMA_VERSION.
      setUserVersion(db, SCHEMA_VERSION);
      const next = SCHEMA_VERSION + 1;
      const steps: Migration[] = [
        ...MIGRATIONS,
        {
          version: next,
          name: "test-add-marker-table",
          up: (d) => {
            d.run("CREATE TABLE IF NOT EXISTS _mig_probe (id INTEGER PRIMARY KEY)");
            d.run("INSERT INTO _mig_probe DEFAULT VALUES");
          },
        },
      ];
      applyMigrations(db, SCHEMA_VERSION, next, steps);
      expect(getUserVersion(db)).toBe(next);
      const n =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _mig_probe").get()?.n ?? 0;
      expect(n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("applyMigrations is a no-op when already at target", () => {
    const db = openDb(":memory:");
    try {
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
      applyMigrations(db, SCHEMA_VERSION, SCHEMA_VERSION);
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("missing migration step throws", () => {
    const db = openDb(":memory:");
    try {
      // Past SCHEMA_VERSION: no product step exists for the next integer.
      expect(() =>
        applyMigrations(db, SCHEMA_VERSION, SCHEMA_VERSION + 1, MIGRATIONS),
      ).toThrow(/missing migration step/);
    } finally {
      db.close();
    }
  });

  test("doctor schema_version stays green after openDb", () => {
    const db = openDb(":memory:");
    try {
      const report = buildDoctorReport(db, { dbPath: ":memory:" });
      const schema = report.checks.find((c) => c.id === "schema_version");
      expect(schema?.status).toBe("pass");
      expect(schema?.message).toContain(String(SCHEMA_VERSION));
      expect(report.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test("newer-than-binary user_version fails open on existing db", () => {
    const scratch = scratchDbPath();
    try {
      const db1 = openDb(scratch.path);
      setUserVersion(db1, SCHEMA_VERSION + 99);
      db1.close();

      expect(() => openDb(scratch.path)).toThrow(/newer than this binary/);
    } finally {
      scratch.cleanup();
    }
  });
});
