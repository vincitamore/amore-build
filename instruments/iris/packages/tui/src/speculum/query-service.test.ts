import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUSY_DELAY_MS,
  BUSY_MAX_ATTEMPTS,
  isSqliteBusy,
  openQueryService,
  prepareFtsQuery,
  resolveIndexPath,
  SUPPORTED_SCHEMA_VERSIONS,
  withBusyRetry,
  type QueryService,
} from './query-service';

/** Minimal WU-era schema matching tables the query-service reads (SCHEMA_VERSION 4). */
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
let badVersionDbPath: string;
let v6DbPath: string;

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
        'sess-newer',
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
        'sess-older',
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
      toolName: string | null = null,
      toolError: number | null = null,
    ): number => {
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES (?, ?, 'primary', NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0, ?)`,
        [sessionId, '/proj/a', ts, kind, text, toolName, toolError, JSON.stringify({ text })],
      );
      const id = Number(db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id);
      db.run(
        `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         VALUES (?, ?, ?, NULL, NULL)`,
        [id, text, toolName],
      );
      return id;
    };

    insertEvent('sess-newer', '2026-06-02T12:00:00.000Z', 'user', 'hello from operator');
    insertEvent(
      'sess-newer',
      '2026-06-02T12:01:00.000Z',
      'assistant',
      'stuck on NTFS junction path resolution',
    );
    insertEvent('sess-newer', '2026-06-02T12:02:00.000Z', 'tool_use', '', 'Read', 0);
    insertEvent('sess-older', '2026-06-01T08:30:00.000Z', 'user', 'unrelated weather chat');

    db.run(
      `INSERT INTO usage (
         session_id, project_path, ts, model_id,
         input_tokens, output_tokens, total_tokens, raw
       ) VALUES ('sess-newer', '/proj/a', '2026-06-02T12:05:00.000Z', 'model-x', 10, 20, 30, '{}')`,
    );
    db.run(
      `INSERT INTO ingest_state (
         file_path, size_bytes, mtime, byte_offset, last_ingested, forgotten
       ) VALUES ('/sessions/a.jsonl', 100, '2026-06-02T12:00:00.000Z', 100, '2026-06-02T13:30:00.000Z', 0)`,
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
  tempRoot = mkdtempSync(join(tmpdir(), 'qs-si08-'));
  goodDbPath = join(tempRoot, 'good', 'speculum.sqlite');
  badVersionDbPath = join(tempRoot, 'bad-ver', 'speculum.sqlite');
  v6DbPath = join(tempRoot, 'v6', 'speculum.sqlite');
  mkdirSync(join(tempRoot, 'good'), { recursive: true });
  mkdirSync(join(tempRoot, 'bad-ver'), { recursive: true });
  mkdirSync(join(tempRoot, 'v6'), { recursive: true });
  seedGoodIndex(goodDbPath);
  seedBadVersionIndex(badVersionDbPath);
  seedV6Index(v6DbPath);
});

afterAll(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('resolveIndexPath', () => {
  test('SPECULUM_DB wins', () => {
    expect(
      resolveIndexPath({
        SPECULUM_DB: 'C:\\custom\\index.sqlite',
        SPECULUM_HOME: 'C:\\ignored',
        AMORE_HOME: 'C:\\also-ignored',
      }),
    ).toBe('C:\\custom\\index.sqlite');
  });

  test('SPECULUM_HOME then speculum.sqlite', () => {
    const p = resolveIndexPath({ SPECULUM_HOME: join(tempRoot, 'home-only') });
    expect(p).toBe(join(tempRoot, 'home-only', 'speculum.sqlite'));
  });

  test('default resolves under AMORE_HOME (fake home)', () => {
    const fakeHome = join(tempRoot, 'fake-amore');
    const p = resolveIndexPath({ AMORE_HOME: fakeHome });
    expect(p).toBe(join(fakeHome, 'instruments', 'speculum', 'speculum.sqlite'));
  });
});

describe('prepareFtsQuery / busy helpers', () => {
  test('prepareFtsQuery quotes tokens and strips operators', () => {
    expect(prepareFtsQuery('  junction path  ')).toBe('"junction" "path"');
    expect(prepareFtsQuery('a AND b')).toBe('"a" "AND" "b"');
    expect(prepareFtsQuery('')).toBe('');
  });

  test('isSqliteBusy detects locked messages', () => {
    const err = new Error('database is locked');
    (err as { code?: string }).code = 'SQLITE_BUSY';
    expect(isSqliteBusy(err)).toBe(true);
    expect(isSqliteBusy(new Error('unique constraint'))).toBe(false);
  });

  test('withBusyRetry succeeds after transient busy', () => {
    let n = 0;
    const sleeps: number[] = [];
    const result = withBusyRetry(
      () => {
        n += 1;
        if (n < 3) {
          const e = new Error('database is locked');
          (e as { code?: string }).code = 'SQLITE_BUSY';
          throw e;
        }
        return 'ok';
      },
      {
        maxAttempts: 3,
        delayMs: 1,
        sleep: (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(n).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  test('withBusyRetry exhausts and reports busy', () => {
    let n = 0;
    const result = withBusyRetry(
      () => {
        n += 1;
        const e = new Error('database is locked');
        (e as { code?: string }).code = 'SQLITE_BUSY';
        throw e;
      },
      { maxAttempts: BUSY_MAX_ATTEMPTS, delayMs: BUSY_DELAY_MS, sleep: () => {} },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.busy).toBe(true);
    expect(n).toBe(BUSY_MAX_ATTEMPTS);
  });

  test('withBusyRetry rethrows non-busy errors', () => {
    expect(() =>
      withBusyRetry(
        () => {
          throw new Error('boom');
        },
        { maxAttempts: 3, delayMs: 1, sleep: () => {} },
      ),
    ).toThrow('boom');
  });
});

describe('openQueryService readonly + version gate', () => {
  test('SUPPORTED_SCHEMA_VERSIONS is pinned to [4, 5, 6]', () => {
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([4, 5, 6]);
  });

  test('readonly: INSERT on opened db throws', () => {
    const qs = openQueryService(goodDbPath);
    try {
      expect(qs.schemaOK()).toBe(true);
      expect(qs.getVersion()).toBe(4);
      // Reach into the private handle via a second open on the same path.
      const ro = new Database(goodDbPath, { readonly: true, create: false });
      try {
        expect(() => {
          ro.run(
            `INSERT INTO sessions (
               id, project_path, agent, parent_session, model_id,
               started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
             ) VALUES ('x', '/p', 'primary', NULL, NULL, 't', 't', 0, 0, 0, 0)`,
          );
        }).toThrow();
      } finally {
        ro.close();
      }
    } finally {
      qs.close();
    }
  });

  test('version outside set → schemaOK false, no crash', () => {
    const qs = openQueryService(badVersionDbPath);
    try {
      expect(qs.getVersion()).toBe(99);
      expect(qs.schemaOK()).toBe(false);
      // Open path itself must not throw for mismatch.
      expect(qs.busy()).toBe(false);
    } finally {
      qs.close();
    }
  });

  test('missing index path throws (honest empty vs missing)', () => {
    const missing = join(tempRoot, 'no-such', 'speculum.sqlite');
    expect(() => openQueryService(missing)).toThrow(/not found/i);
  });

  test('SPECULUM_DB env override points at synthetic index', () => {
    const qs = openQueryService({
      env: { SPECULUM_DB: goodDbPath },
    });
    try {
      expect(qs.path).toBe(goodDbPath);
      expect(qs.schemaOK()).toBe(true);
      const st = qs.status();
      expect(st.sessions).toBe(2);
    } finally {
      qs.close();
    }
  });
});

describe('typed reads', () => {
  let qs: QueryService;

  beforeAll(() => {
    qs = openQueryService(goodDbPath);
  });

  afterAll(() => {
    qs.close();
  });

  test('status returns counts + lastIngestedAt + stale', () => {
    const st = qs.status();
    expect(st.sessions).toBe(2);
    // seedGoodIndex rows are both agent='primary'.
    expect(st.primarySessions).toBe(2);
    expect(st.subagentSessions).toBe(0);
    expect(st.byAgent).toEqual({ primary: 2 });
    expect(st.events).toBeGreaterThanOrEqual(3);
    expect(st.usageRows).toBe(1);
    expect(st.lastIngestedAt).toBe('2026-06-02T13:30:00.000Z');
    // Seeded newest session is 2026-06-02 — far older than 24h from now → stale.
    expect(st.stale).toBe(true);
  });

  test('sessionList ordered by started_at desc with event counts', () => {
    const list = qs.sessionList(10, 0);
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe('sess-newer');
    expect(list[1]!.id).toBe('sess-older');
    expect(list[0]!.eventCount).toBeGreaterThanOrEqual(2);
    expect(list[0]!.turnCount).toBe(2);
    expect(list[1]!.eventCount).toBe(1);
    // v4 synthetic seed has no title column → empty string, no error.
    expect(list[0]!.title).toBe('');
    expect(list[1]!.title).toBe('');
  });

  test('turns returns eventId/kind/text in ts order', () => {
    const turns = qs.turns('sess-newer');
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0]!.ts <= turns[1]!.ts).toBe(true);
    expect(typeof turns[0]!.eventId).toBe('number');
    expect(turns[0]!.kind).toBe('user');
    expect(turns[0]!.text).toBe('hello from operator');
    const junction = turns.find((t) => (t.text ?? '').includes('junction'));
    expect(junction).toBeDefined();
    expect(junction!.eventId).toBeGreaterThan(0);
  });

  test('search returns seeded FTS hit', () => {
    const hits = qs.search('junction', { limit: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.sessionId).toBe('sess-newer');
    expect(typeof hits[0]!.eventId).toBe('number');
    expect(hits[0]!.snippet.toLowerCase()).toContain('junction');
    // v4 seed: title empty
    expect(hits[0]!.title).toBe('');
  });
});

describe('links() evidence edges', () => {
  test('parentage + event_links aggregation; co-visible filter; empty set', () => {
    const path = join(tempRoot, 'links-v5.sqlite');
    {
      const db = new Database(path);
      db.exec(SYNTHETIC_DDL);
      db.run(`
        CREATE TABLE event_links (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          source_event_id  INTEGER NOT NULL,
          target_event_id  INTEGER NOT NULL,
          kind             TEXT NOT NULL,
          method           TEXT NOT NULL,
          confidence       REAL NOT NULL DEFAULT 1.0,
          heuristic        INTEGER NOT NULL DEFAULT 0,
          UNIQUE(source_event_id, target_event_id, kind)
        );
      `);
      db.run('ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT \'\'');
      db.run('PRAGMA user_version = 5');

      const insertSession = (
        id: string,
        parent: string | null,
        project = '/proj/a',
      ) => {
        db.run(
          `INSERT INTO sessions (
             id, project_path, agent, parent_session, model_id,
             started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
           ) VALUES (?, ?, ?, ?, 'm',
             '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 1, 1, 0, 0, ?)`,
          [id, project, parent ? 'subagent' : 'primary', parent, id === 'parent-sess' ? 'Primary Title' : ''],
        );
      };
      insertSession('parent-sess', null);
      insertSession('child-sess', 'parent-sess');
      insertSession('peer-a', null, '/proj/b');
      insertSession('peer-b', null, '/proj/b');
      insertSession('outside-only', null, '/proj/c');

      const insertEvent = (sessionId: string, text: string): number => {
        db.run(
          `INSERT INTO events (
             session_id, project_path, agent, parent_session, ts, kind,
             text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
             is_boilerplate, sensitive, raw
           ) VALUES (?, '/proj/a', 'primary', NULL, '2026-06-02T12:00:00.000Z',
             'user', ?, NULL, NULL, NULL, NULL, NULL, 0, 0, '{}')`,
          [sessionId, text],
        );
        return Number(db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id);
      };
      const eParent = insertEvent('parent-sess', 'from parent');
      const ePeerA = insertEvent('peer-a', 'from peer-a');
      const ePeerB = insertEvent('peer-b', 'from peer-b');
      const eOutside = insertEvent('outside-only', 'outside');
      // Two event_links between peer-a and peer-b (aggregated count=2).
      db.run(
        `INSERT INTO event_links (source_event_id, target_event_id, kind, method)
         VALUES (?, ?, 'GENERATED', 'test'), (?, ?, 'USED', 'test')`,
        [ePeerA, ePeerB, ePeerA, ePeerB],
      );
      // Cross-set link: parent → outside (should drop when outside not in set).
      db.run(
        `INSERT INTO event_links (source_event_id, target_event_id, kind, method)
         VALUES (?, ?, 'GENERATED', 'test')`,
        [eParent, eOutside],
      );
      db.close();
    }

    const qs = openQueryService(path);
    try {
      expect(qs.links([])).toEqual([]);
      const full = qs.links(['parent-sess', 'child-sess', 'peer-a', 'peer-b']);
      const parentage = full.filter((l) => l.kind === 'parentage');
      expect(parentage).toEqual([
        { source: 'child-sess', target: 'parent-sess', kind: 'parentage', count: 1 },
      ]);
      const events = full.filter((l) => l.kind === 'event');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        source: 'peer-a',
        target: 'peer-b',
        kind: 'event',
        count: 2,
      });
      // Co-visible: without peer-b, event edge drops; without parent, parentage drops.
      const noPeerB = qs.links(['parent-sess', 'child-sess', 'peer-a']);
      expect(noPeerB.filter((l) => l.kind === 'event')).toHaveLength(0);
      expect(noPeerB.filter((l) => l.kind === 'parentage')).toHaveLength(1);
      const noParent = qs.links(['child-sess', 'peer-a', 'peer-b']);
      expect(noParent.filter((l) => l.kind === 'parentage')).toHaveLength(0);
      expect(noParent.filter((l) => l.kind === 'event')).toHaveLength(1);
    } finally {
      qs.close();
    }
  });

  test('links() is resilient when event_links table is absent', () => {
    // goodDbPath is v4 synthetic without event_links — parentage only if any.
    const qs = openQueryService(goodDbPath);
    try {
      const links = qs.links(['sess-newer', 'sess-older']);
      expect(Array.isArray(links)).toBe(true);
      expect(links.every((l) => l.kind === 'parentage' || l.kind === 'event')).toBe(true);
    } finally {
      qs.close();
    }
  });
});

describe('schema v5 title column', () => {
  test('sessionList returns titles; search joins title; v4 stays empty', () => {
    const v5Path = join(tempRoot, 'v5-titles.sqlite');
    {
      const db = new Database(v5Path);
      db.exec(SYNTHETIC_DDL);
      db.run('ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT \'\'');
      db.run('PRAGMA user_version = 5');
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
         ) VALUES ('sess-titled', '/proj/a', 'primary', NULL, 'm',
           '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 1, 1, 0, 0,
           'Repeat Previous Single Word Reply Request')`,
      );
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES ('sess-titled', '/proj/a', 'primary', NULL, '2026-06-02T12:00:00.000Z',
           'user', 'junction path title search', NULL, NULL, NULL, NULL, NULL, 0, 0, '{}')`,
      );
      const eid = Number(
        db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id,
      );
      db.run(
        `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         VALUES (?, 'junction path title search', NULL, NULL, NULL)`,
        [eid],
      );
      db.close();
    }

    const qs = openQueryService(v5Path);
    try {
      expect(qs.getVersion()).toBe(5);
      expect(qs.schemaOK()).toBe(true);
      const list = qs.sessionList();
      expect(list.length).toBe(1);
      expect(list[0]!.title).toBe('Repeat Previous Single Word Reply Request');
      const hits = qs.search('junction', { limit: 5 });
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.title).toBe('Repeat Previous Single Word Reply Request');
      expect(hits[0]!.sessionId).toBe('sess-titled');
    } finally {
      qs.close();
    }
  });
});

describe('busy / retry on QueryService', () => {
  test('retries then succeeds; busy() false', () => {
    // forceBusyAttempts is on OpenQueryServiceOpts; force 2 then succeed.
    const qs = openQueryService({
      path: goodDbPath,
      forceBusyAttempts: 2,
      maxAttempts: 3,
      delayMs: 0,
      sleep: () => {},
    }) as QueryService & { forceBusy(n: number): void };
    try {
      const st = qs.status();
      expect(st.sessions).toBe(2);
      expect(qs.busy()).toBe(false);
    } finally {
      qs.close();
    }
  });

  test('exhausted busy → busy() true and empty fallback', () => {
    const qs = openQueryService({
      path: goodDbPath,
      forceBusyAttempts: 10,
      maxAttempts: 3,
      delayMs: 0,
      sleep: () => {},
    });
    try {
      const list = qs.sessionList();
      expect(list).toEqual([]);
      expect(qs.busy()).toBe(true);
    } finally {
      qs.close();
    }
  });
});

describe('status session split (primary / subagent)', () => {
  test('mix of primary + subagent + unknown agent classifies correctly', () => {
    const path = join(tempRoot, 'agent-split.sqlite');
    {
      const db = new Database(path);
      db.exec(SYNTHETIC_DDL);
      db.run('PRAGMA user_version = 4');
      const insert = (
        id: string,
        agent: string,
        parent: string | null,
      ): void => {
        db.run(
          `INSERT INTO sessions (
             id, project_path, agent, parent_session, model_id,
             started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
           ) VALUES (?, '/p', ?, ?, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z', 0, 0, 0, 0)`,
          [id, agent, parent],
        );
      };
      insert('p1', 'primary', null);
      insert('p2', 'primary', null);
      insert('s1', 'subagent', 'p1');
      insert('s2', 'subagent', 'p1');
      insert('s3', 'subagent', 'p2');
      // Unclassifiable → primary bucket (never NaN/undefined).
      insert('weird', 'orchestrator', null);
      insert('empty-ish', '', null);
      db.close();
    }

    const qs = openQueryService(path);
    try {
      const st = qs.status();
      expect(st.sessions).toBe(7);
      expect(st.subagentSessions).toBe(3);
      // primary(2) + orchestrator(1) + empty(1) = 4
      expect(st.primarySessions).toBe(4);
      expect(st.primarySessions + st.subagentSessions).toBe(st.sessions);
      expect(typeof st.primarySessions).toBe('number');
      expect(typeof st.subagentSessions).toBe('number');
      expect(Number.isNaN(st.primarySessions)).toBe(false);
      expect(Number.isNaN(st.subagentSessions)).toBe(false);
      expect(st.byAgent.primary).toBe(2);
      expect(st.byAgent.subagent).toBe(3);
      expect(st.byAgent.orchestrator).toBe(1);
      expect(st.byAgent['']).toBe(1);
    } finally {
      qs.close();
    }
  });

  test('all-subagent corpus: primarySessions is 0, not undefined', () => {
    const path = join(tempRoot, 'all-sub.sqlite');
    {
      const db = new Database(path);
      db.exec(SYNTHETIC_DDL);
      db.run('PRAGMA user_version = 4');
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
         ) VALUES ('c1', '/p', 'subagent', 'parent', NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z', 0, 0, 0, 0)`,
      );
      db.close();
    }
    const qs = openQueryService(path);
    try {
      const st = qs.status();
      expect(st.sessions).toBe(1);
      expect(st.primarySessions).toBe(0);
      expect(st.subagentSessions).toBe(1);
      expect(st.byAgent).toEqual({ subagent: 1 });
    } finally {
      qs.close();
    }
  });
});

describe('close / reopen', () => {
  test('reopen picks up rows written between close and reopen', () => {
    const path = join(tempRoot, 'reopen.sqlite');
    // Fresh writable seed
    {
      const db = new Database(path);
      db.exec(SYNTHETIC_DDL);
      db.run('PRAGMA user_version = 4');
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
         ) VALUES ('s1', '/p', 'primary', NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z', 0, 0, 0, 0)`,
      );
      db.close();
    }

    const qs = openQueryService(path);
    try {
      expect(qs.sessionList().length).toBe(1);
      qs.close();

      // CLI-style write while closed
      {
        const w = new Database(path);
        w.run(
          `INSERT INTO sessions (
             id, project_path, agent, parent_session, model_id,
             started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
           ) VALUES ('s2', '/p', 'primary', NULL, NULL, '2026-06-03T00:00:00.000Z', '2026-06-03T01:00:00.000Z', 0, 0, 0, 0)`,
        );
        w.close();
      }

      qs.reopen();
      const list = qs.sessionList();
      expect(list.length).toBe(2);
      expect(list[0]!.id).toBe('s2');
    } finally {
      qs.close();
    }
  });
});

// ---------------------------------------------------------------------------
// v6 sessionList opts / sessionCount / turnDetail / annotations / sessionLinks
// ---------------------------------------------------------------------------

const V6_SESSIONS_ALTER = `
ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN cwd_class TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN subagent_type TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT '';
`;

const V6_EXTRA_TABLES = `
CREATE TABLE session_annotations (
  session_id     TEXT PRIMARY KEY,
  phase_class    TEXT NOT NULL DEFAULT '',
  error_density  REAL NOT NULL DEFAULT 0,
  probe_hits     TEXT NOT NULL DEFAULT '{}',
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  duration_sec   REAL NOT NULL DEFAULT 0,
  method         TEXT NOT NULL DEFAULT ''
);
CREATE TABLE session_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_session  TEXT NOT NULL,
  target_session  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  method          TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  heuristic       INTEGER NOT NULL DEFAULT 0,
  evidence        TEXT NOT NULL DEFAULT '',
  UNIQUE(source_session, target_session, kind)
);
CREATE TABLE event_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_id  INTEGER NOT NULL,
  target_event_id  INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  method           TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  heuristic        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_event_id, target_event_id, kind)
);
`;

function seedV6Index(path: string): void {
  const db = new Database(path);
  try {
    db.exec(SYNTHETIC_DDL);
    db.exec(V6_SESSIONS_ALTER);
    db.exec(V6_EXTRA_TABLES);
    db.run('PRAGMA user_version = 6');

    type Sess = {
      id: string;
      project: string;
      agent: string;
      parent: string | null;
      started: string;
      turns: number;
      errors: number;
      title: string;
      cwd: string;
      agentName: string;
      subType: string;
      desc: string;
      titleSrc: string;
    };
    const insertSess = (s: Sess) => {
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count,
           title, cwd_class, agent_name, subagent_type, description, title_source
         ) VALUES (?, ?, ?, ?, 'm', ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.id,
          s.project,
          s.agent,
          s.parent,
          s.started,
          s.started,
          s.turns,
          s.errors,
          s.title,
          s.cwd,
          s.agentName,
          s.subType,
          s.desc,
          s.titleSrc,
        ],
      );
    };

    insertSess({
      id: 'op-primary',
      project: '/Users/op/Documents/amore-build',
      agent: 'primary',
      parent: null,
      started: '2026-06-10T12:00:00.000Z',
      turns: 5,
      errors: 1,
      title: 'Operator Build Work',
      cwd: 'operator',
      agentName: 'grok-build',
      subType: '',
      desc: '',
      titleSrc: 'summary',
    });
    insertSess({
      id: 'op-sub',
      project: '/Users/op/Documents/amore-build',
      agent: 'subagent',
      parent: 'op-primary',
      started: '2026-06-10T12:30:00.000Z',
      turns: 2,
      errors: 0,
      title: '',
      cwd: 'operator',
      agentName: '',
      subType: 'explore',
      desc: 'Explore the map stage',
      titleSrc: '',
    });
    insertSess({
      id: 'exp-primary',
      project: '/Users/op/Documents/experiments/demo',
      agent: 'primary',
      parent: null,
      started: '2026-06-05T08:00:00.000Z',
      turns: 12,
      errors: 4,
      title: 'Experiment Demo Run',
      cwd: 'experiment',
      agentName: 'smoke-agent',
      subType: '',
      desc: '',
      titleSrc: 'harness',
    });
    insertSess({
      id: 'har-primary',
      project: '/tmp/harness-run',
      agent: 'primary',
      parent: null,
      started: '2026-05-01T00:00:00.000Z',
      turns: 1,
      errors: 0,
      title: 'Harness Quiet Session',
      cwd: 'harness',
      agentName: 'ci-runner',
      subType: '',
      desc: '',
      titleSrc: 'generated',
    });
    insertSess({
      id: 'unk-primary',
      project: 'C:\\Other\\ProjectX',
      agent: 'primary',
      parent: null,
      started: '2026-06-08T15:00:00.000Z',
      turns: 3,
      errors: 2,
      title: 'Unknown Class Title',
      cwd: 'unknown',
      agentName: '',
      subType: '',
      desc: '',
      titleSrc: '',
    });

    // Events for turnDetail (full tool payload) + parentage links.
    db.run(
      `INSERT INTO events (
         session_id, project_path, agent, parent_session, ts, kind,
         text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
         is_boilerplate, sensitive, raw
       ) VALUES (
         'op-primary', '/Users/op/Documents/amore-build', 'primary', NULL,
         '2026-06-10T12:01:00.000Z', 'tool_use',
         'read the file', 'Read', '{"path":"/x"}', '{"content":"full output body"}', 0, 'tc1',
         0, 0, '{"secret":"NEVER_EXPOSE"}'
       )`,
    );
    db.run(
      `INSERT INTO events (
         session_id, project_path, agent, parent_session, ts, kind,
         text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
         is_boilerplate, sensitive, raw
       ) VALUES (
         'exp-primary', '/Users/op/Documents/experiments/demo', 'primary', NULL,
         '2026-06-05T08:01:00.000Z', 'user',
         NULL, NULL, NULL, NULL, NULL, NULL,
         0, 0, '{}'
       )`,
    );

    db.run(
      `INSERT INTO session_annotations (
         session_id, phase_class, error_density, probe_hits,
         input_tokens, output_tokens, total_tokens, duration_sec, method
       ) VALUES (
         'op-primary', 'build', 0.12, '{"privacy":2,"staleness":1}',
         100, 200, 300, 45.5, 'heuristic-v1'
       )`,
    );
    db.run(
      `INSERT INTO session_annotations (
         session_id, phase_class, error_density, probe_hits,
         input_tokens, output_tokens, total_tokens, duration_sec, method
       ) VALUES (
         'exp-primary', 'explore', 0.5, 'NOT-JSON{{{',
         10, 20, 30, 12, 'heuristic-v1'
       )`,
    );

    db.run(
      `INSERT INTO session_links (source_session, target_session, kind, method)
       VALUES ('op-primary', 'exp-primary', 'resumed_from', 'title-match')`,
    );
    db.run(
      `INSERT INTO session_links (source_session, target_session, kind, method)
       VALUES ('op-primary', 'unk-primary', 'shared_artifact', 'path-match')`,
    );
    // Outside-set target should drop when only op-primary + exp-primary requested.
    db.run(
      `INSERT INTO session_links (source_session, target_session, kind, method)
       VALUES ('op-primary', 'har-primary', 'resumed_from', 'title-match')`,
    );
  } finally {
    db.close();
  }
}

describe('sessionList opts + sessionCount', () => {
  let qs: QueryService;

  beforeAll(() => {
    qs = openQueryService(v6DbPath);
  });

  afterAll(() => {
    qs.close();
  });

  test('legacy sessionList(limit, offset) still works and returns facets', () => {
    const list = qs.sessionList(2, 0);
    expect(list.length).toBe(2);
    // started_at DESC: op-sub (12:30), op-primary (12:00)
    expect(list[0]!.id).toBe('op-sub');
    expect(list[1]!.id).toBe('op-primary');
    expect(list[0]!.cwdClass).toBe('operator');
    expect(list[0]!.subagentType).toBe('explore');
    expect(list[0]!.description).toBe('Explore the map stage');
    expect(list[1]!.agentName).toBe('grok-build');
    expect(list[1]!.titleSource).toBe('summary');
  });

  test('legacy offset paging', () => {
    const page1 = qs.sessionList(2, 2);
    expect(page1.length).toBe(2);
    expect(page1[0]!.id).toBe('unk-primary');
    expect(page1[1]!.id).toBe('exp-primary');
  });

  test('filter cwdClass', () => {
    const ops = qs.sessionList({ cwdClass: 'operator' });
    expect(ops.map((r) => r.id).sort()).toEqual(['op-primary', 'op-sub']);
    expect(qs.sessionCount({ cwdClass: 'operator' })).toBe(2);
  });

  test('filter agent', () => {
    const subs = qs.sessionList({ agent: 'subagent' });
    expect(subs).toHaveLength(1);
    expect(subs[0]!.id).toBe('op-sub');
    expect(qs.sessionCount({ agent: 'subagent' })).toBe(1);
  });

  test('filter project case-insensitive substring', () => {
    const rows = qs.sessionList({ project: 'amore-BUILD' });
    expect(rows.map((r) => r.id).sort()).toEqual(['op-primary', 'op-sub']);
    const win = qs.sessionList({ project: 'projectx' });
    expect(win).toHaveLength(1);
    expect(win[0]!.id).toBe('unk-primary');
  });

  test('filter since / until against started_at', () => {
    const since = qs.sessionList({ since: '2026-06-08T00:00:00.000Z' });
    expect(since.map((r) => r.id).sort()).toEqual([
      'op-primary',
      'op-sub',
      'unk-primary',
    ]);
    const until = qs.sessionList({ until: '2026-06-05T23:59:59.000Z' });
    expect(until.map((r) => r.id).sort()).toEqual(['exp-primary', 'har-primary']);
    const window = qs.sessionList({
      since: '2026-06-05T00:00:00.000Z',
      until: '2026-06-09T00:00:00.000Z',
    });
    expect(window.map((r) => r.id).sort()).toEqual(['exp-primary', 'unk-primary']);
  });

  test('filter title case-insensitive substring', () => {
    const rows = qs.sessionList({ title: 'operator build' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('op-primary');
  });

  test('filters AND-compose', () => {
    const rows = qs.sessionList({
      cwdClass: 'operator',
      agent: 'primary',
      project: 'amore',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('op-primary');
    expect(qs.sessionCount({ cwdClass: 'operator', agent: 'primary', project: 'amore' })).toBe(
      1,
    );
  });

  test('sort recent / turns / errors', () => {
    const recent = qs.sessionList({ sort: 'recent', limit: 50 });
    expect(recent[0]!.id).toBe('op-sub');
    expect(recent.map((r) => r.id)).toEqual([
      'op-sub',
      'op-primary',
      'unk-primary',
      'exp-primary',
      'har-primary',
    ]);

    const turns = qs.sessionList({ sort: 'turns', limit: 50 });
    expect(turns[0]!.id).toBe('exp-primary'); // 12 turns
    expect(turns[1]!.id).toBe('op-primary'); // 5

    const errors = qs.sessionList({ sort: 'errors', limit: 50 });
    expect(errors[0]!.id).toBe('exp-primary'); // 4 errors
    expect(errors[1]!.id).toBe('unk-primary'); // 2
  });

  test('sessionCount agrees with filtered list length', () => {
    const opts = { cwdClass: 'experiment' as const };
    const list = qs.sessionList({ ...opts, limit: 100 });
    expect(qs.sessionCount(opts)).toBe(list.length);
    expect(qs.sessionCount({})).toBe(5);
    expect(qs.sessionCount({})).toBe(qs.sessionList({ limit: 100 }).length);
  });

  test('opts form offset paging', () => {
    const p0 = qs.sessionList({ sort: 'recent', limit: 2, offset: 0 });
    const p1 = qs.sessionList({ sort: 'recent', limit: 2, offset: 2 });
    expect(p0.map((r) => r.id)).toEqual(['op-sub', 'op-primary']);
    expect(p1.map((r) => r.id)).toEqual(['unk-primary', 'exp-primary']);
  });
});

describe('turnDetail', () => {
  test('maps full untruncated columns; raw never present; null → empty string', () => {
    const qs = openQueryService(v6DbPath);
    try {
      // Find tool_use event for op-primary.
      const turns = qs.turns('op-primary');
      expect(turns.length).toBeGreaterThanOrEqual(1);
      const eid = turns[0]!.eventId;
      const detail = qs.turnDetail(eid);
      expect(detail).not.toBeNull();
      expect(detail!.eventId).toBe(eid);
      expect(detail!.sessionId).toBe('op-primary');
      expect(detail!.kind).toBe('tool_use');
      expect(detail!.text).toBe('read the file');
      expect(detail!.toolName).toBe('Read');
      expect(detail!.toolInput).toBe('{"path":"/x"}');
      expect(detail!.toolOutput).toBe('{"content":"full output body"}');
      expect(detail!.toolError).toBe('0');
      // raw must never appear on the returned object.
      expect(Object.keys(detail!).includes('raw')).toBe(false);
      expect(JSON.stringify(detail)).not.toContain('NEVER_EXPOSE');
      expect(JSON.stringify(detail)).not.toContain('"raw"');

      // Null columns normalize to ''.
      const nullTurns = qs.turns('exp-primary');
      expect(nullTurns.length).toBe(1);
      const nullDetail = qs.turnDetail(nullTurns[0]!.eventId);
      expect(nullDetail).not.toBeNull();
      expect(nullDetail!.text).toBe('');
      expect(nullDetail!.toolName).toBe('');
      expect(nullDetail!.toolInput).toBe('');
      expect(nullDetail!.toolOutput).toBe('');
      expect(nullDetail!.toolError).toBe('');

      expect(qs.turnDetail(999999)).toBeNull();
    } finally {
      qs.close();
    }
  });
});

describe('annotations', () => {
  test('parses probe_hits; bad JSON → {}; empty input → {}', () => {
    const qs = openQueryService(v6DbPath);
    try {
      expect(qs.annotations([])).toEqual({});
      const map = qs.annotations(['op-primary', 'exp-primary', 'missing-id']);
      expect(Object.keys(map).sort()).toEqual(['exp-primary', 'op-primary']);
      expect(map['op-primary']).toEqual({
        phaseClass: 'build',
        errorDensity: 0.12,
        probeHits: { privacy: 2, staleness: 1 },
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        durationSec: 45.5,
        method: 'heuristic-v1',
      });
      // Bad JSON falls back to {}.
      expect(map['exp-primary']!.probeHits).toEqual({});
      expect(map['exp-primary']!.phaseClass).toBe('explore');
      expect(map['exp-primary']!.method).toBe('heuristic-v1');
    } finally {
      qs.close();
    }
  });
});

describe('sessionLinks', () => {
  test('includes session_links kinds; in-set drop; count=1; links() unchanged', () => {
    const qs = openQueryService(v6DbPath);
    try {
      const fullSet = ['op-primary', 'op-sub', 'exp-primary', 'unk-primary', 'har-primary'];
      const all = qs.sessionLinks(fullSet);
      const parentage = all.filter((l) => l.kind === 'parentage');
      expect(parentage).toEqual([
        { source: 'op-sub', target: 'op-primary', kind: 'parentage', count: 1 },
      ]);
      const resumed = all.filter((l) => l.kind === 'resumed_from');
      expect(resumed).toHaveLength(2);
      expect(
        resumed.every((l) => l.count === 1 && l.kind === 'resumed_from'),
      ).toBe(true);
      const shared = all.filter((l) => l.kind === 'shared_artifact');
      expect(shared).toEqual([
        {
          source: 'op-primary',
          target: 'unk-primary',
          kind: 'shared_artifact',
          count: 1,
        },
      ]);

      // Co-visible: drop edges to har-primary when not in set.
      const partial = qs.sessionLinks(['op-primary', 'exp-primary']);
      expect(partial.filter((l) => l.kind === 'resumed_from')).toEqual([
        {
          source: 'op-primary',
          target: 'exp-primary',
          kind: 'resumed_from',
          count: 1,
        },
      ]);
      expect(partial.filter((l) => l.kind === 'shared_artifact')).toHaveLength(0);
      expect(partial.filter((l) => l.target === 'har-primary')).toHaveLength(0);

      // links() stays parentage + event only (no session_links kinds).
      const base = qs.links(fullSet);
      expect(base.every((l) => l.kind === 'parentage' || l.kind === 'event')).toBe(true);
      expect(base.filter((l) => l.kind === 'resumed_from')).toHaveLength(0);
      expect(base.filter((l) => l.kind === 'shared_artifact')).toHaveLength(0);
      // sessionLinks is a superset of links for the same set.
      expect(all.length).toBeGreaterThanOrEqual(base.length);
    } finally {
      qs.close();
    }
  });
});

describe('v5 / v4 graceful degrade', () => {
  test('v5: facets empty, annotations {}, sessionLinks equals links, filters ignored', () => {
    const path = join(tempRoot, 'v5-degrade.sqlite');
    {
      const db = new Database(path);
      db.exec(SYNTHETIC_DDL);
      db.run(`ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
      db.run(`
        CREATE TABLE event_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_event_id INTEGER NOT NULL,
          target_event_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          method TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          heuristic INTEGER NOT NULL DEFAULT 0,
          UNIQUE(source_event_id, target_event_id, kind)
        );
      `);
      db.run('PRAGMA user_version = 5');
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
         ) VALUES
           ('p1', '/proj/A', 'primary', NULL, 'm', '2026-06-02T12:00:00.000Z', '2026-06-02T13:00:00.000Z', 2, 1, 0, 0, 'Alpha Title'),
           ('c1', '/proj/A', 'subagent', 'p1', 'm', '2026-06-02T12:30:00.000Z', '2026-06-02T13:00:00.000Z', 1, 1, 0, 0, '')`,
      );
      db.close();
    }

    const qs = openQueryService(path);
    try {
      expect(qs.getVersion()).toBe(5);
      expect(qs.schemaOK()).toBe(true);
      const list = qs.sessionList({ limit: 10 });
      expect(list).toHaveLength(2);
      // started_at DESC: c1 (12:30) then p1 (12:00 with title).
      expect(list[0]!.id).toBe('c1');
      expect(list[1]!.id).toBe('p1');
      expect(list[1]!.title).toBe('Alpha Title');
      // v6 facets absent → ''.
      expect(list[1]!.cwdClass).toBe('');
      expect(list[1]!.agentName).toBe('');
      expect(list[1]!.subagentType).toBe('');
      expect(list[1]!.description).toBe('');
      expect(list[1]!.titleSource).toBe('');

      // cwdClass filter needs missing column → ignored, returns all.
      expect(qs.sessionList({ cwdClass: 'operator' }).length).toBe(2);
      expect(qs.sessionCount({ cwdClass: 'operator' })).toBe(2);

      // title filter still works on v5.
      expect(qs.sessionList({ title: 'alpha' })).toHaveLength(1);

      expect(qs.annotations(['p1', 'c1'])).toEqual({});

      const base = qs.links(['p1', 'c1']);
      const extended = qs.sessionLinks(['p1', 'c1']);
      expect(extended).toEqual(base);
      expect(extended).toEqual([
        { source: 'c1', target: 'p1', kind: 'parentage', count: 1 },
      ]);
    } finally {
      qs.close();
    }
  });

  test('v4: empty facets; title filter ignored; no throw', () => {
    const qs = openQueryService(goodDbPath);
    try {
      const list = qs.sessionList({ limit: 50 });
      expect(list.length).toBe(2);
      expect(list[0]!.cwdClass).toBe('');
      expect(list[0]!.title).toBe('');
      // title filter ignored without column — still returns rows.
      expect(qs.sessionList({ title: 'anything' }).length).toBe(2);
      expect(qs.sessionCount({ title: 'anything' })).toBe(2);
      expect(qs.annotations(['sess-newer'])).toEqual({});
      expect(qs.sessionLinks(['sess-newer', 'sess-older'])).toEqual(
        qs.links(['sess-newer', 'sess-older']),
      );
    } finally {
      qs.close();
    }
  });
});
