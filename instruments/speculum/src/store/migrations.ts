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
      db.run("ALTER TABLE events ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0");
    },
  },
];

/** Look up the step that lands on `version` (from version-1). */
export function migrationFor(version: number, steps: readonly Migration[] = MIGRATIONS): Migration | undefined {
  return steps.find((m) => m.version === version);
}
