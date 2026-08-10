import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveSessionsState,
  EMPTY_DETAIL,
  fetchStatusState,
  formatIngestAge,
  INSTALL_RECIPE,
} from './status';

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

  test('ok && sessions > 0 → ready with strip flavor', () => {
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
    // Age depends on Date.now(); just assert structure (sessions + last ingest present).
    expect(d!.detail).toMatch(/^installed · 7 sessions · last ingest /);
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

describe('fetchStatusState', () => {
  let tmp: string;
  let prevBin: string | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'status-fetch-'));
    prevBin = process.env.SPECULUM_BIN;
  });

  afterAll(() => {
    if (prevBin === undefined) delete process.env.SPECULUM_BIN;
    else process.env.SPECULUM_BIN = prevBin;
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
    expect(d!.detail).toMatch(/installed · 4 sessions/);
  });

  test('not-installed binary maps to not-installed', async () => {
    process.env.SPECULUM_BIN = join(tmp, 'no-such-binary-does-not-exist');
    const d = await fetchStatusState();
    expect(d!.state).toBe('not-installed');
    expect(d!.detail).toBe(INSTALL_RECIPE);
  });
});
