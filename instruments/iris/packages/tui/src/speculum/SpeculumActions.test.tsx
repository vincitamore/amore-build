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
  formatComposition,
  formatHumanBytes,
  formatIngestFlash,
  formatNarrowHint,
  formatOversizeMessage,
  formatScrubSummary,
  formatSelectionLabel,
  isOversizeRefuse,
  lastNFromDigit,
  lensDecision,
  lensRefuseReason,
  stepLastN,
  LAST_N_OPTIONS,
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
const oversizeFlag = ${JSON.stringify(join(tmp, 'oversize-dry'))};
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
  const oversize = existsSync(oversizeFlag);
  const lastNIdx = args.indexOf("--last-n");
  const lastN = lastNIdx >= 0 ? Number.parseInt(args[lastNIdx + 1] ?? "5", 10) : 5;
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
    if (oversize) {
      const bytes = 1450141;
      const reason = "payload " + bytes + " bytes exceeds lens cap 102400 bytes; narrow the slice (--session, --since/--until, --last-n); never silently truncated";
      console.log(JSON.stringify({
        lens: name,
        refused: true,
        refusedReason: reason,
        dryRun: true,
        spawned: false,
        modelId: null,
        scrub: {
          ok: false,
          counts: { secret: 0, email: 1, "home-path": 2, "password-assignment": 0 },
          bytes,
          refuseReason: reason,
        },
        slice: {
          sessionId: "abc",
          project: "/tmp/proj",
          turnsRendered: 4876,
          subagentCount: 71,
          selectionSessionIds: ["a", "b", "c", "d", "e"].slice(0, Math.max(1, lastN)),
        },
        audit: {
          ts: "2026-08-10T12:23:00.000Z",
          lens: name,
          decision: "refused",
          reason,
          payloadBytes: bytes,
          scrubCounts: { secret: 0, email: 1, "home-path": 2, "password-assignment": 0 },
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

function setOversizeDry(on: boolean) {
  const flag = join(tmp, 'oversize-dry');
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
  setOversizeDry(false);
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

describe('last-n selection helpers', () => {
  test('LAST_N_OPTIONS is 1 2 3 5 10', () => {
    expect([...LAST_N_OPTIONS]).toEqual([1, 2, 3, 5, 10]);
  });
  test('stepLastN wraps at ends', () => {
    expect(stepLastN(5, -1)).toBe(3);
    expect(stepLastN(5, 1)).toBe(10);
    expect(stepLastN(1, -1)).toBe(10);
    expect(stepLastN(10, 1)).toBe(1);
  });
  test('lastNFromDigit maps 0→10 and known options', () => {
    expect(lastNFromDigit('1')).toBe(1);
    expect(lastNFromDigit('5')).toBe(5);
    expect(lastNFromDigit('0')).toBe(10);
    expect(lastNFromDigit('4')).toBeNull();
  });
  test('formatSelectionLabel is plain operator copy', () => {
    expect(formatSelectionLabel(5)).toBe('--last-n 5 · 5 most recent primary sessions');
    expect(formatSelectionLabel(1)).toBe('--last-n 1 · 1 most recent primary sessions');
  });
});

describe('composition / oversize helpers', () => {
  const oversizeEnv = {
    refused: true,
    refusedReason:
      'payload 1450141 bytes exceeds lens cap 102400 bytes; narrow the slice (--session, --since/--until, --last-n); never silently truncated',
    scrub: {
      ok: false,
      bytes: 1_450_141,
      counts: { secret: 0, email: 1, 'home-path': 2, 'password-assignment': 0 },
      refuseReason:
        'payload 1450141 bytes exceeds lens cap 102400 bytes; narrow the slice (--session, --since/--until, --last-n); never silently truncated',
    },
    slice: { turnsRendered: 4876, subagentCount: 71 },
    audit: { decision: 'refused' as const },
  };

  test('formatHumanBytes matches operator language', () => {
    expect(formatHumanBytes(1_450_141)).toBe('1.45 MB');
    expect(formatHumanBytes(102_400)).toBe('100 KB');
  });
  test('isOversizeRefuse detects cap refuse', () => {
    expect(isOversizeRefuse(oversizeEnv.refusedReason)).toBe(true);
    expect(isOversizeRefuse('residual secret-shaped content')).toBe(false);
    expect(isOversizeRefuse('dry-run: scrub ok (1500 bytes); model not invoked')).toBe(
      false,
    );
  });
  test('formatComposition surfaces bytes/turns/subagents/scrub', () => {
    const line = formatComposition(oversizeEnv);
    expect(line).toContain('payload 1450141 bytes');
    expect(line).toContain('cap 100 KB');
    expect(line).toContain('4876 turns');
    expect(line).toContain('71 subagents');
    expect(line).toMatch(/scrub:.*email=1/);
    expect(line).toMatch(/home-path=2/);
  });
  test('formatOversizeMessage + narrow hint', () => {
    expect(formatOversizeMessage(oversizeEnv)).toBe(
      'payload 1.45 MB exceeds the 100 KB cap',
    );
    expect(formatNarrowHint(5)).toBe('‹1› likely fits — try it');
    expect(formatNarrowHint(1)).toMatch(/still over cap/);
  });
  test('canSend still false for oversize refuse (two-step invariant)', () => {
    expect(canSend('refused', oversizeEnv.refusedReason)).toBe(false);
    // dry-run decision with non-dry-run reason (scrub/cap refuse under dry path)
    expect(canSend('dry-run', oversizeEnv.refusedReason)).toBe(false);
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

  test('lens picker renders last-n selection row', async () => {
    const { keys, renderOnce, captureCharFrame } = await mount();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toMatch(/Lens picker/);
    // chips / label for default 5
    expect(frame).toMatch(/\[5\]|last-n 5|5 most recent primary sessions/);
    expect(frame).toMatch(/1/);
    expect(frame).toMatch(/10|‹|›/);
  });

  test('changing last-n on dry-run re-spawns with new --last-n argv', async () => {
    const { keys, renderOnce } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    let log = readLog();
    const first = log.find((e) => e.verb === 'lens' && e.args.includes('--dry-run'));
    expect(first).toBeDefined();
    expect(first!.args).toContain('--last-n');
    expect(first!.args).toContain('5');

    // Step left (ARROW_LEFT): 5 → 3; debounce ~200ms then re-dry-run
    keys.pressKey('ARROW_LEFT');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    log = readLog();
    const dryRuns = log.filter((e) => e.verb === 'lens' && e.args.includes('--dry-run'));
    expect(dryRuns.length).toBeGreaterThanOrEqual(2);
    const second = dryRuns[dryRuns.length - 1]!;
    expect(second.args).toContain('--last-n');
    const nIdx = second.args.indexOf('--last-n');
    expect(second.args[nIdx + 1]).toBe('3');
    // no live spawn from selection change
    expect(log.some((e) => e.verb === 'lens' && !e.args.includes('--dry-run'))).toBe(
      false,
    );
  });

  test('digit key sets last-n before dry-run argv', async () => {
    const { keys, renderOnce } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('1'); // last-n → 1
    await new Promise((r) => setTimeout(r, 40));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    const log = readLog();
    const dry = log.find((e) => e.verb === 'lens' && e.args.includes('--dry-run'));
    expect(dry).toBeDefined();
    const nIdx = dry!.args.indexOf('--last-n');
    expect(nIdx).toBeGreaterThanOrEqual(0);
    expect(dry!.args[nIdx + 1]).toBe('1');
  });

  test('oversize refuse renders composition + narrow hint; no confirm', async () => {
    setOversizeDry(true);
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    const frame = captureCharFrame();
    // composition read
    expect(frame).toMatch(/1450141|payload/);
    expect(frame).toMatch(/4876|turns/);
    expect(frame).toMatch(/71|subagents/);
    // actionable oversize
    expect(frame).toMatch(/1\.45 MB|exceeds the 100 KB cap|exceeds/);
    expect(frame).toMatch(/likely fits|narrow|‹1›/);
    expect(frame).not.toMatch(/Send scrubbed slice to/);

    // y must not live-send
    keys.pressKey('y');
    await new Promise((r) => setTimeout(r, 300));
    await renderOnce();
    const log = readLog();
    expect(log.every((e) => e.verb !== 'lens' || e.args.includes('--dry-run'))).toBe(
      true,
    );
  });

  test('sendable dry-run still requires confirm before live (two-step)', async () => {
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame).toMatch(/sendable|Send scrubbed slice/i);
    // composition also present on sendable path
    expect(frame).toMatch(/1500 bytes|8 turns|1 subagents|payload/);

    let log = readLog();
    expect(log.some((e) => e.verb === 'lens' && !e.args.includes('--dry-run'))).toBe(
      false,
    );

    keys.pressKey('y');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();
    log = readLog();
    const live = log.find(
      (e) => e.verb === 'lens' && !e.args.includes('--dry-run') && e.args.includes('--json'),
    );
    expect(live).toBeDefined();
    expect(live!.args).toContain('--last-n');
    expect(live!.args).toContain('5');
  });
});
