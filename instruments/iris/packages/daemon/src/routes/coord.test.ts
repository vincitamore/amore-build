import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPeers, readRoster } from './coord.ts';

describe('coord presence roster', () => {
  test('empty dir is zero live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-coord-'));
    try {
      expect(readRoster(dir)).toEqual([]);
      expect(formatPeers([])).toBe('Peers: 0 LIVE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('live pid is listed; dead pid is skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-coord-'));
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
      expect(formatPeers(entries)).toContain('1 LIVE');
      expect(formatPeers(entries)).toContain('amore');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
