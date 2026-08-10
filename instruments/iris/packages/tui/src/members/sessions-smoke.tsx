// Headless char-frame smoke for SessionsMember against a multi-verb fake SPECULUM_BIN.
// Run: bun run src/members/sessions-smoke.tsx
// Renders the member DIRECTLY (not through Shell) — self-contained from any cwd.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { SessionsMember } from './SessionsMember';

const W = Number(process.env.SMOKE_W ?? 120);
const H = Number(process.env.SMOKE_H ?? 32);

const STATUS_READY = {
  counts: { sessions: 3, events: 40, usageRows: 12 },
  ingest: { lastIngestedAt: '2026-05-01T10:00:00.000Z' },
  staleness: { stale: false, thresholdHours: 72, hoursSinceNewestSession: 1 },
};

const SCAN = [
  {
    probe: 'apology-rate',
    value: 0.08,
    ciLow: 0.03,
    ciHigh: 0.18,
    n: 50,
    partial: false,
    unit: 'msg',
    summary: '4 self-corrections / 50 assistant messages [heuristic]',
    data: {},
    hits: [
      {
        sessionId: 'smoke-sess',
        ts: '2026-01-02T12:00:00.000Z',
        category: 'self-correction',
        evidence: 'apologies for the confusion on that step',
      },
    ],
    heuristic: true,
  },
  {
    probe: 'stuck-loop',
    value: 2,
    ciLow: 0.1,
    ciHigh: 0.4,
    n: 10,
    partial: false,
    unit: 'session',
    summary: '2 loops across 2 of 10 sessions [heuristic]',
    data: {},
    hits: [],
    heuristic: true,
  },
];

const USAGE = {
  window: { since: null, until: null },
  models: [
    {
      model: 'smoke-model',
      turns: 10,
      sessions: 2,
      tokens: {
        input: 1500,
        output: 2500,
        cachedRead: 200,
        reasoning: 50,
        total: 4250,
      },
    },
  ],
  totals: {
    turns: 10,
    sessions: 2,
    tokens: {
      input: 1500,
      output: 2500,
      cachedRead: 200,
      reasoning: 50,
      total: 4250,
    },
  },
  note: 'Token and turn counts only. No price table in v1 — provider prices vary per user.',
};

const AUDIT = {
  path: '/tmp/audit.jsonl',
  n: 0,
  records: [],
};

const tmp = mkdtempSync(join(tmpdir(), 'sessions-smoke-'));
const prevBin = process.env.SPECULUM_BIN;

function writeReadyBin(): string {
  const mjs = join(tmp, 'fake-ready.mjs');
  writeFileSync(
    mjs,
    [
      `const verb = process.argv[2];`,
      `if (verb === 'status') { console.log(JSON.stringify(${JSON.stringify(STATUS_READY)})); process.exit(0); }`,
      `if (verb === 'scan') { console.log(JSON.stringify(${JSON.stringify(SCAN)})); process.exit(0); }`,
      `if (verb === 'usage') { console.log(JSON.stringify(${JSON.stringify(USAGE)})); process.exit(0); }`,
      `if (verb === 'audit') { console.log(JSON.stringify(${JSON.stringify(AUDIT)})); process.exit(0); }`,
      `console.error('unknown verb ' + verb); process.exit(2);`,
      ``,
    ].join('\n'),
    'utf8',
  );
  if (process.platform === 'win32') {
    const bin = join(tmp, 'fake-ready.cmd');
    writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');
    return bin;
  }
  const bin = join(tmp, 'fake-ready');
  writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mjs}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
  return bin;
}

function cleanup() {
  if (prevBin === undefined) delete process.env.SPECULUM_BIN;
  else process.env.SPECULUM_BIN = prevBin;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── Run 1: ready corpus ──
process.env.SPECULUM_BIN = writeReadyBin();

const {
  renderer,
  renderOnce,
  captureCharFrame,
} = await createTestRenderer({ width: W, height: H });
const keys = createMockKeys(renderer);
const root = createRoot(renderer);
root.render(
  <ThemeProvider initial="horizon">
    <SessionsMember inputActive />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 900));
await renderOnce();
const frameReady = captureCharFrame();
console.log('--- ready frame ---');
console.log(frameReady);

const hasReadyStrip = /installed · 3 sessions|3 sessions/.test(frameReady);
const hasProbes = /apology-rate/.test(frameReady);
const hasHeuristic = /\[heuristic\]/.test(frameReady);
const hasChips = /Probes/.test(frameReady) && /Usage/.test(frameReady);
const noMicroscope = !/Microscope|Map|Search/.test(frameReady);
const hasBorders = /[┌┐└┘─│]/.test(frameReady);

// Stage switch: u → Usage
await keys.pressKey('u');
await new Promise((r) => setTimeout(r, 700));
await renderOnce();
const frameUsage = captureCharFrame();
console.log('--- usage frame ---');
console.log(frameUsage);

const hasUsageNote = /Token and turn counts only|No price table/.test(frameUsage);
const hasModel = /smoke-model/.test(frameUsage);
const hasTokens = /1\.5K|2\.5K|4\.3K|4\.2K/.test(frameUsage);

renderer.destroy();

// ── Run 2: not-installed ──
process.env.SPECULUM_BIN = join(tmp, 'no-such-speculum-binary');

const {
  renderer: r2,
  renderOnce: render2,
  captureCharFrame: capture2,
} = await createTestRenderer({ width: W, height: H });
createRoot(r2).render(
  <ThemeProvider initial="horizon">
    <SessionsMember inputActive />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 600));
await render2();
const frameNi = capture2();
console.log('--- not-installed frame ---');
console.log(frameNi);

const hasInstallRecipe = /amore init --with-speculum/.test(frameNi);
const hasNotInstalled = /not installed/i.test(frameNi);

r2.destroy();
cleanup();

const checks = {
  readyStrip: hasReadyStrip,
  probes: hasProbes,
  heuristic: hasHeuristic,
  chips: hasChips,
  noMicroscope,
  borders: hasBorders,
  usageNote: hasUsageNote,
  model: hasModel,
  tokens: hasTokens,
  installRecipe: hasInstallRecipe,
  notInstalled: hasNotInstalled,
};

console.log('\n' + Object.entries(checks).map(([k, v]) => `${k}:${v}`).join('  '));

const ok = Object.values(checks).every(Boolean);
process.exit(ok ? 0 : 1);
