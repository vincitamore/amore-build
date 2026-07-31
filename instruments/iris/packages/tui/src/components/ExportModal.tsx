import { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { THEMES } from '../theme';
import { Modal } from './Modal';

export interface ExportChoices {
  theme: string;
  pageSize: 'letter' | 'a4';
  includeMetadata: boolean;
  includeLinks: boolean;
  includeToc: boolean;
}

/**
 * PDF export options. Defaults are SHAREABLE — frontmatter + links off, so a printed/shared PDF
 * doesn't leak internal org structure (wikilink cross-references are always scrubbed to plain text
 * upstream). Flip them on for personal-use exports, and pick an export theme WITHOUT changing the
 * TUI theme (defaults to the active theme). ↑↓ picks a field, ←→/space changes it, ⏎ exports.
 */
export function ExportModal({
  active,
  initialTheme,
  onExport,
  onCancel,
}: {
  /** Kept MOUNTED always; `active` shows it + owns the keyboard. Toggling this instead of
   *  mounting/unmounting avoids the OpenTUI-0.4.2 teardown/mount use-after-free on open. */
  active: boolean;
  initialTheme: string;
  onExport: (choices: ExportChoices) => void;
  onCancel: () => void;
}) {
  const t = usePalette();
  const themeKeys = Object.keys(THEMES);
  const [themeI, setThemeI] = useState(Math.max(0, themeKeys.indexOf(initialTheme)));
  const [pageSize, setPageSize] = useState<'letter' | 'a4'>('letter');
  const [meta, setMeta] = useState(false);
  const [links, setLinks] = useState(false);
  const [toc, setToc] = useState(true);
  const [row, setRow] = useState(0);
  const ROWS = 5;

  // Fresh defaults each time it opens (shareable-clean, current theme) — and reset to Horizon-safe
  // if the active theme changed since the last open.
  useEffect(() => {
    if (!active) return;
    setThemeI(Math.max(0, themeKeys.indexOf(initialTheme)));
    setPageSize('letter');
    setMeta(false);
    setLinks(false);
    setToc(true);
    setRow(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, initialTheme]);

  const change = (d: number) => {
    if (row === 0) setThemeI((i) => (i + d + themeKeys.length) % themeKeys.length);
    else if (row === 1) setPageSize((p) => (p === 'letter' ? 'a4' : 'letter'));
    else if (row === 2) setMeta((v) => !v);
    else if (row === 3) setLinks((v) => !v);
    else if (row === 4) setToc((v) => !v);
  };
  const doExport = () =>
    onExport({ theme: themeKeys[themeI], pageSize, includeMetadata: meta, includeLinks: links, includeToc: toc });

  useKeyboard((key: { name?: string }) => {
    if (!active) return; // mounted-but-hidden: don't eat keys when closed
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'up' || n === 'k') return setRow((r) => (r - 1 + ROWS) % ROWS);
    if (n === 'down' || n === 'j') return setRow((r) => (r + 1) % ROWS);
    if (n === 'left') return change(-1);
    if (n === 'right' || n === 'space') return change(1);
    if (n === 'return' || n === 'enter') return doExport();
    if (n === 'escape') return onCancel();
  });

  const toggle = (v: boolean) => ({ value: v ? '● on' : '○ off', fg: v ? t.success : t.muted });
  const rows: { label: string; value: string; fg: typeof t.info }[] = [
    { label: 'Theme', value: THEMES[themeKeys[themeI]].label, fg: t.info },
    { label: 'Page size', value: pageSize === 'letter' ? 'Letter' : 'A4', fg: t.info },
    { label: 'Frontmatter', ...toggle(meta) },
    { label: 'Links & backlinks', ...toggle(links) },
    { label: 'Table of contents', ...toggle(toc) },
  ];

  return (
    <Modal title="Export PDF" width={52} visible={active}>
      <box flexDirection="column">
        {rows.map((r, i) => (
          <box key={r.label} flexDirection="row" backgroundColor={i === row ? t.selection : t.background} onMouseDown={() => setRow(i)}>
            <text fg={i === row ? t.primary : t.muted}>{`${i === row ? '› ' : '  '}${r.label.padEnd(20)}`}</text>
            <text fg={r.fg}>{r.value}</text>
          </box>
        ))}
      </box>
      <box marginTop={1}>
        <text fg={t.muted}>{'↑↓ field · ←→/space change · ⏎ export · esc cancel'}</text>
      </box>
    </Modal>
  );
}
