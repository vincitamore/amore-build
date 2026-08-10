import { useState } from 'react';
import { usePalette } from '../ThemeProvider';
import { useStableDimensions } from '../use-stable-dimensions';

/** Below this column count, chips abbreviate to digits/letter and the hint is hidden. */
export const MEMBER_BAR_NARROW_COLS = 100;

/**
 * Chip label for a member slot.
 * Wide: `1 Dashboard` … `9 Graph`, Sessions as `S Sessions` (no digit — letter key only).
 * Narrow: `1`…`9` + `S` — never a second bar row.
 */
export function memberChipLabel(index: number, name: string, narrow: boolean): string {
  const isSessions = name === 'Sessions' || index >= 9;
  if (narrow) return isSessions ? 'S' : String(index + 1);
  if (isSessions) return `S ${name}`;
  return `${index + 1} ${name}`;
}

export function memberBarIsNarrow(width: number, threshold = MEMBER_BAR_NARROW_COLS): boolean {
  return width < threshold;
}

/**
 * The top tab bar: one cell-row, a chip per member. Each chip is mouse-interactive —
 * click to switch, hover to highlight (OpenTUI dispatches onMouseOver/Out per box) —
 * and the keyboard nav (Ctrl+N/P, 1-9, S) stays first-class alongside it.
 * At narrow widths chips abbreviate; a second row is forbidden.
 */
export function MemberBar({
  members,
  active,
  onSelect,
  overdue = 0,
}: {
  members: readonly string[];
  active: number;
  onSelect: (i: number) => void;
  /** Overdue-reminder count — surfaced from any screen (the launch-toast replacement). */
  overdue?: number;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const narrow = memberBarIsNarrow(dims.width);
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <box width="100%" height={1} flexDirection="row" backgroundColor={t.background}>
      {members.map((m, i) => {
        const isActive = i === active;
        const isHover = i === hovered;
        const label = memberChipLabel(i, m, narrow);
        return (
          <box
            key={m}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={isActive || isHover ? t.selection : t.background}
            onMouseDown={() => onSelect(i)}
            onMouseOver={() => setHovered(i)}
            onMouseOut={() => setHovered((h) => (h === i ? null : h))}
          >
            <text fg={isActive ? t.primary : isHover ? t.foreground : t.muted}>{label}</text>
          </box>
        );
      })}
      <box flexGrow={1} flexDirection="row" backgroundColor={t.background} paddingLeft={2} paddingRight={1}>
        {narrow ? null : (
          <text fg={t.muted}>{'click · 1-9 · S sessions · / search · v select · t themes · q quit'}</text>
        )}
        <box flexGrow={1} />
        {overdue > 0 ? <text fg={t.error}>{`● ${overdue} overdue`}</text> : null}
      </box>
    </box>
  );
}
