/**
 * Ordered schema migrations for the derived sqlite index.
 *
 * Sessions files are source of truth; sqlite is derived and rebuildable.
 * Migrations upgrade existing derived indexes in place; ingest --full rebuilds
 * from byte 0 (fresh create via schema.sql, not this list).
 *
 * schema.sql is the single source of truth for a greenfield create.
 * Each entry here is the incremental path from version N-1 → N for EXISTING DBs.
 * Product ALTERs / new tables begin at version 2+ (owned by later units).
 */

import type { Database } from "bun:sqlite";

export type MigrationDb = Database;

export interface Migration {
  /** Target PRAGMA user_version after this step completes. */
  version: number;
  name: string;
  /** Apply DDL/DML. Called inside a transaction by the runner. */
  up: (db: MigrationDb) => void;
}

// Version 1 is established by schema.sql on fresh create (historical). The
// baseline step lets an existing DB whose stamp was forced below SCHEMA_VERSION
// walk the ordered loop without re-running greenfield DDL (tables already present).
// Version 2 adds events.sensitive (flag-only at ingest; never rewrites raw).
// Version 3 adds events_fts (FTS5 standalone over events text/tool fields).
// Version 4 adds event_links + decisions (derived; rebuilt on every ingest post-pass).
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "v1-baseline",
    up: (_db) => {
      // no-op: greenfield shape lives in schema.sql
    },
  },
  {
    version: 2,
    name: "v2-events-sensitive",
    up: (db) => {
      // Legacy v1 indexes shipped events.sensitive in their schema while
      // stamping user_version 1; re-adding the column would fail every open
      // with a duplicate-column error. Add only when actually absent.
      const cols = db.query<{ name: string }, []>(`PRAGMA table_info(events)`).all();
      if (!cols.some((c) => c.name === "sensitive")) {
        db.run("ALTER TABLE events ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 3,
    name: "v3-events-fts",
    up: (db) => {
      // Standalone FTS5 (rowid = events.id). External-content form was avoided:
      // bun:sqlite DELETE on empty external-content vtab can raise CORRUPT_VTAB.
      // Derived index — rebuild anytime: drop any legacy FTS first so an index
      // that predates this step (or carried its own FTS) lands on one shape.
      db.run("DROP TABLE IF EXISTS events_fts");
      db.run(`
        CREATE VIRTUAL TABLE events_fts USING fts5(
          text,
          tool_name,
          tool_input,
          tool_output
        )
      `);
      // Backfill from existing events (derived index — safe to rebuild anytime).
      db.run(`
        INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
        SELECT id, text, tool_name, tool_input, tool_output FROM events
      `);
    },
  },
  {
    version: 4,
    name: "v4-event-links-decisions",
    up: (db) => {
      // Derived tables: empty shells; ingest post-pass re-derives rows.
      db.run(`
        CREATE TABLE IF NOT EXISTS event_links (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_event_id  INTEGER NOT NULL,
          target_event_id  INTEGER NOT NULL,
          kind             TEXT NOT NULL,
          method           TEXT NOT NULL,
          confidence       REAL NOT NULL DEFAULT 1.0,
          heuristic        INTEGER NOT NULL DEFAULT 0,
          UNIQUE(source_event_id, target_event_id, kind)
        )
      `);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_event_links_source ON event_links(source_event_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_event_links_target ON event_links(target_event_id)",
      );
      db.run("CREATE INDEX IF NOT EXISTS idx_event_links_kind ON event_links(kind)");
      db.run(`
        CREATE TABLE IF NOT EXISTS decisions (
          id               TEXT PRIMARY KEY,
          session_id       TEXT NOT NULL,
          project_path     TEXT NOT NULL,
          ts               TEXT NOT NULL,
          category         TEXT NOT NULL,
          scenario         TEXT,
          reasoning        TEXT,
          outcome          TEXT,
          confidence       REAL,
          decision_maker   TEXT,
          source_event_id  INTEGER,
          method           TEXT NOT NULL,
          metadata         TEXT
        )
      `);
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, ts)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source_event_id)",
      );
    },
  },
];

/** Look up the step that lands on `version` (from version-1). */
export function migrationFor(version: number, steps: readonly Migration[] = MIGRATIONS): Migration | undefined {
  return steps.find((m) => m.version === version);
}
