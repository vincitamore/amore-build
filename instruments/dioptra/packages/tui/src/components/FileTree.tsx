import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { usePalette } from '../ThemeProvider';
import { dlog, tickRender } from '../debug';
import { useHoverThrottle } from '../use-hover-throttle';
import { Panel } from './Panel';

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

// Directories never worth walking, and binary leaves not worth showing.
const EXCLUDE_DIR = new Set(['node_modules', '.git', 'target', 'dist', '.next', 'build', '.turbo', '.cache', 'out', 'coverage', '.bun']);
const BINARY = /\.(png|jpe?g|gif|ico|webp|wasm|woff2?|ttf|otf|eot|pdf|zip|gz|tar|exe|dll|so|dylib|lockb|node|bin|wgsl|sqlite|db)$/i;

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
}

function readDir(dir: string): FileNode[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return !EXCLUDE_DIR.has(e.name) && !e.name.startsWith('.');
        return !BINARY.test(e.name);
      })
      .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  } catch {
    return [];
  }
}

interface FileTreeProps {
  /** Absolute root directory. */
  root: string;
  reserve?: number;
  inputActive?: boolean;
  /** Open a file (absolute path). */
  onActivate?: (absPath: string) => void;
}

type VisRow = { node: FileNode; depth: number; expanded: boolean };

/**
 * A lazy filesystem tree — reads each directory only when expanded (large org trees are far
 * too large to walk eagerly). ▾/▸ folders, file leaves open into DocView (which routes
 * markdown vs code). One cursor over visible rows; mouse + keyboard co-equal; always
 * all-collapsed on mount.
 */
export function FileTree({ root, reserve = 6, inputActive = true, onActivate }: FileTreeProps) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  // Start collapsed every mount, and deliberately DON'T persist/restore expansion: restoring a
  // large/deep set (21+ nested dirs) in one shot on mount is a heavy read+build+render that crashed
  // the native renderer, so no restore was ever safe to wire — the old persistence write was dead
  // (never read back) and has been removed. Default-collapsed is also what the operator wants;
  // folders load lazily in toggle(). (Within-session expanded state across tab-switches is sacrificed.)
  const [expanded, setExp] = useState<Set<string>>(() => new Set());
  const [cache, setCache] = useState<Map<string, FileNode[]>>(() => new Map([[root, readDir(root)]]));
  const [cursor, setCursor] = useState(0);
  const [hovered, hoverTo, clearHover] = useHoverThrottle(); // throttled — raw setHovered per mouse-move sample is the UAF churn multiplier
  const lastToggle = useRef(0);

  useEffect(() => {
    dlog('filetree', `mount root=${root}`);
  }, [root]);

  const rows = useMemo<VisRow[]>(() => {
    const out: VisRow[] = [];
    const walk = (dir: string, depth: number) => {
      for (const node of cache.get(dir) ?? []) {
        const isExp = node.isDir && expanded.has(node.path);
        out.push({ node, depth, expanded: isExp });
        if (isExp) walk(node.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [root, cache, expanded]);

  const visible = Math.max(1, dims.height - reserve);
  const cur = hovered ?? cursor;

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  let offset = 0;
  if (rows.length > visible) offset = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));

  const toggle = (path: string) => {
    // Throttle: a held toggle key (Enter/←/→) fires many times in ms; coalesce to a
    // safe rate so we never pump OpenTUI's native renderer with a burst of state churn.
    const now = Date.now();
    if (now - lastToggle.current < 70) return;
    lastToggle.current = now;
    const opening = !expanded.has(path);
    // Lazy-read children on expand, IN the handler (no cache-dependent effect — that
    // re-ran on every cache change and cascaded, accumulating renders → native crash).
    if (opening && !cache.has(path)) {
      const entries = readDir(path);
      dlog('filetree', `read ${path} n=${entries.length}`);
      setCache((c) => (c.has(path) ? c : new Map(c).set(path, entries)));
    }
    dlog('filetree', `${opening ? 'expand' : 'collapse'} ${path}`);
    setExp((prev) => {
      const next = new Set(prev);
      if (opening) next.add(path);
      else next.delete(path);
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
    if (r.node.isDir) toggle(r.node.path);
    else onActivate?.(r.node.path);
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
    if (n === 'left' && r?.node.isDir && r.expanded) return toggle(r.node.path);
    if (n === 'right' && r?.node.isDir && !r.expanded) return toggle(r.node.path);
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
  const maxW = Math.max(8, dims.width - 4);
  tickRender('FileTree');

  // FIXED ROW SLOTS: render a constant `visible` count of boxes keyed by slot index, not
  // by row id. Expand/collapse/scroll changes each slot's CONTENT, never the node set — so
  // OpenTUI never mounts/unmounts row renderables under rapid toggling (which segfaulted
  // the native renderer, likely a mouse/hit-test use-after-free on a freed row node).
  return (
    <Panel title="Files" headerRight={root.replace(/\\/g, '/').split('/').pop() ?? ''} flexGrow={1}>
      <box flexDirection="column" flexGrow={1} onMouseScroll={onScroll} onMouseOut={clearHover}>
        {Array.from({ length: visible }, (_, vi) => {
          const r = shown[vi];
          const i = offset + vi;
          const hi = !!r && i === cur;
          const label = r
            ? truncate(`${'  '.repeat(r.depth)}${r.node.isDir ? (r.expanded ? '▾' : '▸') : ' '} ${r.node.name}`, maxW)
            : ' ';
          const fg = hi ? t.primary : !r ? t.background : r.node.isDir ? t.secondary : t.foreground;
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
                      activateAt(i);
                    }
                  : undefined
              }
            >
              <text fg={fg}>{label}</text>
            </box>
          );
        })}
      </box>
    </Panel>
  );
}
