// Headless smoke for ProbesStage + UsageStage against a fake SPECULUM_BIN.
// Run: bun run src/speculum/stages-smoke.tsx
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { ProbesStage } from './ProbesStage';
import { UsageStage } from './UsageStage';

const W = Number(process.env.SMOKE_W ?? 110);
const H = Number(process.env.SMOKE_H ?? 44);

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
        eventId: 7,
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

const tmp = mkdtempSync(join(tmpdir(), 'stages-smoke-'));
const mjs = join(tmp, 'fake-speculum.mjs');
writeFileSync(
  mjs,
  [
    `const verb = process.argv[2];`,
    `if (verb === 'scan') { console.log(JSON.stringify(${JSON.stringify(SCAN)})); process.exit(0); }`,
    `if (verb === 'usage') { console.log(JSON.stringify(${JSON.stringify(USAGE)})); process.exit(0); }`,
    `console.error('unknown verb ' + verb); process.exit(2);`,
    ``,
  ].join('\n'),
  'utf8',
);

let bin: string;
if (process.platform === 'win32') {
  bin = join(tmp, 'fake-speculum.cmd');
  writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');
} else {
  bin = join(tmp, 'fake-speculum');
  writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mjs}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
}

const prevBin = process.env.SPECULUM_BIN;
process.env.SPECULUM_BIN = bin;

function BothStages() {
  // Column split: Probes card grid on top, Usage stat cards below.
  return (
    <box flexDirection="column" width={W} height={H}>
      <box height={20} flexShrink={0}>
        <ProbesStage inputActive />
      </box>
      <box height={24} flexShrink={0}>
        <UsageStage inputActive />
      </box>
    </box>
  );
}

const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({
  width: W,
  height: H,
});
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <BothStages />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 800));
await renderOnce();
let frame = captureCharFrame();

// Card titles (ALL-CAPS) + summary body + usage note/model.
const hasApology = /apology-rate|APOLOGY-RATE/i.test(frame);
const hasHeuristic = /\[heuristic\]|hits\s+\d+/i.test(frame);
const hasSummary = /self-corrections|4 self/i.test(frame);
const hasRange = /probes\s+\d+–\d+\s+of\s+\d+/i.test(frame);
const hasUsageNote = /Token and turn counts only|No price table/.test(frame);
const hasModel = /smoke-model|SMOKE-MODEL/i.test(frame);
const hasTokens = /1\.5K|2\.5K|4\.3K|4\.2K/.test(frame);
const hasBorders = /[┌┐└┘─│]/.test(frame);
const hasTurns = /TURNS|Turns/i.test(frame);

// Drill: Enter opens hits row for the selected probe.
await mockInput.pressEnter();
await new Promise((r) => setTimeout(r, 100));
await renderOnce();
frame = captureCharFrame();
const hasDrill = /hits\s*\(/.test(frame) && /smoke-sess/.test(frame);

console.log(frame);
console.log(
  `\napology:${hasApology} heuristic:${hasHeuristic} summary:${hasSummary} range:${hasRange} note:${hasUsageNote} model:${hasModel} tokens:${hasTokens} turns:${hasTurns} borders:${hasBorders} drill:${hasDrill}`,
);

renderer.destroy();
if (prevBin === undefined) delete process.env.SPECULUM_BIN;
else process.env.SPECULUM_BIN = prevBin;
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

const ok =
  hasApology &&
  hasHeuristic &&
  hasSummary &&
  hasRange &&
  hasUsageNote &&
  hasModel &&
  hasTokens &&
  hasBorders &&
  hasDrill;
process.exit(ok ? 0 : 1);
