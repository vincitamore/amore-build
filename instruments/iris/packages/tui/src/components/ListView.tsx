import { useEffect, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { tickRender } from '../debug';
import { useHoverThrottle } from '../use-hover-throttle';
import { Panel } from './Panel';

export interface ListRow {
  id: string;
  /** Primary text (left-aligned, truncated to width). */
  left: string;
  /** Optional right-aligned badge text (e.g. a status/type). */
  right?: string;
  /** Render muted (e.g. a resolved/complete item). */
  dim?: boolean;
}

interface ListViewProps {
  title: string;
  rows: ListRow[];
  /** Resolve the badge color at render time (theme-reactive). Defaults to muted. */
  rightColor?: (row: ListRow) => RGBA;
  /** Rows consumed by chrome outside the list (bar + panel border + title). */
  reserve?: number;
  /** When false, the list ignores keyboard input (a shell overlay owns it). */
  inputActive?: boolean;
  /** Called on Enter or click. */
  onActivate?: (row: ListRow, index: number) => void;
  emptyText?: string;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/**
 * A windowed, scrollable list rendered in a Panel — the backbone of the list members.
 * Mouse and keyboard are co-equal: arrows/page/home/end/Enter move a keyboard cursor
 * (which the viewport follows), the wheel scrolls, hover highlights any row without
 * moving the cursor, and click selects + activates. Sizes its window to the terminal
 * height so a taller terminal shows more rows.
 */
export function ListView({ title, rows, rightColor, reserve = 6, inputActive = true, onActivate, emptyText }: ListViewProps) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const [selected, setSelected] = useState(0);
  const [hovered, hoverTo, clearHover] = useHoverThrottle(); // throttled — raw setHovered per mouse-move sample churned the list
  const visible = Math.max(1, dims.height - reserve);
  tickRender('ListView');

  // Keep the cursor in range as the row set changes.
  useEffect(() => {
    setSelected((s) => Math.max(0, Math.min(s, rows.length - 1)));
  }, [rows.length]);

  // Window offset follows the keyboard cursor (not the hover), keeping it visible.
  let offset = 0;
  if (rows.length > visible) {
    offset = Math.max(0, Math.min(selected - Math.floor(visible / 2), rows.length - visible));
  }

  const move = (delta: number) => {
    clearHover();
    setSelected((s) => Math.max(0, Math.min(rows.length - 1, s + delta)));
  };

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || rows.length === 0) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'up' || n === 'k') return move(-1);
    if (n === 'down' || n === 'j') return move(1);
    if (n === 'pageup') return move(-visible);
    if (n === 'pagedown') return move(visible);
    if (n === 'home') return move(-rows.length);
    if (n === 'end') return move(rows.length);
    if (n === 'return' || n === 'enter') return onActivate?.(rows[selected], selected);
  });

  const onScroll = (e: { scroll?: { direction?: string }; button?: number }) => {
    let dir = e.scroll?.direction;
    if (!dir && e.button === 4) dir = 'up';
    if (!dir && e.button === 5) dir = 'down';
    if (dir === 'up') move(-3);
    else if (dir === 'down') move(3);
  };

  const leftW = Math.max(10, dims.width - 18);
  const shown = rows.slice(offset, offset + visible);
  const cursor = hovered ?? selected;
  const rc = rightColor ?? (() => t.muted);

  // FIXED, UNIFORM ROW SLOTS (keyed by slot index) — scroll changes content only, never the
  // node set, so OpenTUI never mounts/unmounts row renderables (a native-crash risk under
  // rapid input). Empty rows render the placeholder in the first slot.
  return (
    <Panel title={title} headerRight={`${rows.length}`} flexGrow={1}>
      <box flexDirection="column" flexGrow={1} onMouseScroll={onScroll} onMouseOut={clearHover}>
        {Array.from({ length: visible }, (_, vi) => {
          const row = shown[vi];
          const i = offset + vi;
          const hi = !!row && i === cursor;
          const empty = rows.length === 0 && vi === 0;
          const marker = empty ? '' : !row ? ' ' : hi ? '› ' : '  ';
          const main = empty ? (emptyText ?? 'nothing here') : row ? truncate(row.left, leftW) : ' ';
          const mainFg = empty ? t.muted : !row ? t.background : row.dim ? t.muted : t.foreground;
          return (
            <box
              key={`slot-${vi}`}
              flexDirection="row"
              backgroundColor={hi ? t.selection : t.background}
              onMouseOver={row ? () => hoverTo(i) : undefined}
              onMouseDown={
                row
                  ? () => {
                      clearHover();
                      setSelected(i);
                      onActivate?.(row, i);
                    }
                  : undefined
              }
            >
              <text fg={hi ? t.primary : t.muted}>{marker}</text>
              <text fg={mainFg}>{main}</text>
              <box flexGrow={1} />
              <text fg={row ? rc(row) : t.muted}>{row?.right ?? ''}</text>
            </box>
          );
        })}
      </box>
    </Panel>
  );
}
