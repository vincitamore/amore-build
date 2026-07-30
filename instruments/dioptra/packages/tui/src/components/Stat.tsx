import { useState } from 'react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';

interface StatProps {
  /** The headline number (or short word, e.g. a short status word). */
  value: string | number;
  /** What it counts, in muted text. */
  label: string;
  /** Optional second muted line (e.g. "12 total", "3 snoozed"). */
  sub?: string;
  /** Semantic color for the value — the card's only saturated element. */
  color: RGBA;
  /** When set, the card is clickable (e.g. jump to a member) and highlights on hover. */
  onSelect?: () => void;
}

/**
 * A single stat card: a bordered cell with a color-coded value over a muted label.
 * The value carries the only saturation (hierarchy by color, per the design language).
 * When `onSelect` is given the card becomes mouse-interactive — hover lifts the border
 * to the active color, click activates — keeping mouse a first-class affordance.
 */
export function Stat({ value, label, sub, color, onSelect }: StatProps) {
  const t = usePalette();
  const [hover, setHover] = useState(false);
  const interactive = !!onSelect;
  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={interactive && hover ? t.borderActive : t.border}
      backgroundColor={t.background}
      paddingLeft={1}
      paddingRight={1}
      marginRight={1}
      flexGrow={1}
      flexShrink={1}
      minWidth={11}
      onMouseOver={interactive ? () => setHover(true) : undefined}
      onMouseOut={interactive ? () => setHover(false) : undefined}
      onMouseDown={onSelect}
    >
      <text fg={color}>{String(value)}</text>
      <text fg={t.muted}>{label}</text>
      <text fg={t.muted}>{sub ?? ' '}</text>
    </box>
  );
}
