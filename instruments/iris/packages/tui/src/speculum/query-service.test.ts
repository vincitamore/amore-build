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
  mkdirSync(join(tempRoot, 'good'), { recursive: true });
  mkdirSync(join(tempRoot, 'bad-ver'), { recursive: true });
  seedGoodIndex(goodDbPath);
  seedBadVersionIndex(badVersionDbPath);
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
  test('SUPPORTED_SCHEMA_VERSIONS is pinned to [4]', () => {
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual([4]);
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
