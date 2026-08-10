import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveSessionsState,
  EMPTY_DETAIL,
  enrichWithSessionSplit,
  fetchStatusState,
  formatIngestAge,
  formatReadyStripDetail,
  INSTALL_RECIPE,
} from './status';
import { openQueryService } from './query-service';

/** Minimal schema matching query-service reads (SCHEMA_VERSION 4). */
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

describe('deriveSessionsState', () => {
  test('null input → null (loading holder)', () => {
    expect(deriveSessionsState(null)).toBeNull();
  });

  test('not-installed → not-installed with install recipe detail', () => {
    const d = deriveSessionsState({
      ok: false,
      error: { kind: 'not-installed', message: 'speculum binary not found (speculum)' },
    });
    expect(d).toEqual({
      state: 'not-installed',
      sessions: 0,
      detail: INSTALL_RECIPE,
    });
    expect(d!.detail).toBe('amore init --with-speculum');
  });

  test('other error → error with kind + message detail', () => {
    const d = deriveSessionsState({
      ok: false,
      error: { kind: 'timeout', message: 'speculum status exceeded 30000ms' },
    });
    expect(d!.state).toBe('error');
    expect(d!.sessions).toBe(0);
    expect(d!.detail).toBe('timeout: speculum status exceeded 30000ms');
  });

  test('error without message falls back to unknown error', () => {
    const d = deriveSessionsState({
      ok: false,
      error: { kind: 'spawn-failed' },
    });
    expect(d!.state).toBe('error');
    expect(d!.detail).toBe('spawn-failed: unknown error');
  });

  test('ok && sessions === 0 → empty', () => {
    const d = deriveSessionsState({
      ok: true,
      json: { counts: { sessions: 0 } },
    });
    expect(d).toEqual({
      state: 'empty',
      sessions: 0,
      detail: EMPTY_DETAIL,
    });
    expect(d!.detail).toBe("no ingested sessions — run 'speculum ingest'");
  });

  test('ok && undefined counts → empty (edge)', () => {
    const d = deriveSessionsState({ ok: true, json: {} });
    expect(d!.state).toBe('empty');
    expect(d!.sessions).toBe(0);
    expect(d!.detail).toBe(EMPTY_DETAIL);
  });

  test('ok && missing json → empty', () => {
    const d = deriveSessionsState({ ok: true });
    expect(d!.state).toBe('empty');
    expect(d!.sessions).toBe(0);
  });

  test('ok && sessions > 0 → ready with session dirs copy (no invented split)', () => {
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const d = deriveSessionsState({
      ok: true,
      json: {
        counts: { sessions: 7 },
        ingest: { lastIngestedAt: '2026-06-01T11:30:00.000Z' },
        staleness: { stale: false },
      },
    });
    expect(d!.state).toBe('ready');
    expect(d!.sessions).toBe(7);
    expect(d!.primarySessions).toBeUndefined();
    expect(d!.subagentSessions).toBeUndefined();
    // CLI-only path: honest "session dirs", no primary/subagent invention.
    expect(d!.detail).toMatch(/^installed · 7 session dirs · last ingest /);
    expect(d!.detail).not.toMatch(/primary|subagent/);
    expect(d!.detail).not.toMatch(/stale/);

    // Deterministic age via formatIngestAge.
    expect(formatIngestAge('2026-06-01T11:30:00.000Z', now)).toBe('30m ago');
  });

  test('ready with stale flag appends · stale', () => {
    const d = deriveSessionsState({
      ok: true,
      json: {
        counts: { sessions: 2 },
        ingest: { lastIngestedAt: null },
        staleness: { stale: true },
      },
    });
    expect(d!.state).toBe('ready');
    expect(d!.detail).toMatch(/last ingest never · stale$/);
    expect(d!.detail).toMatch(/session dirs/);
  });
});

describe('formatReadyStripDetail', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');

  test('without split → session dirs + last ingest', () => {
    expect(
      formatReadyStripDetail({
        sessions: 1699,
        lastIngestedAt: '2026-06-01T11:00:00.000Z',
        now,
      }),
    ).toBe('installed · 1699 session dirs · last ingest 1h ago');
  });

  test('with split → session dirs · primary · subagent · last ingest', () => {
    expect(
      formatReadyStripDetail({
        sessions: 1699,
        primarySessions: 412,
        subagentSessions: 1287,
        lastIngestedAt: '2026-06-01T11:00:00.000Z',
        now,
      }),
    ).toBe(
      'installed · 1699 session dirs · 412 primary · 1287 subagent · last ingest 1h ago',
    );
  });
});

describe('formatIngestAge', () => {
  const now = Date.parse('2026-03-15T12:00:00.000Z');

  test('null/empty/unparseable → never', () => {
    expect(formatIngestAge(null, now)).toBe('never');
    expect(formatIngestAge(undefined, now)).toBe('never');
    expect(formatIngestAge('', now)).toBe('never');
    expect(formatIngestAge('not-a-date', now)).toBe('never');
  });

  test('coarsens minutes / hours / days', () => {
    expect(formatIngestAge('2026-03-15T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatIngestAge('2026-03-15T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatIngestAge('2026-03-13T12:00:00.000Z', now)).toBe('2d ago');
  });
});

describe('enrichWithSessionSplit', () => {
  let tmp: string;
  let splitDb: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'status-split-'));
    splitDb = join(tmp, 'split.sqlite');
    mkdirSync(tmp, { recursive: true });
    const db = new Database(splitDb);
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 4');
    const insert = (id: string, agent: string, parent: string | null): void => {
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
    db.run(
      `INSERT INTO ingest_state (
         file_path, size_bytes, mtime, byte_offset, last_ingested, forgotten
       ) VALUES ('/s.jsonl', 1, '2026-06-01T00:00:00.000Z', 1, '2026-06-01T02:00:00.000Z', 0)`,
    );
    db.close();
  });

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test('schemaOK index enriches ready state with primary/subagent split', () => {
    const base = deriveSessionsState({
      ok: true,
      json: {
        counts: { sessions: 99 },
        ingest: { lastIngestedAt: null },
      },
    })!;
    const enriched = enrichWithSessionSplit(base, () => openQueryService(splitDb));
    expect(enriched.state).toBe('ready');
    expect(enriched.sessions).toBe(5);
    expect(enriched.primarySessions).toBe(2);
    expect(enriched.subagentSessions).toBe(3);
    expect(enriched.detail).toMatch(
      /installed · 5 session dirs · 2 primary · 3 subagent · last ingest /,
    );
  });

  test('missing index leaves CLI-only copy unchanged (no invented split)', () => {
    const base = deriveSessionsState({
      ok: true,
      json: {
        counts: { sessions: 12 },
        ingest: { lastIngestedAt: null },
      },
    })!;
    const missing = join(tmp, 'no-such', 'speculum.sqlite');
    const out = enrichWithSessionSplit(base, () => openQueryService(missing));
    expect(out.sessions).toBe(12);
    expect(out.primarySessions).toBeUndefined();
    expect(out.subagentSessions).toBeUndefined();
    expect(out.detail).toMatch(/^installed · 12 session dirs · last ingest /);
    expect(out.detail).not.toMatch(/primary|subagent/);
  });

  test('non-ready states pass through untouched', () => {
    const empty = { state: 'empty' as const, sessions: 0, detail: EMPTY_DETAIL };
    expect(enrichWithSessionSplit(empty, () => openQueryService(splitDb))).toEqual(empty);
  });
});

describe('fetchStatusState', () => {
  let tmp: string;
  let prevBin: string | undefined;
  let prevDb: string | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'status-fetch-'));
    prevBin = process.env.SPECULUM_BIN;
    prevDb = process.env.SPECULUM_DB;
    // Point away from any live corpus so enrichWithSessionSplit cannot invent
    // a split or overwrite the CLI count during unit tests.
    process.env.SPECULUM_DB = join(tmp, 'no-live-index.sqlite');
  });

  afterAll(() => {
    if (prevBin === undefined) delete process.env.SPECULUM_BIN;
    else process.env.SPECULUM_BIN = prevBin;
    if (prevDb === undefined) delete process.env.SPECULUM_DB;
    else process.env.SPECULUM_DB = prevDb;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function writeFakeBin(mjsBody: string): string {
    const mjs = join(tmp, `fake-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(mjs, mjsBody, 'utf8');
    if (process.platform === 'win32') {
      const cmd = join(tmp, `fake-${Date.now()}.cmd`);
      writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');
      return cmd;
    }
    const sh = join(tmp, `fake-${Date.now()}`);
    writeFileSync(sh, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mjs}" "$@"\n`, {
      encoding: 'utf8',
      mode: 0o755,
    });
    return sh;
  }

  test('wraps runSpeculum(status --json) through deriveSessionsState', async () => {
    process.env.SPECULUM_BIN = writeFakeBin(
      `console.log(JSON.stringify({ counts: { sessions: 4 }, ingest: { lastIngestedAt: null } }));\n`,
    );
    const d = await fetchStatusState();
    expect(d!.state).toBe('ready');
    expect(d!.sessions).toBe(4);
    // Missing index → no invented split; honest session-dirs wording.
    expect(d!.primarySessions).toBeUndefined();
    expect(d!.subagentSessions).toBeUndefined();
    expect(d!.detail).toMatch(/^installed · 4 session dirs · last ingest /);
  });

  test('not-installed binary maps to not-installed', async () => {
    process.env.SPECULUM_BIN = join(tmp, 'no-such-binary-does-not-exist');
    const d = await fetchStatusState();
    expect(d!.state).toBe('not-installed');
    expect(d!.detail).toBe(INSTALL_RECIPE);
  });
});
