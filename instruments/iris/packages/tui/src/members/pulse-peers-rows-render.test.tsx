/**
 * Pulse Peers: count on the label row, identities on a fixed-height sub-line.
 * Long N=4 names must ellipsize, not wrap; a shorter follow-up paint must
 * fully clear the prior identities (opaque row + wrapMode none).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import {
  formatPeers,
  formatPeersDetail,
  type PresenceEntry,
} from '../coord/presence';
import { ThemeProvider, usePalette } from '../ThemeProvider';
import { emptyDisplayRow, formatLucernaDisplayLine } from './lucerna-display';

const COL_W = 48;
const INNER = COL_W - 4;
const RIGHT_W = Math.max(12, Math.min(32, INNER - 12));

function PulsePeersRows({ line, detail }: { line: string; detail: string }) {
  const t = usePalette();
  const sub = detail ? formatLucernaDisplayLine(`   ${detail}`, INNER, '/tmp') : emptyDisplayRow(INNER);
  return (
    <box
      flexDirection="column"
      width={COL_W}
      height={4}
      backgroundColor={t.background}
      paddingLeft={1}
      paddingRight={1}
    >
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        overflow="hidden"
        backgroundColor={t.background}
      >
        <text fg={t.info} wrapMode="none">
          ●
        </text>
        <text fg={t.foreground} wrapMode="none">
          {' Peers'}
        </text>
        <box flexGrow={1} backgroundColor={t.background} />
        <text fg={t.muted} wrapMode="none">
          {formatLucernaDisplayLine(line, RIGHT_W, '/tmp')}
        </text>
      </box>
      <box
        height={1}
        width={INNER}
        flexShrink={0}
        overflow="hidden"
        backgroundColor={t.background}
      >
        <text fg={t.muted} wrapMode="none">
          {sub}
        </text>
      </box>
    </box>
  );
}

function rowContaining(frame: string, marker: string): string | undefined {
  return frame.split(/\r?\n/).find((r) => r.includes(marker));
}

describe('Pulse Peers rows (count + identities, wrapMode none)', () => {
  let destroy: (() => void) | undefined;

  afterEach(() => {
    destroy?.();
    destroy = undefined;
  });

  test('N=4 long names stay on one sub-line and ellipsize', async () => {
    const entries: PresenceEntry[] = [
      { seat: 'very-long-seat-alpha', harness: 'claude-code' },
      { seat: 'very-long-seat-beta', harness: 'cursor-agent' },
      { seat: 'very-long-seat-gamma', harness: 'amore-session', remote: true, ageHours: 0.2 },
      { seat: 'very-long-seat-delta', harness: 'claude-code', remote: true, ageHours: 14, stale: true },
    ];
    const line = formatPeers(entries);
    const detail = formatPeersDetail(entries);
    expect(line).toBe('2 LIVE · 2 remote-reported');

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: COL_W + 4,
      height: 6,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line={line} detail={detail} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain('Peers');
    expect(frame).toContain('2 LIVE');
    expect(frame).toContain('remote-reported');
    const identRow = rowContaining(frame, 'very-long-seat-alpha');
    expect(identRow, `frame:\n${frame}`).toBeDefined();
    // wrapMode none: the fourth long name must not leak onto a later row.
    const lines = frame.split(/\r?\n/).filter((r) => r.includes('very-long-seat-'));
    expect(lines.length).toBe(1);
    expect(frame).not.toContain('very-long-seat-delta');
  });

  test('shorter identities fully clear a prior long sub-line', async () => {
    const longDetail = 'ALPHA_LONG_' + 'X'.repeat(40);
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: COL_W + 4,
      height: 6,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);

    root.render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line="4 LIVE" detail={longDetail} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const longFrame = captureCharFrame();
    expect(longFrame).toContain('ALPHA_LONG_');
    expect(longFrame).toMatch(/X{8,}/);

    root.render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line="0 LIVE" detail="" />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const shortFrame = captureCharFrame();
    expect(shortFrame).toContain('0 LIVE');
    expect(shortFrame).not.toContain('ALPHA_LONG_');
    expect(shortFrame).not.toMatch(/X{8,}/);
  });

  test('presence unavailable is visible on the label row', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: COL_W + 4,
      height: 6,
    });
    destroy = () => renderer.destroy();
    createRoot(renderer).render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line="presence unavailable" detail="" />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain('Peers');
    expect(frame).toContain('presence unavailable');
  });
});
