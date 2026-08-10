import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { buildUsageCards, formatTokens, UsageStage, type UsageJson } from './UsageStage';

let tmp: string;
let prevBin: string | undefined;
let destroy: (() => void) | undefined;

function writeFakeBin(handlerBody: string): string {
  const mjs = join(tmp, `fake-usage-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(mjs, handlerBody, 'utf8');
  if (process.platform === 'win32') {
    const cmd = join(tmp, `fake-usage-bin-${Date.now()}-${Math.random().toString(36).slice(2)}.cmd`);
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = join(tmp, `fake-usage-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(sh, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mjs}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
  return sh;
}

const USAGE_FIXTURE: UsageJson = {
  window: { since: null, until: null },
  models: [
    {
      model: 'gpt-test-1',
      turns: 42,
      sessions: 3,
      tokens: {
        input: 1200,
        output: 3400,
        cachedRead: 500,
        reasoning: 100,
        total: 5200,
      },
    },
  ],
  totals: {
    turns: 42,
    sessions: 3,
    tokens: {
      input: 1200,
      output: 3400,
      cachedRead: 500,
      reasoning: 100,
      total: 5200,
    },
  },
  note: 'Token and turn counts only. No price table in v1 — provider prices vary per user.',
};

const USAGE_EMPTY_MODELS: UsageJson = {
  window: { since: null, until: null },
  models: [],
  totals: {
    turns: 0,
    sessions: 0,
    tokens: { input: 0, output: 0, cachedRead: 0, reasoning: 0, total: 0 },
  },
  note: 'Token and turn counts only. No price table in v1 — provider prices vary per user.',
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'usage-stage-'));
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

describe('formatTokens', () => {
  test('compact K/M and plain small numbers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1200)).toBe('1.2K');
    expect(formatTokens(3400000)).toBe('3.4M');
    expect(formatTokens(1_000_000)).toBe('1.0M');
  });
});

describe('buildUsageCards', () => {
  test('emits 7 totals + one card per model, price-free', () => {
    const cards = buildUsageCards(USAGE_FIXTURE);
    expect(cards.filter((c) => c.kind === 'total')).toHaveLength(7);
    expect(cards.map((c) => c.title)).toContain('Turns');
    expect(cards.map((c) => c.title)).toContain('Cached-read');
    expect(cards.map((c) => c.title)).toContain('Total');
    const models = cards.filter((c) => c.kind === 'model');
    expect(models).toHaveLength(1);
    expect(models[0]!.title).toBe('gpt-test-1');
    expect(models[0]!.value).toBe('5.2K');
    expect(JSON.stringify(cards)).not.toMatch(/\$\d/);
  });
});

describe('UsageStage render', () => {
  test('renders totals + note + model card from usage fixture', async () => {
    const bin = writeFakeBin(
      [
        `const verb = process.argv[2];`,
        `if (verb === 'usage') {`,
        `  console.log(JSON.stringify(${JSON.stringify(USAGE_FIXTURE)}));`,
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
        createElement(UsageStage, { inputActive: true }),
      ),
    );

    await new Promise((r) => setTimeout(r, 600));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/Token and turn counts only/);
    expect(frame).toMatch(/No price table/);
    expect(frame).toMatch(/gpt-test-1|GPT-TEST-1/i);
    expect(frame).toMatch(/1\.2K/);
    expect(frame).toMatch(/3\.4K|5\.2K/);
    expect(frame).toMatch(/TURNS|Turns/i);
    // price-free: no currency chrome
    expect(frame).not.toMatch(/\$\d/);
  });

  test('empty models still renders honest note + zero totals', async () => {
    const bin = writeFakeBin(
      [
        `console.log(JSON.stringify(${JSON.stringify(USAGE_EMPTY_MODELS)}));`,
        ``,
      ].join('\n'),
    );
    process.env.SPECULUM_BIN = bin;

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 110,
      height: 28,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(UsageStage, { inputActive: true }),
      ),
    );

    await new Promise((r) => setTimeout(r, 500));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/Token and turn counts only/);
    expect(frame).toMatch(/none|no usage|by model|TURNS/i);
  });

  test('not-installed error shows install recipe', async () => {
    process.env.SPECULUM_BIN = join(tmp, 'no-such-usage-binary');

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
        createElement(UsageStage, { inputActive: true }),
      ),
    );

    await new Promise((r) => setTimeout(r, 400));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame, `frame:\n${frame}`).toMatch(/not installed|not-installed|not found/i);
    expect(frame).toMatch(/amore init --with-speculum/);
  });
});
