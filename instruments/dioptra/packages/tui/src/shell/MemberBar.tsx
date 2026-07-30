import { useState } from 'react';
import { usePalette } from '../ThemeProvider';

/**
 * The top tab bar: one cell-row, a chip per member. Each chip is mouse-interactive —
 * click to switch, hover to highlight (OpenTUI dispatches onMouseOver/Out per box) —
 * and the keyboard nav (Ctrl+N/P, 1-9) stays first-class alongside it.
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
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <box width="100%" height={1} flexDirection="row" backgroundColor={t.background}>
      {members.map((m, i) => {
        const isActive = i === active;
        const isHover = i === hovered;
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
            <text fg={isActive ? t.primary : isHover ? t.foreground : t.muted}>{`${i + 1} ${m}`}</text>
          </box>
        );
      })}
      <box flexGrow={1} flexDirection="row" backgroundColor={t.background} paddingLeft={2} paddingRight={1}>
        <text fg={t.muted}>{'click · 1-9 · / search · v select · t themes · q quit'}</text>
        <box flexGrow={1} />
        {overdue > 0 ? <text fg={t.error}>{`● ${overdue} overdue`}</text> : null}
      </box>
    </box>
  );
}
