import { test, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonBaseUrl,
  daemonGet,
  DaemonError,
  IRIS_DAEMON_SERVICE,
  normalizeOrgRoot,
  pidFilePath,
  stopDaemon,
  writePidFile,
} from './daemon';

const savedUrl = process.env.IRIS_URL;
const temps: string[] = [];

afterEach(() => {
  if (savedUrl === undefined) delete process.env.IRIS_URL;
  else process.env.IRIS_URL = savedUrl;
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'iris-cli-stop-'));
  temps.push(d);
  return d;
}

test('daemonBaseUrl honors IRIS_URL', () => {
  process.env.IRIS_URL = 'http://example.test:1234';
  expect(daemonBaseUrl()).toBe('http://example.test:1234');
});

test('daemonBaseUrl defaults to loopback :3853 (amore house Bun daemon)', () => {
  delete process.env.IRIS_URL;
  delete process.env.IRIS_PORT;
  expect(daemonBaseUrl()).toBe('http://127.0.0.1:3853');
});

test('daemonBaseUrl honors IRIS_PORT (3847 = legacy daemon)', () => {
  delete process.env.IRIS_URL;
  process.env.IRIS_PORT = '3847';
  try {
    expect(daemonBaseUrl()).toBe('http://127.0.0.1:3847');
  } finally {
    delete process.env.IRIS_PORT;
  }
});

test('daemonGet throws DAEMON_UNAVAILABLE when nothing is listening', async () => {
  process.env.IRIS_URL = 'http://127.0.0.1:59999'; // nothing listens here
  let caught: unknown;
  try {
    await daemonGet('/api/graph');
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(DaemonError);
  expect((caught as DaemonError).code).toBe('DAEMON_UNAVAILABLE');
});

test('stopDaemon: stale pidfile cleans up rather than hanging', async () => {
  const runtimeDir = tempDir();
  const deadPid = 2_147_483_646; // not alive
  writePidFile(runtimeDir, deadPid);
  expect(existsSync(pidFilePath(runtimeDir))).toBe(true);

  let statusCalled = false;
  let signaled = false;
  const result = await stopDaemon('/tmp/org-a', {
    runtimeDir,
    fetchStatus: async () => {
      statusCalled = true;
      return {};
    },
    signal: () => {
      signaled = true;
    },
    // force dead even if the high pid somehow exists
    isAlive: () => false,
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.note).toMatch(/stale/i);
    expect(result.pid).toBe(deadPid);
  }
  expect(statusCalled).toBe(false);
  expect(signaled).toBe(false);
  expect(existsSync(pidFilePath(runtimeDir))).toBe(false);
});

test('stopDaemon: foreign org_root refuses to signal', async () => {
  const runtimeDir = tempDir();
  const pid = process.pid;
  writePidFile(runtimeDir, pid);

  let signaled = false;
  const cliRoot = 'C:\\scratch\\cli-org';
  const foreignRoot = 'C:\\scratch\\foreign-org';
  const result = await stopDaemon(cliRoot, {
    runtimeDir,
    isAlive: () => true,
    fetchStatus: async () => ({
      info: {
        service: IRIS_DAEMON_SERVICE,
        pid,
        org_root: foreignRoot,
      },
    }),
    signal: () => {
      signaled = true;
    },
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/org_root differs/);
    expect(result.error).toContain(foreignRoot);
    expect(result.error).toContain(cliRoot);
  }
  expect(signaled).toBe(false);
  // pidfile left in place — operator may still need it
  expect(existsSync(pidFilePath(runtimeDir))).toBe(true);
});

test('stopDaemon: matching identity signals and clears pidfile', async () => {
  const runtimeDir = tempDir();
  const pid = 55555;
  writePidFile(runtimeDir, pid);
  const org = 'C:\\scratch\\same-org';
  let alive = true;
  let signaled = false;

  const result = await stopDaemon(org, {
    runtimeDir,
    isAlive: () => alive,
    fetchStatus: async () => ({
      info: {
        service: IRIS_DAEMON_SERVICE,
        pid,
        org_root: org,
      },
    }),
    signal: (p) => {
      expect(p).toBe(pid);
      signaled = true;
      alive = false;
    },
    sleep: async () => {},
    pollMs: 1,
  });

  expect(result.ok).toBe(true);
  expect(signaled).toBe(true);
  if (result.ok) {
    expect(result.signaled).toBe(true);
    expect(result.pid).toBe(pid);
  }
  expect(existsSync(pidFilePath(runtimeDir))).toBe(false);
});

test('normalizeOrgRoot folds separators and trailing slash', () => {
  const a = normalizeOrgRoot('C:/foo/bar/');
  const b = normalizeOrgRoot('C:\\foo\\bar');
  expect(a).toBe(b);
});
