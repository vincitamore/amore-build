// Smoke self-test: record against the legacy daemon, then replay against the SAME
// daemon. Record → replay within one corpus moment MUST be 100% — it is the
// harness proving itself before it is trusted to judge a replacement. SKIPS
// cleanly when no daemon answers on the base (CI / offline), so the suite is
// green with or without a live daemon.

import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from './record';
import { replay } from './replay';

const BASE = process.env.PARITY_SMOKE_BASE ?? 'http://127.0.0.1:3847';

async function daemonUp(): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(`${BASE}/api/health`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

const up = await daemonUp();
const dir = mkdtempSync(join(tmpdir(), 'parity-smoke-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!up)('record → replay against the same daemon is 100% pass', async () => {
  const rec = await record(BASE, dir);
  expect(rec.caseCount).toBeGreaterThan(0);

  const rep = await replay(BASE, dir);
  const failures = rep.cases.filter((c) => !c.pass);
  // Surface the first failure's paths in the assertion message for debuggability.
  const detail = failures.map((f) => `${f.path}: ${f.diffs.map((d) => `${d.kind} ${d.path}`).join(', ')}`).join(' | ');
  expect(rep.failed, `self-replay diverged: ${detail}`).toBe(0);
  expect(rep.passed).toBe(rep.total);
}, 60_000);

if (!up) {
  test('smoke skipped — no daemon on base (this is fine)', () => {
    expect(up).toBe(false);
  });
}
