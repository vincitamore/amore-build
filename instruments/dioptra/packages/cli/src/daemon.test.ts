import { test, expect, afterEach } from 'bun:test';
import { daemonBaseUrl, daemonGet, DaemonError } from './daemon';

const savedUrl = process.env.DIOPTRA_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.DIOPTRA_URL;
  else process.env.DIOPTRA_URL = savedUrl;
});

test('daemonBaseUrl honors DIOPTRA_URL', () => {
  process.env.DIOPTRA_URL = 'http://example.test:1234';
  expect(daemonBaseUrl()).toBe('http://example.test:1234');
});

test('daemonBaseUrl defaults to loopback :3852 (selene house Bun daemon)', () => {
  delete process.env.DIOPTRA_URL;
  delete process.env.DIOPTRA_PORT;
  expect(daemonBaseUrl()).toBe('http://127.0.0.1:3852');
});

test('daemonBaseUrl honors DIOPTRA_PORT (3847 = legacy daemon)', () => {
  delete process.env.DIOPTRA_URL;
  process.env.DIOPTRA_PORT = '3847';
  try {
    expect(daemonBaseUrl()).toBe('http://127.0.0.1:3847');
  } finally {
    delete process.env.DIOPTRA_PORT;
  }
});

test('daemonGet throws DAEMON_UNAVAILABLE when nothing is listening', async () => {
  process.env.DIOPTRA_URL = 'http://127.0.0.1:59999'; // nothing listens here
  let caught: unknown;
  try {
    await daemonGet('/api/graph');
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(DaemonError);
  expect((caught as DaemonError).code).toBe('DAEMON_UNAVAILABLE');
});
