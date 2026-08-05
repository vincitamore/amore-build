/**
 * Sqlite event store via bun:sqlite. Derived and rebuildable from sessions.
 *
 * Schema is imported as text so `bun build --compile` embeds it in the binary
 * (a runtime readFileSync of a sibling .sql would fail once compiled).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultDbPath } from "../paths";
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

export type Db = Database;

export const SCHEMA_VERSION = 1;

export function openDb(path?: string): Db {
  const dbPath = path ?? defaultDbPath();
  if (dbPath !== ":memory:" && dbPath !== "") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");

  db.exec(SCHEMA_SQL);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
