// proxies/lucerna.test.ts — Lucerna state-file proxy against tmpdir fixtures.
// Covers absent, fresh, stale, and malformed JSON for all read/write paths.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeBeatAgeSec,
  isInstalled,
  isStaleBeat,
  readEnablement,
  readHealth,
  readLog,
  readStatus,
  resolveHeartbeatIntervalSec,
  writeHalt,
  writeSleep,
  writeWake,
} from './lucerna.ts';

let org: string;
let ldir: string;

beforeEach(() => {
  org = mkdtempSync(join(tmpdir(), 'iris-lucerna-'));
  ldir = join(org, 'instruments', 'lucerna');
});
afterEach(() => {
  delete process.env.LUCERNA_HEARTBEAT_INTERVAL_SEC;
  rmSync(org, { recursive: true, force: true });
});

const ensureDir = () => mkdirSync(ldir, { recursive: true });
const wf = (name: string, content: string) => {
  ensureDir();
  writeFileSync(join(ldir, name), content);
};

describe('isInstalled', () => {
  test('absent dir → false', () => {
    expect(isInstalled(org)).toBe(false);
  });
  test('present dir → true', () => {
    ensureDir();
    expect(isInstalled(org)).toBe(true);
  });
});

describe('computeBeatAgeSec / isStaleBeat', () => {
  test('RFC3339 age', () => {
    const now = Date.parse('2026-08-05T00:02:00Z');
    expect(computeBeatAgeSec('2026-08-05T00:00:00Z', now)).toBeCloseTo(120, 5);
  });
  test('stale when age > 2 intervals', () => {
    expect(isStaleBeat(121, 60)).toBe(true);
    expect(isStaleBeat(120, 60)).toBe(false);
    expect(isStaleBeat(null, 60)).toBe(true);
  });
  test('unparseable → null', () => {
    expect(computeBeatAgeSec('not-a-date')).toBeNull();
    expect(computeBeatAgeSec(undefined)).toBeNull();
  });
});

describe('resolveHeartbeatIntervalSec', () => {
  test('default 60', () => {
    expect(resolveHeartbeatIntervalSec()).toBe(60);
  });
  test('health field', () => {
    expect(resolveHeartbeatIntervalSec(30)).toBe(30);
  });
  test('env overrides health', () => {
    process.env.LUCERNA_HEARTBEAT_INTERVAL_SEC = '45';
    expect(resolveHeartbeatIntervalSec(30)).toBe(45);
  });
});

describe('readHealth', () => {
  test('absent dir → available:false reason not-installed', () => {
    const h = readHealth(org);
    expect(h).toEqual({ available: false, reason: 'not-installed' });
  });

  test('dir present, no health.json → available true, not stale', () => {
    ensureDir();
    const h = readHealth(org);
    expect(h.available).toBe(true);
    expect(h.stale).toBe(false);
    expect(h.beatAgeSec).toBeNull();
  });

  test('malformed json → available true, stale true', () => {
    wf('health.json', '{not json');
    const h = readHealth(org);
    expect(h.available).toBe(true);
    expect(h.stale).toBe(true);
  });

  test('non-object json → available true, stale true', () => {
    wf('health.json', '[1,2,3]');
    const h = readHealth(org);
    expect(h.available).toBe(true);
    expect(h.stale).toBe(true);
  });

  test('fresh beat → available true, stale false', () => {
    const nowMs = Date.parse('2026-08-05T00:00:30Z');
    wf(
      'health.json',
      JSON.stringify({
        pid: 4242,
        startedAt: '2026-08-05T00:00:00Z',
        lastBeat: '2026-08-05T00:00:00Z',
        version: '0.1.0',
        heartbeatIntervalSec: 60,
      }),
    );
    const h = readHealth(org, nowMs);
    expect(h.available).toBe(true);
    expect(h.stale).toBe(false);
    expect(h.pid).toBe(4242);
    expect(h.version).toBe('0.1.0');
    expect(h.beatAgeSec).toBeCloseTo(30, 5);
  });

  test('stale beat → available true, stale true', () => {
    const nowMs = Date.parse('2026-08-05T00:05:00Z'); // 300s after beat
    wf(
      'health.json',
      JSON.stringify({
        lastBeat: '2026-08-05T00:00:00Z',
        heartbeatIntervalSec: 60,
      }),
    );
    const h = readHealth(org, nowMs);
    expect(h.available).toBe(true);
    expect(h.stale).toBe(true);
    expect(h.beatAgeSec).toBeCloseTo(300, 5);
  });
});

describe('readEnablement / readStatus', () => {
  test('absent enablement → both false', () => {
    ensureDir();
    expect(readEnablement(org)).toEqual({ dreamsEnabled: false, autoCommitLive: false });
  });

  test('enablement file honored', () => {
    wf('lucerna.enable.json', JSON.stringify({ dreamsEnabled: true, autoCommitLive: true }));
    expect(readEnablement(org)).toEqual({ dreamsEnabled: true, autoCommitLive: true });
  });

  test('status not-installed', () => {
    const s = readStatus(org);
    expect(s.available).toBe(false);
    expect(s.reason).toBe('not-installed');
    expect(s.enablement).toEqual({ dreamsEnabled: false, autoCommitLive: false });
  });

  test('status happy path with state + enablement', () => {
    const nowMs = Date.parse('2026-08-05T00:00:10Z');
    wf(
      'health.json',
      JSON.stringify({
        pid: 1,
        lastBeat: '2026-08-05T00:00:00Z',
        version: '0.2.0',
      }),
    );
    wf(
      'state.json',
      JSON.stringify({
        activity: 'idle',
        lastActions: [{ action: 'beat' }],
        budgets: { tokens: 100 },
      }),
    );
    wf('lucerna.enable.json', JSON.stringify({ dreamsEnabled: true, autoCommitLive: false }));
    const s = readStatus(org, nowMs);
    expect(s.available).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.version).toBe('0.2.0');
    expect(s.activity).toBe('idle');
    expect(s.budgets).toEqual({ tokens: 100 });
    expect(s.enablement).toEqual({ dreamsEnabled: true, autoCommitLive: false });
  });

  test('malformed state.json still available', () => {
    ensureDir();
    wf('state.json', '{bad');
    const s = readStatus(org);
    expect(s.available).toBe(true);
    expect(s.activity).toBeUndefined();
  });
});

describe('readLog', () => {
  test('not-installed', () => {
    const l = readLog(org);
    expect(l).toEqual({ available: false, reason: 'not-installed', lines: [], total: 0 });
  });

  test('missing log file → empty', () => {
    ensureDir();
    expect(readLog(org)).toEqual({ available: true, lines: [], total: 0 });
  });

  test('n limit + newest first', () => {
    wf('log', ['line1', 'line2', 'line3'].join('\n'));
    const l = readLog(org, 2);
    expect(l.total).toBe(3);
    expect(l.lines).toEqual(['line3', 'line2']);
  });
});

describe('writes', () => {
  test('halt not-installed → ok false', () => {
    expect(writeHalt(org)).toEqual({ available: false, reason: 'not-installed', ok: false });
  });

  test('halt/wake/sleep write sentinels', () => {
    ensureDir();
    expect(writeHalt(org)).toEqual({ available: true, ok: true });
    expect(readFileSync(join(ldir, 'halt'), 'utf8')).toBe('halted from iris');
    expect(writeWake(org)).toEqual({ available: true, ok: true });
    expect(existsSync(join(ldir, 'wake'))).toBe(true);
    expect(writeSleep(org)).toEqual({ available: true, ok: true });
    expect(existsSync(join(ldir, 'sleep'))).toBe(true);
  });
});
