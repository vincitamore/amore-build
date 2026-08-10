/**
 * Measure a PARENT-CONSTRAINED box (flexGrow / width 100% / minHeight 0).
 *
 * Laws:
 *  - 0-guard: ignore w<=0 || h<=0 (keep last good / seed)
 *  - debounce commit so layout-changed bursts settle
 *  - seed until first positive layout commit
 *  - slow recheck for keep-mounted boot-hidden path
 *  - never measure a content-sized box (circular shrink)
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type MeasuredSize = { width: number; height: number };

interface MeasurableEl {
  width?: number;
  height?: number;
  on?: (event: string, fn: () => void) => void;
  off?: (event: string, fn: () => void) => void;
}

const DEFAULT_SETTLE_MS = 60;
const DEFAULT_RECHECK_MS = 500;
const MOUNT_FALLBACK_MS = 50;

export function useMeasuredSize(
  seed: MeasuredSize,
  opts?: { settleMs?: number; recheckMs?: number },
): {
  ref: (node: unknown) => void;
  width: number;
  height: number;
  /** true after ≥1 positive layout commit */
  ready: boolean;
} {
  const settleMs = opts?.settleMs ?? DEFAULT_SETTLE_MS;
  const recheckMs = opts?.recheckMs ?? DEFAULT_RECHECK_MS;

  const [size, setSize] = useState<MeasuredSize>(() => ({
    width: Math.max(1, Math.floor(seed.width)),
    height: Math.max(1, Math.floor(seed.height)),
  }));
  const [ready, setReady] = useState(false);
  const [node, setNode] = useState<MeasurableEl | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const ref = useCallback((n: unknown) => {
    setNode((n as MeasurableEl) ?? null);
  }, []);

  // Hold seed until the first positive layout commit (deterministic pre-measure frames).
  useEffect(() => {
    if (readyRef.current) return;
    const next = {
      width: Math.max(1, Math.floor(seed.width)),
      height: Math.max(1, Math.floor(seed.height)),
    };
    setSize((prev) =>
      prev.width === next.width && prev.height === next.height ? prev : next,
    );
  }, [seed.width, seed.height]);

  useEffect(() => {
    const el = node;
    if (!el) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: MeasuredSize | null = null;

    const flush = (): void => {
      timer = undefined;
      if (disposed || !pending) return;
      const next = pending;
      pending = null;
      if (
        next.width !== sizeRef.current.width ||
        next.height !== sizeRef.current.height
      ) {
        setSize(next);
      }
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      }
    };

    const read = (): void => {
      if (disposed) return;
      const w = typeof el.width === 'number' ? el.width : 0;
      const h = typeof el.height === 'number' ? el.height : 0;
      // Pre-layout / transient zero — keep last good size (seed or prior commit).
      if (w <= 0 || h <= 0) return;
      pending = { width: Math.floor(w), height: Math.floor(h) };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, settleMs);
    };

    read();
    const mountFallback = setTimeout(read, MOUNT_FALLBACK_MS);
    el.on?.('resized', read);
    el.on?.('layout-changed', read);
    // Boot-hidden gap: no layout event when a display:none subtree becomes visible.
    const recheck = setInterval(read, recheckMs);

    return () => {
      disposed = true;
      clearTimeout(mountFallback);
      if (timer) clearTimeout(timer);
      clearInterval(recheck);
      el.off?.('resized', read);
      el.off?.('layout-changed', read);
    };
  }, [node, settleMs, recheckMs]);

  return { ref, width: size.width, height: size.height, ready };
}
