import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import {
  aggregateHitsBySession,
  brailleSparkline,
  budgetHitSlots,
  budgetProbeVisibleRows,
  buildProbeBoard,
  clampHitScroll,
  clampRowScroll,
  cycleProbeScope,
  formatDegenerateBody,
  formatHitClock,
  formatHitLine,
  formatScopeRow,
  formatSeriesLine,
  formatSessionAggLine,
  probeCardBody,
  formatProbeValue,
  formatWilsonRange,
  hitEventId,
  moveProbeCursor,
  parseSeriesMap,
  probeCardRight,
  probeCiWidth,
  probeVisibleRange,
  rankSignalProbes,
  scopeSinceIso,
  seriesDeltaLabel,
  seriesProbeList,
  SERIES_EXCLUDE_PROBES,
  REGISTRY_PROBE_NAMES,
  truncateHitLabel,
  ProbesStage,
  type ProbeHit,
  type ScanRow,
  type SeriesWindowPoint,
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

describe('formatHitLine titles', () => {
  const hit: ProbeHit = {
    sessionId: 'sess-aaa-bbbb-cccc',
    ts: '2026-01-01T15:55:24.630Z',
    category: 'self-correction',
    evidence: 'sorry about that',
    eventId: 42,
  };

  test('without title map falls back to short session id; no full ISO', () => {
    const line = formatHitLine(hit, false, undefined, 112);
    expect(line.startsWith(' ')).toBe(true);
    expect(line).toMatch(/sess-aaa-bb/);
    expect(line).toContain('sorry about that');
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(line).toMatch(/\b15:55\b/);
  });

  test('with title map: title primary, HH:MM, no paren id, no ISO', () => {
    const titles = new Map([
      ['sess-aaa-bbbb-cccc', 'Repeat Previous Single Word Reply Request'],
    ]);
    const line = formatHitLine(hit, true, titles, 112);
    expect(line.startsWith('>')).toBe(true);
    expect(line).toContain('Repeat Previous');
    expect(line).toMatch(/\b15:55\b/);
    expect(line).toContain('self-correction');
    expect(line).toContain('sorry about that');
    expect(line).not.toMatch(/\([0-9a-f-]{8,}/i);
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(line.indexOf('Repeat')).toBeLessThan(line.indexOf('sorry'));
  });

  test('formatHitClock is HH:MM UTC', () => {
    expect(formatHitClock('2026-01-01T15:55:24.630Z')).toBe('15:55');
    expect(formatHitClock('bad')).toBe('--:--');
  });

  test('truncateHitLabel respects max', () => {
    expect(truncateHitLabel('short', 28)).toBe('short');
    expect(truncateHitLabel('x'.repeat(40), 10).length).toBe(10);
    expect(truncateHitLabel('x'.repeat(40), 10).endsWith('…')).toBe(true);
  });

  test('probeCardBody never echoes probe slug or hits N', () => {
    const withSummary = SCAN_FIXTURE[0]!;
    const body = probeCardBody(withSummary);
    expect(body).not.toContain(withSummary.probe);
    expect(body).not.toMatch(/^hits \d+/);
    expect(body).toBe(withSummary.summary!);

    const bare: typeof withSummary = {
      ...SCAN_FIXTURE[1]!,
      summary: undefined,
    };
    const valueBody = probeCardBody(bare);
    expect(valueBody).not.toContain(bare.probe);
    expect(valueBody).toMatch(/n=\d/);
  });
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

describe('signal ranking + degenerate collapse', () => {
  test('rankSignalProbes: hits desc, then narrower CI first; drops n=0', () => {
    const ranked = rankSignalProbes(SCAN_FIXTURE);
    // sensitive-content n=0 excluded; apology hits=1 ciW=0.20; stuck hits=1 ciW=0.30
    expect(ranked.map((r) => r.probe)).toEqual(['apology-rate', 'stuck-loop']);
    expect(probeCiWidth(ranked[0]!)).toBeLessThan(probeCiWidth(ranked[1]!));
  });

  test('buildProbeBoard collapses n=0 into one degenerate unit', () => {
    const board = buildProbeBoard(SCAN_FIXTURE);
    expect(board).toHaveLength(3);
    expect(board[0]).toMatchObject({ kind: 'probe', row: { probe: 'apology-rate' } });
    expect(board[1]).toMatchObject({ kind: 'probe', row: { probe: 'stuck-loop' } });
    expect(board[2]?.kind).toBe('degenerate');
    if (board[2]?.kind === 'degenerate') {
      expect(board[2].names).toEqual(['sensitive-content']);
    }
    expect(formatDegenerateBody(['a', 'b'])).toBe('no-signal probes (2): a · b');
  });

  test('hits dominate CI width in ranking', () => {
    const rows: ScanRow[] = [
      {
        probe: 'few-hits-tight',
        value: 0.1,
        ciLow: 0.05,
        ciHigh: 0.15,
        n: 50,
        partial: false,
        unit: 'msg',
        hits: [{ sessionId: 's1', evidence: 'e' }],
        heuristic: true,
      },
      {
        probe: 'many-hits-wide',
        value: 0.5,
        ciLow: 0.0,
        ciHigh: 1.0,
        n: 10,
        partial: false,
        unit: 'session',
        hits: [
          { sessionId: 's2', evidence: 'e' },
          { sessionId: 's3', evidence: 'e' },
          { sessionId: 's4', evidence: 'e' },
        ],
        heuristic: true,
      },
    ];
    expect(rankSignalProbes(rows).map((r) => r.probe)).toEqual([
      'many-hits-wide',
      'few-hits-tight',
    ]);
  });
});

describe('scope row window arithmetic', () => {
  test('cycleProbeScope wraps all → 30d → 7d → all', () => {
    expect(cycleProbeScope('all', 1)).toBe('30d');
    expect(cycleProbeScope('30d', 1)).toBe('7d');
    expect(cycleProbeScope('7d', 1)).toBe('all');
    expect(cycleProbeScope('all', -1)).toBe('7d');
    expect(cycleProbeScope('7d', -1)).toBe('30d');
  });

  test('scopeSinceIso: all is null; 7d/30d are ISO floors at local midnight', () => {
    const now = new Date(2026, 5, 15, 14, 30, 0); // local Jun 15 2026
    expect(scopeSinceIso('all', now)).toBeNull();
    const d7 = scopeSinceIso('7d', now)!;
    const d30 = scopeSinceIso('30d', now)!;
    expect(d7).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d30).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const t7 = new Date(d7).getTime();
    const t30 = new Date(d30).getTime();
    const day = 24 * 60 * 60 * 1000;
    // 30d floor is ~23 days earlier than 7d floor
    expect(t7 - t30).toBeGreaterThan(20 * day);
    expect(t7 - t30).toBeLessThan(26 * day);
    // floors land on local midnight (ms-of-day ≈ 0 in local, but ISO is UTC)
    const local7 = new Date(d7);
    expect(local7.getHours() + local7.getMinutes() + local7.getSeconds()).toBe(0);
  });

  test('formatScopeRow marks active chip in uppercase', () => {
    expect(formatScopeRow('all')).toBe('ALL · 30d · 7d');
    expect(formatScopeRow('7d')).toBe('all · 30d · 7D');
  });
});

describe('series parse + sparkline + degrade', () => {
  const windows: SeriesWindowPoint[] = Array.from({ length: 12 }, (_, i) => ({
    since: `2026-0${Math.floor(i / 4) + 1}-01T00:00:00.000Z`,
    until: `2026-0${Math.floor(i / 4) + 1}-08T00:00:00.000Z`,
    value: i / 20,
    ciLow: 0,
    ciHigh: 1,
    n: i === 0 ? 0 : 10,
    partial: i === 11,
  }));

  test('brailleSparkline is 12 braille cells; empty n paints blank', () => {
    const spark = brailleSparkline(windows, 12);
    expect(spark.length).toBe(12);
    // braille block is U+2800..U+28FF
    for (const ch of spark) {
      const code = ch.codePointAt(0)!;
      expect(code).toBeGreaterThanOrEqual(0x2800);
      expect(code).toBeLessThanOrEqual(0x28ff);
    }
  });

  test('seriesDeltaLabel reports pp delta for rate-like windows', () => {
    const short: SeriesWindowPoint[] = [
      { since: 'a', until: 'b', value: 0.1, ciLow: 0, ciHigh: 1, n: 5, partial: false },
      { since: 'b', until: 'c', value: 0.25, ciLow: 0, ciHigh: 1, n: 5, partial: true },
    ];
    expect(seriesDeltaLabel(short)).toMatch(/Δ \+15\.0pp/);
    expect(seriesDeltaLabel([])).toBe('');
  });

  test('parseSeriesMap soft-degrades bad shapes to empty map', () => {
    expect(parseSeriesMap(null).size).toBe(0);
    expect(parseSeriesMap({}).size).toBe(0);
    expect(parseSeriesMap([{ probe: 'x' }]).size).toBe(0); // no windows
    const good = parseSeriesMap([
      { probe: 'apology-rate', granularity: 'weekly', windows },
    ]);
    expect(good.get('apology-rate')).toHaveLength(12);
    const line = formatSeriesLine(windows);
    expect(line.length).toBeGreaterThan(12);
    expect(line).toMatch(/Δ/);
  });
});

describe('detail aggregation math', () => {
  test('aggregateHitsBySession groups counts + latest + first hit', () => {
    const hits: ProbeHit[] = [
      {
        sessionId: 'sess-a',
        ts: '2026-01-01T10:00:00.000Z',
        evidence: 'first',
        eventId: 1,
      },
      {
        sessionId: 'sess-b',
        ts: '2026-01-02T12:00:00.000Z',
        evidence: 'solo',
        eventId: 2,
      },
      {
        sessionId: 'sess-a',
        ts: '2026-01-03T15:30:00.000Z',
        evidence: 'later',
        eventId: 3,
      },
    ];
    const titles = new Map([['sess-a', 'Alpha Session'], ['sess-b', 'Beta']]);
    const aggs = aggregateHitsBySession(hits, titles);
    expect(aggs).toHaveLength(2);
    // sess-a has 2 hits → first
    expect(aggs[0]!.sessionId).toBe('sess-a');
    expect(aggs[0]!.hitCount).toBe(2);
    expect(aggs[0]!.latestTs).toBe('2026-01-03T15:30:00.000Z');
    expect(aggs[0]!.firstHit.eventId).toBe(1);
    expect(aggs[0]!.title).toContain('Alpha');
    expect(aggs[1]!.hitCount).toBe(1);
    const line = formatSessionAggLine(aggs[0]!, true);
    expect(line.startsWith('>')).toBe(true);
    expect(line).toMatch(/2 hits/);
    expect(line).toMatch(/latest 15:30/);
  });
});

describe('series exclusion list membership', () => {
  test('sensitive-content is excluded; kin criterion is privacy-gate full-text', () => {
    expect(SERIES_EXCLUDE_PROBES).toContain('sensitive-content');
    expect(SERIES_EXCLUDE_PROBES).not.toContain('apology-rate');
    expect(REGISTRY_PROBE_NAMES).toContain('sensitive-content');
    const trend = seriesProbeList();
    expect(trend).not.toContain('sensitive-content');
    expect(trend.length).toBe(REGISTRY_PROBE_NAMES.length - SERIES_EXCLUDE_PROBES.length);
    // every exclude is a known registry name
    for (const n of SERIES_EXCLUDE_PROBES) {
      expect(REGISTRY_PROBE_NAMES).toContain(n);
    }
  });
});

describe('probe drill budget + hit window', () => {
  test('budgetHitSlots fills residual body height (tall/short)', () => {
    // body residual: 30 − 10 grid − 1 header → 19 slots
    expect(budgetHitSlots(30, 10, 1)).toBe(19);
    // short body: 10 − 5 grid − 1 header → 4
    expect(budgetHitSlots(10, 5, 1)).toBe(4);
    // starved residual still floors at 1 (fit-clamp floor, not a MIN past residual)
    expect(budgetHitSlots(6, 10, 1)).toBe(1);
    // default hits-header arg (=1)
    expect(budgetHitSlots(30, 10)).toBe(19);
  });

  test('budgetProbeVisibleRows: closed grows; open leaves room for hits', () => {
    // closed board at bodyH 30 → several card rows (capped 6); card row H = 5
    expect(budgetProbeVisibleRows(30, false)).toBeGreaterThanOrEqual(3);
    expect(budgetProbeVisibleRows(30, false)).toBeLessThanOrEqual(6);
    // open at short body still ≥1 grid row
    expect(budgetProbeVisibleRows(10, true)).toBe(1);
    // open at tall: grid stays compact so hits absorb height
    const tallOpen = budgetProbeVisibleRows(30, true);
    expect(tallOpen).toBeGreaterThanOrEqual(1);
    const hitSlots = budgetHitSlots(30, tallOpen * 5, 1);
    expect(hitSlots).toBeGreaterThanOrEqual(8);
  });

  test('I-PROBE-SLOTS-FIT: grid + hits stay within bodyH', () => {
    for (const bodyH of [9, 15, 20, 30, 39]) {
      const vr = budgetProbeVisibleRows(bodyH, true);
      const gridH = vr * 5;
      const hits = budgetHitSlots(bodyH, gridH, 1);
      // Fit-clamp: painted stack never exceeds body when residual can hold header+hit
      if (bodyH >= gridH + 2) {
        expect(gridH + 1 + hits).toBeLessThanOrEqual(bodyH);
      }
      expect(hits).toBeGreaterThanOrEqual(1);
    }
  });

  test('clampHitScroll follows the cursor into the window', () => {
    // 10 hits, 4 slots
    expect(clampHitScroll(0, 0, 4, 10)).toBe(0);
    expect(clampHitScroll(3, 0, 4, 10)).toBe(0);
    expect(clampHitScroll(4, 0, 4, 10)).toBe(1); // cursor past window end
    expect(clampHitScroll(9, 0, 4, 10)).toBe(6);
    expect(clampHitScroll(1, 5, 4, 10)).toBe(1); // cursor above window → jump back
    expect(clampHitScroll(0, 0, 4, 2)).toBe(0); // fewer hits than slots
    expect(clampHitScroll(5, 10, 4, 10)).toBe(5); // scroll clamped to max
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
    // n=0 probes collapse into the no-signal card (not a full sensitive-content card)
    expect(frame).toMatch(/no-signal|NO-SIGNAL|sensitive-content/i);
    expect(frame).toMatch(/\[heuristic\]|hits\s+\d+/i);
    expect(frame).toMatch(/probes\s+\d+–\d+\s+of\s+\d+/i);
    // scope chips present (active ALL uppercase)
    expect(frame).toMatch(/\bALL\b/);
    expect(frame).toMatch(/30d|7d/i);
    // empty corpus still shows wide CI honesty somewhere, or hits annotation
    expect(frame).toMatch(/0\.0–100\.0%|hits\s+\d+|no-signal/i);
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

  test('detail d opens aggregated sessions; L handoff fires onLensSession', async () => {
    const multiHit: ScanRow[] = [
      {
        ...SCAN_FIXTURE[0]!,
        hits: [
          {
            sessionId: 'sess-aaa',
            ts: '2026-01-01T10:00:00.000Z',
            category: 'self-correction',
            evidence: 'sorry once',
            eventId: 1,
          },
          {
            sessionId: 'sess-aaa',
            ts: '2026-01-01T11:00:00.000Z',
            category: 'self-correction',
            evidence: 'sorry twice',
            eventId: 2,
          },
          {
            sessionId: 'sess-ccc',
            ts: '2026-01-02T09:00:00.000Z',
            category: 'self-correction',
            evidence: 'other',
            eventId: 3,
          },
        ],
      },
      SCAN_FIXTURE[2]!,
    ];
    const bin = writeFakeBin(
      [
        `const verb = process.argv[2];`,
        `if (verb === 'scan') {`,
        `  console.log(JSON.stringify(${JSON.stringify(multiHit)}));`,
        `  process.exit(0);`,
        `}`,
        `process.exit(2);`,
        ``,
      ].join('\n'),
    );
    process.env.SPECULUM_BIN = bin;

    let lensId: string | null = null;
    const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({
      width: 110,
      height: 36,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      createElement(
        ThemeProvider,
        { initial: 'horizon' },
        createElement(ProbesStage, {
          inputActive: true,
          onLensSession: (sessionId) => {
            lensId = sessionId;
          },
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 600));
    await renderOnce();

    // Open detail on first ranked probe (apology-rate).
    mockInput.pressKey('d');
    await new Promise((r) => setTimeout(r, 100));
    await renderOnce();
    const detailFrame = captureCharFrame();
    expect(detailFrame, `detail:\n${detailFrame}`).toMatch(/detail/i);
    expect(detailFrame).toMatch(/apology-rate|APOLOGY-RATE/i);
    // Aggregated: sess-aaa should show 2 hits (or title/id + hit count).
    expect(detailFrame).toMatch(/2 hits|sessions\s*\(/i);

    // L on the selected session row → lens handoff.
    mockInput.pressKey('l');
    await new Promise((r) => setTimeout(r, 80));
    expect(lensId, 'onLensSession should fire').toBe('sess-aaa');
  });

  test('series degrade: board still paints when series spawn fails', async () => {
    const bin = writeFakeBin(
      [
        `const args = process.argv.slice(2);`,
        `const verb = args[0];`,
        `if (verb === 'scan' && args.includes('--series')) {`,
        `  console.error('series boom');`,
        `  process.exit(3);`,
        `}`,
        `if (verb === 'scan') {`,
        `  console.log(JSON.stringify(${JSON.stringify(SCAN_FIXTURE)}));`,
        `  process.exit(0);`,
        `}`,
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

    await new Promise((r) => setTimeout(r, 700));
    await renderOnce();
    const frame = captureCharFrame();
    // Board still up despite series failure.
    expect(frame, `frame:\n${frame}`).toMatch(/apology-rate|APOLOGY-RATE/i);
    expect(frame).toMatch(/probes\s+\d+–\d+\s+of\s+\d+/i);
    expect(frame).not.toMatch(/series boom/i);
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

  test('drill flex: tall terminal shows ≥8 hit rows; short fits footer', async () => {
    const manyHits: ProbeHit[] = Array.from({ length: 12 }, (_, i) => ({
      sessionId: `hit-sess-${String(i).padStart(2, '0')}`,
      ts: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
      category: 'self-correction',
      evidence: `evidence row ${i}`,
      eventId: 100 + i,
    }));
    const tallFixture: ScanRow[] = [
      {
        ...SCAN_FIXTURE[0]!,
        hits: manyHits,
      },
      SCAN_FIXTURE[1]!,
    ];
    const bin = writeFakeBin(
      [
        `const verb = process.argv[2];`,
        `if (verb === 'scan') {`,
        `  console.log(JSON.stringify(${JSON.stringify(tallFixture)}));`,
        `  process.exit(0);`,
        `}`,
        `process.exit(2);`,
        ``,
      ].join('\n'),
    );
    process.env.SPECULUM_BIN = bin;

    // --- tall: 110×44 — hits panel must show more than the old hard 4 ---
    {
      const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({
        width: 110,
        height: 44,
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
      await mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 80));
      await renderOnce();
      const tall = captureCharFrame();
      expect(tall, `tall drill:\n${tall}`).toMatch(/hits\s*\(\s*12\s*\)/);
      // Count distinct hit session rows painted (fixed-slot window).
      const hitRowCount = (tall.match(/hit-sess-\d+/g) ?? []).length;
      expect(hitRowCount, `expected ≥8 hit rows in tall frame, got ${hitRowCount}:\n${tall}`).toBeGreaterThanOrEqual(8);
      expect(tall).toMatch(/↑↓ hit|enter open session|h\/esc close/i);
      renderer.destroy();
      destroy = undefined;
    }

    // --- short: 80×24 — drill fits without clipping the stage footer ---
    {
      const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({
        width: 80,
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
      await new Promise((r) => setTimeout(r, 600));
      await renderOnce();
      await mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 80));
      await renderOnce();
      const short = captureCharFrame();
      expect(short, `short drill:\n${short}`).toMatch(/hits\s*\(/);
      // Footer chrome must remain visible (not overflow-clipped off the buffer).
      expect(short, `short drill missing footer:\n${short}`).toMatch(
        /↑↓ hit|enter open|h\/esc close|r refresh/i,
      );
      // captureCharFrame may append a trailing newline → H+1 split parts; count content.
      const lines = short.replace(/\n+$/, '').split('\n');
      expect(lines.length).toBeLessThanOrEqual(24);
    }
  });
});
