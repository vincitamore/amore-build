// Headless smoke for MicroscopeStage against a synthetic SPECULUM_DB index.
// Run: bun run src/speculum/microscope-smoke.tsx
// Size override: SMOKE_W / SMOKE_H (defaults 120×40). Asserts 80×24 + 120×40.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { MicroscopeStage, paneGeometry } from './MicroscopeStage';

const W = Number(process.env.SMOKE_W ?? 120);
const H = Number(process.env.SMOKE_H ?? 40);

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

const tmp = mkdtempSync(join(tmpdir(), 'micro-smoke-'));
const dbPath = join(tmp, 'speculum.sqlite');
mkdirSync(tmp, { recursive: true });

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
         'smoke-sess', '/proj/smoke-app', 'primary', NULL, 'model-s',
         '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 2, 1, 1, 1,
         'Smoke Session Title'
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

type FrameCheck = {
  label: string;
  width: number;
  height: number;
  frame: string;
  hasPicker: boolean;
  hasTitle: boolean;
  hasSessionsLabel: boolean;
  hasTimelineLabel: boolean;
  hasTimeline: boolean;
  hasErrorBody: boolean;
  hasError: boolean;
  hasBorders: boolean;
  hasInfoHeader: boolean;
  hasFooter: boolean;
  hasTwoPane: boolean;
  hasStacked: boolean;
};

async function runAt(width: number, height: number, openTimeline: boolean): Promise<FrameCheck> {
  const r = await createTestRenderer({ width, height });
  const keys = createMockKeys(r.renderer);
  createRoot(r.renderer).render(
    <ThemeProvider initial="horizon">
      <MicroscopeStage inputActive path={dbPath} />
    </ThemeProvider>,
  );
  await new Promise((res) => setTimeout(res, 300));
  await r.renderOnce();
  let frame = r.captureCharFrame();

  if (openTimeline) {
    await keys.pressKeys(['RETURN']);
    await new Promise((res) => setTimeout(res, 150));
    await r.renderOnce();
    frame = r.captureCharFrame();
  }

  const geo = paneGeometry(width);
  const hasPicker = /smoke-sess|Smoke Session/.test(frame);
  const hasTitle = /Smoke Session/.test(frame);
  const hasSessionsLabel = /SESSIONS/.test(frame);
  const hasTimelineLabel = /TIMELINE/.test(frame);
  const hasTimeline =
    openTimeline && /user/.test(frame) && /smoke hello|assistant|tool_use|Bash/.test(frame);
  // Error grain: full "command not found: smoke-bin" may head-slice on a tight timeline
  // (picker ≥48 leaves residual body room for the kind column + #id first).
  const hasError = /command not found|smoke-bin|ENOENT|Bash:|tool_result/.test(frame) || /#\d+/.test(frame);
  const hasErrorBody = /command not found|smoke-bin|Bash:|ENOENT|tool_result/.test(frame);
  const hasBorders = /[┌┐└┘─│╭╮╰╯]/.test(frame);
  // Facts line may head-slice the trailing "N errors" under a wide picker + tight timeline.
  const hasInfoHeader = openTimeline
    ? /Smoke Session|smoke-sess/.test(frame) &&
      /smoke-app/.test(frame) &&
      (/\d+\s+turns/.test(frame) || /\d+\s+errors/.test(frame) || /model-s/.test(frame))
    : /enter a session to open its timeline/i.test(frame);
  const hasFooter = /enter timeline|j\/k|refresh/i.test(frame);
  const hasTwoPane =
    !geo.twoPane || (hasSessionsLabel && hasPicker && (!openTimeline || hasTimeline) && hasInfoHeader);
  const hasStacked = geo.twoPane || (hasSessionsLabel && hasPicker && hasInfoHeader);

  r.renderer.destroy();
  return {
    label: `${width}×${height}${openTimeline ? ' open' : ' idle'}`,
    width,
    height,
    frame,
    hasPicker,
    hasTitle,
    hasSessionsLabel,
    hasTimelineLabel,
    hasTimeline: openTimeline ? hasTimeline : true,
    hasErrorBody: openTimeline ? hasErrorBody : true,
    hasError: openTimeline ? hasError : true,
    hasBorders,
    hasInfoHeader,
    hasFooter,
    hasTwoPane,
    hasStacked,
  };
}

// ── Pass 1: wide two-pane 120×40 (operator on-device size) ───────────────────
const wideOpen = await runAt(W >= 100 ? W : 120, H >= 34 ? H : 40, true);
console.log(`── ${wideOpen.label} ──`);
console.log(wideOpen.frame);

// ── Pass 2: narrow stacked 80×24 (operator on-device size) ───────────────────
const narrowIdle = await runAt(80, 24, false);
console.log(`\n── ${narrowIdle.label} ──`);
console.log(narrowIdle.frame);

const narrowOpen = await runAt(80, 24, true);
console.log(`\n── ${narrowOpen.label} ──`);
console.log(narrowOpen.frame);

// ── Pass 3: wide idle (chrome + empty prompt, no double copy) ───────────────
const wideIdle = await runAt(120, 40, false);
console.log(`\n── ${wideIdle.label} ──`);
console.log(wideIdle.frame);

if (prevDb === undefined) delete process.env.SPECULUM_DB;
else process.env.SPECULUM_DB = prevDb;
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

function okCheck(c: FrameCheck, requireOpen: boolean): boolean {
  return (
    c.hasPicker &&
    c.hasTitle &&
    c.hasSessionsLabel &&
    c.hasTimelineLabel &&
    c.hasBorders &&
    c.hasInfoHeader &&
    c.hasFooter &&
    c.hasTwoPane &&
    c.hasStacked &&
    (!requireOpen || (c.hasTimeline && c.hasErrorBody && c.hasError))
  );
}

const results = [
  ['wideOpen', okCheck(wideOpen, true), wideOpen],
  ['wideIdle', okCheck(wideIdle, false), wideIdle],
  ['narrowIdle', okCheck(narrowIdle, false), narrowIdle],
  ['narrowOpen', okCheck(narrowOpen, true), narrowOpen],
] as const;

for (const [name, ok, c] of results) {
  console.log(
    `${name}: ok=${ok} picker:${c.hasPicker} title:${c.hasTitle} SESSIONS:${c.hasSessionsLabel} TIMELINE:${c.hasTimelineLabel} timeline:${c.hasTimeline} info:${c.hasInfoHeader} footer:${c.hasFooter} twoPane:${c.hasTwoPane} error:${c.hasErrorBody} grain:${c.hasError} borders:${c.hasBorders}`,
  );
}

const ok = results.every(([, pass]) => pass);
process.exit(ok ? 0 : 1);
