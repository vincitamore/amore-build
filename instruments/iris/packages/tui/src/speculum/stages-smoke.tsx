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
const H = Number(process.env.SMOKE_H ?? 30);

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
  // Column split at 110×30: Probes board on top, Usage totals+models below.
  return (
    <box flexDirection="column" width={W} height={H}>
      <box height={10} flexShrink={0}>
        <ProbesStage inputActive />
      </box>
      <box height={20} flexShrink={0}>
        <UsageStage inputActive />
      </box>
    </box>
  );
}

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
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
const frame = captureCharFrame();
console.log(frame);

const hasApology = /apology-rate/.test(frame);
const hasHeuristic = /\[heuristic\]/.test(frame);
const hasUsageNote = /Token and turn counts only|No price table/.test(frame);
const hasModel = /smoke-model/.test(frame);
const hasTokens = /1\.5K|2\.5K|4\.3K|4\.2K/.test(frame);
const hasBorders = /[┌┐└┘─│]/.test(frame);

console.log(
  `\napology:${hasApology} heuristic:${hasHeuristic} note:${hasUsageNote} model:${hasModel} tokens:${hasTokens} borders:${hasBorders}`,
);

renderer.destroy();
if (prevBin === undefined) delete process.env.SPECULUM_BIN;
else process.env.SPECULUM_BIN = prevBin;
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

const ok = hasApology && hasHeuristic && hasUsageNote && hasModel && hasTokens && hasBorders;
process.exit(ok ? 0 : 1);
