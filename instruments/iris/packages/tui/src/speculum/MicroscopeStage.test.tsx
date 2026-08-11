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
  agentFilterToAgent,
  agentGlyph,
  budgetSessionSlots,
  budgetTurnSlots,
  buildListOpts,
  classFilterToCwd,
  classGlyph,
  collapseAbsolutePaths,
  cycleChip,
  CLASS_CYCLE,
  AGENT_CYCLE,
  WIN_CYCLE,
  SORT_CYCLE,
  formatEventTs,
  formatFilterRow,
  formatSessionInfo,
  formatSessionLine,
  formatSessionTitleLine,
  formatTurnLine,
  isSubagentRow,
  kindColor,
  MicroscopeStage,
  pageRangeLabel,
  paneGeometry,
  paneInnerWidth,
  PICKER_MAX_OUTER,
  PICKER_MIN_OUTER,
  projectBasename,
  relAge,
  rowText,
  sessionDisplayTitle,
  sessionPickerLabel,
  shortSessionId,
  STACK_BELOW_COLS,
  winFilterSince,
} from './MicroscopeStage';
import type { SessionListRow, TurnRow } from './query-service';

/** Schema with v6 session facets so filter chips exercise the real read path. */
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
  title            TEXT NOT NULL DEFAULT '',
  cwd_class        TEXT NOT NULL DEFAULT '',
  agent_name       TEXT NOT NULL DEFAULT '',
  subagent_type    TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  title_source     TEXT NOT NULL DEFAULT ''
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
    cwdClass: partial.cwdClass ?? '',
    agentName: partial.agentName ?? '',
    subagentType: partial.subagentType ?? '',
    description: partial.description ?? '',
    titleSource: partial.titleSource ?? '',
  };
}

function insertSession(
  db: Database,
  row: {
    id: string;
    projectPath?: string;
    agent?: string;
    parentSession?: string | null;
    modelId?: string | null;
    startedAt: string;
    endedAt?: string;
    turnCount?: number;
    userMsgCount?: number;
    toolCallCount?: number;
    toolErrorCount?: number;
    title?: string;
    cwdClass?: string;
    agentName?: string;
    subagentType?: string;
    description?: string;
    titleSource?: string;
  },
): void {
  db.run(
    `INSERT INTO sessions (
       id, project_path, agent, parent_session, model_id,
       started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count,
       title, cwd_class, agent_name, subagent_type, description, title_source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.projectPath ?? '/proj/microscope-demo',
      row.agent ?? 'primary',
      row.parentSession !== undefined ? row.parentSession : null,
      row.modelId !== undefined ? row.modelId : 'model-x',
      row.startedAt,
      row.endedAt ?? row.startedAt,
      row.turnCount ?? 1,
      row.userMsgCount ?? 1,
      row.toolCallCount ?? 0,
      row.toolErrorCount ?? 0,
      row.title ?? '',
      row.cwdClass ?? 'operator',
      row.agentName ?? '',
      row.subagentType ?? '',
      row.description ?? '',
      row.titleSource ?? '',
    ],
  );
}

function seedGoodIndex(path: string): number {
  const db = new Database(path);
  let errId = 0;
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 6');

    insertSession(db, {
      id: 'sess-alpha',
      projectPath: '/proj/microscope-demo',
      agent: 'primary',
      modelId: 'model-x',
      startedAt: '2026-06-02T12:00:00.000Z',
      endedAt: '2026-06-02T13:00:00.000Z',
      turnCount: 3,
      userMsgCount: 1,
      toolCallCount: 2,
      toolErrorCount: 1,
      title: 'Repeat Previous Single Word Reply Request',
      cwdClass: 'operator',
      agentName: 'grok-build',
      titleSource: 'summary',
    });
    insertSession(db, {
      id: 'sess-beta',
      projectPath: '/proj/other',
      agent: 'primary',
      modelId: 'model-y',
      startedAt: '2026-06-01T08:00:00.000Z',
      endedAt: '2026-06-01T09:00:00.000Z',
      turnCount: 1,
      title: '', // empty title → id fallback
      cwdClass: 'experiment',
    });
    // Subagents of alpha (parentage nav). Older than alpha so sort:recent
    // still lists the primary first (enter opens alpha's timeline).
    insertSession(db, {
      id: 'sess-alpha-child-a',
      agent: 'subagent',
      parentSession: 'sess-alpha',
      startedAt: '2026-06-02T11:10:00.000Z',
      title: '',
      description: 'child explore map',
      cwdClass: 'operator',
      subagentType: 'explore',
    });
    insertSession(db, {
      id: 'sess-alpha-child-b',
      agent: 'subagent',
      parentSession: 'sess-alpha',
      startedAt: '2026-06-02T11:20:00.000Z',
      title: 'Child Plan Turn',
      cwdClass: 'operator',
      subagentType: 'plan',
    });
    // Extra primaries for paging (newest first by started_at)
    for (let i = 0; i < 12; i++) {
      const n = String(i).padStart(2, '0');
      insertSession(db, {
        id: `sess-page-${n}`,
        projectPath: '/proj/page-farm',
        agent: 'primary',
        startedAt: `2026-05-${String(20 - (i % 10)).padStart(2, '0')}T10:00:00.000Z`,
        title: `Page Farm Session ${n}`,
        cwdClass: i % 3 === 0 ? 'harness' : i % 3 === 1 ? 'operator' : 'experiment',
        toolErrorCount: i % 4,
        turnCount: i + 1,
      });
    }

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
    insertEvent(
      'sess-alpha',
      '2026-06-02T12:04:00.000Z',
      'user',
      'unique-needle-alpha search token',
    );

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

  test('rowText summarizes user/tool/error rows; collapses absolute paths', () => {
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

    const pathTool: TurnRow = {
      eventId: 4,
      kind: 'tool_use',
      ts: '2026-06-02T12:02:30.000Z',
      text: 'C:\\Users\\x\\proj\\file.ts',
      toolName: 'Read',
      toolError: 0,
    };
    expect(rowText(pathTool)).toBe('Read file.ts');
    expect(rowText(pathTool)).not.toContain('C:\\Users');
    expect(rowText(pathTool, { fullPaths: true })).toContain('C:\\Users');

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

  test('collapseAbsolutePaths basenames windows and posix paths', () => {
    expect(collapseAbsolutePaths('C:\\Users\\x\\proj\\file.ts')).toBe('file.ts');
    expect(collapseAbsolutePaths('/home/a/b/out.json')).toBe('out.json');
    expect(collapseAbsolutePaths('relative/path.ts')).toBe('relative/path.ts');
  });

  test('formatSessionLine leads with title; age+counts secondary; no id on titled rows', () => {
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
    expect(line).toMatch(/t:3 e:4/);
    expect(line).toMatch(/\d+[mhd] ago/);
    // titled rows do not carry a secondary id
    expect(line).not.toMatch(/sess-alpha/);
  });

  test('formatSessionLine width drops meta before title; pad contract', () => {
    const now = new Date('2026-06-03T12:00:00.000Z').getTime();
    const titled = baseSession({
      id: 'sess-alpha',
      title: 'U7 Lens Runnability Dash Panel',
      turnCount: 3,
      eventCount: 4,
      startedAt: '2026-06-03T10:00:00.000Z',
    });
    const inner = paneInnerWidth(paneGeometry(140).pickerW);
    expect(inner).toBeGreaterThanOrEqual(48);
    const line = formatSessionLine(titled, false, now, inner);
    expect(line.length).toBeLessThanOrEqual(inner);
    expect(line.startsWith(' U7 Lens')).toBe(true);
    // distinctive head visible (not mid-token ellipsis of a short title)
    expect(line).toContain('U7 Lens');
    // meta present when title fits
    expect(line).toMatch(/\d+[mhd] ago|t:\d/);

    const long = baseSession({
      id: 'sess-long',
      title: 'X'.repeat(80),
      turnCount: 1,
      eventCount: 1,
    });
    const cut = formatSessionLine(long, true, now, 40);
    expect(cut.length).toBe(40);
    expect(cut.endsWith('\u2026')).toBe(true);
    expect(cut.startsWith('>XXXX')).toBe(true);
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

  test('formatSessionLine uses description when title empty (subagent)', () => {
    const now = new Date('2026-06-03T12:00:00.000Z').getTime();
    const sub = baseSession({
      id: 'sub-1',
      title: '',
      description: 'explore the map stage',
      agent: 'subagent',
      parentSession: 'sess-alpha',
      cwdClass: 'operator',
    });
    const line = formatSessionLine(sub, true, now);
    expect(line).toMatch(/explore the map stage/);
    expect(line).toMatch(/OS/); // O class + S agent
    expect(line).not.toMatch(/sub-1/);
  });

  test('formatSessionLine drop-order: counts → age → glyphs under narrow width', () => {
    const now = new Date('2026-06-03T12:00:00.000Z').getTime();
    const row = baseSession({
      id: 'sess-drop',
      title: 'Short Title',
      cwdClass: 'operator',
      turnCount: 12,
      eventCount: 34,
      startedAt: '2026-06-03T10:00:00.000Z',
    });
    const wide = formatSessionLine(row, false, now, 80);
    expect(wide).toMatch(/t:12 e:34/);
    expect(wide).toMatch(/\d+[mhd] ago/);
    expect(wide).toMatch(/OP/);

    const mid = formatSessionLine(row, false, now, 28);
    // counts dropped first
    expect(mid).not.toMatch(/t:12/);
    expect(mid).toMatch(/Short Title/);

    const tight = formatSessionLine(row, false, now, 18);
    // title survives
    expect(tight).toMatch(/Short/);
    expect(tight.length).toBeLessThanOrEqual(18);
  });

  test('sessionDisplayTitle / formatSessionTitleLine prefer rewritten title', () => {
    const titled = baseSession({ id: 'sess-alpha', title: '  Hello World  ' });
    expect(sessionDisplayTitle(titled)).toBe('Hello World');
    expect(formatSessionTitleLine(titled)).toBe('Hello World');
    const bare = baseSession({ id: 'sess-alpha-long-id-suffix', title: '' });
    expect(sessionDisplayTitle(bare)).toBe(shortSessionId(bare.id));
    const withDesc = baseSession({
      id: 'sub-x',
      title: '',
      description: '  child work  ',
    });
    expect(sessionDisplayTitle(withDesc)).toBe('child work');
    expect(sessionPickerLabel('Pipeline: dream-2026-02-14T08-19-40-project-health')).toBe(
      'project-health 2026-02-14',
    );
  });

  test('paging math + N-of-M honesty', () => {
    expect(pageRangeLabel(0, 0, 0)).toBe('0–0 of 0');
    expect(pageRangeLabel(0, 8, 100)).toBe('1–8 of 100');
    expect(pageRangeLabel(8, 8, 100)).toBe('9–16 of 100');
    expect(pageRangeLabel(96, 4, 100)).toBe('97–100 of 100');
  });

  test('filter chip cycles + list opts mapping', () => {
    expect(cycleChip(CLASS_CYCLE, 'all')).toBe('op');
    expect(cycleChip(CLASS_CYCLE, 'har')).toBe('all');
    expect(cycleChip(AGENT_CYCLE, 'all')).toBe('prim');
    expect(cycleChip(AGENT_CYCLE, 'sub')).toBe('all');
    expect(cycleChip(WIN_CYCLE, 'all', 1)).toBe('7d');
    expect(cycleChip(WIN_CYCLE, 'all', -1)).toBe('30d');
    expect(cycleChip(SORT_CYCLE, 'recent')).toBe('turns');
    expect(cycleChip(SORT_CYCLE, 'errors')).toBe('recent');

    expect(classFilterToCwd('op')).toBe('operator');
    expect(classFilterToCwd('all')).toBeUndefined();
    expect(agentFilterToAgent('prim')).toBe('primary');
    expect(agentFilterToAgent('all')).toBeUndefined();
    const since7 = winFilterSince('7d', Date.parse('2026-06-10T00:00:00.000Z'));
    expect(since7).toMatch(/^2026-06-03/);

    const opts = buildListOpts({
      classF: 'op',
      agentF: 'sub',
      winF: '30d',
      sortF: 'errors',
      titleFilter: 'hello',
      limit: 5,
      offset: 10,
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    });
    expect(opts.cwdClass).toBe('operator');
    expect(opts.agent).toBe('subagent');
    expect(opts.sort).toBe('errors');
    expect(opts.title).toBe('hello');
    expect(opts.limit).toBe(5);
    expect(opts.offset).toBe(10);
    expect(opts.since).toBeTruthy();

    expect(formatFilterRow({ classF: 'op', agentF: 'all', winF: '7d', sortF: 'recent' })).toBe(
      'class:op · agent:all · win:7d · sort:rec',
    );
    expect(classGlyph('operator')).toBe('O');
    expect(classGlyph('')).toBe('·');
    expect(agentGlyph(baseSession({ id: 'p', agent: 'primary' }))).toBe('P');
    expect(
      agentGlyph(baseSession({ id: 's', agent: 'subagent', parentSession: 'p' })),
    ).toBe('S');
    expect(isSubagentRow(baseSession({ id: 's', parentSession: 'p' }))).toBe(true);
  });

  test('formatSessionInfo includes facet middots when present', () => {
    const now = new Date('2026-06-02T14:00:00.000Z').getTime();
    const faceted = baseSession({
      id: 'sess-alpha-long-id-suffix',
      title: 'Named Session',
      projectPath: '/proj/microscope-demo',
      modelId: 'model-x',
      startedAt: '2026-06-02T12:00:00.000Z',
      turnCount: 100,
      toolErrorCount: 3,
      cwdClass: 'operator',
      agentName: 'grok-build',
      titleSource: 'generated',
    });
    const info = formatSessionInfo(faceted, now);
    expect(info).toMatch(/operator/);
    expect(info).toMatch(/grok-build/);
    expect(info).toMatch(/model-x/);
    expect(info).toMatch(/generated/);
    expect(info).toMatch(/microscope-demo/);
    expect(info).toMatch(/100 turns/);
  });

  test('formatTurnLine includes selection prefix + grain; basename tool paths', () => {
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

    const pathTurn: TurnRow = {
      eventId: 7,
      kind: 'tool_use',
      ts: '2026-06-02T12:05:00.000Z',
      text: 'C:\\Users\\x\\proj\\file.ts',
      toolName: 'Read',
      toolError: 0,
    };
    const unsel = formatTurnLine(pathTurn, false, 80);
    expect(unsel).toContain('file.ts');
    expect(unsel).not.toContain('C:\\Users');
    // selected + wide budget may keep full path
    const selWide = formatTurnLine(pathTurn, true, 200);
    expect(selWide).toContain('C:\\Users');
  });

  test('paneGeometry flex picker ≥48 outer at operator sizes; stacked below 100', () => {
    expect(STACK_BELOW_COLS).toBe(100);
    // host width = residual stage box (term − member pad); content charges stage pad + panel chrome
    const op = paneGeometry(140);
    expect(op.twoPane).toBe(true);
    expect(op.pickerW).toBeGreaterThanOrEqual(PICKER_MIN_OUTER);
    expect(op.pickerW).toBeLessThanOrEqual(PICKER_MAX_OUTER);
    expect(op.pickerW + 1 + op.timelineW).toBe(op.contentW);
    expect(paneInnerWidth(op.pickerW)).toBe(op.pickerW - 4);
    expect(paneInnerWidth(op.pickerW)).toBeGreaterThanOrEqual(48);

    const narrow = paneGeometry(118); // term 120 − 2 member pad
    expect(narrow.twoPane).toBe(true);
    expect(narrow.pickerW).toBeGreaterThanOrEqual(PICKER_MIN_OUTER);
    expect(narrow.pickerW).toBeLessThanOrEqual(PICKER_MAX_OUTER);
    expect(narrow.pickerW + 1 + narrow.timelineW).toBe(narrow.contentW);
    // contentW = host − stage pad(2) − panel chrome(4)
    expect(narrow.contentW).toBe(118 - 2 - 4);

    const stacked = paneGeometry(88); // term 90 − 2
    expect(stacked.twoPane).toBe(false);
    expect(stacked.pickerW).toBe(stacked.contentW);
    expect(stacked.timelineW).toBe(stacked.contentW);

    // term 100 → host 98; host + member pad restores stack threshold
    const edge = paneGeometry(98);
    expect(edge.twoPane).toBe(true);
    expect(edge.pickerW).toBeGreaterThanOrEqual(PICKER_MIN_OUTER);

    // Card inner width = outer − 4
    expect(paneInnerWidth(48)).toBe(44);
  });

  test('budgetSessionSlots / budgetTurnSlots fit-clamp; never overflow host with chrome', () => {
    // 80×24 seed residual ≈ 15 → listHost ≈ 10 after MICRO_STAGE_CHROME (5)
    // Tight host drops STACK_GAP so both lists keep ≥1 row:
    // overhead = 2×3 + 0 + 2 = 8 → available = 2 → s=1 t=1.
    const listHostFloor = 10;
    const s80 = budgetSessionSlots(listHostFloor, false);
    const t80 = budgetTurnSlots(listHostFloor, false, s80);
    expect(s80).toBe(1);
    expect(t80).toBe(1);
    // stacked paint (no gap at this host) ≤ list host
    const stackedPaint =
      s80 + t80 + 2 /* TIMELINE_INFO_ROWS */ + 2 * 3 /* CARD_V_CHROME */; /* gap dropped */
    expect(stackedPaint).toBeLessThanOrEqual(listHostFloor);

    // Two-pane residual listHost 29 → content = host − card chrome
    const sTall = budgetSessionSlots(29, true);
    const tTall = budgetTurnSlots(29, true);
    expect(sTall).toBe(29 - 3); // CARD_V_CHROME
    expect(tTall).toBe(29 - 3 - 2); // chrome + info
    expect(sTall).toBeGreaterThan(s80);
    expect(tTall).toBeGreaterThan(t80);

    // Fit invariant when the host can hold chrome + content (gap drops when tight)
    for (const h of [8, 10, 12, 16, 24, 40]) {
      const s = budgetSessionSlots(h, false);
      const t = budgetTurnSlots(h, false, s);
      const needWithGap = 2 * 3 + 1 + 2 + 2; // chrome + gap + info + 2 content
      const gap = h >= needWithGap ? 1 : 0;
      const overhead = 2 * 3 + gap + 2;
      const paint = s + t + overhead;
      // Below overhead+content the floor-1 path is belt-only; assert fit once host holds chrome+rows.
      if (h >= overhead + 2) expect(paint).toBeLessThanOrEqual(h);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(t).toBeGreaterThanOrEqual(0);
    }
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
    // Session-info: title first + facts (project / turns; errors may head-slice on tight timeline)
    expect(frame).toMatch(/Repeat Previous/);
    expect(frame).toMatch(/microscope-demo/);
    // facts may head-slice turns/errors under a wide facet line
    expect(frame).toMatch(/\d+\s+turns|\d+\s+errors|operator|grok-build|mod\u2026|model/);
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
    expect(frame).toMatch(/\d+\s+turns|\d+\s+errors|operator|grok-build|mod\u2026|model/);
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

  test('filter row + N-of-M label on ready corpus', async () => {
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

    await new Promise((r) => setTimeout(r, 250));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/class:all/);
    expect(frame).toMatch(/agent:all/);
    expect(frame).toMatch(/win:all/);
    // recent abbreviates to rec so four chips fit picker min width
    expect(frame).toMatch(/sort:rec/);
    // N-of-M: total sessions = 2 primaries + 2 children + 12 page farm = 16
    // (en-dash or hyphen depending on terminal cell rendering)
    expect(frame).toMatch(/\d+[\-–—]\d+ of 16/);
  });

  test('filter chip keys cycle class/agent/window/sort', async () => {
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

    await new Promise((r) => setTimeout(r, 250));
    await renderOnce();

    keys.typeText('f');
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/class:op/);

    keys.typeText('a');
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toMatch(/agent:prim/);

    keys.typeText(']');
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toMatch(/win:7d/);

    keys.typeText(',');
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toMatch(/sort:turns/);
  });

  test('title filter apply via t + enter; esc clears', async () => {
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

    await new Promise((r) => setTimeout(r, 250));
    await renderOnce();

    keys.typeText('t');
    await new Promise((r) => setTimeout(r, 80));
    keys.typeText('Repeat');
    await new Promise((r) => setTimeout(r, 80));
    await keys.pressKeys(['RETURN']);
    await new Promise((r) => setTimeout(r, 150));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/Repeat Previous/);
    expect(frame).toMatch(/of 1/);

    await keys.pressKeys(['ESCAPE']);
    await new Promise((r) => setTimeout(r, 150));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toMatch(/of 16/);
  });

  test('parentage: s on primary filters children; esc restores', async () => {
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

    await new Promise((r) => setTimeout(r, 250));
    await renderOnce();
    // sess-alpha is newest primary (started 06-02) — should be cursor 0
    keys.typeText('s');
    await new Promise((r) => setTimeout(r, 150));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/children of/i);
    expect(frame).toMatch(/child explore map|Child Plan/);
    expect(frame).toMatch(/of 2/);

    await keys.pressKeys(['ESCAPE']);
    await new Promise((r) => setTimeout(r, 150));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).not.toMatch(/children of/i);
    expect(frame).toMatch(/of 16/);
  });

  test('in-session search / + enter steps with n', async () => {
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

    await new Promise((r) => setTimeout(r, 250));
    await renderOnce();
    // Open alpha timeline
    await keys.pressKeys(['RETURN']);
    await new Promise((r) => setTimeout(r, 150));
    await renderOnce();

    keys.typeText('/');
    await new Promise((r) => setTimeout(r, 80));
    keys.typeText('unique-needle-alpha');
    await new Promise((r) => setTimeout(r, 80));
    await keys.pressKeys(['RETURN']);
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/unique-needle-alpha|#\d+/);

    keys.typeText('n');
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    frame = captureCharFrame();
    // still on timeline with hit grain
    expect(frame).toMatch(/TIMELINE|user|unique-needle/);
  });

  test('cursor past page edge fetches next page (N-of-M advances)', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 28, // seed nest → fewer list slots → paging required
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

    await new Promise((r) => setTimeout(r, 250));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/1[\-–—]\d+ of 16/);
    const firstRange = frame.match(/(\d+)[\-–—](\d+) of 16/);
    expect(firstRange).toBeTruthy();
    const firstLast = Number(firstRange![2]);
    expect(firstLast).toBeLessThan(16);

    // Walk to the last row of the page (await each step so refs settle), then edge.
    for (let i = 0; i < firstLast - 1; i++) {
      await keys.pressKeys(['ARROW_DOWN']);
      await new Promise((r) => setTimeout(r, 20));
    }
    await renderOnce();
    // One more down from the last visible row fetches the next page.
    await keys.pressKeys(['ARROW_DOWN']);
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(
      new RegExp(`${firstLast + 1}[\\-–—]\\d+ of 16`),
    );
  });
});
