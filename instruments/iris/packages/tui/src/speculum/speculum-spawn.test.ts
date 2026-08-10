import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSpeculumBin, runSpeculum } from './speculum-spawn';

/**
 * Fixture pattern: SPECULUM_BIN = bun (process.execPath), verb = path to a temp .mjs
 * script, args = remaining argv. No live speculum binary, no operator index.
 */

let tmp: string;
let prevBin: string | undefined;

function writeScript(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'speculum-spawn-'));
  prevBin = process.env.SPECULUM_BIN;
  process.env.SPECULUM_BIN = process.execPath;
});

afterAll(() => {
  if (prevBin === undefined) delete process.env.SPECULUM_BIN;
  else process.env.SPECULUM_BIN = prevBin;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('resolveSpeculumBin', () => {
  test('returns SPECULUM_BIN when set (call-time, not module-load)', () => {
    process.env.SPECULUM_BIN = '/custom/speculum-bin';
    expect(resolveSpeculumBin()).toBe('/custom/speculum-bin');
    process.env.SPECULUM_BIN = process.execPath;
    expect(resolveSpeculumBin()).toBe(process.execPath);
  });

  test('returns literal "speculum" when env unset or empty', () => {
    delete process.env.SPECULUM_BIN;
    expect(resolveSpeculumBin()).toBe('speculum');
    process.env.SPECULUM_BIN = '';
    expect(resolveSpeculumBin()).toBe('speculum');
    process.env.SPECULUM_BIN = process.execPath;
  });
});

describe('runSpeculum', () => {
  test('ok-path parses JSON and returns ms + stdout', async () => {
    process.env.SPECULUM_BIN = process.execPath;
    const script = writeScript(
      'ok.mjs',
      `console.log(JSON.stringify({ status: "ok", n: 42 }));\n`,
    );
    const r = await runSpeculum<{ status: string; n: number }>(script, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.json).toEqual({ status: 'ok', n: 42 });
    expect(r.stdout).toContain('"status"');
    expect(typeof r.ms).toBe('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.ms).toBeLessThan(30_000);
  });

  test('nonzero captures stderrTail with exit code', async () => {
    process.env.SPECULUM_BIN = process.execPath;
    const script = writeScript(
      'nonzero.mjs',
      `console.error("boom: fixture failure line");\nprocess.exit(3);\n`,
    );
    const r = await runSpeculum(script, []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('nonzero');
    expect(r.error.message).toMatch(/exited 3/);
    expect(r.error.stderrTail).toContain('boom: fixture failure');
    expect(typeof r.error.ms).toBe('number');
  });

  test('not-installed when SPECULUM_BIN points at a nonexistent path', async () => {
    const missing = join(tmp, 'no-such-binary-does-not-exist');
    process.env.SPECULUM_BIN = missing;
    try {
      const r = await runSpeculum('status', ['--json']);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('not-installed');
      expect(r.error.message).toMatch(/not found/i);
    } finally {
      process.env.SPECULUM_BIN = process.execPath;
    }
  });

  test('timeout fires and kills the child', async () => {
    process.env.SPECULUM_BIN = process.execPath;
    // Sleep far longer than timeoutMs; hang forever if kill fails (test would stall).
    const script = writeScript(
      'hang.mjs',
      `await new Promise(() => {});\n`,
    );
    const started = Date.now();
    const r = await runSpeculum(script, [], { timeoutMs: 400 });
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('timeout');
    expect(r.error.message).toMatch(/exceeded 400ms/);
    // Should not wait anything close to the hang forever; allow generous CI slack.
    expect(elapsed).toBeLessThan(15_000);
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  test('parse-failed on non-JSON stdout with exit 0', async () => {
    process.env.SPECULUM_BIN = process.execPath;
    const script = writeScript(
      'badjson.mjs',
      `console.log("this is not json");\nprocess.exit(0);\n`,
    );
    const r = await runSpeculum(script, []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse-failed');
    expect(r.error.stdoutTail).toContain('this is not json');
  });

  test('inflight dedupe: concurrent identical calls spawn once', async () => {
    process.env.SPECULUM_BIN = process.execPath;
    const counterPath = join(tmp, 'inflight-counter.txt');
    if (existsSync(counterPath)) writeFileSync(counterPath, '', 'utf8');
    else writeFileSync(counterPath, '', 'utf8');

    // Script appends one byte per invocation, delays so concurrent callers share inflight.
    // Counter path is baked into the script so (verb, args) stay identical for both callers.
    const escaped = counterPath.replace(/\\/g, '/');
    const script = writeScript(
      'count.mjs',
      [
        `import { appendFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(escaped)}, "x");`,
        `await new Promise((r) => setTimeout(r, 250));`,
        `console.log(JSON.stringify({ ok: true }));`,
        ``,
      ].join('\n'),
    );

    const [a, b] = await Promise.all([
      runSpeculum<{ ok: boolean }>(script, []),
      runSpeculum<{ ok: boolean }>(script, []),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Same settled result object identity is not required; same spawn is.
    const hits = readFileSync(counterPath, 'utf8');
    expect(hits).toBe('x');
  });

  test('different args do not coalesce', async () => {
    process.env.SPECULUM_BIN = process.execPath;
    const counterPath = join(tmp, 'diff-counter.txt');
    writeFileSync(counterPath, '', 'utf8');
    const escaped = counterPath.replace(/\\/g, '/');
    const script = writeScript(
      'count-args.mjs',
      [
        `import { appendFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(escaped)}, "x");`,
        `console.log(JSON.stringify({ arg: process.argv[2] ?? null }));`,
        ``,
      ].join('\n'),
    );

    const [a, b] = await Promise.all([
      runSpeculum(script, ['--one']),
      runSpeculum(script, ['--two']),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const hits = readFileSync(counterPath, 'utf8');
    expect(hits).toBe('xx');
  });
});
