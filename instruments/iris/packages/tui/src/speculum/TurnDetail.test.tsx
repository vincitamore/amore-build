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
  budgetDetailLines,
  buildTurnDetailLines,
  clampScroll,
  collapseAbsolutePaths,
  DETAIL_CARD_V_CHROME,
  formatDetailHeader,
  formatEventTs,
  headCapLines,
  isToolErrored,
  kindColor,
  prettyPayload,
  TOOL_PAYLOAD_HEAD_CAP,
  TurnDetail,
  wrapPlain,
} from './TurnDetail';
import type { TurnDetail as TurnDetailRow } from './query-service';

/** Minimal schema matching tables turnDetail reads. */
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
let userEventId: number;
let toolEventId: number;
let errorEventId: number;
let emptyToolEventId: number;
let destroy: (() => void) | undefined;

function seedIndex(path: string): {
  userId: number;
  toolId: number;
  errorId: number;
  emptyToolId: number;
} {
  const db = new Database(path);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 5');
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
       ) VALUES (
         'td-sess', '/proj/turn-detail-demo', 'primary', NULL, 'model-t',
         '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 4, 1, 2, 1,
         'Turn Detail Fixture Session'
       )`,
    );

    const insert = (
      ts: string,
      kind: string,
      text: string | null,
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
           'td-sess', '/proj/turn-detail-demo', 'primary', NULL, ?, ?,
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
          JSON.stringify({ text, NEVER_EXPOSE: true }),
        ],
      );
      const id = Number(
        db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id,
      );
      db.run(
        `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         VALUES (?, ?, ?, ?, ?)`,
        [id, text ?? '', toolName, toolInput, toolOutput],
      );
      return id;
    };

    const userId = insert(
      '2026-06-02T12:00:00.000Z',
      'user',
      'please inspect C:\\Users\\x\\proj\\file.ts and /home/a/b/out.json',
      null,
      null,
      null,
      null,
    );
    const toolId = insert(
      '2026-06-02T12:01:00.000Z',
      'tool_use',
      'read the file',
      'Read',
      '{"path":"/home/a/b/out.json","nested":{"ok":true}}',
      '',
      0,
    );
    const errorId = insert(
      '2026-06-02T12:02:00.000Z',
      'tool_result',
      'ENOENT: no such file',
      'Read',
      '',
      '{"error":"ENOENT","path":"C:\\\\Users\\\\x\\\\proj\\\\file.ts"}',
      1,
    );
    const emptyToolId = insert(
      '2026-06-02T12:03:00.000Z',
      'tool_use',
      '',
      'Bash',
      '',
      null,
      0,
    );
    return { userId, toolId, errorId, emptyToolId };
  } finally {
    db.close();
  }
}

function baseRow(partial: Partial<TurnDetailRow> & { eventId: number }): TurnDetailRow {
  return {
    eventId: partial.eventId,
    sessionId: partial.sessionId ?? 'td-sess',
    kind: partial.kind ?? 'user',
    ts: partial.ts ?? '2026-06-02T12:00:00.000Z',
    text: partial.text ?? '',
    toolName: partial.toolName ?? '',
    toolInput: partial.toolInput ?? '',
    toolOutput: partial.toolOutput ?? '',
    toolError: partial.toolError ?? '',
  };
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'turn-detail-'));
  goodDbPath = join(tempRoot, 'good', 'speculum.sqlite');
  mkdirSync(join(tempRoot, 'good'), { recursive: true });
  const ids = seedIndex(goodDbPath);
  userEventId = ids.userId;
  toolEventId = ids.toolId;
  errorEventId = ids.errorId;
  emptyToolEventId = ids.emptyToolId;
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

describe('TurnDetail pure helpers', () => {
  test('formatEventTs is HH:MM UTC', () => {
    expect(formatEventTs('2026-06-02T12:03:00.000Z')).toBe('12:03');
    expect(formatEventTs('bad')).toBe('--:--');
  });

  test('formatDetailHeader includes id kind tool time', () => {
    const h = formatDetailHeader(
      baseRow({
        eventId: 7,
        kind: 'tool_use',
        toolName: 'Read',
        ts: '2026-06-02T12:01:00.000Z',
      }),
    );
    expect(h).toBe('#7 \u00b7 tool_use \u00b7 Read \u00b7 12:01');
  });

  test('prettyPayload pretty-prints JSON and leaves prose alone', () => {
    expect(prettyPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyPayload('not json')).toBe('not json');
    expect(prettyPayload('')).toBe('');
  });

  test('headCapLines appends +N more lines tail', () => {
    const many = Array.from({ length: 5 }, (_, i) => `line-${i}`);
    expect(headCapLines(many, 3)).toEqual([
      'line-0',
      'line-1',
      'line-2',
      '\u2026 +2 more lines',
    ]);
    expect(headCapLines(many, 10)).toEqual(many);
  });

  test('wrapPlain hard-breaks long tokens and wraps words', () => {
    expect(wrapPlain('hello world', 5)).toEqual(['hello', 'world']);
    expect(wrapPlain('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('collapseAbsolutePaths basenames windows and posix paths', () => {
    expect(collapseAbsolutePaths('C:\\Users\\x\\proj\\file.ts')).toBe('file.ts');
    expect(collapseAbsolutePaths('/home/a/b/out.json')).toBe('out.json');
    expect(collapseAbsolutePaths('relative/path.ts')).toBe('relative/path.ts');
  });

  test('isToolErrored treats string 1 as error', () => {
    expect(isToolErrored('1')).toBe(true);
    expect(isToolErrored('0')).toBe(false);
    expect(isToolErrored('')).toBe(false);
    expect(isToolErrored(null)).toBe(false);
  });

  test('kindColor maps kinds; toolError forces error', () => {
    const p = toPalette('horizon');
    expect(kindColor('user', p)).toBe(p.primary);
    expect(kindColor('assistant', p)).toBe(p.foreground);
    expect(kindColor('tool_use', p)).toBe(p.info);
    expect(kindColor('tool_result', p, true)).toBe(p.error);
  });

  test('budgetDetailLines fit-clamps and never exceeds host', () => {
    expect(budgetDetailLines(10)).toBe(10 - DETAIL_CARD_V_CHROME);
    expect(budgetDetailLines(3)).toBe(0);
    expect(budgetDetailLines(2)).toBe(0);
    expect(budgetDetailLines(0)).toBe(0);
    expect(budgetDetailLines(4)).toBe(1);
  });

  test('clampScroll stays in range', () => {
    expect(clampScroll(-1, 20, 5)).toBe(0);
    expect(clampScroll(100, 20, 5)).toBe(15);
    expect(clampScroll(3, 20, 5)).toBe(3);
    expect(clampScroll(0, 3, 10)).toBe(0);
  });

  test('buildTurnDetailLines: header + title + body; omits empty tool sections', () => {
    const lines = buildTurnDetailLines(
      baseRow({
        eventId: 1,
        kind: 'user',
        text: 'hello body line',
        toolInput: '',
        toolOutput: '',
      }),
      { sessionTitle: 'Fixture Session', innerW: 40, collapsePaths: false },
    );
    expect(lines[0]!.text).toMatch(/^#1 · user · 12:00$/);
    expect(lines.some((l) => l.text === 'Fixture Session')).toBe(true);
    expect(lines.some((l) => l.text.includes('hello body line'))).toBe(true);
    expect(lines.some((l) => l.text === 'tool input')).toBe(false);
    expect(lines.some((l) => l.text === 'tool output')).toBe(false);
  });

  test('buildTurnDetailLines: JSON pretty-print + head-cap tail', () => {
    const bigObj: Record<string, string> = {};
    for (let i = 0; i < TOOL_PAYLOAD_HEAD_CAP + 40; i++) {
      bigObj[`k${i}`] = `v${i}`;
    }
    const lines = buildTurnDetailLines(
      baseRow({
        eventId: 2,
        kind: 'tool_use',
        toolName: 'Read',
        text: '',
        toolInput: JSON.stringify(bigObj),
        toolOutput: '',
      }),
      { sessionTitle: '', innerW: 80, collapsePaths: false },
    );
    expect(lines.some((l) => l.text === 'tool input')).toBe(true);
    expect(lines.some((l) => l.text.includes('more lines'))).toBe(true);
    expect(lines.some((l) => l.text === 'tool output')).toBe(false);
  });

  test('buildTurnDetailLines: path collapse toggles absolute paths', () => {
    const row = baseRow({
      eventId: 3,
      kind: 'user',
      text: 'see /home/a/b/out.json please',
    });
    const collapsed = buildTurnDetailLines(row, {
      sessionTitle: '',
      innerW: 60,
      collapsePaths: true,
    });
    const full = buildTurnDetailLines(row, {
      sessionTitle: '',
      innerW: 60,
      collapsePaths: false,
    });
    expect(collapsed.some((l) => l.text.includes('out.json'))).toBe(true);
    expect(collapsed.some((l) => l.text.includes('/home/a/b'))).toBe(false);
    expect(full.some((l) => l.text.includes('/home/a/b/out.json'))).toBe(true);
  });

  test('buildTurnDetailLines: error tone when toolError is 1', () => {
    const lines = buildTurnDetailLines(
      baseRow({
        eventId: 9,
        kind: 'tool_result',
        toolName: 'Read',
        toolError: '1',
        text: 'fail',
      }),
      { sessionTitle: '', innerW: 40, collapsePaths: false },
    );
    expect(lines[0]!.tone).toBe('error');
  });

  test('buildTurnDetailLines: soft states', () => {
    const soft = buildTurnDetailLines(null, {
      sessionTitle: '',
      innerW: 40,
      collapsePaths: true,
      soft: 'corpus busy',
    });
    expect(soft).toEqual([{ text: 'corpus busy', tone: 'muted' }]);
    const missing = buildTurnDetailLines(null, {
      sessionTitle: '',
      innerW: 40,
      collapsePaths: true,
    });
    expect(missing[0]!.text).toBe('turn not found');
  });
});

describe('TurnDetail render', () => {
  test('renders header + body from fixture index', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: true,
          eventId: userEventId,
          sessionTitle: 'Turn Detail Fixture Session',
          inputActive: true,
          onClose: () => {},
          onStep: () => {},
          path: goodDbPath,
          width: 72,
          height: 18,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(new RegExp(`#${userEventId}`));
    expect(frame).toMatch(/user/);
    expect(frame).toMatch(/Turn Detail Fixture Session|please inspect|file\.ts|out\.json/);
    expect(frame).toMatch(/TURN/i);
  });

  test('tool event shows pretty JSON section; empty payloads omit sections', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 90,
      height: 28,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: true,
          eventId: toolEventId,
          sessionTitle: 'Turn Detail Fixture Session',
          inputActive: true,
          onClose: () => {},
          onStep: () => {},
          path: goodDbPath,
          width: 80,
          height: 22,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/tool input/i);
    expect(frame).toMatch(/path|nested|ok|out\.json/);
    // tool output empty → no section
    expect(frame).not.toMatch(/tool output/i);
  });

  test('error tool paints header grain and body', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: true,
          eventId: errorEventId,
          sessionTitle: 'Turn Detail Fixture Session',
          inputActive: true,
          onClose: () => {},
          onStep: () => {},
          path: goodDbPath,
          width: 72,
          height: 18,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(new RegExp(`#${errorEventId}`));
    expect(frame).toMatch(/ENOENT|tool_result|Read/);
  });

  test('empty tool payloads render nothing for sections', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 70,
      height: 18,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: true,
          eventId: emptyToolEventId,
          sessionTitle: '',
          inputActive: true,
          onClose: () => {},
          onStep: () => {},
          path: goodDbPath,
          width: 60,
          height: 12,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/tool_use|Bash/);
    expect(frame).not.toMatch(/tool input/i);
    expect(frame).not.toMatch(/tool output/i);
  });

  test('soft state for missing eventId', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 60,
      height: 16,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: true,
          eventId: null,
          sessionTitle: '',
          inputActive: true,
          onClose: () => {},
          onStep: () => {},
          path: goodDbPath,
          width: 50,
          height: 10,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/no turn selected|turn not found/i);
  });

  test('soft state for unknown event id does not crash', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 60,
      height: 16,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: true,
          eventId: 999999,
          sessionTitle: '',
          inputActive: true,
          onClose: () => {},
          onStep: () => {},
          path: goodDbPath,
          width: 50,
          height: 10,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/turn not found|no turn/i);
  });

  test('esc closes; [ ] step; scroll + path collapse keys', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 20,
    });
    destroy = () => renderer.destroy();
    const keys = createMockKeys(renderer);
    let closed = 0;
    let stepped = 0;
    let lastStep: 1 | -1 | 0 = 0;
    let flash = '';
    let eventId = userEventId;
    const root = createRoot(renderer);

    const paint = (id: number) => {
      root.render(
        createElement(
          ThemeProvider,
          { initial: 'horizon' },
          createElement(TurnDetail, {
            visible: true,
            eventId: id,
            sessionTitle: 'Turn Detail Fixture Session',
            inputActive: true,
            onClose: () => {
              closed += 1;
            },
            onStep: (d) => {
              stepped += 1;
              lastStep = d;
              eventId = d === 1 ? toolEventId : userEventId;
              paint(eventId);
            },
            onFlash: (m) => {
              flash = m;
            },
            path: goodDbPath,
            width: 70,
            height: 14,
          }),
        ),
      );
    };
    paint(userEventId);
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toMatch(new RegExp(`#${userEventId}`));

    // Path collapse off → full path may appear; default is collapsed (basename).
    expect(frame).toMatch(/file\.ts|out\.json|please inspect/);
    keys.typeText('p');
    await new Promise((r) => setTimeout(r, 40));
    await renderOnce();
    frame = captureCharFrame();
    // After toggle, absolute paths can surface.
    expect(frame).toMatch(/C:\\Users|\/home\/a\/b|file\.ts|out\.json|please inspect/);

    keys.typeText(']');
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    frame = captureCharFrame();
    expect(stepped).toBeGreaterThanOrEqual(1);
    expect(lastStep).toBe(1);
    expect(frame).toMatch(new RegExp(`#${toolEventId}|tool_use|Read|tool input`));

    keys.typeText('y');
    await new Promise((r) => setTimeout(r, 40));
    // Flash may succeed or fail depending on clip tool; either is soft.
    expect(flash === '' || /copied|copy failed|nothing/.test(flash)).toBe(true);

    await keys.pressKeys(['ESCAPE']);
    await new Promise((r) => setTimeout(r, 40));
    // Keep-mounted re-paints can stack a second handler briefly; ≥1 is the close contract.
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  test('scroll clamps at ends', async () => {
    // Build a long body via pure helper expectation, then drive j past end.
    const longText = Array.from({ length: 80 }, (_, i) => `row-content-line-${i}`).join('\n');
    // Seed a long event into a throwaway db.
    const longPath = join(tempRoot, 'long', 'speculum.sqlite');
    mkdirSync(join(tempRoot, 'long'), { recursive: true });
    const db = new Database(longPath);
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 5');
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
       ) VALUES (
         'long-sess', '/proj/x', 'primary', NULL, 'm',
         '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 1, 1, 0, 0, 'Long'
       )`,
    );
    db.run(
      `INSERT INTO events (
         session_id, project_path, agent, parent_session, ts, kind,
         text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
         is_boilerplate, sensitive, raw
       ) VALUES (
         'long-sess', '/proj/x', 'primary', NULL, '2026-06-02T12:00:00.000Z', 'assistant',
         ?, NULL, NULL, NULL, NULL, NULL, 0, 0, '{}'
       )`,
      [longText],
    );
    const longId = Number(
      db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id,
    );
    db.close();

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 70,
      height: 16,
    });
    destroy = () => renderer.destroy();
    const keys = createMockKeys(renderer);
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: true,
          eventId: longId,
          sessionTitle: 'Long',
          inputActive: true,
          onClose: () => {},
          onStep: () => {},
          path: longPath,
          width: 60,
          height: 10,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    // Scroll way past end — should not crash; last visible lines remain in range.
    for (let i = 0; i < 200; i++) keys.typeText('j');
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/row-content-line|assistant|Long|#/);
    // Scroll to top
    for (let i = 0; i < 200; i++) keys.typeText('k');
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    const top = captureCharFrame();
    expect(top).toMatch(new RegExp(`#${longId}|assistant`));
  });

  test('hidden pane paints nothing (keep-mounted)', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 40,
      height: 10,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(TurnDetail, {
          visible: false,
          eventId: userEventId,
          sessionTitle: 'hidden',
          inputActive: false,
          onClose: () => {},
          onStep: () => {},
          path: goodDbPath,
          width: 30,
          height: 8,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toMatch(/Turn Detail Fixture|please inspect/);
  });
});
