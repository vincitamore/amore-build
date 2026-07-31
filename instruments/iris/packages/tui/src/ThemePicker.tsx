import { useEffect, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { THEME_ORDER, THEMES, toPalette } from './theme';
import { useTheme } from './ThemeProvider';

/**
 * A centered theme picker overlay. Arrow/jk move the selection and preview the
 * theme live (the whole UI re-themes as you move); Enter commits + persists, Esc
 * reverts to the theme that was active when the picker opened. Each row shows the
 * theme's label plus a swatch strip so the palette is visible before committing.
 */
export function ThemePicker({ visible = true, onClose }: { visible?: boolean; onClose: () => void }) {
  const { themeName, setTheme, previewTheme, palette } = useTheme();
  const dims = useTerminalDimensions();
  const startName = useRef(themeName);
  const [idx, setIdx] = useState(() => Math.max(0, THEME_ORDER.indexOf(themeName)));

  // Kept MOUNTED (toggled by `visible`, not mount/unmount → no teardown UAF). On show, snapshot the
  // committed theme as the revert target and start the cursor on it.
  useEffect(() => {
    if (!visible) return;
    startName.current = themeName;
    setIdx(Math.max(0, THEME_ORDER.indexOf(themeName)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Live preview — only while shown (a hidden picker must not re-theme the whole UI).
  useEffect(() => {
    if (!visible) return;
    previewTheme(THEME_ORDER[idx]);
  }, [idx, visible, previewTheme]);

  useKeyboard((key: { name?: string }) => {
    if (!visible) return; // mounted-but-hidden
    const n = (key.name ?? '').toLowerCase();
    if (n === 'escape') {
      previewTheme(startName.current);
      return onClose();
    }
    if (n === 'return' || n === 'enter') {
      setTheme(THEME_ORDER[idx]);
      return onClose();
    }
    if (n === 'up' || n === 'k') return setIdx((i) => (i - 1 + THEME_ORDER.length) % THEME_ORDER.length);
    if (n === 'down' || n === 'j') return setIdx((i) => (i + 1) % THEME_ORDER.length);
  });

  const width = 46;
  const left = Math.max(0, Math.floor((dims.width - width) / 2));
  // Bound the absolute overlay to the terminal (the documented absolute-overlay gotcha): an
  // unbounded picker grows past a short terminal's bottom edge and can't truly center. Cap the box
  // at dims.height - 2, put the theme list in a height-bounded scrollbox, and center on the cap.
  const capH = Math.max(3, dims.height - 2);
  const boxH = Math.min(THEME_ORDER.length + 3, capH); // list rows + footer(1) + border(2)
  const listRows = Math.max(1, boxH - 3);
  const top = Math.max(1, Math.floor((dims.height - boxH) / 2));

  // Follow the keyboard selection when the list overflows its window (scrollTop is a
  // ScrollBoxRenderable setter, not a typed JSX prop — drive it through a ref).
  const sbRef = useRef<{ scrollTop: number } | null>(null);
  useEffect(() => {
    const sb = sbRef.current;
    if (!sb) return;
    if (idx < sb.scrollTop) sb.scrollTop = idx;
    else if (idx >= sb.scrollTop + listRows) sb.scrollTop = idx - listRows + 1;
  }, [idx, listRows]);

  return (
    <box
      visible={visible}
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={boxH}
      maxHeight={capH}
      zIndex={100}
      border
      borderStyle="rounded"
      borderColor={palette.borderActive}
      backgroundColor={palette.background}
      title=" Theme "
      titleAlignment="center"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox ref={sbRef as never} scrollY height={listRows} maxHeight={listRows}>
        {THEME_ORDER.map((name, i) => {
          const p = toPalette(name);
          const sel = i === idx;
          return (
            <box key={name} flexDirection="row" backgroundColor={sel ? palette.selection : palette.background}>
              <text fg={sel ? palette.primary : palette.muted}>{sel ? '› ' : '  '}</text>
              <text fg={sel ? palette.foreground : palette.muted}>{THEMES[name].label.padEnd(20)}</text>
              <text fg={p.primary}>█</text>
              <text fg={p.secondary}>█</text>
              <text fg={p.accent}>█</text>
              <text fg={p.success}>█</text>
              <text fg={p.warning}>█</text>
              <text fg={p.error}>█</text>
              <text fg={p.info}>█</text>
            </box>
          );
        })}
      </scrollbox>
      <text fg={palette.muted}>{'↑↓ preview   ⏎ apply   esc cancel'}</text>
    </box>
  );
}
