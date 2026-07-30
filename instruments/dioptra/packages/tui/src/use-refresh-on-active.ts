import { useEffect, useRef } from 'react';

/**
 * Re-run `refresh` whenever a keep-mounted member goes from hidden → active.
 *
 * Members are mounted once and kept alive (visibility-toggled) to dodge the OpenTUI-0.4.2 teardown
 * crash — but that means they never RE-MOUNT, so a one-shot mount-time read goes permanently stale
 * (a task completed from another screen, an external write) until an in-member action happens to
 * reload it. This restores the "re-read when you come back" behaviour the lost re-mount used to give,
 * without any work while the member is hidden.
 *
 * `active` is the member's `inputActive` (true only when it's the visible, focused member). The first
 * mount is treated as already-read (members lazy-mount active), so this fires only on RE-activation.
 */
export function useRefreshOnActive(active: boolean | undefined, refresh: () => void): void {
  const wasActive = useRef(true); // mount already read → only re-read on a later re-activation
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (active && !wasActive.current) refreshRef.current();
    wasActive.current = !!active;
  }, [active]);
}
