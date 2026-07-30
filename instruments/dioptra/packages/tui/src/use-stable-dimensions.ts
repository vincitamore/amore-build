import { useEffect, useRef, useState } from 'react';
import { useTerminalDimensions } from '@opentui/react';

/**
 * Terminal dimensions, but coalesced across a resize BURST.
 *
 * A phone-SSH resize (Termius — keyboard slide-in, orientation change, pane reflow) is never a
 * single event; it's many resize events in a few ms. Each one changes the derived row counts of
 * the views, which re-keys / mounts / unmounts mouse-interactive row renderables. Doing that
 * *while OpenTUI's native cell buffer is mid-reallocation* is a use-after-free in the native
 * renderer — a hard segfault that bypasses Bun's JS crash handlers entirely.
 *
 * This holds the previous dimensions until resize events stop for `settleMs`, then commits once.
 * The native buffer realloc finishes during the quiet window before the React tree churns. It is
 * the resize-axis analog of the per-toggle throttle the tree/list views already use.
 *
 * Live dims (`useTerminalDimensions`) still drive the cheap outer frame promptly; use THIS only
 * for the expensive, row-count-driving sizing (windowed lists, the search palette) so a resize
 * burst can't pump renderable churn through a reallocating buffer.
 */
export function useStableDimensions(settleMs = 110): { width: number; height: number } {
  const live = useTerminalDimensions();
  const [stable, setStable] = useState(() => ({ width: live.width, height: live.height }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStable({ width: live.width, height: live.height }), settleMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [live.width, live.height, settleMs]);

  return stable;
}
