// proxies/lucerna.test.ts — Lucerna state-file proxy against tmpdir fixtures.
// Covers absent, fresh, stale, and malformed JSON for all read/write paths.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  buildLucernaPulse,
  computeBeatAgeSec,
  isInstalled,
  isStaleBeat,
  parseNotificationLine,
  parseNotificationsJsonl,
  readEnablement,
  readHealth,
  readLog,
  readNotifications,
  readPulse,
  readStatus,
  resolveHeartbeatIntervalSec,
  resolveLucernaSpawnPlan,
  startLucerna,
  stopLucerna,
  writeEnablement,
  writeHalt,
  writeSleep,
  writeWake,
  type LucernaProcessDeps,
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

describe('writeEnablement', () => {
  test('not-installed → ok false', () => {
    expect(writeEnablement(org, { dreamsEnabled: true }).ok).toBe(false);
  });

  test('atomic set + re-read accuracy', () => {
    ensureDir();
    const w = writeEnablement(org, { dreamsEnabled: true });
    expect(w.ok).toBe(true);
    expect(w.enablement).toEqual({ dreamsEnabled: true, autoCommitLive: false });
    expect(readEnablement(org)).toEqual({ dreamsEnabled: true, autoCommitLive: false });

    const w2 = writeEnablement(org, { autoCommitLive: true });
    expect(w2.enablement).toEqual({ dreamsEnabled: true, autoCommitLive: true });
    expect(readEnablement(org)).toEqual({ dreamsEnabled: true, autoCommitLive: true });

    expect(writeEnablement(org, { dreamsEnabled: false, autoCommitLive: false }).ok).toBe(true);
    expect(readEnablement(org)).toEqual({ dreamsEnabled: false, autoCommitLive: false });
    // File content is valid JSON (write-temp-rename)
    const raw = JSON.parse(readFileSync(join(ldir, 'lucerna.enable.json'), 'utf8'));
    expect(raw).toEqual({ dreamsEnabled: false, autoCommitLive: false });
  });
});

describe('notifications parse', () => {
  test('parseNotificationLine rejects malformed', () => {
    expect(parseNotificationLine('')).toBeNull();
    expect(parseNotificationLine('{not json')).toBeNull();
    expect(parseNotificationLine(JSON.stringify({ ts: 't' }))).toBeNull();
    expect(
      parseNotificationLine(
        JSON.stringify({ ts: '2026-08-05T00:00:00', level: 'nope', kind: 'k', message: 'm' }),
      ),
    ).toBeNull();
  });

  test('parseNotificationsJsonl newest-first + skip bad lines', () => {
    const text = [
      JSON.stringify({ ts: 't1', level: 'info', kind: 'a', message: 'one' }),
      'not-json',
      JSON.stringify({ ts: 't2', level: 'warn', kind: 'b', message: 'two' }),
      JSON.stringify({ ts: 't3', level: 'error', kind: 'c', message: 'three', ref: 'x.md' }),
    ].join('\n');
    const r = parseNotificationsJsonl(text, 2);
    expect(r.total).toBe(3);
    expect(r.skipped).toBe(1);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].message).toBe('three');
    expect(r.entries[0].ref).toBe('x.md');
    expect(r.entries[1].message).toBe('two');
  });

  test('readNotifications absent file → honest empty', () => {
    ensureDir();
    expect(readNotifications(org)).toEqual({
      available: true,
      entries: [],
      total: 0,
      skipped: 0,
    });
  });

  test('readNotifications not-installed', () => {
    expect(readNotifications(org).available).toBe(false);
    expect(readNotifications(org).reason).toBe('not-installed');
  });

  test('readNotifications file present', () => {
    wf(
      'notifications.jsonl',
      JSON.stringify({ ts: '2026-08-05T01:00:00', level: 'info', kind: 'beat', message: 'ok' }) +
        '\n',
    );
    const n = readNotifications(org, 10);
    expect(n.available).toBe(true);
    expect(n.total).toBe(1);
    expect(n.entries[0].kind).toBe('beat');
  });
});

describe('pulse-row data shape', () => {
  test('buildLucernaPulse states', () => {
    expect(buildLucernaPulse({ available: false, reason: 'not-installed' }).state).toBe(
      'not-installed',
    );
    expect(
      buildLucernaPulse({ available: true, stale: false, beatAgeSec: null }).state,
    ).toBe('stopped');
    expect(
      buildLucernaPulse({
        available: true,
        stale: false,
        lastBeat: '2026-08-05T00:00:00Z',
        beatAgeSec: 5,
        pid: 9,
      }).state,
    ).toBe('running');
    expect(
      buildLucernaPulse({
        available: true,
        stale: true,
        lastBeat: '2026-08-05T00:00:00Z',
        beatAgeSec: 999,
      }).state,
    ).toBe('stale');
  });

  test('readPulse includes last notification', () => {
    ensureDir();
    const now = Date.parse('2026-08-05T00:00:10Z');
    wf(
      'health.json',
      JSON.stringify({
        pid: 3,
        lastBeat: '2026-08-05T00:00:00Z',
        version: '0.1.0',
      }),
    );
    wf(
      'notifications.jsonl',
      JSON.stringify({
        ts: '2026-08-05T00:00:05',
        level: 'info',
        kind: 'cycle',
        message: 'tick',
      }) + '\n',
    );
    // freeze time via health age with real Date.now — use build from known reads
    const health = readHealth(org, now);
    const notes = readNotifications(org, 1);
    const pulse = buildLucernaPulse(health, notes.entries[0] ?? null);
    expect(pulse.state).toBe('running');
    expect(pulse.lastNotification?.message).toBe('tick');
    expect(pulse.beatAgeSec).toBeCloseTo(10, 5);
    // live reader also returns a pulse shape
    const live = readPulse(org);
    expect(live).toHaveProperty('state');
    expect(live).toHaveProperty('beatAgeSec');
    expect(live).toHaveProperty('lastNotification');
  });
});

describe('resolveLucernaSpawnPlan', () => {
  test('resolution order: env → path → repo', () => {
    const fakeBin = join(org, 'custom-lucerna.exe');
    writeFileSync(fakeBin, 'x');
    const planEnv = resolveLucernaSpawnPlan(org, {
      env: { IRIS_LUCERNA_BIN: fakeBin },
      exists: existsSync,
      findOnPath: () => null,
    });
    expect(planEnv?.source).toBe('env');
    expect(planEnv?.cmd).toBe(fakeBin);

    const pathBin = join(org, 'path-lucerna');
    writeFileSync(pathBin, 'x');
    const planPath = resolveLucernaSpawnPlan(org, {
      env: {},
      exists: existsSync,
      findOnPath: (n) => (n === 'lucerna' ? pathBin : null),
    });
    expect(planPath?.source).toBe('path');
    expect(planPath?.cmd).toBe(pathBin);
    expect(planPath?.args).toEqual(['start', '--house', resolve(org)]);

    ensureDir();
    const cli = join(ldir, 'src', 'cli.ts');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '//');
    const planRepo = resolveLucernaSpawnPlan(org, {
      env: {},
      exists: existsSync,
      findOnPath: () => null,
    });
    expect(planRepo?.source).toBe('repo');
    expect(planRepo?.args[0]).toBe(cli);
  });

  test('no binary → null', () => {
    ensureDir();
    expect(
      resolveLucernaSpawnPlan(org, {
        env: {},
        exists: () => false,
        findOnPath: () => null,
      }),
    ).toBeNull();
  });
});

describe('startLucerna (spawn stub — windows + posix paths)', () => {
  function liveBeat() {
    wf(
      'health.json',
      JSON.stringify({
        pid: 4242,
        lastBeat: new Date().toISOString(),
        version: '0.1.0',
        heartbeatIntervalSec: 60,
      }),
    );
  }

  test('not-installed', async () => {
    const r = await startLucerna(org, { sleep: async () => {} });
    expect(r.outcome).toBe('not-installed');
    expect(r.ok).toBe(false);
  });

  test('already-running', async () => {
    liveBeat();
    const r = await startLucerna(org, { sleep: async () => {} });
    expect(r.outcome).toBe('already-running');
    expect(r.ok).toBe(true);
    expect(r.pid).toBe(4242);
  });

  test('no-binary', async () => {
    ensureDir();
    const r = await startLucerna(org, {
      env: {},
      findOnPath: () => null,
      exists: (p) => p === ldir || p === join(org, 'instruments', 'lucerna'),
      sleep: async () => {},
    });
    expect(r.outcome).toBe('no-binary');
    expect(r.ok).toBe(false);
  });

  for (const platform of ['win32', 'linux'] as const) {
    test(`spawn detached path on ${platform} then liveness`, async () => {
      ensureDir();
      const spawns: Array<{ cmd: string; args: string[]; platform: string }> = [];
      let tick = 0;
      const deps: LucernaProcessDeps = {
        platform,
        env: { IRIS_LUCERNA_BIN: join(org, 'fake-lucerna') },
        exists: (p) => existsSync(p) || p === join(org, 'fake-lucerna') || p === ldir,
        findOnPath: () => null,
        spawnDetached: (cmd, args, opts) => {
          spawns.push({ cmd, args, platform: opts.platform });
          return { pid: 9001 };
        },
        sleep: async () => {
          tick += 1;
          if (tick >= 2) liveBeat();
        },
        nowMs: (() => {
          let t = 1_000;
          return () => {
            t += 100;
            return t;
          };
        })(),
        startTimeoutMs: 5_000,
        startPollMs: 1,
      };
      // Ensure fake bin "exists" for resolve
      writeFileSync(join(org, 'fake-lucerna'), 'x');
      const r = await startLucerna(org, deps);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].platform).toBe(platform);
      expect(spawns[0].args).toContain('start');
      expect(spawns[0].args).toContain('--house');
      expect(r.ok).toBe(true);
      expect(r.outcome).toBe('started');
      expect(r.source).toBe('env');
    });
  }

  test('timeout when beat never arrives', async () => {
    ensureDir();
    writeFileSync(join(org, 'fake-lucerna'), 'x');
    let now = 0;
    const r = await startLucerna(org, {
      platform: 'win32',
      env: { IRIS_LUCERNA_BIN: join(org, 'fake-lucerna') },
      exists: existsSync,
      findOnPath: () => null,
      spawnDetached: () => ({ pid: 1 }),
      sleep: async () => {},
      nowMs: () => {
        now += 1_000;
        return now;
      },
      startTimeoutMs: 2_500,
      startPollMs: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('timeout');
  });
});

describe('stopLucerna (graceful + escalation)', () => {
  test('already-stopped', async () => {
    ensureDir();
    const r = await stopLucerna(org, {
      sleep: async () => {},
      isPidAlive: () => false,
    });
    expect(r.outcome).toBe('already-stopped');
    expect(r.ok).toBe(true);
    expect(r.graceful).toBe(true);
  });

  test('graceful halt when beat stops', async () => {
    ensureDir();
    wf(
      'health.json',
      JSON.stringify({
        pid: 55,
        lastBeat: new Date().toISOString(),
        heartbeatIntervalSec: 60,
      }),
    );
    let polls = 0;
    const r = await stopLucerna(org, {
      sleep: async () => {
        polls += 1;
        if (polls >= 1) {
          // clear health beat → not live
          wf('health.json', JSON.stringify({ pid: 55 }));
        }
      },
      isPidAlive: () => false,
      nowMs: (() => {
        let t = 0;
        return () => {
          t += 100;
          return t;
        };
      })(),
      stopGraceMs: 5_000,
      stopPollMs: 1,
    });
    expect(existsSync(join(ldir, 'halt'))).toBe(true);
    expect(r.outcome).toBe('halted');
    expect(r.graceful).toBe(true);
    expect(r.escalated).toBe(false);
    expect(r.ok).toBe(true);
  });

  test('escalation kills verified lucerna pid', async () => {
    ensureDir();
    wf(
      'health.json',
      JSON.stringify({
        pid: 77,
        lastBeat: new Date().toISOString(),
        heartbeatIntervalSec: 60,
      }),
    );
    const killed: number[] = [];
    let now = 0;
    const r = await stopLucerna(org, {
      platform: 'linux',
      sleep: async () => {},
      isPidAlive: (pid) => pid === 77 && killed.length === 0,
      isLucernaProcess: (pid) => pid === 77,
      killPid: (pid) => {
        killed.push(pid);
      },
      nowMs: () => {
        // First call for health0, then grace loop immediately past deadline, then settle
        now += 10_000;
        return now;
      },
      stopGraceMs: 100,
      stopPollMs: 1,
    });
    expect(killed).toEqual([77]);
    expect(r.outcome).toBe('killed');
    expect(r.escalated).toBe(true);
    expect(r.graceful).toBe(false);
    expect(r.ok).toBe(true);
  });

  test('kill-refused when pid is not lucerna', async () => {
    ensureDir();
    wf(
      'health.json',
      JSON.stringify({
        pid: 88,
        lastBeat: new Date().toISOString(),
        heartbeatIntervalSec: 60,
      }),
    );
    let now = 0;
    const r = await stopLucerna(org, {
      platform: 'win32',
      sleep: async () => {},
      isPidAlive: () => true,
      isLucernaProcess: () => false,
      killPid: () => {
        throw new Error('must not kill');
      },
      nowMs: () => {
        now += 10_000;
        return now;
      },
      stopGraceMs: 100,
      stopPollMs: 1,
    });
    expect(r.outcome).toBe('kill-refused');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pid-not-lucerna');
  });
});
