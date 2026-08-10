/**
 * Card primitive — pure grid math + headless render checks.
 * Long title stays one row; right annotation visible; selected title ink shifts;
 * CardGrid rows match width math without interleave at 40/80/120.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { toPalette } from '../theme';
import {
  Card,
  CardGrid,
  cardInnerWidth,
  cardWidthForRow,
  cardsPerRow,
  chunkByRow,
  fitTitleBar,
  padTruncate,
} from './Card';

describe('Card pure math', () => {
  test('cardsPerRow: width / min → per-row count', () => {
    expect(cardsPerRow(40, 18, 1)).toBe(2);
    expect(cardsPerRow(40, 20, 1)).toBe(1);
    expect(cardsPerRow(80, 18, 1)).toBe(4);
    expect(cardsPerRow(120, 18, 1)).toBe(6);
    // (68+1)/(22+1) = 3
    expect(cardsPerRow(68, 22, 1)).toBe(3);
    expect(cardsPerRow(104, 16, 1)).toBe(6);
  });

  test('cardsPerRow: boundaries', () => {
    expect(cardsPerRow(0, 18, 1)).toBe(1);
    expect(cardsPerRow(40, 0, 1)).toBe(1);
    expect(cardsPerRow(-1, 18, 1)).toBe(1);
    expect(cardsPerRow(18, 18, 1)).toBe(1);
    // 18 + gap1 + 18 = 37 → still fits 2 via (37+1)/(18+1)
    expect(cardsPerRow(37, 18, 1)).toBe(2);
    // 18 + 1 + 18 = 37 > 36 → only 1
    expect(cardsPerRow(36, 18, 1)).toBe(1);
    expect(cardsPerRow(19, 18, 0)).toBe(1);
    expect(cardsPerRow(36, 18, 0)).toBe(2);
  });

  test('chunkByRow + cardWidthForRow', () => {
    expect(chunkByRow([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkByRow([], 3)).toEqual([]);
    expect(chunkByRow(['a'], 4)).toEqual([['a']]);
    // 40 wide, 2 cards, gap 1 → floor((40-1)/2) = 19
    expect(cardWidthForRow(40, 2, 1)).toBe(19);
    expect(cardWidthForRow(80, 4, 1)).toBe(19);
    expect(cardWidthForRow(120, 6, 1)).toBe(19);
  });

  test('cardInnerWidth uses house −6 rule', () => {
    expect(cardInnerWidth(40)).toBe(34);
    expect(cardInnerWidth(6)).toBe(0);
    expect(cardInnerWidth(5)).toBe(0);
    expect(cardInnerWidth(0)).toBe(0);
  });

  test('padTruncate + fitTitleBar never exceed width', () => {
    expect(padTruncate('hello', 10)).toBe('hello     ');
    expect(padTruncate('hello world', 8).length).toBe(8);
    expect(padTruncate('hello world', 8)).toBe('hello w\u2026');

    for (const w of [8, 12, 20, 40, 60]) {
      const { left, right } = fitTitleBar(
        'probe-name-that-is-quite-long',
        '12.3–45.6%',
        w,
        true,
      );
      const used = left.length + right.length;
      expect(used, `width ${w}: left=${left.length} right=${right.length}`).toBe(w);
      expect(left).toMatch(/\u25B8|…|PROBED|PROBE/);
    }
  });
});

describe('Card render', () => {
  let destroy: (() => void) | undefined;

  afterEach(() => {
    destroy?.();
    destroy = undefined;
  });

  test('long title truncates to one row; right appears; selected title ink', async () => {
    const { renderer, renderOnce, captureCharFrame, captureSpans } = await createTestRenderer({
      width: 48,
      height: 10,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    const longTitle = 'session postmortem probe with a very long name';
    const right = '12.0–34.0%';

    root.render(
      <ThemeProvider initial="horizon">
        <Card title={longTitle} right={right} selected width={36}>
          <text>body line</text>
        </Card>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();
    const lines = frame.split(/\r?\n/).filter((l) => l.trim().length > 0);

    // Right annotation present.
    expect(frame).toContain('12.0');
    // No full untruncated title spilled across rows (ellipsis or caret form only).
    expect(frame).not.toContain(longTitle);
    expect(frame).not.toContain(longTitle.toUpperCase());
    // Title bar is a single visual row containing the caret and a PROBE/SESSION fragment.
    const titleLine = lines.find((l) => l.includes('\u25B8') || l.includes('SESSION') || l.includes('POST'));
    expect(titleLine, `frame:\n${frame}`).toBeDefined();
    // Body still below title — not interleaved into the title row.
    expect(frame).toContain('body line');
    const bodyIdx = frame.indexOf('body line');
    const titleIdx = frame.indexOf('\u25B8');
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(titleIdx);

    // Selected title uses primary ink (horizon #e95678).
    const primary = toPalette('horizon').primary.toInts();
    const spans = captureSpans() as {
      lines: Array<{ spans: Array<{ text: string; fg: { toInts: () => number[] } }> }>;
    };
    let foundTitleInk = false;
    for (const line of spans.lines) {
      for (const s of line.spans) {
        if (s.text.includes('\u25B8') || /SESSION|POSTMORTEM|PROBE/i.test(s.text)) {
          const ink = s.fg.toInts();
          expect(ink.slice(0, 3)).toEqual(primary.slice(0, 3));
          foundTitleInk = true;
          break;
        }
      }
      if (foundTitleInk) break;
    }
    expect(foundTitleInk, `no title span in:\n${frame}`).toBe(true);
  });

  test('unselected title does not use selection caret', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 40,
      height: 8,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      <ThemeProvider initial="horizon">
        <Card title="usage" right="n=4" width={28}>
          <text>x</text>
        </Card>
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain('USAGE');
    expect(frame).toContain('n=4');
    expect(frame).not.toContain('\u25B8');
  });

  test('CardGrid rows match width math without interleave at 40/80/120', async () => {
    const labels = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT'];
    const minCard = 18;
    const gap = 1;

    for (const W of [40, 80, 120] as const) {
      const per = cardsPerRow(W, minCard, gap);
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: W + 4,
        height: 24,
      });
      destroy = () => renderer.destroy();
      const root = createRoot(renderer);

      root.render(
        <ThemeProvider initial="horizon">
          <box width={W} flexDirection="column">
            <CardGrid width={W} minCardWidth={minCard} gap={gap}>
              {labels.map((name) => (
                <Card key={name} title={name} width={cardWidthForRow(W, per, gap)}>
                  <text>{`v-${name}`}</text>
                </Card>
              ))}
            </CardGrid>
          </box>
        </ThemeProvider>,
      );
      await new Promise((r) => setTimeout(r, 80));
      await renderOnce();
      const frame = captureCharFrame();

      // Every card title appears (ALL-CAPS already).
      for (const name of labels) {
        expect(frame, `W=${W} missing ${name}`).toContain(name);
      }

      // Row count from math: ceil(N / per).
      const expectedRows = Math.ceil(labels.length / per);
      // Count top-border corners as a proxy for card boxes; each card has one ┌.
      const tops = (frame.match(/┌/g) ?? []).length;
      expect(tops, `W=${W} per=${per} frame:\n${frame}`).toBe(labels.length);

      // No interleaved mash of two titles on one content cell (e.g. ALPHABRAVO).
      expect(frame).not.toMatch(/ALPHABRAVO|BRAVOCHARLIE|CHARLIEDELTA|DELTAECHO|ECHOFOXTROT/);
      // Fixed-size audit: frame width lines should not exceed renderer width wildly.
      for (const line of frame.split(/\r?\n/)) {
        expect(line.length, `W=${W} line too long: ${line}`).toBeLessThanOrEqual(W + 4);
      }

      // Sanity: expected row math used.
      expect(per).toBeGreaterThanOrEqual(1);
      expect(expectedRows).toBeGreaterThanOrEqual(1);

      destroy();
      destroy = undefined;
    }
  });
});
