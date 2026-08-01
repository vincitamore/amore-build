import { test, expect } from 'bun:test';
import { daemonStatus } from './daemon-status.ts';

const CONFIG = { orgRoot: 'C:/tmp/org', port: 3850, startedAt: Date.now() - 5000 };

// Replicates isIrisDaemonStatus from packages/tui/src/daemon.ts VERBATIM —
// the dash accepts this daemon only if this exact predicate passes. If the TUI
// predicate changes, this copy must be updated with it.
function isIrisDaemonStatus(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const o = body as Record<string, unknown>;
  return (
    typeof o.attached_at_startup === 'boolean' &&
    typeof o.live === 'boolean' &&
    typeof o.port === 'number' &&
    'binary_path' in o &&
    'info' in o
  );
}

test('daemon-status satisfies the TUI isDaemonUp shape predicate', async () => {
  const res = daemonStatus(CONFIG);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  const body = await res.json();
  expect(isIrisDaemonStatus(body)).toBe(true);
});

test('daemon-status reports truthful identity: no PTY daemon, bun-daemon service', async () => {
  const body = (await daemonStatus(CONFIG).json()) as Record<string, unknown>;
  expect(body.live).toBe(false);
  expect(body.attached_at_startup).toBe(false);
  expect(body.binary_path).toBeNull();
  const info = body.info as Record<string, unknown>;
  expect(info.service).toBe('iris-bun-daemon');
  expect(info.pty).toBe(false);
  expect(typeof info.uptime_secs).toBe('number');
});
