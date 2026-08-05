/**
 * Sqlite event store via bun:sqlite. Derived and rebuildable from sessions.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDbPath } from "../paths";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);
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
