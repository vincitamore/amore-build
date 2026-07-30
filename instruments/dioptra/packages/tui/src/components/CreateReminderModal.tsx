import { useEffect, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Modal } from './Modal';
import { WHEN_PRESETS, parseLocalDateTime } from '../reminder-when';

type InputHandle = { value?: string; focus?: () => void; blur?: () => void };

/**
 * Create a reminder: type a title, pick when to be reminded. The quick presets cover the
 * common case; the last option — "Custom date/time…" — reveals an editable field for an exact
 * instant (`YYYY-MM-DD HH:mm`, am/pm and date-only accepted). ↑↓ moves through the options
 * (focus follows into the custom field); the title input stays editable until you enter custom.
 */
export function CreateReminderModal({
  active = true,
  onConfirm,
  onCancel,
}: {
  active?: boolean;
  onConfirm: (title: string, remindAt: string) => void;
  onCancel: () => void;
}) {
  const t = usePalette();
  const CUSTOM_I = WHEN_PRESETS.length;
  const [wi, setWi] = useState(3); // default: tomorrow 9am
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<InputHandle | null>(null);
  const whenRef = useRef<InputHandle | null>(null);
  const inCustom = wi === CUSTOM_I;

  // Kept MOUNTED; reset to a blank default each time it's shown (no mount/unmount → no teardown UAF).
  useEffect(() => {
    if (!active) return;
    setWi(3);
    setError(null);
    if (titleRef.current) titleRef.current.value = '';
    if (whenRef.current) whenRef.current.value = '';
  }, [active]);

  // Drive focus: the title input while picking presets, the custom field once it's selected. Only
  // while shown — a hidden modal must not steal focus (and thus keys) from the list behind it.
  useEffect(() => {
    if (!active) {
      titleRef.current?.blur?.();
      whenRef.current?.blur?.();
      return;
    }
    if (inCustom) {
      titleRef.current?.blur?.();
      whenRef.current?.focus?.();
    } else {
      whenRef.current?.blur?.();
      titleRef.current?.focus?.();
    }
  }, [inCustom, active]);

  const moveWi = (d: number) => {
    setError(null);
    setWi((x) => (x + d + (CUSTOM_I + 1)) % (CUSTOM_I + 1));
  };

  const submit = () => {
    const title = (titleRef.current?.value ?? '').trim();
    if (!title) return setError('a title is required');
    let remindAt: string;
    if (inCustom) {
      const parsed = parseLocalDateTime(whenRef.current?.value ?? '');
      if (!parsed) return setError('use YYYY-MM-DD HH:mm (or 2:30pm, or a bare date)');
      remindAt = parsed;
    } else {
      remindAt = WHEN_PRESETS[wi].compute(Date.now());
    }
    onConfirm(title, remindAt);
  };

  useKeyboard((key: { name?: string }) => {
    if (!active) return; // mounted-but-hidden
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'up') return moveWi(-1);
    if (n === 'down') return moveWi(1);
    if (n === 'return' || n === 'enter') return submit();
    if (n === 'escape') return onCancel();
  });

  return (
    <Modal title="New Reminder" width={58} visible={active}>
      <input
        ref={titleRef as never}
        placeholder="what to be reminded of…"
        backgroundColor={t.background}
        textColor={t.foreground}
      />
      <box flexDirection="column" marginTop={1}>
        <text fg={t.muted}>remind me</text>
        {WHEN_PRESETS.map((p, idx) => (
          <box key={p.label} backgroundColor={idx === wi ? t.selection : t.background} onMouseDown={() => setWi(idx)}>
            <text fg={idx === wi ? t.primary : t.muted}>{`${idx === wi ? '› ' : '  '}${p.label}`}</text>
          </box>
        ))}
        <box backgroundColor={inCustom ? t.selection : t.background} onMouseDown={() => setWi(CUSTOM_I)}>
          <text fg={inCustom ? t.primary : t.muted}>{`${inCustom ? '› ' : '  '}custom date/time…`}</text>
        </box>
      </box>
      {/* Kept MOUNTED (visibility toggle): ↑↓ crossing the custom row must not mount/unmount an
          interactive input (the UAF class) — and the buffer persists across toggles for free,
          uncontrolled (a `value` prop re-applied by a parent re-render wiped typed text). */}
      <box visible={inCustom}>
        <input ref={whenRef as never} placeholder="YYYY-MM-DD HH:mm" backgroundColor={t.background} textColor={t.foreground} />
      </box>
      {error ? <text fg={t.error}>{error}</text> : null}
      <text fg={t.muted}>
        {inCustom ? 'type date · ↑↓ options · ⏎ create · esc cancel' : 'type title · ↑↓ when · ⏎ create · esc cancel'}
      </text>
    </Modal>
  );
}
