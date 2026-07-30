import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { tickRender } from '../debug';
import { buildTree, flattenTree } from '../tree';
import { useHoverThrottle } from '../use-hover-throttle';
import { Panel } from './Panel';

interface TreeViewProps {
  title: string;
  /** Flat items; `path` is org-relative (knowledge/a/b/foo.md), `label` the display title. */
  items: { path: string; label: string }[];
  /** Leading path segment to strip when building the tree (e.g. "knowledge"). */
  prefix: string;
  reserve?: number;
  inputActive?: boolean;
  /** Open a file leaf. */
  onActivate?: (id: string) => void;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/**
 * A nested folder tree (the KB browser's tree nav) — folders carry ▾/▸ carets + a recursive
 * count and expand/collapse; files are leaves opened on Enter/click. One cursor walks the
 * visible rows; depth shows as indentation. Default all-collapsed (fresh each mount).
 * Mouse + keyboard co-equal (click caret/folder toggles, click leaf opens, hover, wheel).
 */
export function TreeView({ title, items, prefix, reserve = 6, inputActive = true, onActivate }: TreeViewProps) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const [expanded, setExp] = useState<Set<string>>(() => new Set()); // start collapsed (no eager restore — see FileTree)
  const [cursor, setCursor] = useState(0);
  const [hovered, hoverTo, clearHover] = useHoverThrottle(); // throttled — raw setHovered per mouse-move sample is the UAF churn multiplier
  const lastToggle = useRef(0);

  const root = useMemo(() => buildTree(items, prefix), [items, prefix]);
  const rows = useMemo(() => flattenTree(root, expanded), [root, expanded]);
  tickRender('TreeView');

  const visible = Math.max(1, dims.height - reserve);
  const cur = hovered ?? cursor;

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  let offset = 0;
  if (rows.length > visible) offset = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));

  const toggle = (path: string) => {
    const now = Date.now();
    if (now - lastToggle.current < 70) return; // coalesce held-key bursts (native-renderer safety)
    lastToggle.current = now;
    setExp((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const move = (d: number) => {
    clearHover();
    setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + d)));
  };
  const activateAt = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === 'folder') toggle(r.node.path);
    else onActivate?.(r.leaf.id);
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
    const r = rows[cursor];
    if (n === 'left' && r?.kind === 'folder' && r.expanded) return toggle(r.node.path);
    if (n === 'right' && r?.kind === 'folder' && !r.expanded) return toggle(r.node.path);
    if (n === 'return' || n === 'enter' || n === 'space') return activateAt(cursor);
  });

  const onScroll = (e: { scroll?: { direction?: string }; button?: number }) => {
    let dir = e.scroll?.direction;
    if (!dir && e.button === 4) dir = 'up';
    if (!dir && e.button === 5) dir = 'down';
    if (dir === 'up') move(-3);
    else if (dir === 'down') move(3);
  };

  const shown = rows.slice(offset, offset + visible);

  return (
    <Panel title={title} headerRight={`${root.total}`} flexGrow={1}>
      <box flexDirection="column" flexGrow={1} onMouseScroll={onScroll} onMouseOut={clearHover}>
        {Array.from({ length: visible }, (_, vi) => {
          const r = shown[vi];
          const i = offset + vi;
          const hi = !!r && i === cur;
          const empty = rows.length === 0 && vi === 0;
          const indent = r ? '  '.repeat(r.depth) : '';
          let main = empty ? 'empty' : ' ';
          let mainFg = empty ? t.muted : t.background;
          let right = '';
          if (r?.kind === 'folder') {
            main = truncate(`${indent}${r.expanded ? '▾' : '▸'} ${r.node.name}`, Math.max(8, dims.width - 8));
            mainFg = hi ? t.primary : t.secondary;
            right = `${r.node.total}`;
          } else if (r?.kind === 'leaf') {
            main = `${indent}  ${truncate(r.leaf.label, Math.max(8, dims.width - r.depth * 2 - 8))}`;
            mainFg = hi ? t.primary : t.foreground;
          }
          return (
            <box
              key={`slot-${vi}`}
              flexDirection="row"
              backgroundColor={hi ? t.selection : t.background}
              onMouseOver={r ? () => hoverTo(i) : undefined}
              onMouseDown={
                r
                  ? () => {
                      clearHover();
                      setCursor(i);
                      if (r.kind === 'folder') toggle(r.node.path);
                      else onActivate?.(r.leaf.id);
                    }
                  : undefined
              }
            >
              <text fg={mainFg}>{main}</text>
              <box flexGrow={1} />
              <text fg={t.muted}>{right}</text>
            </box>
          );
        })}
      </box>
    </Panel>
  );
}
