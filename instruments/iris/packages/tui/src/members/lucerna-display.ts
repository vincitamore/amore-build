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
 * Known typography → ASCII (always applied). Other narrow BMP (box drawing,
 * braille, middle-dot, bullets, etc.) passes through; only wide/combining/
 * non-BMP classes fall back to '?'.
 */
const TYPO_ASCII: Array<[RegExp, string]> = [
  [/\u2192/g, '->'], // →
  [/\u2190/g, '<-'], // ←
  [/\u21d2/g, '=>'], // ⇒
  [/\u21d0/g, '<='], // ⇐
  [/\u21d4/g, '<=>'], // ⇔
  [/\u2191/g, 'up'], // ↑ (footer hints)
  [/\u2193/g, 'dn'], // ↓
  [/\u2265/g, '>='], // ≥
  [/\u2264/g, '<='], // ≤
  [/\u2260/g, '!='], // ≠
  [/\u00d7/g, 'x'], // ×
  [/\u00f7/g, '/'], // ÷
  [/\u2014/g, '-'], // em dash
  [/\u2013/g, '-'], // en dash
  [/\u00a0/g, ' '], // nbsp
  [/\u25a3/g, '#'], // ▣ image placeholder from md-render
];

function isUnrenderableCodePoint(cp: number): boolean {
  // C0 controls (keep tab handled upstream as space-ish if present)
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return true;
  if (cp === 0x7f) return true;
  // Combining diacriticals
  if (cp >= 0x0300 && cp <= 0x036f) return true;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  // Fullwidth / halfwidth forms (wide cells)
  if (cp >= 0xff01 && cp <= 0xff60) return true;
  if (cp >= 0xffe0 && cp <= 0xffe6) return true;
  // Non-BMP (emoji / astral) — cell advance unreliable
  if (cp > 0xffff) return true;
  // Private use / noncharacters in BMP
  if (cp >= 0xe000 && cp <= 0xf8ff) return true;
  return false;
}

/**
 * Display sanitizer for Lucerna rows and the review overlay.
 * 1) Map known typography to ASCII
 * 2) Pass through other printable narrow BMP (box drawing, braille, bullets, …)
 * 3) Replace unrenderable classes with '?'
 */
export function sanitizeDisplayText(line: string): string {
  let s = line;
  for (const [re, rep] of TYPO_ASCII) s = s.replace(re, rep);
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isUnrenderableCodePoint(cp)) out += '?';
    else out += ch;
  }
  return out;
}

/**
 * Fixed-width cell for Lucerna/Dashboard list rows.
 * Sanitize glyphs, then truncate/pad so string length equals `width`
 * (paired with an opaque row background for full repaint clear).
 */
export function formatLogCell(line: string, width: number): string {
  if (width <= 0) return '';
  const cleaned = sanitizeDisplayText(line);
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
