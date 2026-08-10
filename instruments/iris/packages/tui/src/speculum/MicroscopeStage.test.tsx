import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { toPalette } from '../theme';
import {
  formatEventTs,
  formatSessionLine,
  formatTurnLine,
  kindColor,
  MicroscopeStage,
  projectBasename,
  relAge,
  rowText,
} from './MicroscopeStage';
import type { SessionListRow, TurnRow } from './query-service';

/** Minimal schema matching tables the query-service reads (version 4). */
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

let tempRoot: string;
let goodDbPath: string;
let emptyDbPath: string;
let badVersionDbPath: string;
let errorEventId: number;
let destroy: (() => void) | undefined;

function seedGoodIndex(path: string): number {
  const db = new Database(path);
  let errId = 0;
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 4');

    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess-alpha',
        '/proj/microscope-demo',
        'primary',
        null,
        'model-x',
        '2026-06-02T12:00:00.000Z',
        '2026-06-02T13:00:00.000Z',
        3,
        1,
        2,
        1,
      ],
    );
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess-beta',
        '/proj/other',
        'primary',
        null,
        'model-y',
        '2026-06-01T08:00:00.000Z',
        '2026-06-01T09:00:00.000Z',
        1,
        1,
        0,
        0,
      ],
    );

    const insertEvent = (
      sessionId: string,
      ts: string,
      kind: string,
      text: string,
      toolName: string | null = null,
      toolError: number | null = null,
    ): number => {
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES (?, ?, 'primary', NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0, ?)`,
        [
          sessionId,
          '/proj/microscope-demo',
          ts,
          kind,
          text,
          toolName,
          toolError,
          JSON.stringify({ text }),
        ],
      );
      const id = Number(
        db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id,
      );
      db.run(
        `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         VALUES (?, ?, ?, NULL, NULL)`,
        [id, text, toolName],
      );
      return id;
    };

    insertEvent('sess-alpha', '2026-06-02T12:00:00.000Z', 'user', 'hello from operator');
    insertEvent(
      'sess-alpha',
      '2026-06-02T12:01:00.000Z',
      'assistant',
      'looking at the path resolution',
    );
    insertEvent('sess-alpha', '2026-06-02T12:02:00.000Z', 'tool_use', '', 'Read', 0);
    errId = insertEvent(
      'sess-alpha',
      '2026-06-02T12:03:00.000Z',
      'tool_result',
      'ENOENT: no such file or directory',
      'Read',
      1,
    );
    insertEvent('sess-beta', '2026-06-01T08:30:00.000Z', 'user', 'unrelated weather chat');

    db.run(
      `INSERT INTO ingest_state (
         file_path, size_bytes, mtime, byte_offset, last_ingested, forgotten
       ) VALUES ('/sessions/a.jsonl', 100, '2026-06-02T12:00:00.000Z', 100, '2026-06-02T13:30:00.000Z', 0)`,
    );
  } finally {
    db.close();
  }
  return errId;
}

function seedEmptyIndex(path: string): void {
  const db = new Database(path);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 4');
  } finally {
    db.close();
  }
}

function seedBadVersionIndex(path: string): void {
  const db = new Database(path);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 99');
  } finally {
    db.close();
  }
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'micro-si09-'));
  goodDbPath = join(tempRoot, 'good', 'speculum.sqlite');
  emptyDbPath = join(tempRoot, 'empty', 'speculum.sqlite');
  badVersionDbPath = join(tempRoot, 'bad-ver', 'speculum.sqlite');
  mkdirSync(join(tempRoot, 'good'), { recursive: true });
  mkdirSync(join(tempRoot, 'empty'), { recursive: true });
  mkdirSync(join(tempRoot, 'bad-ver'), { recursive: true });
  errorEventId = seedGoodIndex(goodDbPath);
  seedEmptyIndex(emptyDbPath);
  seedBadVersionIndex(badVersionDbPath);
});

afterAll(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

afterEach(() => {
  destroy?.();
  destroy = undefined;
});

describe('Microscope pure helpers', () => {
  test('relAge coarsens to m/h/d', () => {
    const now = new Date('2026-06-02T14:00:00.000Z').getTime();
    expect(relAge('2026-06-02T13:30:00.000Z', now)).toBe('30m ago');
    expect(relAge('2026-06-02T11:00:00.000Z', now)).toBe('3h ago');
    expect(relAge('2026-05-30T14:00:00.000Z', now)).toBe('3d ago');
    expect(relAge('not-a-date', now)).toBe('?');
  });

  test('formatEventTs is HH:MM UTC', () => {
    expect(formatEventTs('2026-06-02T12:03:00.000Z')).toBe('12:03');
    expect(formatEventTs('bad')).toBe('--:--');
  });

  test('projectBasename handles slash styles', () => {
    expect(projectBasename('/proj/microscope-demo')).toBe('microscope-demo');
    expect(projectBasename('C:\\proj\\other')).toBe('other');
    expect(projectBasename('')).toBe('?');
  });

  test('kindColor maps kinds to semantic palette slots', () => {
    const p = toPalette('horizon');
    expect(kindColor('user', p)).toBe(p.primary);
    expect(kindColor('assistant', p)).toBe(p.foreground);
    expect(kindColor('tool_use', p)).toBe(p.info);
    expect(kindColor('tool_result', p)).toBe(p.muted);
    expect(kindColor('tool_result', p, 1)).toBe(p.error);
    expect(kindColor('tool_error', p)).toBe(p.error);
    expect(kindColor('system', p)).toBe(p.muted);
    expect(kindColor('usage', p)).toBe(p.info);
    expect(kindColor('plan', p)).toBe(p.info);
    expect(kindColor('task', p)).toBe(p.info);
  });

  test('rowText summarizes user/tool/error rows', () => {
    const user: TurnRow = {
      eventId: 1,
      kind: 'user',
      ts: '2026-06-02T12:00:00.000Z',
      text: 'hello   world',
      toolName: null,
      toolError: null,
    };
    expect(rowText(user)).toBe('hello world');

    const tool: TurnRow = {
      eventId: 2,
      kind: 'tool_use',
      ts: '2026-06-02T12:02:00.000Z',
      text: '',
      toolName: 'Read',
      toolError: 0,
    };
    expect(rowText(tool)).toBe('Read');

    const err: TurnRow = {
      eventId: 3,
      kind: 'tool_result',
      ts: '2026-06-02T12:03:00.000Z',
      text: 'ENOENT: no such file',
      toolName: 'Read',
      toolError: 1,
    };
    expect(rowText(err)).toMatch(/Read.*ENOENT/);
  });

  test('formatSessionLine / formatTurnLine include selection prefix + grain', () => {
    const s: SessionListRow = {
      id: 'sess-alpha',
      projectPath: '/proj/microscope-demo',
      agent: 'primary',
      parentSession: null,
      modelId: 'm',
      startedAt: '2026-06-02T12:00:00.000Z',
      endedAt: '2026-06-02T13:00:00.000Z',
      turnCount: 3,
      userMsgCount: 1,
      toolCallCount: 2,
      toolErrorCount: 1,
      eventCount: 4,
    };
    const line = formatSessionLine(s, true, new Date('2026-06-03T12:00:00.000Z').getTime());
    expect(line.startsWith('>')).toBe(true);
    expect(line).toMatch(/sess-alpha/);
    expect(line).toMatch(/t:3 e:4/);
    expect(line).toMatch(/microscope-demo/);

    const turn: TurnRow = {
      eventId: 42,
      kind: 'user',
      ts: '2026-06-02T12:00:00.000Z',
      text: 'hi',
      toolName: null,
      toolError: null,
    };
    const tline = formatTurnLine(turn, false);
    expect(tline).toMatch(/12:00/);
    expect(tline).toMatch(/user/);
    expect(tline).toMatch(/#42/);
  });
});

describe('MicroscopeStage render', () => {
  test('picker rows render session ids + project basename', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 34,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, { inputActive: true, path: goodDbPath }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/sess-alpha/);
    expect(frame).toMatch(/sess-beta/);
    expect(frame).toMatch(/microscope-demo|other/);
    expect(frame).toMatch(/sessions/i);
  });

  test('Enter opens timeline with kind rows + error event marked', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 34,
    });
    destroy = () => renderer.destroy();
    const keys = createMockKeys(renderer);
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, { inputActive: true, path: goodDbPath }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    await keys.pressKeys(['RETURN']);
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/user/);
    expect(frame).toMatch(/assistant|tool_use|tool_result|Read/);
    // Error row: toolError=1 surfaces ENOENT tail + event id grain
    expect(frame).toMatch(/ENOENT/);
    expect(frame).toMatch(new RegExp(`#${errorEventId}`));
  });

  test('jump prop jumpKey change selects + opens + highlights eventId', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 34,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);

    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, {
          inputActive: true,
          path: goodDbPath,
          jump: null,
          jumpKey: 0,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();

    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, {
          inputActive: true,
          path: goodDbPath,
          jump: { sessionId: 'sess-alpha', eventId: errorEventId },
          jumpKey: 1,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/sess-alpha/);
    expect(frame).toMatch(/ENOENT/);
    expect(frame).toMatch(new RegExp(`#${errorEventId}`));
    // Timeline section header shows the opened session
    expect(frame).toMatch(/timeline\s+sess-alpha/i);
  });

  test('schema-mismatch fixture renders honest version banner', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 28,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, { inputActive: true, path: badVersionDbPath }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/index at version 99/);
    expect(frame).toMatch(/this build supports 4/);
  });

  test('empty corpus renders ingest copy', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 28,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, { inputActive: true, path: emptyDbPath }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/no ingested sessions|speculum ingest/);
  });

  test('missing index path renders install/ingest copy without crash', async () => {
    const missing = join(tempRoot, 'no-such', 'speculum.sqlite');
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 24,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, { inputActive: true, path: missing }),
      ),
    );

    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/no speculum index|speculum ingest/);
  });
});
