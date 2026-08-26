import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatMessages, formatPeers, formatPeersDetail, localSeat, readRoster } from './coord.ts';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('coord presence roster', () => {
  test('empty dir is zero live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-coord-'));
    withEnv({ HOUSE_SEAT: 'test' }, () => {
      try {
        expect(readRoster(dir)).toEqual([]);
        expect(formatPeers([])).toBe('0 LIVE');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('live pid is listed; dead pid is skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-coord-'));
    withEnv({ HOUSE_SEAT: 'test' }, () => {
      try {
        writeFileSync(
          join(dir, `amore-${process.pid}.json`),
          JSON.stringify({
            seat: 'test',
            harness: 'amore',
            pid: process.pid,
            tree: 'iris',
            started: '2026-08-25T12:00:00Z',
          }),
        );
        writeFileSync(
          join(dir, 'cursor-0.json'),
          JSON.stringify({
            seat: 'test',
            harness: 'cursor',
            pid: 0,
            tree: 'gone',
            started: '2026-08-25T11:00:00Z',
          }),
        );
        const entries = readRoster(dir);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.harness).toBe('amore');
        expect(formatPeers(entries)).toBe('1 LIVE');
        expect(formatPeersDetail(entries)).toContain('amore');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('dead remote row is kept without PID probe', () => {
    const root = mkdtempSync(join(tmpdir(), 'iris-coord-remote-'));
    const dir = join(root, 'presence');
    mkdirSync(dir);
    writeFileSync(join(root, 'seats'), 'there user@host\n');
    withEnv({ HOUSE_SEAT: 'here', HOUSE_COORD_DIR: dir }, () => {
      try {
        writeFileSync(
          join(dir, 'peer-0.json'),
          JSON.stringify({
            seat: 'there',
            harness: 'amore',
            pid: 0,
            tree: 'peer',
            started: '2026-08-25T11:00:00Z',
          }),
        );
        writeFileSync(
          join(dir, 'local-dead.json'),
          JSON.stringify({
            seat: 'here',
            harness: 'cursor',
            pid: 0,
            tree: 'gone',
            started: '2026-08-25T11:00:00Z',
          }),
        );
        const entries = readRoster(dir);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.seat).toBe('there');
        expect(entries[0]?.remote).toBe(true);
        expect(formatPeers(entries)).toBe('0 LIVE · 1 remote-reported');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test('unknown-seat dead pid is local (seats-register) and hidden', () => {
    const root = mkdtempSync(join(tmpdir(), 'iris-coord-unknown-'));
    const dir = join(root, 'presence');
    mkdirSync(dir);
    writeFileSync(join(root, 'seats'), 'there user@host\n');
    withEnv({ HOUSE_SEAT: 'here', HOUSE_COORD_DIR: dir }, () => {
      try {
        writeFileSync(
          join(dir, 'ghost-0.json'),
          JSON.stringify({
            seat: 'unknown',
            harness: 'amore',
            pid: 0,
            tree: 'ghost',
            started: '2026-08-25T11:00:00Z',
          }),
        );
        expect(readRoster(dir)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test('stale remote mtime stops claiming LIVE', () => {
    const root = mkdtempSync(join(tmpdir(), 'iris-coord-stale-'));
    const dir = join(root, 'presence');
    mkdirSync(dir);
    writeFileSync(join(root, 'seats'), 'there user@host\n');
    withEnv({ HOUSE_SEAT: 'here', HOUSE_COORD_DIR: dir }, () => {
      try {
        const peer = join(dir, 'peer-0.json');
        writeFileSync(
          peer,
          JSON.stringify({
            seat: 'there',
            harness: 'amore',
            pid: 0,
            tree: 'peer',
            started: '2026-08-25T11:00:00Z',
          }),
        );
        const old = new Date(Date.now() - 13 * 3600 * 1000);
        utimesSync(peer, old, old);
        const entries = readRoster(dir);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.remote).toBe(true);
        expect(entries[0]?.stale).toBe(true);
        expect(formatPeers(entries)).toBe('0 LIVE · 1 remote-reported');
        expect(formatPeersDetail(entries)).toMatch(/seen \d+h ago/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test('empty log dir is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-coord-log-'));
    withEnv({ HOUSE_COORD_DIR: join(dir, 'presence') }, () => {
      try {
        expect(formatMessages([])).toBe('none');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('localSeat chain', () => {
  test('HOUSE_SEAT override wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-seat-env-'));
    writeFileSync(join(dir, 'seat'), 'from-file\n');
    withEnv(
      {
        HOUSE_SEAT: 'zzz-test',
        HOUSE_COORD_DIR: join(dir, 'presence'),
      },
      () => {
        try {
          expect(localSeat()).toBe('zzz-test');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });

  test('seat file wins over MagicDNS when HOUSE_SEAT unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-seat-file-'));
    writeFileSync(join(dir, 'seat'), 'from-file\n');
    withEnv(
      {
        HOUSE_SEAT: undefined,
        HOUSE_COORD_DIR: join(dir, 'presence'),
      },
      () => {
        try {
          expect(localSeat({ tailscale: () => 'magic-dns' })).toBe('from-file');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });

  test('missing env+file falls through to hostname (never empty)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-seat-host-'));
    const want =
      hostname().trim().replace(/^\.+|\.+$/g, '').split('.')[0]?.trim().toLowerCase() ||
      'unknown';
    withEnv(
      {
        HOUSE_SEAT: undefined,
        HOUSE_COORD_DIR: join(dir, 'presence'),
      },
      () => {
        try {
          const got = localSeat({ tailscale: () => null });
          expect(got).not.toBe('');
          expect(got).toBe(want);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
});
