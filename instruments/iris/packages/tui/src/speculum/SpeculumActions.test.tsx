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
import { Database } from 'bun:sqlite';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import {
  SpeculumActions,
  buildLensArgv,
  buildSummarizeArgv,
  canSend,
  canSummarizeSend,
  defaultLensSelection,
  formatComposition,
  formatFitsVerdict,
  formatHumanBytes,
  formatIngestFlash,
  formatNarrowHint,
  formatOversizeMessage,
  formatScrubSummary,
  formatSelectionLabel,
  formatSummarizeFlash,
  formatSummarizePlan,
  isOversizeRefuse,
  lastNFromDigit,
  lensDecision,
  lensRefuseReason,
  reportFileExists,
  stepLastN,
  LAST_N_OPTIONS,
} from './SpeculumActions';

let tmp: string;
let prevBin: string | undefined;
let prevDb: string | undefined;
let logPath: string;
let seedDbPath: string;
let destroy: (() => void) | undefined;

const SEED_DDL = `
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  agent           TEXT NOT NULL,
  parent_session  TEXT,
  ts              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  text            TEXT,
  tool_name       TEXT,
  tool_input      TEXT,
  tool_output     TEXT,
  tool_error      INTEGER,
  tool_call_id    TEXT,
  is_boilerplate  INTEGER NOT NULL DEFAULT 0,
  sensitive       INTEGER NOT NULL DEFAULT 0,
  raw             TEXT NOT NULL
);
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  agent            TEXT NOT NULL,
  parent_session   TEXT,
  model_id         TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  turn_count       INTEGER NOT NULL,
  user_msg_count   INTEGER NOT NULL,
  tool_call_count  INTEGER NOT NULL,
  tool_error_count INTEGER NOT NULL
);
CREATE TABLE usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  project_path        TEXT NOT NULL,
  ts                  TEXT NOT NULL,
  model_id            TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_read_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  num_turns           INTEGER NOT NULL DEFAULT 0,
  model_calls         INTEGER NOT NULL DEFAULT 0,
  raw                 TEXT NOT NULL
);
CREATE TABLE ingest_state (
  file_path     TEXT PRIMARY KEY,
  size_bytes    INTEGER NOT NULL,
  mtime         TEXT NOT NULL,
  byte_offset   INTEGER NOT NULL,
  last_ingested TEXT NOT NULL,
  forgotten     INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE events_fts USING fts5(
  text,
  tool_name,
  tool_input,
  tool_output
);
`;

function seedSessionIndex(path: string): void {
  const db = new Database(path);
  try {
    db.exec(SEED_DDL);
    db.run('PRAGMA user_version = 4');
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess-target-aaa',
        '/proj/alpha',
        'primary',
        null,
        'model-x',
        '2026-08-10T12:00:00.000Z',
        '2026-08-10T13:00:00.000Z',
        4,
        2,
        1,
        0,
      ],
    );
    db.run(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sess-target-bbb',
        '/proj/beta',
        'primary',
        null,
        'model-x',
        '2026-08-09T12:00:00.000Z',
        '2026-08-09T13:00:00.000Z',
        2,
        1,
        0,
        0,
      ],
    );
  } finally {
    db.close();
  }
}

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
  const reportPath = ${JSON.stringify(join(tmp, 'lens-report-accepted.md'))};
  const records = [
    {
      ts: "2026-08-10T12:00:01.000Z",
      lens: "session-postmortem",
      decision: "dry-run",
      reason: "dry-run: scrub ok (1200 bytes); model not invoked",
      payloadBytes: 1200,
      scrubCounts: { secret: 0, email: 1, "home-path": 2, "password-assignment": 0 },
      reportPath: null,
    },
    {
      ts: "2026-08-10T12:05:00.000Z",
      lens: "pattern-extraction",
      decision: "accepted",
      reason: null,
      payloadBytes: 2400,
      scrubCounts: { secret: 0, email: 0, "home-path": 1, "password-assignment": 0 },
      modelId: "test-model",
      reportPath,
    },
    {
      ts: "2026-08-10T12:10:00.000Z",
      lens: "usage-story",
      decision: "refused",
      reason: "payload exceeds cap",
      payloadBytes: 200000,
      scrubCounts: { secret: 0, email: 0, "home-path": 0, "password-assignment": 0 },
      reportPath: ${JSON.stringify(join(tmp, 'gone-report.md'))},
    },
  ];
  console.log(JSON.stringify({ path: "/tmp/fake-audit.jsonl", n: 20, records }, null, 2));
  process.exit(0);
}

if (verb === "summarize") {
  const dry = args.includes("--dry-run");
  if (dry) {
    console.log(JSON.stringify({
      attempted: 3,
      generated: 0,
      refused_scrub: 0,
      failed_parse: 0,
      dry_run: true,
      results: [
        { sessionId: "s1", outcome: "dry-run" },
        { sessionId: "s2", outcome: "dry-run" },
        { sessionId: "s3", outcome: "dry-run" },
      ],
    }, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify({
    attempted: 3,
    generated: 2,
    refused_scrub: 1,
    failed_parse: 0,
    dry_run: false,
    results: [
      { sessionId: "s1", outcome: "generated", title: "Fix Mount Path" },
      { sessionId: "s2", outcome: "generated", title: "Probe Tuning" },
      { sessionId: "s3", outcome: "refused_scrub" },
    ],
  }, null, 2));
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
  const noSub = args.includes("--no-subagents");
  const lastNIdx = args.indexOf("--last-n");
  const lastN = lastNIdx >= 0 ? Number.parseInt(args[lastNIdx + 1] ?? "5", 10) : 5;
  const sessionIdx = args.indexOf("--session");
  const sessionId = sessionIdx >= 0 ? (args[sessionIdx + 1] ?? null) : null;
  // Narrowed selection that fits under the oversize-flag corpus: last-n 1 + no-sub, or any --session + no-sub.
  const fitsNarrow = noSub && (sessionId != null || lastN === 1);

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
        slice: { sessionId: "abc", project: null, turnsRendered: 3, subagentCount: 0, selectionSessionIds: ["abc"] },
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
    if (oversize && !fitsNarrow) {
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
          selectionSessionIds: sessionId
            ? [sessionId]
            : ["a", "b", "c", "d", "e"].slice(0, Math.max(1, lastN)),
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
    // Sendable dry-run (default, or narrowed under oversize flag).
    const bytes = fitsNarrow ? 79082 : 1500;
    const turns = fitsNarrow ? 12 : 8;
    const subs = noSub ? 0 : 1;
    const sid = sessionId || "abc";
    console.log(JSON.stringify({
      lens: name,
      refused: true,
      refusedReason: "dry-run: scrub ok (" + bytes + " bytes); model not invoked",
      dryRun: true,
      spawned: false,
      modelId: null,
      scrub: {
        ok: true,
        counts: { secret: 0, email: 1, "home-path": 3, "password-assignment": 0 },
        bytes,
        refuseReason: null,
      },
      slice: {
        sessionId: sid,
        project: "/tmp/proj",
        turnsRendered: turns,
        subagentCount: subs,
        selectionSessionIds: [sid],
      },
      audit: {
        ts: "2026-08-10T12:21:00.000Z",
        lens: name,
        decision: "dry-run",
        reason: "dry-run: scrub ok (" + bytes + " bytes); model not invoked",
        payloadBytes: bytes,
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
    reportPath: ${JSON.stringify(join(tmp, 'lens-report-accepted.md'))},
    scrub: {
      ok: true,
      counts: { secret: 0, email: 1, "home-path": 3, "password-assignment": 0 },
      bytes: 1500,
      refuseReason: null,
    },
    slice: { sessionId: sessionId || "abc", project: "/tmp/proj", turnsRendered: 8, subagentCount: noSub ? 0 : 1 },
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
  lensPrefill?: { sessionId: string; key: number } | null;
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
        lensPrefill={opts?.lensPrefill ?? null}
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
  return { renderer, renderOnce, captureCharFrame, keys, flashes, captures, root };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'speculum-actions-'));
  logPath = join(tmp, 'spawn-log.jsonl');
  writeFileSync(logPath, '', 'utf8');
  // Real report file for audit enter-to-open + live lens open.
  writeFileSync(
    join(tmp, 'lens-report-accepted.md'),
    '# Lens report\n\nSynthetic accepted report body.\n',
    'utf8',
  );
  seedDbPath = join(tmp, 'seed.sqlite');
  seedSessionIndex(seedDbPath);
  prevBin = process.env.SPECULUM_BIN;
  prevDb = process.env.SPECULUM_DB;
  const bin = writeFakeBinary();
  process.env.SPECULUM_BIN = bin;
  process.env.SPECULUM_DB = seedDbPath;
  setRefuseDry(false);
});

afterAll(() => {
  destroy?.();
  if (prevBin === undefined) delete process.env.SPECULUM_BIN;
  else process.env.SPECULUM_BIN = prevBin;
  if (prevDb === undefined) delete process.env.SPECULUM_DB;
  else process.env.SPECULUM_DB = prevDb;
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
    expect(formatSelectionLabel(defaultLensSelection(1, true))).toBe(
      '--last-n 1 · 1 most recent primary sessions · --no-subagents',
    );
    expect(
      formatSelectionLabel(defaultLensSelection(5, true, '019febfd-18d0-7ac1-9b3f')),
    ).toMatch(/--session 019febfd-18… · --no-subagents|--session 019febfd-18/);
  });
});

describe('buildLensArgv', () => {
  test('default last-n dry-run', () => {
    expect(buildLensArgv('session-postmortem', defaultLensSelection(5), { dryRun: true })).toEqual([
      'session-postmortem',
      '--last-n',
      '5',
      '--dry-run',
      '--json',
    ]);
  });
  test('no-subagents flag present', () => {
    const args = buildLensArgv(
      'session-postmortem',
      defaultLensSelection(1, true),
      { dryRun: true },
    );
    expect(args).toContain('--no-subagents');
    expect(args).toContain('--last-n');
    expect(args).toContain('1');
  });
  test('session target replaces last-n', () => {
    const args = buildLensArgv(
      'usage-story',
      defaultLensSelection(5, true, 'sess-target-aaa'),
      { dryRun: false },
    );
    expect(args).toContain('--session');
    expect(args).toContain('sess-target-aaa');
    expect(args).toContain('--no-subagents');
    expect(args).not.toContain('--last-n');
    expect(args).not.toContain('--dry-run');
    expect(args).toContain('--json');
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
  test('formatComposition includes selection descriptor when provided', () => {
    const line = formatComposition(
      oversizeEnv,
      defaultLensSelection(1, true, null),
    );
    expect(line).toContain('--last-n 1');
    expect(line).toContain('--no-subagents');
  });
  test('formatOversizeMessage + narrow hint always actionable', () => {
    expect(formatOversizeMessage(oversizeEnv)).toBe(
      'payload 1.45 MB exceeds the 100 KB cap',
    );
    expect(formatNarrowHint(5)).toMatch(/‹1›|no-subagents/);
    expect(formatNarrowHint(1)).toMatch(/no-subagents/);
    expect(formatNarrowHint(defaultLensSelection(1, true))).toMatch(/pick a session|session \(t\)/);
    expect(
      formatNarrowHint(defaultLensSelection(1, true, 'sess-target-aaa')),
    ).toMatch(/different lens/);
  });
  test('formatFitsVerdict over-cap vs sendable', () => {
    expect(
      formatFitsVerdict(oversizeEnv, 'refused', oversizeEnv.refusedReason),
    ).toBe('over cap — narrow');
    expect(
      formatFitsVerdict(
        { scrub: { bytes: 1500, ok: true } },
        'dry-run',
        'dry-run: scrub ok (1500 bytes); model not invoked',
      ),
    ).toBe('sendable — confirm to invoke model');
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
    // Idle Actions paints zero chrome; flash rides the member footer via onFlash.
    expect(flashes.some((f) => f.includes('ingested 3 sessions'))).toBe(true);
    await renderOnce();
    const frame = captureCharFrame();
    // Idle strip must not paint the global actions line.
    expect(frame).not.toMatch(/i ingest\s*·\s*L lens\s*·\s*A audit/);
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
    expect(frame).toMatch(/not sendable|residual secret|over cap/i);
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
    expect(frame).toMatch(/no-subagents/);
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

  test('toggling no-subagents changes spawned argv', async () => {
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('n'); // toggle no-subagents on picker
    await new Promise((r) => setTimeout(r, 40));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toMatch(/\[no-subagents\]/);

    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    const log = readLog();
    const dry = log.find((e) => e.verb === 'lens' && e.args.includes('--dry-run'));
    expect(dry).toBeDefined();
    expect(dry!.args).toContain('--no-subagents');
    expect(dry!.args).toContain('--last-n');
  });

  test('choosing a session target changes argv to --session (no --last-n)', async () => {
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('t'); // open session pick
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toMatch(/pick session|sess-target/);

    keys.pressKey('\r'); // select first recent session
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toMatch(/--session|sess-target/);

    keys.pressKey('\r'); // dry-run with session target
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    const log = readLog();
    const dry = log.find((e) => e.verb === 'lens' && e.args.includes('--dry-run'));
    expect(dry).toBeDefined();
    expect(dry!.args).toContain('--session');
    expect(dry!.args).toContain('sess-target-aaa');
    expect(dry!.args).not.toContain('--last-n');
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
    expect(frame).toMatch(/1\.45 MB|exceeds the 100 KB cap|exceeds|over cap/);
    expect(frame).toMatch(/no-subagents|‹1›|narrow|pick a session/);
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

  test('over-cap at default → narrow last-n 1 + no-subagents → sendable (the lens turnaround)', async () => {
    setOversizeDry(true);
    const { keys, renderOnce, captureCharFrame } = await mount();
    clearLog();
    keys.pressKey('l', { shift: true });
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    let frame = captureCharFrame();
    expect(frame).toMatch(/over cap|1450141|not sendable|exceeds/i);
    expect(frame).not.toMatch(/Send scrubbed slice to/);

    // Narrow: last-n 1
    keys.pressKey('1');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();
    // Toggle no-subagents
    keys.pressKey('n');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    frame = captureCharFrame();
    const log = readLog();
    const dryRuns = log.filter((e) => e.verb === 'lens' && e.args.includes('--dry-run'));
    expect(dryRuns.length).toBeGreaterThanOrEqual(2);
    const last = dryRuns[dryRuns.length - 1]!;
    expect(last.args).toContain('--no-subagents');
    const nIdx = last.args.indexOf('--last-n');
    expect(nIdx).toBeGreaterThanOrEqual(0);
    expect(last.args[nIdx + 1]).toBe('1');

    // Now sendable: confirm modal / sendable copy
    expect(frame).toMatch(/sendable|Send scrubbed slice/i);
    expect(frame).toMatch(/79082|payload|no-subagents|--last-n 1/);

    // Two-step still holds: no live yet
    expect(log.some((e) => e.verb === 'lens' && !e.args.includes('--dry-run'))).toBe(
      false,
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
    // selection descriptor in composition
    expect(frame).toMatch(/--last-n 5|last-n 5/);

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

  test('audit enter-to-open stats report; soft flash when gone', async () => {
    expect(reportFileExists(join(tmp, 'lens-report-accepted.md'))).toBe(true);
    expect(reportFileExists(join(tmp, 'gone-report.md'))).toBe(false);

    const { keys, renderOnce, captureCharFrame, flashes } = await mount();
    clearLog();
    keys.pressKey('a', { shift: true });
    await new Promise((r) => setTimeout(r, 400));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toMatch(/Audit tail|pattern-extraction|accepted/i);

    // Cursor defaults to last row (refused with gone path). Enter → soft flash.
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 120));
    await renderOnce();
    expect(flashes.some((f) => /report gone|no report/i.test(f))).toBe(true);

    // Move up to accepted row (index 1 of 3) and open.
    keys.pressKey('ARROW_UP');
    await new Promise((r) => setTimeout(r, 40));
    await renderOnce();
    keys.pressKey('\r');
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame, `frame:\n${frame}`).toMatch(/Lens report|Synthetic accepted|read-only report/i);
  });

  test('summarize chain: dry-run → confirm → cancel never lives', async () => {
    const { keys, renderOnce, captureCharFrame, flashes } = await mount();
    clearLog();
    keys.pressKey('t', { shift: true });
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    let log = readLog();
    const dry = log.find(
      (e) => e.verb === 'summarize' && e.args.includes('--dry-run') && e.args.includes('--json'),
    );
    expect(dry).toBeDefined();
    expect(log.some((e) => e.verb === 'summarize' && !e.args.includes('--dry-run'))).toBe(
      false,
    );

    const frame = captureCharFrame();
    expect(frame).toMatch(/Summarize plan|attempted 3|scrubbed and audited/i);
    expect(frame).toMatch(/Generate titles|Confirm|y confirm|content leaves/i);
    expect(flashes.some((f) => /summarize plan/i.test(f))).toBe(true);

    // Cancel — never live
    keys.pressKey('n');
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();
    log = readLog();
    expect(log.filter((e) => e.verb === 'summarize').length).toBe(1);
    expect(log.every((e) => e.verb !== 'summarize' || e.args.includes('--dry-run'))).toBe(
      true,
    );
  });

  test('summarize chain: confirm runs live batch and flashes', async () => {
    const { keys, renderOnce, flashes } = await mount();
    clearLog();
    keys.pressKey('t', { shift: true });
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();
    keys.pressKey('y');
    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();

    const log = readLog();
    const live = log.find(
      (e) =>
        e.verb === 'summarize' && !e.args.includes('--dry-run') && e.args.includes('--json'),
    );
    expect(live).toBeDefined();
    expect(flashes.some((f) => /summarize.*titled|2 titled/i.test(f))).toBe(true);
  });

  test('lensPrefill key-bump re-fires even for same session', async () => {
    destroy?.();
    destroy = undefined;
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 90,
      height: 28,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    const keys = createMockKeys(renderer);

    const paint = (prefill: { sessionId: string; key: number } | null) => {
      root.render(
        <ThemeProvider initial="horizon">
          <SpeculumActions inputActive lensPrefill={prefill} />
        </ThemeProvider>,
      );
    };

    // Install probe
    paint(null);
    await new Promise((r) => setTimeout(r, 200));
    await renderOnce();

    // First handoff
    paint({ sessionId: 'sess-target-aaa', key: 1 });
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toMatch(/Lens picker|--session|sess-target/i);

    // Close picker
    keys.pressKey('ESCAPE');
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).not.toMatch(/Lens picker/);

    // Same session, new key — must re-open
    paint({ sessionId: 'sess-target-aaa', key: 2 });
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toMatch(/Lens picker|--session|sess-target/i);

    // Close + third bump
    keys.pressKey('ESCAPE');
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    paint({ sessionId: 'sess-target-aaa', key: 3 });
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toMatch(/Lens picker|--session|sess-target/i);
  });
});

describe('summarize helpers', () => {
  test('buildSummarizeArgv dry-run + json', () => {
    expect(buildSummarizeArgv({ dryRun: true })).toEqual(['--dry-run', '--json']);
    expect(buildSummarizeArgv({ dryRun: true, limit: 10 })).toEqual([
      '--limit',
      '10',
      '--dry-run',
      '--json',
    ]);
    expect(buildSummarizeArgv({ sessionId: 'abc', dryRun: false })).toEqual([
      '--session',
      'abc',
      '--json',
    ]);
  });

  test('formatSummarizePlan names egress; canSummarizeSend gates empty', () => {
    expect(canSummarizeSend({ attempted: 0, results: [] })).toBe(false);
    expect(canSummarizeSend({ attempted: 3 })).toBe(true);
    const plan = formatSummarizePlan({ attempted: 3, refused_scrub: 1 });
    expect(plan).toMatch(/3 session/);
    expect(plan).toMatch(/scrubbed and audited/i);
    expect(plan).toMatch(/leaves this machine/i);
    expect(formatSummarizeFlash({ attempted: 3, generated: 2 }, true)).toMatch(
      /2 titled/,
    );
  });
});
