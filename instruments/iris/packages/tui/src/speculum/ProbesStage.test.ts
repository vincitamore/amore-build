import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import {
  clampRowScroll,
  formatProbeValue,
  formatWilsonRange,
  hitEventId,
  moveProbeCursor,
  probeCardRight,
  probeVisibleRange,
  ProbesStage,
  type ScanRow,
} from './ProbesStage';

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

const SCAN_FIXTURE: ScanRow[] = [
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
        eventId: 42,
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
    hits: [
      {
        sessionId: 'sess-bbb',
        ts: '2026-02-01T00:00:00.000Z',
        category: 'loop',
        evidence: 'repeated the same edit thrice',
        eventIds: [99, 100],
      },
    ],
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

describe('probe grid navigation helpers', () => {
  test('moveProbeCursor: ←→ within row, ↑↓ by perRow', () => {
    // 2-up grid, 5 items (indices 0..4)
    expect(moveProbeCursor(0, 'right', 5, 2)).toBe(1);
    expect(moveProbeCursor(1, 'right', 5, 2)).toBe(2);
    expect(moveProbeCursor(0, 'left', 5, 2)).toBe(0);
    expect(moveProbeCursor(2, 'left', 5, 2)).toBe(1);
    expect(moveProbeCursor(0, 'down', 5, 2)).toBe(2);
    expect(moveProbeCursor(1, 'down', 5, 2)).toBe(3);
    expect(moveProbeCursor(3, 'down', 5, 2)).toBe(4); // clamp
    expect(moveProbeCursor(4, 'down', 5, 2)).toBe(4);
    expect(moveProbeCursor(3, 'up', 5, 2)).toBe(1);
    expect(moveProbeCursor(1, 'up', 5, 2)).toBe(0);
  });

  test('probeVisibleRange + clampRowScroll', () => {
    // 11 probes, 2-up → 6 rows; show 2 rows starting at row 0 → 1–4
    expect(probeVisibleRange(11, 0, 2, 2)).toEqual({ first: 1, last: 4 });
    // scroll to row 2 → probes 5–8
    expect(probeVisibleRange(11, 2, 2, 2)).toEqual({ first: 5, last: 8 });
    // last window
    expect(probeVisibleRange(11, 4, 2, 2)).toEqual({ first: 9, last: 11 });
    expect(probeVisibleRange(0, 0, 2, 2)).toEqual({ first: 0, last: 0 });

    expect(clampRowScroll(0, 0, 2, 2)).toBe(0);
    expect(clampRowScroll(5, 0, 2, 2)).toBe(1); // row 2 needs scroll 1 for window of 2
    expect(clampRowScroll(1, 2, 2, 2)).toBe(0); // row 0 < scroll 2 → jump back
  });

  test('probeCardRight prefers hits N when present', () => {
    const withHits = SCAN_FIXTURE[0]!;
    const empty = SCAN_FIXTURE[1]!;
    expect(probeCardRight(withHits)).toBe('hits 1');
    expect(probeCardRight(empty)).toMatch(/0\.0–100\.0%.*\[heuristic\]/);
  });

  test('hitEventId reads eventId then eventIds[0]', () => {
    expect(hitEventId({ sessionId: 's', evidence: '', eventId: 7 })).toBe(7);
    expect(hitEventId({ sessionId: 's', evidence: '', eventIds: [9, 10] })).toBe(9);
    expect(hitEventId({ sessionId: 's', evidence: '' })).toBeUndefined();
  });
});

describe('ProbesStage render', () => {
  test('renders probe cards from scan fixture', async () => {
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

    await new Promise((r) => setTimeout(r, 600));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/apology-rate|APOLOGY-RATE/i);
    expect(frame).toMatch(/sensitive-content|SENSITIVE-CONTENT/i);
    expect(frame).toMatch(/\[heuristic\]|hits\s+\d+/i);
    expect(frame).toMatch(/probes\s+\d+–\d+\s+of\s+\d+/i);
    // empty corpus still shows wide CI honesty somewhere (sensitive-content)
    expect(frame).toMatch(/0\.0–100\.0%|hits\s+1/i);
  });

  test('drill Enter opens hits; second Enter fires onOpenSession with eventId', async () => {
    const bin = writeFakeBin(
      [
        `const verb = process.argv[2];`,
        `if (verb === 'scan') {`,
        `  console.log(JSON.stringify(${JSON.stringify(SCAN_FIXTURE)}));`,
        `  process.exit(0);`,
        `}`,
        `process.exit(2);`,
        ``,
      ].join('\n'),
    );
    process.env.SPECULUM_BIN = bin;

    let opened: { sessionId: string; opts?: { eventId?: string | number } } | null = null;
    const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({
      width: 110,
      height: 32,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(ProbesStage, {
          inputActive: true,
          onOpenSession: (sessionId, opts) => {
            opened = { sessionId, opts };
          },
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 600));
    await renderOnce();

    // First probe is apology-rate (has hits with eventId 42).
    await mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const hitsFrame = captureCharFrame();
    expect(hitsFrame, `hits frame:\n${hitsFrame}`).toMatch(/hits\s*\(/);
    expect(hitsFrame).toMatch(/sess-aaa/);

    // Enter on the selected hit → openSession with eventId.
    await mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 80));
    expect(opened, 'onOpenSession should fire').not.toBeNull();
    expect(opened!.sessionId).toBe('sess-aaa');
    expect(opened!.opts?.eventId).toBe(42);
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
