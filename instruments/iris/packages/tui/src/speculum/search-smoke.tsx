// Headless smoke for SearchStage: seed synthetic SPECULUM_DB, type a token, settle debounce,
// assert idle hint (pre-type) + hit row (post-type). Exits non-zero on miss.
// Run: bun run src/speculum/search-smoke.tsx
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { SEARCH_DEBOUNCE_MS, SearchStage } from './SearchStage';

const W = Number(process.env.SMOKE_W ?? 110);
const H = Number(process.env.SMOKE_H ?? 32);
const TOKEN = 'smokesearchtok';

const SYNTHETIC_DDL = `
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
CREATE VIRTUAL TABLE events_fts USING fts5(
  text,
  tool_name,
  tool_input,
  tool_output
);
`;

const tmp = mkdtempSync(join(tmpdir(), 'search-smoke-'));
const dbDir = join(tmp, 'idx');
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, 'speculum.sqlite');

{
  const db = new Database(dbPath);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 4');
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES ('smoke-sess', '/proj/s', 'primary', NULL, 'm',
                 '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 1, 1, 0, 0)`,
    );
    const text = `operator notes about ${TOKEN} in the transcript`;
    db.run(
      `INSERT INTO events (
         session_id, project_path, agent, parent_session, ts, kind,
         text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
         is_boilerplate, sensitive, raw
       ) VALUES ('smoke-sess', '/proj/s', 'primary', NULL, '2026-06-02T12:01:00.000Z',
                 'user', ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
      [text, JSON.stringify({ text })],
    );
    const id = Number(db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id);
    db.run(
      `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
       VALUES (?, ?, NULL, NULL, NULL)`,
      [id, text],
    );
  } finally {
    db.close();
  }
}

const prevDb = process.env.SPECULUM_DB;
process.env.SPECULUM_DB = dbPath;

const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({
  width: W,
  height: H,
});
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <SearchStage inputActive />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 150));
await renderOnce();
const idleFrame = captureCharFrame();
const hasIdle = /type to search sessions/.test(idleFrame);

await mockInput.typeText(TOKEN);
await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 200));
await renderOnce();
const hitFrame = captureCharFrame();
console.log(hitFrame);

const hasHit = /smoke-sess/.test(hitFrame) && new RegExp(TOKEN).test(hitFrame);
const hasTitle = /Search/.test(hitFrame);
const hasBorders = /[┌┐└┘─│]/.test(hitFrame);

console.log(
  `\nidle:${hasIdle} hit:${hasHit} title:${hasTitle} borders:${hasBorders}`,
);

renderer.destroy();
if (prevDb === undefined) delete process.env.SPECULUM_DB;
else process.env.SPECULUM_DB = prevDb;
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

const ok = hasIdle && hasHit && hasTitle && hasBorders;
process.exit(ok ? 0 : 1);
