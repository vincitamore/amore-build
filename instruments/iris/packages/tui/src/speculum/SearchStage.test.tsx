import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import {
  cycleOption,
  filterSearchHits,
  hitRowText,
  parseQuery,
  scopeChipLabel,
  searchWinSince,
  SEARCH_DEBOUNCE_MS,
  SEARCH_KIND_OPTIONS,
  SEARCH_WIN_OPTIONS,
  SearchStage,
  type FilterableSearchHit,
} from './SearchStage';
import type { SearchHit } from './query-service';

/** Minimal schema matching query-service reads (version 4). */
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

const TOKEN = 'zxqftoken9';

let tempRoot: string;
let goodDbPath: string;
let badVersionDbPath: string;
let prevDb: string | undefined;
let destroy: (() => void) | undefined;

function seedGoodIndex(path: string): void {
  const db = new Database(path);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 4');
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess-search-a',
        '/proj/a',
        'primary',
        null,
        'model-x',
        '2026-06-02T12:00:00.000Z',
        '2026-06-02T13:00:00.000Z',
        2,
        1,
        1,
        0,
      ],
    );
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess-search-b',
        '/proj/b',
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
    ): number => {
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES (?, ?, 'primary', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
        [sessionId, '/proj/a', ts, kind, text, JSON.stringify({ text })],
      );
      const id = Number(db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id);
      db.run(
        `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         VALUES (?, ?, NULL, NULL, NULL)`,
        [id, text],
      );
      return id;
    };

    insertEvent(
      'sess-search-a',
      '2026-06-02T12:01:00.000Z',
      'assistant',
      `stuck on ${TOKEN} path resolution for the mount`,
    );
    insertEvent(
      'sess-search-a',
      '2026-06-02T12:02:00.000Z',
      'user',
      'hello from operator without the distinctive word',
    );
    insertEvent(
      'sess-search-b',
      '2026-06-01T08:30:00.000Z',
      'user',
      'unrelated weather chat',
    );
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
  tempRoot = mkdtempSync(join(tmpdir(), 'search-stage-'));
  goodDbPath = join(tempRoot, 'good', 'speculum.sqlite');
  badVersionDbPath = join(tempRoot, 'bad-ver', 'speculum.sqlite');
  mkdirSync(join(tempRoot, 'good'), { recursive: true });
  mkdirSync(join(tempRoot, 'bad-ver'), { recursive: true });
  seedGoodIndex(goodDbPath);
  seedBadVersionIndex(badVersionDbPath);
  prevDb = process.env.SPECULUM_DB;
});

afterAll(() => {
  if (prevDb === undefined) delete process.env.SPECULUM_DB;
  else process.env.SPECULUM_DB = prevDb;
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

afterEach(() => {
  destroy?.();
  destroy = undefined;
  if (prevDb === undefined) delete process.env.SPECULUM_DB;
  else process.env.SPECULUM_DB = prevDb;
});

describe('parseQuery / hitRowText', () => {
  test('parseQuery trims and empties whitespace', () => {
    expect(parseQuery('  hello  ')).toBe('hello');
    expect(parseQuery('   ')).toBe('');
    expect(parseQuery('')).toBe('');
  });

  test('hitRowText marks selection, kind, eventId, snippet', () => {
    const hit: SearchHit = {
      eventId: 42,
      sessionId: 'sess-search-a',
      title: '',
      kind: 'assistant',
      snippet: 'stuck on path',
    };
    const plain = hitRowText(hit, false);
    const sel = hitRowText(hit, true);
    expect(plain.startsWith(' ')).toBe(true);
    expect(sel.startsWith('>')).toBe(true);
    expect(plain).toContain('sess-search-a');
    expect(plain).toContain('[assistant]');
    expect(plain).toContain('#42');
    expect(plain).toContain('stuck on path');
  });

  test('hitRowText surfaces title before id when present', () => {
    const hit: SearchHit = {
      eventId: 7,
      sessionId: 'sess-titled-xx',
      title: 'Repeat Previous Single Word Reply Request',
      kind: 'user',
      snippet: 'hello',
    };
    const line = hitRowText(hit, false);
    expect(line).toContain('Repeat Previous Single');
    expect(line).toContain('sess-titled-xx');
    expect(line.indexOf('Repeat')).toBeLessThan(line.indexOf('sess-titled'));
  });
});

describe('chip filter composition + session-scope gating', () => {
  const hits: FilterableSearchHit[] = [
    {
      eventId: 1,
      sessionId: 'sess-a',
      title: 'Alpha',
      kind: 'user',
      snippet: 'hello',
      ts: '2026-08-10T12:00:00.000Z',
    },
    {
      eventId: 2,
      sessionId: 'sess-a',
      title: 'Alpha',
      kind: 'assistant',
      snippet: 'world',
      ts: '2026-08-10T12:01:00.000Z',
    },
    {
      eventId: 3,
      sessionId: 'sess-b',
      title: 'Beta',
      kind: 'tool',
      snippet: 'run',
      ts: '2026-06-01T08:00:00.000Z',
    },
    {
      eventId: 4,
      sessionId: 'sess-b',
      title: 'Beta',
      kind: 'user',
      snippet: 'old',
      // no ts — window arm fail-open
    },
  ];

  test('kind post-filter keeps matching kinds only', () => {
    const users = filterSearchHits(hits, { kind: 'user', win: 'all' });
    expect(users.every((h) => h.kind === 'user')).toBe(true);
    expect(users).toHaveLength(2);
    const tools = filterSearchHits(hits, { kind: 'tool', win: 'all' });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.eventId).toBe(3);
  });

  test('window post-filter uses hit.ts when present', () => {
    const now = new Date('2026-08-11T00:00:00.000Z');
    const since7 = searchWinSince('7d', now);
    expect(since7).toBeTruthy();
    const recent = filterSearchHits(hits, { kind: 'all', win: '7d', now });
    // June tool row drops; August rows keep; no-ts row fail-open keeps
    expect(recent.map((h) => h.eventId).sort()).toEqual([1, 2, 4]);
    const all = filterSearchHits(hits, { kind: 'all', win: 'all', now });
    expect(all).toHaveLength(4);
  });

  test('kind + window compose', () => {
    const now = new Date('2026-08-11T00:00:00.000Z');
    const rows = filterSearchHits(hits, { kind: 'assistant', win: '30d', now });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('assistant');
  });

  test('cycleOption wraps chip lists', () => {
    expect(cycleOption(SEARCH_KIND_OPTIONS, 'all', 1)).toBe('user');
    expect(cycleOption(SEARCH_KIND_OPTIONS, 'tool', 1)).toBe('all');
    expect(cycleOption(SEARCH_WIN_OPTIONS, '7d', 1)).toBe('all');
    expect(cycleOption(SEARCH_WIN_OPTIONS, 'all', -1)).toBe('7d');
  });

  test('scopeChipLabel gates session arm without handoff', () => {
    expect(scopeChipLabel('corpus', null)).toBe('corpus');
    expect(scopeChipLabel('session', null)).toBe('corpus');
    expect(scopeChipLabel('session', { id: 'sess-abc-long-id', title: '' })).toMatch(
      /sess-abc/,
    );
    expect(
      scopeChipLabel('session', {
        id: 'sess-x',
        title: 'Very Long Session Title Here',
      }),
    ).toMatch(/Very Long|…/);
  });
});

describe('SearchStage render', () => {
  test('empty query shows idle hint', async () => {
    process.env.SPECULUM_DB = goodDbPath;
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 110,
      height: 32,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(SearchStage, { inputActive: true }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();
    const idleHint = 'type to search sessions';
    const idleCount = frame.split(idleHint).length - 1;
    expect(frame, `frame:\n${frame}`).toMatch(/type to search sessions/);
    expect(idleCount, `idle hint must appear exactly once; frame:\n${frame}`).toBe(1);
    expect(frame).toMatch(/Search/);
    // Chip row present (kind · win · scope)
    expect(frame).toMatch(/kind:/i);
    expect(frame).toMatch(/win:/i);
    expect(frame).toMatch(/scope:/i);
  });

  test('session scope chip shows short title when handed a context', async () => {
    process.env.SPECULUM_DB = goodDbPath;
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 110,
      height: 32,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(SearchStage, {
          inputActive: true,
          scopeSession: { id: 'sess-search-a', title: 'Mount Path Fix' },
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/Mount Path Fix|corpus\|Mount/i);
  });

  test('typed token + debounce yields matching hit rows', async () => {
    process.env.SPECULUM_DB = goodDbPath;
    const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({
      width: 110,
      height: 32,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(SearchStage, { inputActive: true }),
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
    await renderOnce();
    await mockInput.typeText(TOKEN);
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 150));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/sess-search-a/);
    expect(frame).toMatch(new RegExp(TOKEN));
    expect(frame).toMatch(/assistant|\[assistant\]/);
    const idleHint = 'type to search sessions';
    const idleCount = frame.split(idleHint).length - 1;
    expect(idleCount, `idle hint must be absent while typing; frame:\n${frame}`).toBe(0);
  });

  test('Enter fires onOpenSession with sessionId + eventId', async () => {
    process.env.SPECULUM_DB = goodDbPath;
    let opened: { sessionId: string; opts?: { eventId?: string | number } } | null = null;
    const { renderer, renderOnce, mockInput } = await createTestRenderer({
      width: 110,
      height: 32,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(SearchStage, {
          inputActive: true,
          onOpenSession: (sessionId, opts) => {
            opened = { sessionId, opts };
          },
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
    await renderOnce();
    await mockInput.typeText(TOKEN);
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 150));
    await renderOnce();
    // pressKey('return') types the letters r-e-t-u-r-n; use pressEnter / RETURN code.
    await mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 80));
    expect(opened, 'onOpenSession should fire').not.toBeNull();
    expect(opened!.sessionId).toBe('sess-search-a');
    expect(opened!.opts?.eventId).toBeDefined();
    expect(typeof opened!.opts?.eventId).toBe('number');
  });

  test('schema-mismatch fixture shows version banner', async () => {
    process.env.SPECULUM_DB = badVersionDbPath;
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 110,
      height: 32,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(SearchStage, { inputActive: true }),
      ),
    );
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/schema v99 unsupported|unsupported \(need 4\)/i);
  });
});
