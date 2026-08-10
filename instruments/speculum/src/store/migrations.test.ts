/**
 * Migration framework coverage (WU-07).
 * File-backed fixtures under OS temp — never a real instrument home.
 */

import { describe, expect, test } from "bun:test";
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

describe("migrations framework", () => {
  test("fresh create opens at SCHEMA_VERSION with greenfield tables", () => {
    const db = openDb(":memory:");
    try {
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(1);
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
    } finally {
      db.close();
    }
  });

  test("existing v1 reopen keeps rows and user_version (VERIFY V4)", () => {
    const scratch = scratchDbPath();
    try {
      const db1 = openDb(scratch.path);
      db1.run(
        `INSERT INTO events (session_id, project_path, agent, ts, kind, text, is_boilerplate, raw)
         VALUES ('sess-v1', '/proj', 'primary', '2026-01-01T00:00:00.000Z', 'user', 'survive-me', 0, '{}')`,
      );
      expect(getUserVersion(db1)).toBe(1);
      db1.close();

      const db2 = openDb(scratch.path);
      try {
        expect(getUserVersion(db2)).toBe(SCHEMA_VERSION);
        const row = db2
          .query<{ text: string; session_id: string }, []>(
            "SELECT session_id, text FROM events WHERE session_id = 'sess-v1'",
          )
          .get();
        expect(row?.text).toBe("survive-me");
        expect(row?.session_id).toBe("sess-v1");

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

  test("synthetic downgrade to user_version 0 reopens via migrations to current", () => {
    const scratch = scratchDbPath();
    try {
      const db1 = openDb(scratch.path);
      db1.run(
        `INSERT INTO sessions (id, project_path, agent, started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count)
         VALUES ('s0', '/p', 'primary', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 1, 1, 0, 0)`,
      );
      setUserVersion(db1, 0);
      expect(getUserVersion(db1)).toBe(0);
      db1.close();

      const db2 = openDb(scratch.path);
      try {
        expect(getUserVersion(db2)).toBe(SCHEMA_VERSION);
        const row = db2
          .query<{ id: string }, []>("SELECT id FROM sessions WHERE id = 's0'")
          .get();
        expect(row?.id).toBe("s0");
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
      // Synthetic earlier stamp; inject a step that would land as version 2.
      setUserVersion(db, 1);
      const steps: Migration[] = [
        ...MIGRATIONS,
        {
          version: 2,
          name: "test-add-marker-table",
          up: (d) => {
            d.run("CREATE TABLE IF NOT EXISTS _mig_probe (id INTEGER PRIMARY KEY)");
            d.run("INSERT INTO _mig_probe DEFAULT VALUES");
          },
        },
      ];
      applyMigrations(db, 1, 2, steps);
      expect(getUserVersion(db)).toBe(2);
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
      setUserVersion(db, 0);
      expect(() => applyMigrations(db, 0, 2, MIGRATIONS)).toThrow(/missing migration step/);
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
