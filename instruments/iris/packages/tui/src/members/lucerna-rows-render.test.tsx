/**
 * Render-level stale-cell check for Lucerna Notifications + Activity Log rows.
 *
 * Paints a LONG line into fixed slots, then repaints with a SHORTER line in the
 * same slots, and asserts the captured frame has no residual characters from
 * the long content beyond the short body (opaque row background + exact-width
 * display strings).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider, usePalette } from '../ThemeProvider';
import { formatLucernaDisplayLine } from './lucerna-display';

const ROW_W = 48;
const MARKER_N = 'NOTE_SHORT';
const MARKER_L = 'LOG_SHORT';
const LONG_N = 'NOTIFICATION_LONG_' + 'X'.repeat(40);
const LONG_L = 'ACTIVITY_LONG_' + 'Y'.repeat(40);

function LucernaStyleRows({
  noteLine,
  logLine,
}: {
  noteLine: string;
  logLine: string;
}) {
  const t = usePalette();
  const noteCell = formatLucernaDisplayLine(noteLine, ROW_W, '/home/nobody');
  const logCell = formatLucernaDisplayLine(logLine, ROW_W, '/home/nobody');
  return (
    <box
      flexDirection="column"
      width={ROW_W + 4}
      height={6}
      backgroundColor={t.background}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Notifications slot (mirrors LucernaMember fixed clear rows) */}
      <box height={1} width={ROW_W} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.muted} wrapMode="none">
          {noteCell}
        </text>
      </box>
      {/* Activity Log slot */}
      <box height={1} width={ROW_W} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.foreground} wrapMode="none">
          {logCell}
        </text>
      </box>
    </box>
  );
}

function rowContaining(frame: string, marker: string): string | undefined {
  return frame.split(/\r?\n/).find((r) => r.includes(marker));
}

/** After the marker, remaining non-space cells must not hold prior long-line residue. */
function residualBeyond(row: string, marker: string, forbidden: RegExp): string {
  const idx = row.indexOf(marker);
  if (idx < 0) return `marker ${marker} missing`;
  const after = row.slice(idx + marker.length);
  if (forbidden.test(after)) return after;
  return '';
}

describe('Lucerna row repaint clears residual (notifications + activity log)', () => {
  let destroy: (() => void) | undefined;

  afterEach(() => {
    destroy?.();
    destroy = undefined;
  });

  test('long then short: zero residual of long content in either row', async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: ROW_W + 6,
      height: 8,
    });
    destroy = () => renderer.destroy();
    const root = createRoot(renderer);

    root.render(
      <ThemeProvider initial="horizon">
        <LucernaStyleRows noteLine={LONG_N} logLine={LONG_L} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const longFrame = captureCharFrame();
    expect(longFrame).toContain('NOTIFICATION_LONG_');
    expect(longFrame).toContain('ACTIVITY_LONG_');

    root.render(
      <ThemeProvider initial="horizon">
        <LucernaStyleRows noteLine={MARKER_N} logLine={MARKER_L} />
      </ThemeProvider>,
    );
    await new Promise((r) => setTimeout(r, 80));
    await renderOnce();
    const shortFrame = captureCharFrame();

    const noteRow = rowContaining(shortFrame, MARKER_N);
    const logRow = rowContaining(shortFrame, MARKER_L);
    expect(noteRow, `frame:\n${shortFrame}`).toBeDefined();
    expect(logRow, `frame:\n${shortFrame}`).toBeDefined();

    // No leftover markers or fill chars from the long paint after the short body.
    expect(residualBeyond(noteRow!, MARKER_N, /NOTIFICATION|X{3,}/)).toBe('');
    expect(residualBeyond(logRow!, MARKER_L, /ACTIVITY|Y{3,}/)).toBe('');
    expect(shortFrame).not.toContain('NOTIFICATION_LONG_');
    expect(shortFrame).not.toContain('ACTIVITY_LONG_');
    // Long fill must not remain anywhere in the frame.
    expect(shortFrame).not.toMatch(/X{8,}/);
    expect(shortFrame).not.toMatch(/Y{8,}/);
  });
});
