/**
 * Pulse Peers: count on the label, one identity row per seat.
 * Every seat name must remain visible — no one-line ellipsis of the roster.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import {
  formatPeerSeatRow,
  formatPeers,
  peerSeatRows,
  type PresenceEntry,
} from '../coord/presence';
import { ThemeProvider, usePalette } from '../ThemeProvider';

const COL_W = 48;

function PulsePeersRows({
  line,
  seats,
}: {
  line: string;
  seats: string[];
}) {
  const t = usePalette();
  return (
    <box
      flexDirection="column"
      width={COL_W}
      backgroundColor={t.background}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" flexShrink={0} backgroundColor={t.background}>
        <text fg={t.info} wrapMode="none">
          ●
        </text>
        <text fg={t.foreground} wrapMode="none">
          {' Peers '}
        </text>
        <text fg={t.muted} wrapMode="word">
          {line}
        </text>
      </box>
      {seats.map((s) => (
        <text key={s} fg={t.muted} wrapMode="word">
          {`  ${s}`}
        </text>
      ))}
    </box>
  );
}

describe('Pulse Peers rows (one row per seat)', () => {
  let destroy: (() => void) | undefined;

  afterEach(() => {
    destroy?.();
    destroy = undefined;
  });

  test('N=4 seats all appear; none ellipsized off the roster', async () => {
    const entries: PresenceEntry[] = [
      { seat: 'very-long-seat-alpha', harness: 'claude-code' },
      { seat: 'very-long-seat-beta', harness: 'cursor-agent' },
      { seat: 'very-long-seat-gamma', harness: 'amore-session', remote: true, ageHours: 0.2 },
      { seat: 'very-long-seat-delta', harness: 'claude-code', remote: true, ageHours: 14, stale: true },
    ];
    const line = formatPeers(entries);
    const seats = peerSeatRows(entries).map(formatPeerSeatRow);
    expect(line).toBe('2 LIVE · 2 remote-reported');
    expect(seats.some((s) => s.includes('very-long-seat-delta'))).toBe(true);

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: COL_W + 4,
      height: 12,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);
    root.render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line={line} seats={seats} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain('Peers');
    expect(frame).toContain('2 LIVE');
    expect(frame).toContain('very-long-seat-alpha');
    expect(frame).toContain('very-long-seat-beta');
    expect(frame).toContain('very-long-seat-gamma');
    expect(frame).toContain('very-long-seat-delta');
  });

  test('shorter roster fully clears a prior long roster', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: COL_W + 4,
      height: 10,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);

    root.render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line="4 LIVE" seats={['ALPHA_LONG_' + 'X'.repeat(20)]} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    expect(captureCharFrame()).toContain('ALPHA_LONG_');

    root.render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line="0 LIVE" seats={[]} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const shortFrame = captureCharFrame();
    expect(shortFrame).toContain('0 LIVE');
    expect(shortFrame).not.toContain('ALPHA_LONG_');
  });

  test('presence unavailable is visible on the label row', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: COL_W + 4,
      height: 6,
    });
    destroy = () => renderer.destroy();
    createRoot(renderer).render(
      <ThemeProvider initial="horizon">
        <PulsePeersRows line="presence unavailable" seats={[]} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain('Peers');
    expect(frame).toContain('presence unavailable');
  });
});
