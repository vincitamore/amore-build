// Display-side helpers for Lucerna TUI rows. Never rewrite on-disk log files.
//
// OpenTUI paints text cells such that space glyphs do not reliably clear what
// previously occupied a cell (prior content shows through spaces). Every
// repainted log/notification row must therefore (1) emit a string of exact
// column width and (2) sit in a fixed-height row box with an opaque background
// so a shorter line fully overwrites a longer predecessor.

import { homedir } from 'node:os';

/** Truncate to n columns with the same ellipsis glyph Dashboard rows use (\u2026). */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}\u2026`;
}

/**
 * Fixed-width cell for Lucerna/Dashboard list rows.
 * Multi-byte glyphs that mis-advance the cell grid are mapped to ASCII; the
 * middle-dot separator (\u00b7) and ellipsis (\u2026) are kept so pulse rows
 * match sibling Pulse lines. Truncate then pad so string length always equals
 * `width` (paired with an opaque row background for full repaint clear).
 */
export function formatLogCell(line: string, width: number): string {
  if (width <= 0) return '';
  const cleaned = line
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    // md-render list bullet (U+2022) — must not become "?" (overlay defect)
    .replace(/\u2022/g, '-')
    // Arrow keys often appear in footer hints; dash vocabulary is "up/dn"
    .replace(/\u2191/g, 'up')
    .replace(/\u2193/g, 'dn')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\u00a0/g, ' ')
    // md-render image placeholder / light box-drawing (tables) → ASCII
    .replace(/\u25a3/g, '#') // ▣
    .replace(/[\u2500-\u257f]/g, '-') // box drawing
    // Keep middle-dot (Pulse siblings / tab bar) and ellipsis (Dashboard truncate); map the rest.
    .replace(/[^\t\r\n\x20-\x7e\u00b7\u2026]/g, '?');
  const t = truncate(cleaned, width);
  return t.length >= width ? t.slice(0, width) : t.padEnd(width, ' ');
}

/** Escape a string for use as a literal in RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Display-only: collapse the operator home directory prefix to `~` in free text
 * (Windows and POSIX separators). Does not touch files on disk.
 */
export function collapseHomeInText(text: string, home: string = homedir()): string {
  if (!text || !home) return text;
  const forms = new Set<string>();
  forms.add(home);
  forms.add(home.replace(/\\/g, '/'));
  forms.add(home.replace(/\//g, '\\'));
  // Trim trailing separators so "C:\Users\x\" and "C:\Users\x" both match.
  for (const f of [...forms]) {
    const trimmed = f.replace(/[/\\]+$/, '');
    if (trimmed.length >= 2) forms.add(trimmed);
  }

  let out = text;
  // Longer forms first so a longer absolute path wins over a prefix of itself.
  const ordered = [...forms].filter((f) => f.length >= 2).sort((a, b) => b.length - a.length);
  for (const form of ordered) {
    const re = new RegExp(escapeRegExp(form), 'gi');
    out = out.replace(re, '~');
  }
  return out;
}

/**
 * Full display pipeline for one Lucerna list row: tilde-collapse house paths,
 * then force exact `width` columns for repaint clearing.
 */
export function formatLucernaDisplayLine(
  line: string,
  width: number,
  home: string = homedir(),
): string {
  return formatLogCell(collapseHomeInText(line, home), width);
}

/**
 * Content width inside a Dashboard Pulse panel column.
 * Column is `agendaW` (wide) or full dash width minus dash pad; panel chrome is
 * border(2) + horizontal pad(2). Must match the box Yoga actually lays out so
 * ellipsis truncation is visible instead of mid-word clip at the border.
 */
export function pulsePanelInnerWidth(columnWidth: number): number {
  return Math.max(12, Math.floor(columnWidth) - 4);
}

/**
 * Lucerna Pulse detail sub-line (leading indent + message or empty copy),
 * truncated with ellipsis to the panel's real inner width.
 */
export function formatPulseSubLine(
  message: string | null | undefined,
  innerWidth: number,
  home: string = homedir(),
): string {
  const body =
    message && message.length > 0 ? `   ${message}` : '   no notifications';
  return formatLucernaDisplayLine(body, innerWidth, home);
}

/** Empty (space-filled) row of exact width — clears a previously occupied slot. */
export function emptyDisplayRow(width: number): string {
  return formatLogCell('', width);
}
