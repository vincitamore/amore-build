import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, migrationFor } from "./migrations";

/** Build a minimal v5-shaped db (pre-v6 sessions + session_titles). */
function makeV5Db(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      agent TEXT NOT NULL,
      parent_session TEXT,
      model_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      user_msg_count INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL,
      tool_error_count INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT ''
    )
  `);
  db.run(`CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '')`);
  db.run("PRAGMA user_version = 5");
  return db;
}

describe("v6 migration", () => {
  test("is registered as the step from v5", () => {
    const m = migrationFor(6);
    expect(m).toBeDefined();
    expect(m!.name).toContain("v6");
  });

  test("adds facet columns and the four new tables to a v5 db", () => {
    const db = makeV5Db();
    migrationFor(6, MIGRATIONS)!.up(db);

    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((c) => c.name);
    for (const c of ["cwd_class", "agent_name", "subagent_type", "description", "title_source"]) {
      expect(cols).toContain(c);
    }

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name);
    for (const t of ["session_meta", "session_annotations", "session_links", "generated_titles"]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  test("re-running on an already-migrated db is a no-op, not an error", () => {
    const db = makeV5Db();
    migrationFor(6, MIGRATIONS)!.up(db);
    expect(() => migrationFor(6, MIGRATIONS)!.up(db)).not.toThrow();
    db.close();
  });

  test("session_links enforces one edge per (source, target, kind)", () => {
    const db = makeV5Db();
    migrationFor(6, MIGRATIONS)!.up(db);
    db.run(
      `INSERT INTO session_links (source_session, target_session, kind, method)
       VALUES ('a', 'b', 'resumed_from', 'test')`,
    );
    expect(() =>
      db.run(
        `INSERT INTO session_links (source_session, target_session, kind, method)
         VALUES ('a', 'b', 'resumed_from', 'test')`,
      ),
    ).toThrow();
    db.close();
  });
});
