import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { usePalette } from '../ThemeProvider';

/**
 * A centered overlay shell — rounded border, active color, theme bg, above the view. Height is
 * bounded to the terminal so a modal NEVER overflows off-screen: pass an explicit `height` for
 * list modals (they center on it) and the shell caps everything at `dims.height - 2`. Small
 * fixed-content modals omit `height` and use the centered heuristic.
 */
export function Modal({
  title,
  width = 50,
  height,
  visible = true,
  children,
}: {
  title: string;
  width?: number;
  height?: number;
  /** When false, the overlay is kept MOUNTED but hidden (yoga display:none) — so a modal can be
   *  toggled by visibility instead of mount/unmount, which is the OpenTUI-0.4.2 teardown crash. */
  visible?: boolean;
  children: ReactNode;
}) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const left = Math.max(0, Math.floor((dims.width - width) / 2));
  const capH = Math.max(3, dims.height - 2); // never taller than the screen
  const h = height != null ? Math.min(height, capH) : undefined;
  const top = h != null ? Math.max(1, Math.floor((dims.height - h) / 2)) : Math.max(1, Math.floor(dims.height / 2) - 4);
  return (
    <box
      visible={visible}
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={h}
      maxHeight={capH}
      zIndex={100}
      border
      borderStyle="rounded"
      borderColor={t.borderActive}
      backgroundColor={t.background}
      title={` ${title} `}
      titleAlignment="center"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {children}
    </box>
  );
}

/**
 * Keep selection `i` within a `rows`-tall scroll window. `scrollTop` is a renderable setter (not
 * a typed JSX prop), so we drive it through a ref: attach the returned ref to a `<scrollbox>` and
 * its scroll position follows the selection. Returns the ref to spread as `ref={ref as never}`.
 */
function useScrollWindow(i: number, rows: number) {
  const ref = useRef<{ scrollTop: number } | null>(null);
  useEffect(() => {
    const sb = ref.current;
    if (!sb) return;
    const st = sb.scrollTop;
    if (i < st) sb.scrollTop = i;
    else if (i >= st + rows) sb.scrollTop = i - rows + 1;
  }, [i, rows]);
  return ref;
}

/** Yes/no confirmation (destructive actions). y/Enter confirm, n/Esc cancel. Kept MOUNTED; `active`
 *  toggles visibility + owns the keyboard (no mount/unmount → no OpenTUI-0.4.2 teardown crash). */
export function ConfirmModal({ active = true, message, onConfirm, onCancel }: { active?: boolean; message: string; onConfirm: () => void; onCancel: () => void }) {
  const t = usePalette();
  useKeyboard((key: { name?: string; ctrl?: boolean }) => {
    if (!active) return; // mounted-but-hidden
    if (key.ctrl) return; // Ctrl+N/P are shell-nav chords — 'n' with ctrl must not cancel
    const n = (key.name ?? '').toLowerCase();
    if (n === 'y' || n === 'return' || n === 'enter') return onConfirm();
    if (n === 'n' || n === 'escape') return onCancel();
  });
  return (
    <Modal title="Confirm" width={Math.max(28, message.length + 6)} visible={active}>
      <text fg={t.foreground}>{message}</text>
      <text fg={t.muted}>y confirm · n cancel</text>
    </Modal>
  );
}

export interface PickOption {
  label: string;
  value: string;
}

/** Pick one option from a short list. ↑↓ move, Enter/click pick, Esc cancel. Kept MOUNTED; `active`
 *  toggles visibility + owns the keyboard (visibility toggle, not mount/unmount). */
export function PickModal({
  active = true,
  title,
  options,
  onPick,
  onCancel,
}: {
  active?: boolean;
  title: string;
  options: PickOption[];
  onPick: (value: string) => void;
  onCancel: () => void;
}) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const [i, setI] = useState(0);
  const listRows = Math.min(Math.max(options.length, 1), Math.max(3, dims.height - 6));
  const sbRef = useScrollWindow(i, listRows);
  useEffect(() => {
    if (active) setI(0);
  }, [active]);
  useKeyboard((key: { name?: string }) => {
    if (!active) return; // mounted-but-hidden
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    // Empty-options guard (as LinksModal has): a `% 0` would NaN the index and `options[i].value`
    // would throw — with no options only Esc is live.
    if (options.length === 0) {
      if (n === 'escape') onCancel();
      return;
    }
    if (n === 'up' || n === 'k') return setI((x) => (x - 1 + options.length) % options.length);
    if (n === 'down' || n === 'j') return setI((x) => (x + 1) % options.length);
    if (n === 'return' || n === 'enter') return onPick(options[i].value);
    if (n === 'escape') return onCancel();
  });
  return (
    <Modal title={title} height={(options.length === 0 ? 1 : listRows) + 3} visible={active}>
      {options.length === 0 ? (
        <text fg={t.muted}>no options</text>
      ) : (
        <scrollbox ref={sbRef as never} scrollY height={listRows} maxHeight={listRows}>
          {options.map((o, idx) => (
            <box
              key={o.value}
              backgroundColor={idx === i ? t.selection : t.background}
              onMouseOver={() => setI(idx)}
              onMouseDown={() => onPick(o.value)}
            >
              <text fg={idx === i ? t.primary : t.muted}>{`${idx === i ? '› ' : '  '}${o.label}`}</text>
            </box>
          ))}
        </scrollbox>
      )}
      <text fg={t.muted}>↑↓ ⏎ pick · esc cancel</text>
    </Modal>
  );
}

export interface LinkEntry {
  label: string;
  path: string;
  /** → outbound (this doc links to it) · ← backlink (it links to this doc). */
  dir: '→' | '←';
}

/** Navigate a doc's resolved links (outbound + backlinks). ↑↓ move, Enter open, Esc close.
 *  Kept MOUNTED; `active` shows it + owns the keyboard (visibility toggle, not mount/unmount —
 *  the OpenTUI-0.4.2 modal-mount crash). */
export function LinksModal({ active, entries, onPick, onCancel }: { active: boolean; entries: LinkEntry[]; onPick: (path: string) => void; onCancel: () => void }) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const [i, setI] = useState(0);
  const listRows = Math.min(Math.max(entries.length, 1), Math.max(3, dims.height - 6));
  const sbRef = useScrollWindow(i, listRows);
  useEffect(() => {
    if (active) setI(0);
  }, [active]);
  useKeyboard((key: { name?: string }) => {
    if (!active) return; // mounted-but-hidden
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (entries.length === 0) {
      if (n === 'escape') onCancel();
      return;
    }
    if (n === 'up' || n === 'k') return setI((x) => (x - 1 + entries.length) % entries.length);
    if (n === 'down' || n === 'j') return setI((x) => (x + 1) % entries.length);
    if (n === 'return' || n === 'enter') return onPick(entries[i].path);
    if (n === 'escape') return onCancel();
  });
  return (
    <Modal title="Links" width={64} height={(entries.length === 0 ? 1 : listRows) + 3} visible={active}>
      {entries.length === 0 ? (
        <text fg={t.muted}>no resolved links</text>
      ) : (
        <scrollbox ref={sbRef as never} scrollY height={listRows} maxHeight={listRows}>
          {entries.map((e, idx) => (
            <box
              key={`${e.dir}-${e.path}-${idx}`}
              backgroundColor={idx === i ? t.selection : t.background}
              onMouseOver={() => setI(idx)}
              onMouseDown={() => onPick(e.path)}
            >
              <text fg={idx === i ? t.primary : e.dir === '→' ? t.info : t.muted}>
                {`${idx === i ? '› ' : '  '}${e.dir} ${e.label}`}
              </text>
            </box>
          ))}
        </scrollbox>
      )}
      <text fg={t.muted}>↑↓ ⏎ open · esc close</text>
    </Modal>
  );
}

/** Resolve a lifecycle'd inbox item: pick a terminal status + type a one-line note. Kept MOUNTED;
 *  `active` toggles visibility, owns the keyboard, and only then focuses the input. */
export function ResolveModal({
  active = true,
  onConfirm,
  onCancel,
}: {
  active?: boolean;
  onConfirm: (status: string, note: string) => void;
  onCancel: () => void;
}) {
  const t = usePalette();
  const STATUSES = ['resolved', 'dropped', 'superseded'];
  const [si, setSi] = useState(0);
  const inputRef = useRef<{ value?: string } | null>(null);
  useEffect(() => {
    if (active) {
      setSi(0);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [active]);
  useKeyboard((key: { name?: string }) => {
    if (!active) return; // mounted-but-hidden
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'up' || n === 'down') return setSi((x) => (x + (n === 'down' ? 1 : STATUSES.length - 1)) % STATUSES.length);
    if (n === 'return' || n === 'enter') return onConfirm(STATUSES[si], inputRef.current?.value ?? '');
    if (n === 'escape') return onCancel();
  });
  return (
    <Modal title="Resolve" width={58} visible={active}>
      <box flexDirection="row">
        {STATUSES.map((s, idx) => (
          <box key={s} marginRight={1} backgroundColor={idx === si ? t.selection : t.background} onMouseDown={() => setSi(idx)}>
            <text fg={idx === si ? t.primary : t.muted}>{` ${s} `}</text>
          </box>
        ))}
      </box>
      <input
        ref={inputRef as never}
        focused={active}
        placeholder="resolution — wikilink to where it landed…"
        backgroundColor={t.background}
        textColor={t.foreground}
      />
      <text fg={t.muted}>↑↓ status · type note · ⏎ confirm · esc cancel</text>
    </Modal>
  );
}
