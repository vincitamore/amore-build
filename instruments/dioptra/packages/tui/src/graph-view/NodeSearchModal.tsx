import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { useStableDimensions } from '../use-stable-dimensions';
import { nodeGlyph, type GraphNode } from '../render/graph';
import { composeHintRow, composeResultRow, matchNodes, windowBounds } from './node-search';

const VISIBLE = 12; // fixed on-screen row slots; the full (matcher-capped) result set scrolls beneath

/**
 * Search-to-focus overlay (`s` in the graph). A focused input fuzzy-matches nodes by label/path
 * (see node-search.ts); ↑↓ move the selection over the FULL result set — the fixed row slots are a
 * scroll window that follows the selection (windowBounds), with a position counter so an overflowing
 * result set is never silently truncated. Enter picks (the caller seeds focus mode on it), Esc
 * closes. Kept MOUNTED — `active` toggles visibility (yoga display:none) and owns the keyboard —
 * because mount/unmount of an interactive subtree is the OpenTUI-0.4.2 use-after-free. Reset to a
 * blank search each time it is shown.
 *
 * The input is uncontrolled (ref + onInput → `query` state) rather than a controlled `value`: the
 * InputRenderable's `value` prop is initial-only, so re-passing it each render would fight the cursor.
 * Live filtering rides `onInput`; our own key handler only claims ↑↓/Enter/Esc, leaving printable keys
 * for the focused input, so the two handlers never contend over a character.
 */
export function NodeSearchModal({
  active,
  nodes,
  onPick,
  onClose,
}: {
  active: boolean;
  nodes: GraphNode[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const inputRef = useRef<{ value?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  // Scroll-window start over the full result array. A ref, not state: it's derived from the
  // selection each render (windowBounds), so following the selection never needs an extra render —
  // and it resets with query/selection when the modal reopens.
  const startRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    setQuery('');
    setSel(0);
    startRef.current = 0;
    if (inputRef.current) inputRef.current.value = '';
  }, [active]);

  const results = useMemo(() => matchNodes(nodes, query), [nodes, query]);
  const noMatch = query.trim().length > 0 && results.length === 0;
  const selClamped = results.length === 0 ? 0 : Math.min(sel, results.length - 1);

  useKeyboard((key: { name?: string }) => {
    if (!active) return; // mounted-but-hidden
    const name = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (name === 'escape') return onClose();
    if (name === 'up') return setSel((s) => Math.max(0, Math.min(s, results.length - 1) - 1));
    if (name === 'down') return setSel((s) => Math.min(results.length - 1, s + 1));
    if (name === 'return' || name === 'enter') {
      const r = results[selClamped];
      if (r) onPick(r.id); // no-op while there are no matches
      return;
    }
    // Printable keys fall through to the focused input (we never claim them here).
  });

  const width = Math.min(Math.max(40, dims.width - 8), 84);
  const left = Math.max(0, Math.floor((dims.width - width) / 2));
  // input(1) + hint(1) + VISIBLE rows + border(2), never taller than the screen.
  const capH = Math.max(6, dims.height - 2);
  const height = Math.min(VISIBLE + 4, capH);
  const listRows = Math.max(1, height - 4);
  const top = Math.max(1, Math.floor((dims.height - height) / 2));
  // The content area inside the bordered box: outer width − borders (2) − paddingLeft/Right (2).
  // Measured against the char-frame smoke (search-smoke.tsx) — every row string is budgeted to
  // EXACTLY this many columns because OpenTUI <text> wraps (not clips) past it.
  const inner = width - 4;

  // Follow-selection scroll window: `start` moves only when the selection walks off an edge, and
  // snaps back into range when a keystroke shrinks the result set.
  const start = windowBounds(selClamped, results.length, listRows, startRef.current);
  startRef.current = start;
  const overflow = results.length > listRows;

  return (
    <box
      visible={active}
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={height}
      maxHeight={capH}
      zIndex={200}
      border
      borderStyle="rounded"
      borderColor={t.borderActive}
      backgroundColor={t.background}
      title=" Search → focus "
      titleAlignment="center"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <input
        ref={inputRef as never}
        focused={active}
        placeholder="node label or path…"
        backgroundColor={t.background}
        textColor={t.foreground}
        onInput={(v: string) => {
          setQuery(v);
          setSel(0);
        }}
      />
      {/* FIXED ROW SLOTS: a constant `listRows` count of boxes keyed by slot index. A slot's content
          changes (a result, the no-match line, or blank), never the node set — so typing/resize never
          mounts/unmounts an interactive renderable into a reallocating native buffer. */}
      <box flexDirection="column" flexGrow={1}>
        {Array.from({ length: listRows }, (_, vi) => {
          if (vi === 0 && noMatch) {
            return (
              <box key="slot-0" backgroundColor={t.background}>
                <text fg={t.muted}>{'  no match'}</text>
              </box>
            );
          }
          const ri = start + vi; // index into the FULL result array (the window offset)
          const r = results[ri];
          if (!r) {
            return (
              <box key={`slot-${vi}`} backgroundColor={t.background}>
                <text fg={t.background}>{' '}</text>
              </box>
            );
          }
          const hi = ri === selClamped;
          // ONE PHYSICAL LINE PER SLOT: the row is composed to exactly `inner` columns
          // (composeResultRow's invariant), split into a label segment + a dimmed path segment.
          const { head, tail } = composeResultRow(r.label ?? r.id, r.id, nodeGlyph(r.type), hi, inner);
          const id = r.id;
          return (
            <box
              key={`slot-${vi}`}
              flexDirection="row"
              backgroundColor={hi ? t.selection : t.background}
              onMouseOver={() => setSel(ri)}
              onMouseDown={() => onPick(id)}
            >
              <text fg={hi ? t.primary : t.foreground}>{head}</text>
              {tail ? <text fg={t.muted}>{tail}</text> : null}
            </box>
          );
        })}
      </box>
      {/* Hint row — ONE composed string of exactly `inner` columns (no flex spacers, which let an
          overflowing neighbor squash into it). When the results overflow the window, a `sel/total`
          position counter rides right-aligned in the same string — truncation is never silent. */}
      <box flexShrink={0}>
        <text fg={t.muted}>{composeHintRow('↑↓ move · ⏎ focus · esc close', overflow ? `${selClamped + 1}/${results.length}` : '', inner)}</text>
      </box>
    </box>
  );
}
