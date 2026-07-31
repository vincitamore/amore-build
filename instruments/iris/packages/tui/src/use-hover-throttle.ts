import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Coalesce mouse-hover highlight updates for a windowed list/tree.
 *
 * With `enableMouseMovement` on, `onMouseOver` fires per mouse-move SAMPLE (not just per row
 * crossing), so a `setHovered` per event re-renders the whole list dozens of times a second while
 * the mouse merely drifts over it (~70/s observed). On a stable renderer that's just waste; under
 * OpenTUI 0.4.2's teardown/mount use-after-free it's a crash MULTIPLIER — that ambient churn is what
 * makes a coinciding tree mutation (a member first-mount, an overlay) segfault.
 *
 * Trailing-throttle to ≤1 update / ~90ms: the highlight still tracks the cursor (≤90ms lag) but the
 * list stops re-rendering on every sample. Keyboard-move and click call `clearHover()` to drop the
 * pending flush immediately so the highlight can't stick. Returns `[hovered, hoverTo, clearHover]`.
 *
 * Generic in the hover KEY: windowed lists/trees hover by slot index (`T = number`, the default);
 * the Dashboard attention rail hovers by a string section/item key (`useHoverThrottle<string>()`).
 * One shared throttle serves both, per the /tui doctrine ("use it in every hover-highlighted list").
 */
export function useHoverThrottle<T = number>(): [T | null, (v: T) => void, () => void] {
  const [hovered, setHovered] = useState<T | null>(null);
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<T | null>(null);
  // useCallback: both functions land in consumers' effect deps (e.g. GroupedList's focus-jump
  // effect) and in memo'd children's props — unstable identities would re-run/re-render per render.
  const hoverTo = useCallback((v: T) => {
    pending.current = v;
    if (flush.current) return;
    flush.current = setTimeout(() => {
      flush.current = null;
      setHovered(pending.current);
    }, 90);
  }, []);
  const clearHover = useCallback(() => {
    pending.current = null;
    if (flush.current) {
      clearTimeout(flush.current);
      flush.current = null;
    }
    setHovered((h) => (h === null ? h : null));
  }, []);
  useEffect(
    () => () => {
      if (flush.current) clearTimeout(flush.current);
    },
    [],
  );
  return [hovered, hoverTo, clearHover];
}
