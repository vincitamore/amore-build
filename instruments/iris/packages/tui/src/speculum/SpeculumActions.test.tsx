/**
 * SpeculumActions — governed ingest / two-step lens / audit tail.
 * Fake binary: SPECULUM_BIN → .cmd/.sh launcher → process.execPath + temp .mjs.
 * No live corpus, no real speculum install.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import {
  SpeculumActions,
  canSend,
  formatIngestFlash,
  formatScrubSummary,
  lensDecision,
  lensRefuseReason,
} from './SpeculumActions';

let tmp: string;
let prevBin: string | undefined;
let logPath: string;
let destroy: (() => void) | undefined;

function writeFakeBinary(): string {
  // Multi-verb dispatcher. argv: [bun, script, verb, ...args]
  const mjs = join(tmp, 'fake-speculum.mjs');
  const body = `
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const logPath = ${JSON.stringify(logPath)};
const refuseFlag = ${JSON.stringify(join(tmp, 'refuse-dry'))};
const verb = process.argv[2] ?? "";
const args = process.argv.slice(3);
function log(line) {
  appendFileSync(logPath, line + "\\n", "utf8");
}
log(JSON.stringify({ verb, args }));

if (verb === "audit") {
  const records = [
    {
      ts: "2026-08-10T12:00:01.000Z",
      lens: "session-postmortem",
      decision: "dry-run",
      reason: "dry-run: scrub ok (1200 bytes); model not invoked",
      payloadBytes: 1200,
      scrubCounts: { secret: 0, email: 1, "home-path": 2, "password-assignment": 0 },
    },
    {
      ts: "2026-08-10T12:05:00.000Z",
      lens: "pattern-extraction",
      decision: "accepted",
      reason: null,
      payloadBytes: 2400,
      scrubCounts: { secret: 0, email: 0, "home-path": 1, "password-assignment": 0 },
      modelId: "test-model",
    },
    {
      ts: "2026-08-10T12:10:00.000Z",
      lens: "usage-story",
      decision: "refused",
      reason: "payload exceeds cap",
      payloadBytes: 200000,
      scrubCounts: { secret: 0, email: 0, "home-path": 0, "password-assignment": 0 },
    },
  ];
  console.log(JSON.stringify({ path: "/tmp/fake-audit.jsonl", n: 20, records }, null, 2));
  process.exit(0);
}

if (verb === "ingest") {
  console.log(JSON.stringify({
    sessionDirsScanned: 4,
    sessionDirsIngested: 3,
    sessionDirsSkippedUnchanged: 1,
    sessionDirsSkippedForgotten: 0,
    eventsAppended: 42,
    usageRowsAppended: 7,
    linesSeen: 100,
    linesParsed: 90,
    linesSkipped: 10,
    errors: 0,
    durationMs: 12,
    dryRun: false,
    listMs: 1, parseMs: 2, writeMs: 3, rebuildMs: 4,
  }, null, 2));
  process.exit(0);
}

if (verb === "lens") {
  const name = args[0] ?? "session-postmortem";
  const dry = args.includes("--dry-run");
  const refuse = existsSync(refuseFlag);
  if (dry) {
    if (refuse) {
      console.log(JSON.stringify({
        lens: name,
        refused: true,
        refusedReason: "residual secret-shaped content",
        dryRun: true,
        spawned: false,
        modelId: null,
        scrub: {
          ok: false,
          counts: { secret: 2, email: 0, "home-path": 0, "password-assignment": 0 },
          bytes: 800,
          refuseReason: "residual secret-shaped content",
        },
        slice: { sessionId: "abc", project: null, turnsRendered: 3, subagentCount: 0 },
        audit: {
          ts: "2026-08-10T12:20:00.000Z",
          lens: name,
          decision: "dry-run",
          reason: "residual secret-shaped content",
          payloadBytes: 800,
          scrubCounts: { secret: 2, email: 0, "home-path": 0, "password-assignment": 0 },
        },
        text: null,
      }, null, 2));
      process.exit(0);
    }
    console.log(JSON.stringify({
      lens: name,
      refused: true,
      refusedReason: "dry-run: scrub ok (1500 bytes); model not invoked",
      dryRun: true,
      spawned: false,
      modelId: null,
      scrub: {
        ok: true,
        counts: { secret: 0, email: 1, "home-path": 3, "password-assignment": 0 },
        bytes: 1500,
        refuseReason: null,
      },
      slice: { sessionId: "abc", project: "/tmp/proj", turnsRendered: 8, subagentCount: 1 },
      audit: {
        ts: "2026-08-10T12:21:00.000Z",
        lens: name,
        decision: "dry-run",
        reason: "dry-run: scrub ok (1500 bytes); model not invoked",
        payloadBytes: 1500,
        scrubCounts: { secret: 0, email: 1, "home-path": 3, "password-assignment": 0 },
      },
      text: null,
    }, null, 2));
    process.exit(0);
  }
  // Live lens
  console.log(JSON.stringify({
    lens: name,
    refused: false,
    refusedReason: null,
    dryRun: false,
    spawned: true,
    modelId: "test-model",
    scrub: {
      ok: true,
      counts: { secret: 0, email: 1, "home-path": 3, "password-assignment": 0 },
      bytes: 1500,
      refuseReason: null,
    },
    slice: { sessionId: "abc", project: "/tmp/proj", turnsRendered: 8, subagentCount: 1 },
    audit: {
      ts: "2026-08-10T12:22:00.000Z",
      lens: name,
      decision: "accepted",
      reason: null,
      payloadBytes: 1500,
      scrubCounts: { secret: 0, email: 1, "home-path": 3, "password-assignment": 0 },
      modelId: "test-model",
    },
    text: "lens output body",
  }, null, 2));
  process.exit(0);
}

console.error("unknown verb " + verb);
process.exit(1);
`;
  writeFileSync(mjs, body, 'utf8');

  if (process.platform === 'win32') {
    const cmd = join(tmp, 'fake-speculum.cmd');
    writeFileSync(
      cmd,
      `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`,
      'utf8',
    );
    return cmd;
  }
  const sh = join(tmp, 'fake-speculum');
  writeFileSync(
    sh,
    `#!/bin/sh\nexec "${process.execPath}" "${mjs}" "$@"\n`,
    'utf8',
  );
  chmodSync(sh, 0o755);
  return sh;
}

function readLog(): Array<{ verb: string; args: string[] }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { verb: string; args: string[] });
}

function clearLog() {
  writeFileSync(logPath, '', 'utf8');
}

function setRefuseDry(on: boolean) {
  const flag = join(tmp, 'refuse-dry');
  if (on) writeFileSync(flag, '1', 'utf8');
  else if (existsSync(flag)) rmSync(flag);
}

async function mount(opts?: {
  onFlash?: (m: string) => void;
  onCapture?: (b: boolean) => void;
}) {
  destroy?.();
  destroy = undefined;
  const flashes: string[] = [];
  const captures: boolean[] = [];
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 90,
    height: 28,
  });
  destroy = () => renderer.destroy();
  const keys = createMockKeys(renderer);
  const root = createRoot(renderer);
  root.render(
    <ThemeProvider initial="horizon">
      <SpeculumActions
        inputActive
        onFlash={(m) => {
          flashes.push(m);
          opts?.onFlash?.(m);
        }}
        onCapture={(b) => {
          captures.push(b);
          opts?.onCapture?.(b);
        }}
      />
    </ThemeProvider>,
  );
  // Allow install probe (audit) to settle.
  await new Promise((r) => setTimeout(r, 200));
  await renderOnce();
  return { renderer, renderOnce, captureCharFrame, keys, flashes, captures };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'speculum-actions-'));
  logPath = join(tmp, 'spawn-log.jsonl');
  writeFileSync(logPath, '', 'utf8');
  prevBin = process.env.SPECULUM_BIN;
  const bin = writeFakeBinary();
  process.env.SPECULUM_BIN = bin;
  setRefuseDry(false);
});

afterAll(() => {
  destroy?.();
  if (prevBin === undefined) delete process.env.SPECULUM_BIN;
  else process.env.SPECULUM_BIN = prevBin;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(() => {
  clearLog();
  setRefuseDry(false);
  destroy?.();
  destroy = undefined;
});

// ── Pure helpers ──

describe('canSend', () => {
  test('dry-run with scrub-ok reason is sendable', () => {
    expect(canSend('dry-run', 'dry-run: scrub ok (1500 bytes); model not invoked')).toBe(
      true,
    );
  });
  test('dry-run with null reason is sendable', () => {
    expect(canSend('dry-run', null)).toBe(true);
  });
  test('dry-run with scrub refuse reason is not sendable', () => {
    expect(canSend('dry-run', 'residual secret-shaped content')).toBe(false);
  });
  test('refused is never sendable', () => {
    expect(canSend('refused', 'payload exceeds cap')).toBe(false);
  });
  test('null decision is not sendable', () => {
    expect(canSend(null)).toBe(false);
  });
});

describe('formatIngestFlash', () => {
  test('uses sessionDirsIngested when present', () => {
    expect(formatIngestFlash({ sessionDirsIngested: 3, eventsAppended: 42 })).toBe(
      'ingested 3 sessions',
    );
  });
  test('generic fallback when counts absent', () => {
    expect(formatIngestFlash({})).toBe('ingest complete');
  });
});

describe('lensDecision / formatScrubSummary', () => {
  test('prefers audit.decision', () => {
    expect(
      lensDecision({
        dryRun: true,
        refused: true,
        audit: { decision: 'dry-run' },
      }),
    ).toBe('dry-run');
  });
  test('scrub summary includes counts and bytes', () => {
    const s = formatScrubSummary({
      scrub: {
        ok: true,
        bytes: 1500,
        counts: { secret: 0, email: 1, 'home-path': 3, 'password-assignment': 0 },
      },
      audit: { decision: 'dry-run' },
    });
    expect(s).toContain('1500 B');
    expect(s).toContain('email=1');
    expect(s).toContain('home-path=3');
    expect(s).toContain('dry-run');
  });
  test('lensRefuseReason reads refusedReason', () => {
    expect(lensRefuseReason({ refusedReason: 'residual secret-shaped content' })).toBe(
      'residual secret-shaped content',
    );
  });
});

// ── Render + keyboard ──

describe('SpeculumActions render', () => {
  test('ingest key triggers CLI and flashes outcome', async () => {
    const { keys, renderOnce, captureCharFrame, flashes } = await mount();
    // Probe already logged one audit; clear for the assertion focus.
    clearLog();
    keys.pressKey('i');
    await new Promise((r) => setTimeout(r, 400));
    await renderOnce();
    const log = readLog();
    expect(log.some((e) => e.verb === 'ingest' && e.args.includes('--json'))).toBe(true);
    expect(flashes.some((f) => f.includes('ingested 3 sessions'))).toBe(true);
    const frame = captureCharFrame();
    expect(frame).toMatch(/ingested 3 sessions/);
  });

  test('lens picker then dry-run panel renders scrub report', async () => {
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toMatch(/Lens picker|session-postmortem|pattern-extraction|usage-story/);
    expect(frame).toMatch(/last-n 5|last 5/);

    keys.pressKey('\r'); // enter → dry-run first lens
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();
    frame = captureCharFrame();
    const log = readLog();
    const dry = log.find(
      (e) =>
        e.verb === 'lens' &&
        e.args.includes('--dry-run') &&
        e.args.includes('--json'),
    );
    expect(dry).toBeDefined();
    expect(dry!.args[0]).toBe('session-postmortem');
    expect(dry!.args).toContain('--last-n');
    expect(dry!.args).toContain('5');
    // Scrub counts visible
    expect(frame).toMatch(/email=1|home-path=3|1500 B|scrub/i);
    // Live lens must NOT have run yet
    expect(log.some((e) => e.verb === 'lens' && !e.args.includes('--dry-run'))).toBe(
      false,
    );
  });

  test('dry-run → confirm → live; live does not run until confirm', async () => {
    const { keys, renderOnce, captureCharFrame, flashes } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    let log = readLog();
    expect(log.filter((e) => e.verb === 'lens' && e.args.includes('--dry-run')).length).toBe(
      1,
    );
    expect(log.some((e) => e.verb === 'lens' && !e.args.includes('--dry-run'))).toBe(
      false,
    );

    // Confirm modal should be up (sendable dry-run).
    const frame = captureCharFrame();
    expect(frame).toMatch(/Send scrubbed slice|Confirm|y confirm/i);

    // Confirm with y → live lens
    keys.pressKey('y');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();
    log = readLog();
    const live = log.find(
      (e) => e.verb === 'lens' && !e.args.includes('--dry-run') && e.args.includes('--json'),
    );
    expect(live).toBeDefined();
    expect(live!.args[0]).toBe('session-postmortem');
    expect(flashes.some((f) => /lens accepted|lens /i.test(f))).toBe(true);
  });

  test('refused dry-run disables confirm; no live lens spawn', async () => {
    setRefuseDry(true);
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame).toMatch(/not sendable|residual secret/i);
    // Confirm modal should NOT offer send
    expect(frame).not.toMatch(/Send scrubbed slice to/);

    // Pressing y must not trigger live lens (confirm inactive)
    keys.pressKey('y');
    await new Promise((r) => setTimeout(r, 300));
    await renderOnce();
    const log = readLog();
    expect(log.filter((e) => e.verb === 'lens').length).toBe(1);
    expect(log[0]!.args).toContain('--dry-run');
    expect(log.some((e) => e.verb === 'lens' && !e.args.includes('--dry-run'))).toBe(
      false,
    );
  });

  test('audit tail renders records', async () => {
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('a', { shift: true });
    await new Promise((r) => setTimeout(r, 400));
    await renderOnce();
    const frame = captureCharFrame();
    const log = readLog();
    expect(
      log.some(
        (e) =>
          e.verb === 'audit' &&
          (e.args.includes('--json') || e.args.includes('-n')),
      ),
    ).toBe(true);
    expect(frame).toMatch(/Audit tail|session-postmortem|pattern-extraction|accepted|refused|dry-run/i);
  });
});
