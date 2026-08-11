/**
 * Turn detail pane — third-level view under the Microscope timeline.
 * Renders one turn's full content (text, tool payloads) in a scrollable
 * fixed-slot body. Mounted by MicroscopeStage over the timeline card's area;
 * stays mounted and toggles with `visible` (never mount/unmount on open).
 *
 * Key ownership while visible: this pane owns j/k (scroll), [ / ] (step turn
 * via onStep — the timeline cursor follows), y (copy), p (path collapse),
 * esc (close via onClose). MicroscopeStage defers its handler while open.
 */
import { useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Card } from './Card';

/** Footer hint the stage shows while the detail pane is open. */
export const TURN_DETAIL_FOOTER = 'j/k scroll · [ ] prev/next · y copy · p paths · esc close';

export type TurnDetailProps = {
  /** Pane visibility — the component stays mounted either way. */
  visible: boolean;
  /** events.id of the turn under the timeline cursor; null when none. */
  eventId: number | null;
  /** Resolved title line of the open session ('' when absent). */
  sessionTitle: string;
  /** Keys enabled (stage input chain AND pane visible). */
  inputActive: boolean;
  /** Close back to the timeline (esc). */
  onClose: () => void;
  /** Step the timeline cursor without closing; the pane re-targets. */
  onStep: (delta: 1 | -1) => void;
  /** Flash line for confirms (clipboard copy). */
  onFlash?: (msg: string) => void;
  /** Explicit index path (test seam; wins over env resolution). */
  path?: string;
  /** Outer width of the area the pane may paint (the timeline card's slot). */
  width: number;
  /** Rows available to the pane's host (same budget the timeline card gets). */
  height: number;
};

function padRow(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (text.length >= w) return text.slice(0, w);
  return text + ' '.repeat(w - text.length);
}

function FixedClearRow({ width, color, text }: { width: number; color: RGBA; text: string }) {
  return (
    <text fg={color} wrapMode="none">
      {padRow(text, width)}
    </text>
  );
}

export function TurnDetail({
  visible,
  eventId,
  sessionTitle,
  inputActive,
  onClose,
  onStep,
  onFlash,
  path,
  width,
  height,
}: TurnDetailProps) {
  const t = usePalette();
  // Scroll offset over the rendered content lines (fit-clamped body window).
  const [scroll, setScroll] = useState(0);
  void scroll;
  void setScroll;
  void onFlash;
  void path;
  void height;

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || !visible) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'escape' || n === 'backspace') {
      onClose();
      return;
    }
    if (n === ']') {
      onStep(1);
      return;
    }
    if (n === '[') {
      onStep(-1);
    }
  });

  if (!visible) {
    return <box height={0} overflow="hidden" />;
  }

  const innerW = Math.max(8, Math.floor(width) - 4);
  return (
    <Card title="Turn" right={eventId != null ? `#${eventId}` : undefined} width={width} flexShrink={0}>
      <box flexDirection="column" flexShrink={0}>
        <FixedClearRow width={innerW} color={t.muted} text={padRow(sessionTitle, innerW)} />
        <FixedClearRow width={innerW} color={t.muted} text={padRow('no detail loaded', innerW)} />
      </box>
    </Card>
  );
}
