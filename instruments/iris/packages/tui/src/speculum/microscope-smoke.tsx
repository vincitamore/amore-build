// Headless smoke for MicroscopeStage against a synthetic SPECULUM_DB index.
// Run: bun run src/speculum/microscope-smoke.tsx
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { MicroscopeStage } from './MicroscopeStage';

const W = Number(process.env.SMOKE_W ?? 120);
const H = Number(process.env.SMOKE_H ?? 34);

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

const tmp = mkdtempSync(join(tmpdir(), 'micro-smoke-'));
const dbPath = join(tmp, 'speculum.sqlite');
mkdirSync(tmp, { recursive: true });

function seed(): void {
  const db = new Database(dbPath);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 4');
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES (
         'smoke-sess', '/proj/smoke-app', 'primary', NULL, 'model-s',
         '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 2, 1, 1, 1
       )`,
    );
    const insert = (
      ts: string,
      kind: string,
      text: string,
      toolName: string | null = null,
      toolError: number | null = null,
    ) => {
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES ('smoke-sess', '/proj/smoke-app', 'primary', NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0, ?)`,
        [ts, kind, text, toolName, toolError, JSON.stringify({ text })],
      );
      const id = Number(
        db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id,
      );
      db.run(
        `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         VALUES (?, ?, ?, NULL, NULL)`,
        [id, text, toolName],
      );
    };
    insert('2026-06-02T12:00:00.000Z', 'user', 'smoke hello');
    insert('2026-06-02T12:01:00.000Z', 'assistant', 'smoke reply');
    insert('2026-06-02T12:02:00.000Z', 'tool_use', '', 'Bash', 0);
    insert(
      '2026-06-02T12:03:00.000Z',
      'tool_result',
      'command not found: smoke-bin',
      'Bash',
      1,
    );
  } finally {
    db.close();
  }
}

seed();

const prevDb = process.env.SPECULUM_DB;
process.env.SPECULUM_DB = dbPath;

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
  width: W,
  height: H,
});
const keys = createMockKeys(renderer);

createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <MicroscopeStage inputActive path={dbPath} />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 300));
await renderOnce();
let frame = captureCharFrame();
const hasPicker = /smoke-sess/.test(frame) && /smoke-app/.test(frame);

await keys.pressKeys(['RETURN']);
await new Promise((r) => setTimeout(r, 150));
await renderOnce();
frame = captureCharFrame();
console.log(frame);

const hasTimeline = /user/.test(frame) && /smoke hello|assistant|tool_use|Bash/.test(frame);
const hasError = /command not found|smoke-bin|ENOENT/.test(frame) || /#\d+/.test(frame);
const hasErrorBody = /command not found|smoke-bin/.test(frame);
const hasBorders = /[┌┐└┘─│]/.test(frame);

console.log(
  `\npicker:${hasPicker} timeline:${hasTimeline} error:${hasErrorBody} grain:${hasError} borders:${hasBorders}`,
);

renderer.destroy();
if (prevDb === undefined) delete process.env.SPECULUM_DB;
else process.env.SPECULUM_DB = prevDb;
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

const ok = hasPicker && hasTimeline && hasErrorBody && hasBorders;
process.exit(ok ? 0 : 1);
