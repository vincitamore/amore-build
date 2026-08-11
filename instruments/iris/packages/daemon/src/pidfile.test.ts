import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearPidFile,
  isPidAlive,
  pidFilePath,
  readPidFile,
  writePidFile,
} from './pidfile.ts';

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRuntime(): string {
  const d = mkdtempSync(join(tmpdir(), 'iris-pidfile-'));
  temps.push(d);
  return d;
}

test('writePidFile / readPidFile round-trip', () => {
  const dir = tempRuntime();
  writePidFile(dir, 4242);
  expect(existsSync(pidFilePath(dir))).toBe(true);
  expect(readPidFile(dir)).toBe(4242);
});

test('clearPidFile removes the pidfile', () => {
  const dir = tempRuntime();
  writePidFile(dir, 7);
  clearPidFile(dir);
  expect(existsSync(pidFilePath(dir))).toBe(false);
  expect(readPidFile(dir)).toBeNull();
});

test('clearPidFile is a no-op when missing', () => {
  const dir = tempRuntime();
  expect(() => clearPidFile(dir)).not.toThrow();
});

test('readPidFile returns null for missing or invalid content', () => {
  const dir = tempRuntime();
  expect(readPidFile(dir)).toBeNull();
  writeFileSync(pidFilePath(dir), 'not-a-pid\n', 'utf-8');
  expect(readPidFile(dir)).toBeNull();
});

test('isPidAlive: current process is alive; bogus pid is not', () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(0)).toBe(false);
  expect(isPidAlive(-1)).toBe(false);
  // High unused pid — unlikely to collide on a test host
  expect(isPidAlive(2_147_483_646)).toBe(false);
});
