import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The timer core behind {@link useFlash}, factored out so the reset/clear behavior is testable
 * without a React renderer. `emit` receives the message to show (or null to clear). Setting a new
 * message re-arms the timer (latest wins); `dispose` cancels a pending clear.
 */
export function makeFlash(ms: number, emit: (v: string | null) => void): {
  set: (msg: string) => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const set = (msg: string) => {
    if (timer) clearTimeout(timer);
    emit(msg);
    timer = setTimeout(() => {
      timer = null;
      emit(null);
    }, ms);
  };
  const dispose = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return { set, dispose };
}

/**
 * A transient hint-line "flash": setting a message shows it and arms a timer that clears it back to
 * null after `ms`; a new message while armed resets the timer (latest wins). The timer is cleared on
 * unmount so keep-mounted members don't leak. The returned setter is stable (safe to pass into
 * `React.memo`'d children).
 */
export function useFlash(ms = 2500): [string | null, (msg: string) => void] {
  const [flash, setFlashState] = useState<string | null>(null);
  const ctrl = useRef<ReturnType<typeof makeFlash> | null>(null);
  if (!ctrl.current) ctrl.current = makeFlash(ms, setFlashState);
  const setFlash = useCallback((msg: string) => ctrl.current!.set(msg), []);
  useEffect(() => () => ctrl.current?.dispose(), []);
  return [flash, setFlash];
}
