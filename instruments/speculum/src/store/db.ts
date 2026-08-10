/**
 * Sqlite event store via bun:sqlite. Derived and rebuildable from sessions.
 *
 * Schema is imported as text so `bun build --compile` embeds it in the binary
 * (a runtime readFileSync of a sibling .sql would fail once compiled).
 *
 * Derived-index story: sessions files are source of truth; sqlite is derived
 * and rebuildable. Migrations upgrade existing derived indexes in place;
 * ingest --full rebuilds from byte 0 (same fresh-create path as a new file).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultDbPath } from "../paths";
import SCHEMA_SQL from "./schema.sql" with { type: "text" };
import { MIGRATIONS, migrationFor, type Migration, type MigrationDb } from "./migrations";

export type Db = Database;

/** Current greenfield schema version. Product bumps land with a matching migration. */
export const SCHEMA_VERSION = 3;

export function getUserVersion(db: Db): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/** Stamp PRAGMA user_version. Exported so tests can seed a synthetic earlier version. */
export function setUserVersion(db: Db, version: number): void {
  db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/**
 * True when none of the application tables exist (brand-new file / :memory:).
 * An existing index always has these four from greenfield schema.sql.
 */
export function isFreshDb(db: Db): boolean {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('events', 'sessions', 'usage', 'ingest_state')`,
    )
    .get();
  return (row?.n ?? 0) === 0;
}

/**
 * Apply ordered migration steps for versions (fromVersion+1) .. toVersion.
 * Each step runs in its own transaction and stamps user_version on success.
 * Inject `steps` only in tests to prove a future migration before shipping it.
 */
export function applyMigrations(
  db: Db,
  fromVersion: number,
  toVersion: number = SCHEMA_VERSION,
  steps: readonly Migration[] = MIGRATIONS,
): void {
  if (fromVersion > toVersion) {
    throw new Error(
      `database schema version ${fromVersion} is newer than this binary (SCHEMA_VERSION=${toVersion}); rebuild with a matching speculum or ingest --full after removing the index`,
    );
  }
  if (fromVersion === toVersion) return;

  for (let v = fromVersion + 1; v <= toVersion; v++) {
    const step = migrationFor(v, steps);
    if (!step) {
      throw new Error(`missing migration step for schema version ${v}`);
    }
    // WU-07: one transaction per step — partial multi-step upgrades leave a
    // coherent intermediate stamp rather than a half-applied jump.
    const run = (db as MigrationDb).transaction(() => {
      step.up(db);
      setUserVersion(db, step.version);
    });
    run();
  }
}

/**
 * Open (or create) the derived index.
 *
 * - Brand-new DB: run schema.sql (full greenfield DDL), stamp SCHEMA_VERSION.
 * - Existing DB with user_version < SCHEMA_VERSION: ordered migrations, stamp.
 * - Existing DB already at SCHEMA_VERSION: no-op (rows intact).
 * - Existing DB newer than this binary: throw (do not downgrade silently).
 */
export function openDb(path?: string): Db {
  const dbPath = path ?? defaultDbPath();
  if (dbPath !== ":memory:" && dbPath !== "") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");

  // WU-07: migration / greenfield loop
  if (isFreshDb(db)) {
    db.exec(SCHEMA_SQL);
    setUserVersion(db, SCHEMA_VERSION);
  } else {
    const current = getUserVersion(db);
    if (current > SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `database schema version ${current} is newer than this binary (SCHEMA_VERSION=${SCHEMA_VERSION}); rebuild with a matching speculum or ingest --full after removing the index`,
      );
    }
    if (current < SCHEMA_VERSION) {
      applyMigrations(db, current, SCHEMA_VERSION);
    }
    // current === SCHEMA_VERSION: no-op
  }

  // Invariant: healthy open always ends at SCHEMA_VERSION.
  const final = getUserVersion(db);
  if (final !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `schema open left user_version=${final}, expected SCHEMA_VERSION=${SCHEMA_VERSION}`,
    );
  }

  return db;
}

/**
 * Decode a URL-encoded cwd directory name to a readable project path.
 * Long-path slug+hash forms fall through to the raw name (a `.cwd` file may
 * hold the real path; callers that need it can read that separately).
 */
export function decodeCwdDirName(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
