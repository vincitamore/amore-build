import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { getCollapsed, setCollapsed } from '../config';
import { tickRender } from '../debug';
import { useHoverThrottle } from '../use-hover-throttle';
import { Panel } from './Panel';

export interface GroupedRow {
  id: string;
  left: string;
  right?: string;
  dim?: boolean;
  /** Override the left-text color (e.g. overdue reminders render red); falls back to dim/foreground. */
  mainColor?: RGBA;
}
export interface Group {
  key: string;
  label: string;
  color: RGBA;
  rows: GroupedRow[];
}

interface GroupedListProps {
  title: string;
  groups: Group[];
  /** Stable key for persisting which groups are collapsed. */
  persistKey: string;
  /** Groups collapsed on first run (before the user's choice persists). Default: all groups. */
  defaultCollapsed?: string[];
  rightColor?: (row: GroupedRow) => RGBA;
  reserve?: number;
  inputActive?: boolean;
  /** Move the cursor to this row id (expanding its group if collapsed) — a jump-to-item request. */
  focusId?: string;
  /** Bumped by the parent on each jump request, so re-jumping to the same id re-fires. */
  focusKey?: number;
  /** The row under the cursor (null when the cursor is on a group header). */
  onSelect?: (row: GroupedRow | null) => void;
  /** Enter/click on a row. */
  onActivate?: (row: GroupedRow) => void;
}

type DisplayItem =
  | { kind: 'header'; key: string; label: string; color: RGBA; count: number; collapsed: boolean }
  | { kind: 'row'; row: GroupedRow };

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/**
 * A collapsible grouped list — the Tauri inbox/task grouping in the terminal. Groups
 * have ▼/▶ headers (label + count) that collapse/expand (persisted per `persistKey`);
 * a single cursor moves over headers and rows alike. Mouse + keyboard co-equal: click
 * a header to toggle / a row to activate, hover to highlight, wheel to scroll; arrows
 * move, ←/→ collapse/expand a header, Enter toggles a header or activates a row.
 */
export function GroupedList({
  title,
  groups,
  persistKey,
  defaultCollapsed,
  rightColor,
  reserve = 6,
  inputActive = true,
  focusId,
  focusKey,
  onSelect,
  onActivate,
}: GroupedListProps) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const [userCollapsed, setUserCollapsed] = useState<Set<string> | null>(() => getCollapsed(persistKey));
  const [cursor, setCursor] = useState(0);
  const [hovered, hoverTo, clearHover] = useHoverThrottle(); // throttled — raw setHovered per mouse-move sample churned ~73/s
  const lastToggle = useRef(0);
  const allKeys = useMemo(() => groups.map((g) => g.key), [groups]);
  // Default: `defaultCollapsed` (or all groups) collapsed until the user toggles one (then their choice persists).
  const collapsed = useMemo(
    () => userCollapsed ?? new Set(defaultCollapsed ?? allKeys),
    [userCollapsed, allKeys, defaultCollapsed],
  );

  const items = useMemo<DisplayItem[]>(() => {
    const out: DisplayItem[] = [];
    for (const g of groups) {
      const isCol = collapsed.has(g.key);
      out.push({ kind: 'header', key: g.key, label: g.label, color: g.color, count: g.rows.length, collapsed: isCol });
      if (!isCol) for (const row of g.rows) out.push({ kind: 'row', row });
    }
    return out;
  }, [groups, collapsed]);

  const total = useMemo(() => groups.reduce((a, g) => a + g.rows.length, 0), [groups]);
  tickRender('GroupedList');
  const visible = Math.max(1, dims.height - reserve);
  const cur = hovered ?? cursor;

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, items.length - 1)));
  }, [items.length]);

  // Notify the parent of the current row selection (ref-held callback → no dep churn).
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    const it = items[cur];
    onSelectRef.current?.(it && it.kind === 'row' ? it.row : null);
  }, [cur, items]);

  // Jump-to-item: on a new focusKey, move the cursor to focusId's row (centering it via the offset
  // calc below), expanding its group first if collapsed. Two-pass by design — expanding recomputes
  // `items`, the effect re-runs, and the now-visible row is found. `appliedKey` consumes the request
  // so it never fights the user's own navigation afterward.
  const appliedKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focusKey === undefined || !focusId || appliedKey.current === focusKey) return;
    const idx = items.findIndex((it) => it.kind === 'row' && it.row.id === focusId);
    if (idx >= 0) {
      clearHover();
      setCursor(idx);
      appliedKey.current = focusKey;
      return;
    }
    const g = groups.find((gr) => gr.rows.some((r) => r.id === focusId));
    if (g && collapsed.has(g.key)) {
      setUserCollapsed((prev) => {
        const next = new Set(prev ?? allKeys);
        next.delete(g.key);
        setCollapsed(persistKey, next);
        return next;
      });
      // don't consume — re-runs after `items` recomputes and the row becomes findable
    } else {
      appliedKey.current = focusKey; // not in this list (another member owns it, or it's gone)
    }
  }, [focusKey, focusId, items, groups, collapsed, allKeys, persistKey, clearHover]);

  let offset = 0;
  if (items.length > visible) offset = Math.max(0, Math.min(cursor - Math.floor(visible / 2), items.length - visible));

  const toggle = (key: string) => {
    const now = Date.now();
    if (now - lastToggle.current < 70) return; // coalesce held-key bursts (native-renderer safety)
    lastToggle.current = now;
    setUserCollapsed((prev) => {
      const next = new Set(prev ?? allKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setCollapsed(persistKey, next);
      return next;
    });
  };
  const move = (d: number) => {
    clearHover();
    setCursor((c) => Math.max(0, Math.min(items.length - 1, c + d)));
  };
  const activateAt = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'header') toggle(it.key);
    else onActivate?.(it.row);
  };

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || items.length === 0) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'up' || n === 'k') return move(-1);
    if (n === 'down' || n === 'j') return move(1);
    if (n === 'pageup') return move(-visible);
    if (n === 'pagedown') return move(visible);
    if (n === 'home') return move(-items.length);
    if (n === 'end') return move(items.length);
    const it = items[cursor];
    if (n === 'left' && it?.kind === 'header' && !it.collapsed) return toggle(it.key);
    if (n === 'right' && it?.kind === 'header' && it.collapsed) return toggle(it.key);
    if (n === 'return' || n === 'enter' || n === 'space') return activateAt(cursor);
  });

  const onScroll = (e: { scroll?: { direction?: string }; button?: number }) => {
    let dir = e.scroll?.direction;
    if (!dir && e.button === 4) dir = 'up';
    if (!dir && e.button === 5) dir = 'down';
    if (dir === 'up') move(-3);
    else if (dir === 'down') move(3);
  };

  const leftW = Math.max(10, dims.width - 18);
  const shown = items.slice(offset, offset + visible);
  const rc = rightColor ?? (() => t.muted);

  // FIXED, UNIFORM ROW SLOTS (keyed by slot index, identical node structure for header /
  // row / blank). Collapse/expand/scroll changes content only — OpenTUI never mounts or
  // unmounts row renderables, which segfaulted the native renderer under rapid toggling.
  return (
    <Panel title={title} headerRight={`${total}`} flexGrow={1}>
      <box flexDirection="column" flexGrow={1} onMouseScroll={onScroll} onMouseOut={clearHover}>
        {Array.from({ length: visible }, (_, vi) => {
          const it = shown[vi];
          const i = offset + vi;
          const hi = !!it && i === cur;
          let marker = ' ';
          let markerFg = t.muted;
          let main = ' ';
          let mainFg = t.foreground;
          let right = '';
          let rightFg = t.muted;
          if (it?.kind === 'header') {
            marker = '';
            main = `${it.collapsed ? '▶' : '▼'} ${it.label.toUpperCase()} (${it.count})`;
            mainFg = it.color;
          } else if (it?.kind === 'row') {
            marker = hi ? '  › ' : '    ';
            markerFg = hi ? t.primary : t.muted;
            main = truncate(it.row.left, leftW);
            mainFg = it.row.mainColor ?? (it.row.dim ? t.muted : t.foreground);
            right = it.row.right ?? '';
            rightFg = rc(it.row);
          }
          return (
            <box
              key={`slot-${vi}`}
              flexDirection="row"
              backgroundColor={hi ? t.selection : t.background}
              onMouseOver={it ? () => hoverTo(i) : undefined}
              onMouseDown={
                it
                  ? () => {
                      clearHover();
                      setCursor(i);
                      if (it.kind === 'header') toggle(it.key);
                      else onActivate?.(it.row);
                    }
                  : undefined
              }
            >
              <text fg={markerFg}>{marker}</text>
              <text fg={mainFg}>{main}</text>
              <box flexGrow={1} />
              <text fg={rightFg}>{right}</text>
            </box>
          );
        })}
      </box>
    </Panel>
  );
}
