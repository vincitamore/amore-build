import { test, expect, afterEach } from 'bun:test';
import { daemonBaseUrl, daemonGet, DaemonError } from './daemon';

const savedUrl = process.env.IRIS_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.IRIS_URL;
  else process.env.IRIS_URL = savedUrl;
});

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
