import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useRenderer } from '@opentui/react';
import { StyledText, stringToStyledText, fg, bg, bold, italic, underline, type StylableInput } from '@opentui/core';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { renderMarkdown, type MdLine, type Tone } from '../md-render';
import { copyText } from '../clipboard';
import { tickRender } from '../debug';

/** Map a semantic markdown tone to a palette color + text attributes. */
function toneStyle(p: Palette, tone: Tone): { fg: RGBA; bg?: RGBA; bold?: boolean; italic?: boolean; underline?: boolean } {
  switch (tone) {
    case 'h1':
    case 'h2':
      return { fg: p.primary, bold: true };
    case 'h3':
      return { fg: p.secondary, bold: true };
    // code: a subtle bg tint across the whole block (lines are padded to width), syntax-colored
    case 'code':
      return { fg: p.info, bg: p.selection };
    case 'codeblock':
      return { fg: p.foreground, bg: p.selection };
    case 'kw':
      return { fg: p.primary, bg: p.selection, bold: true };
    case 'str':
      return { fg: p.success, bg: p.selection };
    case 'comment':
      return { fg: p.muted, bg: p.selection, italic: true };
    case 'num':
      return { fg: p.warning, bg: p.selection };
    case 'link':
      return { fg: p.info, underline: true };
    case 'rule':
    case 'qbar':
    case 'tborder':
      return { fg: p.border };
    case 'marker':
      return { fg: p.primary };
    case 'quote':
      return { fg: p.muted, italic: true };
    case 'thead':
      return { fg: p.primary, bold: true };
    case 'image':
      return { fg: p.warning };
    case 'math':
      // Accent color, no bg — display math is indented; inline math sits in prose.
      return { fg: p.secondary };
    default:
      return { fg: p.foreground };
  }
}

/** A markdown line → a single StyledText (styled chunks = styling RUNS, not child renderables). */
function toStyled(line: MdLine, p: Palette): StyledText {
  if (line.length === 0) return stringToStyledText(' ');
  const chunks = line.map((seg) => {
    const st = toneStyle(p, seg.tone);
    let c: StylableInput = seg.text;
    // tone's default attrs OR the segment's own (emphasis composes with any color tone)
    if (st.italic || seg.italic) c = italic(c);
    if (st.bold || seg.bold) c = bold(c);
    if (st.underline || seg.underline) c = underline(c);
    if (st.bg) c = bg(st.bg)(c);
    return fg(st.fg)(c);
  });
  return new StyledText(chunks);
}

/**
 * Our own Markdown viewer — renders `md-render`'s wrapped, tone-tagged lines as a fixed-slot
 * windowed, scrollable view: exactly `visible` `<text>` slots (each a StyledText of chunks), a
 * window into the full line list. Replaces OpenTUI's native `<markdown>` (which segfaults on
 * content changes / long docs). Self-measures its container via a box ref.
 *
 * Selection/copy uses OpenTUI's native selection: the slots are `selectable`, so with mouse
 * reporting on the renderer starts/extends a selection on drag (highlight drawn by the native
 * text buffer) and `y` copies `renderer.getSelection().getSelectedText()` — content-precise, no
 * borders/adjacent panes (boxes aren't selectable). A bare `y` with nothing selected copies the
 * whole doc, so the common case stays one keystroke. ↑↓/PageUp-Down/Home/End/space/wheel scroll.
 */
export function MarkdownView({
  body,
  inputActive,
  onFollowWikilink,
}: {
  body: string;
  inputActive?: boolean;
  /** Follow a `[[wikilink]]`: the host (DocView) resolves the raw target against its outbound
   *  links and navigates. Fired on a click (mouse-down + up on the same cell) that lands on a
   *  wikilink segment; a drag (down/up on different cells) is left to select as before. */
  onFollowWikilink?: (target: string) => void;
}) {
  const p = usePalette();
  const renderer = useRenderer();
  const boxRef = useRef<{ width?: number; height?: number; screenX?: number; screenY?: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [top, setTop] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);

  tickRender('MarkdownView');

  // Measure the laid-out container. The ref's size is only valid AFTER OpenTUI lays out, so a plain
  // effect read gets 0 (the "blank until you scroll" bug). Subscribe to the renderable's layout
  // events instead. TWO guards keep the slot count from churning (which mounts/unmounts text
  // renderables — the native use-after-free): (1) ignore transient 0 reads so height never flips
  // 0↔N, (2) debounce the commit so a burst of layout-changed events settles to one size update.
  useEffect(() => {
    const el = boxRef.current as
      | { width?: number; height?: number; on?: (e: string, fn: () => void) => void; off?: (e: string, fn: () => void) => void }
      | null;
    if (!el) return;
    let pending: { w: number; h: number } | null = null;
    let commit: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      commit = null;
      const pv = pending;
      if (pv) setSize((s) => (pv.w !== s.w || pv.h !== s.h ? pv : s));
    };
    const update = () => {
      const w = el.width ?? 0;
      const h = el.height ?? 0;
      if (w <= 0 || h <= 0) return; // pre-layout / transient zero — keep the last good size
      pending = { w, h };
      if (!commit) commit = setTimeout(flush, 60);
    };
    update();
    el.on?.('resized', update);
    el.on?.('layout-changed', update);
    const t1 = setTimeout(update, 32);
    const t2 = setTimeout(update, 120);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (commit) clearTimeout(commit);
      el.off?.('resized', update);
      el.off?.('layout-changed', update);
    };
  }, []);
  useEffect(() => {
    setTop(0);
  }, [body]); // new doc → reset scroll

  const innerW = Math.max(16, (size.w || 40) - 1); // hair of margin so an exact-fit line can't wrap
  const rows = Math.max(2, size.h || 2);
  const visible = rows - 1; // last row is the status line (scroll % / hint / copy flash)
  const lines = useMemo(() => renderMarkdown(body, innerW), [body, innerW]);
  const maxTop = Math.max(0, lines.length - visible);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(id);
  }, [flash]);

  const clampedTop = Math.min(top, maxTop);
  const shown = lines.slice(clampedTop, clampedTop + visible);

  const doCopy = () => {
    const selected = renderer.getSelection()?.getSelectedText() ?? '';
    const hasSel = selected.trim().length > 0;
    const text = hasSel
      ? selected
      : lines.map((l) => l.map((s) => s.text).join('').replace(/\s+$/, '')).join('\n');
    const ok = copyText(text);
    const count = text.split('\n').length;
    setFlash(ok ? `✓ copied ${hasSel ? 'selection' : 'whole doc'} (${count} line${count === 1 ? '' : 's'})` : 'copy failed (clip.exe?)');
    renderer.clearSelection();
  };

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'y') return doCopy();
    if (n === 'down' || n === 'j') return setTop((tp) => Math.min(tp + 1, maxTop));
    if (n === 'up' || n === 'k') return setTop((tp) => Math.max(tp - 1, 0));
    if (n === 'pagedown' || n === 'space') return setTop((tp) => Math.min(tp + visible, maxTop));
    if (n === 'pageup') return setTop((tp) => Math.max(tp - visible, 0));
    if (n === 'home') return setTop(0);
    if (n === 'end') return setTop(maxTop);
  });

  const onScroll = (e: { scroll?: { direction?: string }; button?: number }) => {
    let d = e.scroll?.direction;
    if (!d && e.button === 4) d = 'up';
    if (!d && e.button === 5) d = 'down';
    if (d === 'up') setTop((tp) => Math.max(tp - 3, 0));
    else if (d === 'down') setTop((tp) => Math.min(tp + 3, maxTop));
  };

  // Wikilink follow. The whole box is one mouse target (each line is one non-interactive `<text>`
  // slot — splitting a line into per-segment renderables would reintroduce the variable-child
  // mount/unmount churn the fixed-slot design exists to avoid). So we translate the click's absolute
  // cell to a (row, col) against the box's own screen origin: row → the shown line, col walked over
  // the line's segment widths → the segment under the cursor, whose `wikilink` (if any) we follow.
  const wikilinkAt = (ex: number, ey: number): string | null => {
    const el = boxRef.current as { screenX?: number; screenY?: number } | null;
    if (!el || el.screenX == null || el.screenY == null) return null;
    const row = ey - el.screenY; // slot index (each content line is exactly 1 row)
    const col = ex - el.screenX;
    if (row < 0 || row >= visible) return null; // outside the content window / on the status line
    const line = shown[row];
    if (!line) return null;
    let x = 0;
    for (const seg of line) {
      const w = seg.text.length;
      if (col >= x && col < x + w) return seg.wikilink ?? null;
      x += w;
    }
    return null;
  };
  const onMouseDown = (e: { x: number; y: number }) => {
    downRef.current = { x: e.x, y: e.y };
  };
  const onMouseUp = (e: { x: number; y: number }) => {
    const d = downRef.current;
    downRef.current = null;
    if (!inputActive || !onFollowWikilink) return;
    if (!d || d.x !== e.x || d.y !== e.y) return; // a drag → leave the native selection alone
    const target = wikilinkAt(e.x, e.y);
    if (target) {
      renderer.clearSelection(); // clear the zero-width selection the click started
      onFollowWikilink(target);
    }
  };

  const blank = useMemo(() => stringToStyledText(''), []);
  const pct = maxTop > 0 ? Math.round((clampedTop / maxTop) * 100) : 100;
  const status = flash ?? `${pct}% · drag to select · y copy`;
  const statusFg = flash ? p.success : p.muted;

  return (
    <box ref={boxRef as never} flexDirection="column" flexGrow={1} onMouseScroll={onScroll} onMouseDown={onMouseDown} onMouseUp={onMouseUp}>
      {/* uniform fixed slots — one <text content={StyledText}> each, content-only updates. Content
          lines are `selectable` (drag-select); trailing blanks are not (no empty-line selection). */}
      {Array.from({ length: visible }, (_, i) => (
        <text key={`md-${i}`} selectable={!!shown[i]} content={shown[i] ? toStyled(shown[i], p) : blank} />
      ))}
      <text key="md-status" fg={statusFg} selectable={false}>
        {status}
      </text>
    </box>
  );
}
