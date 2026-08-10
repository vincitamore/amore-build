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
  budgetSessionSlots,
  budgetTurnSlots,
  formatEventTs,
  formatSessionInfo,
  formatSessionLine,
  formatSessionTitleLine,
  formatTurnLine,
  kindColor,
  MicroscopeStage,
  MIN_SESSION_SLOTS,
  MIN_TURN_SLOTS,
  paneGeometry,
  paneInnerWidth,
  PICKER_COL_WIDTH,
  projectBasename,
  relAge,
  rowText,
  sessionDisplayTitle,
  shortSessionId,
  STACK_BELOW_COLS,
} from './MicroscopeStage';
import type { SessionListRow, TurnRow } from './query-service';

/** Schema with sessions.title (v5) so title fixtures exercise the real read path. */
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

let tempRoot: string;
let goodDbPath: string;
let emptyDbPath: string;
let badVersionDbPath: string;
let errorEventId: number;
let destroy: (() => void) | undefined;

function baseSession(partial: Partial<SessionListRow> & { id: string }): SessionListRow {
  return {
    id: partial.id,
    projectPath: partial.projectPath ?? '/proj/microscope-demo',
    agent: partial.agent ?? 'primary',
    parentSession: partial.parentSession !== undefined ? partial.parentSession : null,
    modelId: partial.modelId !== undefined ? partial.modelId : 'm',
    startedAt: partial.startedAt ?? '2026-06-02T12:00:00.000Z',
    endedAt: partial.endedAt ?? '2026-06-02T13:00:00.000Z',
    turnCount: partial.turnCount ?? 3,
    userMsgCount: partial.userMsgCount ?? 1,
    toolCallCount: partial.toolCallCount ?? 2,
    toolErrorCount: partial.toolErrorCount ?? 1,
    eventCount: partial.eventCount ?? 4,
    title: partial.title ?? '',
  };
}

function seedGoodIndex(path: string): number {
  const db = new Database(path);
  let errId = 0;
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 5');

    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        'Repeat Previous Single Word Reply Request',
      ],
    );
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        '', // empty title → id fallback
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
    db.run('PRAGMA user_version = 5');
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

  test('formatSessionLine leads with title; id+age+counts secondary', () => {
    const now = new Date('2026-06-03T12:00:00.000Z').getTime();
    const titled = baseSession({
      id: 'sess-alpha',
      title: 'Repeat Previous Single Word Reply Request',
      turnCount: 3,
      eventCount: 4,
    });
    const line = formatSessionLine(titled, true, now);
    expect(line.startsWith('>')).toBe(true);
    expect(line.startsWith('>Repeat Previous')).toBe(true);
    expect(line).toMatch(/sess-alpha/);
    expect(line).toMatch(/t:3 e:4/);
    // title leads before the id secondary
    expect(line.indexOf('Repeat Previous')).toBeLessThan(line.indexOf('sess-alpha'));
  });

  test('formatSessionLine falls back to id prefix when title empty', () => {
    const now = new Date('2026-06-03T12:00:00.000Z').getTime();
    const bare = baseSession({ id: 'sess-beta', title: '' });
    const line = formatSessionLine(bare, false, now);
    expect(line.startsWith(' ')).toBe(true);
    expect(line).toMatch(/sess-beta/);
    expect(line).toMatch(/t:3 e:4/);
    // id appears once as the label (no title·id double)
    expect(line.match(/sess-beta/g)?.length).toBe(1);
  });

  test('sessionDisplayTitle / formatSessionTitleLine prefer title', () => {
    const titled = baseSession({ id: 'sess-alpha', title: '  Hello World  ' });
    expect(sessionDisplayTitle(titled)).toBe('Hello World');
    expect(formatSessionTitleLine(titled)).toBe('Hello World');
    const bare = baseSession({ id: 'sess-alpha-long-id-suffix', title: '' });
    expect(sessionDisplayTitle(bare)).toBe(shortSessionId(bare.id));
  });

  test('formatTurnLine includes selection prefix + grain', () => {
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

  test('paneGeometry two-pane at ≥100, stacked below; picker ~30–34', () => {
    expect(STACK_BELOW_COLS).toBe(100);
    const wide = paneGeometry(120);
    expect(wide.twoPane).toBe(true);
    expect(wide.pickerW).toBeGreaterThanOrEqual(30);
    expect(wide.pickerW).toBeLessThanOrEqual(34);
    expect(wide.pickerW).toBe(PICKER_COL_WIDTH);
    expect(wide.timelineW).toBe(wide.contentW - wide.pickerW - 1);
    expect(wide.contentW).toBe(120 - 8);

    const stacked = paneGeometry(90);
    expect(stacked.twoPane).toBe(false);
    expect(stacked.pickerW).toBe(stacked.contentW);
    expect(stacked.timelineW).toBe(stacked.contentW);

    const edge = paneGeometry(100);
    expect(edge.twoPane).toBe(true);

    // Card inner width = outer − 4
    expect(paneInnerWidth(32)).toBe(28);
  });

  test('budgetSessionSlots / budgetTurnSlots grow with height; floors hold at 80×24', () => {
    const s80 = budgetSessionSlots(24, false);
    const t80 = budgetTurnSlots(24, false, s80);
    expect(s80).toBeGreaterThanOrEqual(MIN_SESSION_SLOTS);
    expect(t80).toBeGreaterThanOrEqual(MIN_TURN_SLOTS);
    // stacked body (sess + info + turns) + chrome must fit 24
    expect(s80 + t80 + 2 /* info */ + 12 /* MICRO_CHROME_STACKED */).toBeLessThanOrEqual(24);

    const s120 = budgetSessionSlots(40, true);
    const t120 = budgetTurnSlots(40, true);
    expect(s120).toBeGreaterThan(s80);
    expect(t120).toBeGreaterThan(t80);
    expect(s120).toBe(40 - 11);
    expect(t120).toBe(40 - 11 - 2);
  });

  test('formatSessionInfo facts middot grammar; title lives on its own line', () => {
    const titled = baseSession({
      id: 'sess-alpha-long-id-suffix',
      title: 'Named Session',
      projectPath: '/proj/microscope-demo',
      modelId: 'model-x',
      startedAt: '2026-06-02T12:00:00.000Z',
      turnCount: 100,
      toolErrorCount: 3,
    });
    const now = new Date('2026-06-02T14:00:00.000Z').getTime();
    expect(formatSessionTitleLine(titled)).toBe('Named Session');
    const info = formatSessionInfo(titled, now);
    expect(info).toBe(
      `${shortSessionId(titled.id)} · microscope-demo · model-x · 2h ago · 100 turns · 3 errors`,
    );
    expect(info).toMatch(/·/);
    expect(info).not.toMatch(/\n/);

    const bare = baseSession({
      id: 'sess-beta',
      title: '',
      projectPath: '/proj/other',
      modelId: null,
      turnCount: 1,
      toolErrorCount: 0,
      startedAt: '2026-06-02T12:00:00.000Z',
    });
    // empty title: id is the title line; facts omit the doubled id
    expect(formatSessionInfo(bare, now)).toBe('other · 2h ago · 1 turns · 0 errors');
  });
});

describe('MicroscopeStage render', () => {
  test('two-pane at 120: picker titles + Sessions/Timeline chrome', async () => {
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

    // Title-first picker (session_summary title lands as the row label)
    expect(frame, `frame:\n${frame}`).toMatch(/Repeat Previous/);
    // Empty-title session falls back to id
    expect(frame).toMatch(/sess-beta/);
    // Card chrome (ALL-CAPS via Card)
    expect(frame).toMatch(/SESSIONS/);
    expect(frame).toMatch(/TIMELINE/);
    expect(frame).toMatch(/Microscope/);
    // Info header placeholder until a session is opened
    expect(frame).toMatch(/enter a session to open its timeline/i);
    // Footer two-pane-aware select path
    expect(frame).toMatch(/enter timeline/i);
  });

  test('stacked at 90: sessions still list; no side-by-side requirement', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 90,
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

    expect(paneGeometry(90).twoPane).toBe(false);
    expect(frame, `frame:\n${frame}`).toMatch(/Repeat Previous|sess-alpha/);
    expect(frame).toMatch(/SESSIONS/);
    expect(frame).toMatch(/enter a session to open its timeline/i);
  });

  test('Enter opens timeline with kind rows + title header + error grain', async () => {
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
    // Session-info: title first + facts (project / turns / errors)
    expect(frame).toMatch(/Repeat Previous/);
    expect(frame).toMatch(/microscope-demo/);
    expect(frame).toMatch(/\d+\s+turns/);
    expect(frame).toMatch(/\d+\s+errors/);
    // Picker remains visible in two-pane
    expect(frame).toMatch(/SESSIONS/);
    expect(frame).toMatch(/TIMELINE/);
    expect(frame).toMatch(/sess-beta/);
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

    expect(frame, `frame:\n${frame}`).toMatch(/sess-alpha|Repeat Previous/);
    expect(frame).toMatch(/ENOENT/);
    expect(frame).toMatch(new RegExp(`#${errorEventId}`));
    // Session-info header shows opened session title + project
    expect(frame).toMatch(/microscope-demo/);
    expect(frame).toMatch(/\d+\s+turns/);
  });

  test('jump consume-once: same jumpKey does not re-open after land', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 34,
    });
    destroy = () => renderer.destroy();
    const keys = createMockKeys(renderer);
    const root = createRoot(renderer);

    const jump = { sessionId: 'sess-alpha', eventId: errorEventId };
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, {
          inputActive: true,
          path: goodDbPath,
          jump,
          jumpKey: 1,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(new RegExp(`#${errorEventId}`));

    // Leave timeline focus, move picker cursor down toward sess-beta
    await keys.pressKeys(['ESCAPE']);
    await keys.pressKeys(['ARROW_DOWN']);
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();

    // Re-render with the SAME jumpKey — must not re-fire openTimeline
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(MicroscopeStage, {
          inputActive: true,
          path: goodDbPath,
          jump,
          jumpKey: 1,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    frame = captureCharFrame();
    // Still on two-pane with both sessions; jump did not flash a re-open
    expect(frame, `frame:\n${frame}`).toMatch(/sess-beta/);
    expect(frame).toMatch(/sess-alpha|Repeat Previous/);
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
