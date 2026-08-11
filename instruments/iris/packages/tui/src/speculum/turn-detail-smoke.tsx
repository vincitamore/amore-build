// Headless smoke for TurnDetail against a synthetic SPECULUM_DB index.
// Run: bun run src/speculum/turn-detail-smoke.tsx
// Size override: SMOKE_W / SMOKE_H (defaults 80×24). Asserts 80×24 + 120×40 + 60×16.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { TurnDetail, budgetDetailLines } from './TurnDetail';

const W = Number(process.env.SMOKE_W ?? 80);
const H = Number(process.env.SMOKE_H ?? 24);

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
  tool_error_count INTEGER NOT NULL,
  title            TEXT NOT NULL DEFAULT ''
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

const tmp = mkdtempSync(join(tmpdir(), 'turn-detail-smoke-'));
const dbPath = join(tmp, 'speculum.sqlite');
mkdirSync(tmp, { recursive: true });

let toolEventId = 0;
let userEventId = 0;

function seed(): void {
  const db = new Database(dbPath);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 5');
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
       ) VALUES (
         'smoke-td', '/proj/smoke-app', 'primary', NULL, 'model-s',
         '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 2, 1, 1, 0,
         'Smoke Turn Detail Title'
       )`,
    );
    const insert = (
      ts: string,
      kind: string,
      text: string,
      toolName: string | null,
      toolInput: string | null,
      toolOutput: string | null,
      toolError: number | null,
    ): number => {
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES (
           'smoke-td', '/proj/smoke-app', 'primary', NULL, ?, ?,
           ?, ?, ?, ?, ?, NULL, 0, 0, ?
         )`,
        [
          ts,
          kind,
          text,
          toolName,
          toolInput,
          toolOutput,
          toolError,
          JSON.stringify({ text }),
        ],
      );
      const id = Number(
        db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id,
      );
      db.run(
        `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         VALUES (?, ?, ?, ?, ?)`,
        [id, text, toolName, toolInput, toolOutput],
      );
      return id;
    };
    userEventId = insert(
      '2026-06-02T12:00:00.000Z',
      'user',
      'smoke turn body asks about /home/op/proj/config.json',
      null,
      null,
      null,
      null,
    );
    toolEventId = insert(
      '2026-06-02T12:01:00.000Z',
      'tool_use',
      'reading config',
      'Read',
      '{"path":"/home/op/proj/config.json"}',
      '',
      0,
    );
  } finally {
    db.close();
  }
}

seed();

type FrameCheck = {
  label: string;
  width: number;
  height: number;
  frame: string;
  hasHeader: boolean;
  hasBody: boolean;
  hasTitle: boolean;
  hasCard: boolean;
  slotsOk: boolean;
};

async function runAt(
  width: number,
  height: number,
  eventId: number,
): Promise<FrameCheck> {
  const r = await createTestRenderer({ width, height });
  createRoot(r.renderer).render(
    <ThemeProvider initial="horizon">
      <TurnDetail
        visible
        eventId={eventId}
        sessionTitle="Smoke Turn Detail Title"
        inputActive
        onClose={() => {}}
        onStep={() => {}}
        path={dbPath}
        width={width}
        height={height}
      />
    </ThemeProvider>,
  );
  await new Promise((res) => setTimeout(res, 200));
  await r.renderOnce();
  const frame = r.captureCharFrame();
  const slots = budgetDetailLines(height);
  const hasHeader = new RegExp(`#${eventId}`).test(frame) && /user|tool_use|assistant|Read/.test(frame);
  const hasBody =
    /smoke turn body|reading config|tool input|config\.json|path/.test(frame);
  const hasTitle = /Smoke Turn Detail Title/.test(frame);
  const hasCard = /TURN/i.test(frame) || /[┌┐└┘─│╭╮╰╯]/.test(frame);
  const slotsOk = slots >= 0 && slots <= Math.max(0, height - 3);

  r.renderer.destroy();
  return {
    label: `${width}×${height}`,
    width,
    height,
    frame,
    hasHeader,
    hasBody,
    hasTitle,
    hasCard,
    slotsOk,
  };
}

// ── Pass 1: default / operator-ish 80×24 ────────────────────────────────────
const mid = await runAt(W >= 60 ? W : 80, H >= 16 ? H : 24, userEventId);
console.log(`── ${mid.label} (user turn) ──`);
console.log(mid.frame);

// ── Pass 2: wide 120×40 ─────────────────────────────────────────────────────
const wide = await runAt(120, 40, toolEventId);
console.log(`\n── ${wide.label} (tool turn) ──`);
console.log(wide.frame);

// ── Pass 3: tight 60×16 ─────────────────────────────────────────────────────
const tight = await runAt(60, 16, userEventId);
console.log(`\n── ${tight.label} (user turn) ──`);
console.log(tight.frame);

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

function okCheck(c: FrameCheck): boolean {
  return c.hasHeader && c.hasBody && c.hasTitle && c.hasCard && c.slotsOk;
}

const results = [
  ['mid', okCheck(mid), mid],
  ['wide', okCheck(wide), wide],
  ['tight', okCheck(tight), tight],
] as const;

for (const [name, ok, c] of results) {
  console.log(
    `${name}: ok=${ok} header:${c.hasHeader} body:${c.hasBody} title:${c.hasTitle} card:${c.hasCard} slots:${c.slotsOk} budget=${budgetDetailLines(c.height)}`,
  );
}

const ok = results.every(([, pass]) => pass);
process.exit(ok ? 0 : 1);
