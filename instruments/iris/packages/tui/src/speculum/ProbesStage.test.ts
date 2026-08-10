import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { formatProbeValue, formatWilsonRange, ProbesStage } from './ProbesStage';

/**
 * Fixture: SPECULUM_BIN is a .cmd/.sh wrapper that runs a temp .mjs via process.execPath.
 * The stage calls runSpeculum('scan', ['--json']) → fake bin sees argv verb "scan".
 */

let tmp: string;
let prevBin: string | undefined;
let destroy: (() => void) | undefined;

function writeFakeBin(handlerBody: string): string {
  const mjs = join(tmp, `fake-scan-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(mjs, handlerBody, 'utf8');
  if (process.platform === 'win32') {
    const cmd = join(tmp, `fake-speculum-${Date.now()}-${Math.random().toString(36).slice(2)}.cmd`);
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = join(tmp, `fake-speculum-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(sh, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mjs}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
  return sh;
}

const SCAN_FIXTURE = [
  {
    probe: 'apology-rate',
    value: 0.12,
    ciLow: 0.05,
    ciHigh: 0.25,
    n: 100,
    partial: false,
    unit: 'msg',
    summary: '12 self-corrections / 100 assistant messages [heuristic]',
    data: {},
    hits: [
      {
        sessionId: 'sess-aaa',
        ts: '2026-01-01T00:00:00.000Z',
        category: 'self-correction',
        evidence: 'sorry about that earlier mistake in the patch',
      },
    ],
    heuristic: true,
  },
  {
    probe: 'sensitive-content',
    value: 0.0,
    ciLow: 0.0,
    ciHigh: 1.0,
    n: 0,
    partial: false,
    unit: 'session',
    summary: '0 of 0 sessions [heuristic]',
    data: {},
    hits: [],
    heuristic: true,
  },
];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'probes-stage-'));
  prevBin = process.env.SPECULUM_BIN;
});

afterAll(() => {
  if (prevBin === undefined) delete process.env.SPECULUM_BIN;
  else process.env.SPECULUM_BIN = prevBin;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

afterEach(() => {
  destroy?.();
  destroy = undefined;
  if (prevBin === undefined) delete process.env.SPECULUM_BIN;
  else process.env.SPECULUM_BIN = prevBin;
});

describe('formatProbeValue / formatWilsonRange', () => {
  test('session proportions as percent', () => {
    expect(formatProbeValue(0.25, 'session')).toBe('25.0%');
    expect(formatProbeValue(0, 'session')).toBe('0.0%');
    expect(formatProbeValue(1, 'session')).toBe('100.0%');
  });

  test('session count-like values stay raw', () => {
    expect(formatProbeValue(5, 'session')).toBe('5');
  });

  test('msg rates as percent; integer counts plain', () => {
    expect(formatProbeValue(0.12, 'msg')).toBe('12.0%');
    expect(formatProbeValue(12, 'msg')).toBe('12');
  });

  test('Wilson range keeps empty-corpus honesty [0,1] → 0.0–100.0%', () => {
    expect(formatWilsonRange(0, 1)).toBe('0.0–100.0%');
    expect(formatWilsonRange(0.05, 0.25)).toBe('5.0–25.0%');
  });
});

describe('ProbesStage render', () => {
  test('renders probe rows from scan fixture', async () => {
    const bin = writeFakeBin(
      [
        `const verb = process.argv[2];`,
        `if (verb === 'scan') {`,
        `  console.log(JSON.stringify(${JSON.stringify(SCAN_FIXTURE)}));`,
        `  process.exit(0);`,
        `}`,
        `console.error('unknown verb ' + verb);`,
        `process.exit(2);`,
        ``,
      ].join('\n'),
    );
    process.env.SPECULUM_BIN = bin;

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 110,
      height: 30,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(ProbesStage, { inputActive: true }),
      ),
    );

    // Allow spawn + JSON settle
    await new Promise((r) => setTimeout(r, 600));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/apology-rate/);
    expect(frame).toMatch(/sensitive-content/);
    expect(frame).toMatch(/\[heuristic\]/);
    expect(frame).toMatch(/12\.0%/);
    // empty corpus still shows wide CI honesty, not a fabricated clean claim
    expect(frame).toMatch(/0\.0–100\.0%/);
  });

  test('not-installed error shows install recipe', async () => {
    process.env.SPECULUM_BIN = join(tmp, 'no-such-speculum-binary');

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 110,
      height: 24,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(ProbesStage, { inputActive: true }),
      ),
    );

    await new Promise((r) => setTimeout(r, 400));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/not installed|not-installed|not found/i);
    expect(frame).toMatch(/amore init --with-speculum/);
  });

  test('nonzero fixture shows error kind + retry', async () => {
    const bin = writeFakeBin(
      [
        `console.error('fixture scan boom');`,
        `process.exit(3);`,
        ``,
      ].join('\n'),
    );
    process.env.SPECULUM_BIN = bin;

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 110,
      height: 24,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(ProbesStage, { inputActive: true }),
      ),
    );

    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/nonzero|exited 3/i);
    expect(frame).toMatch(/r to retry|r retry/i);
  });
});
