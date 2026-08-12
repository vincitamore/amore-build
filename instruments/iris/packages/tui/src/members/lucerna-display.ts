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

// ── Lucerna run-state + pulse copy (pure; absent fields match prior behavior) ─

export type LucernaUiState = 'daemon-down' | 'not-installed' | 'stopped' | 'running' | 'stale';

/** Minimal health subset used to derive the member state. All extras optional. */
export interface LucernaHealthFields {
  available?: boolean;
  reason?: string;
  stale?: boolean;
  lastBeat?: string;
  pidAlive?: boolean;
  phase?: string;
  stopped?: boolean;
  staleBoundSec?: number;
  beatAgeSec?: number | null;
}

/** Minimal status subset used to derive the member state. */
export interface LucernaStatusFields {
  available?: boolean;
  reason?: string;
  stale?: boolean;
  activity?: unknown;
  lastActions?: unknown;
  phase?: string;
}

/**
 * Member state machine. `stopped` / `pidAlive === false` beat `stale`.
 * Absent optional fields reproduce the prior mapping exactly.
 */
export function deriveLucernaUiState(
  daemonUrl: string | null | undefined,
  health: LucernaHealthFields | null,
  status: LucernaStatusFields | null,
): LucernaUiState {
  if (!daemonUrl) return 'daemon-down';
  if (!health && !status) return 'stopped';
  const avail = health?.available ?? status?.available;
  if (avail === false && (health?.reason === 'not-installed' || status?.reason === 'not-installed')) {
    return 'not-installed';
  }
  if (avail === false) return 'not-installed';
  if (health?.stopped === true || health?.pidAlive === false) return 'stopped';
  const stale = health?.stale ?? status?.stale;
  if (stale) return 'stale';
  if (health && health.available && !health.lastBeat && health.stale === false) return 'stopped';
  if (health?.available && health.lastBeat && !stale) return 'running';
  if (status?.available && !stale) return 'running';
  return 'stopped';
}

/** Headline word for the Activity Stat. Running is the live label; Hung is reserved for stale. */
export function lucernaActivityValue(uiState: LucernaUiState): string {
  if (uiState === 'stale') return 'Hung';
  if (uiState === 'stopped') return 'Stopped';
  if (uiState === 'running') return 'Running';
  return '—';
}

/** Activity Stat sub: phase when running, else the uiState token. */
export function lucernaActivitySub(
  uiState: LucernaUiState,
  status?: Pick<LucernaStatusFields, 'phase'> | null,
  health?: Pick<LucernaHealthFields, 'phase'> | null,
): string {
  if (uiState !== 'running') return uiState;
  const fromStatus = typeof status?.phase === 'string' ? status.phase.trim() : '';
  if (fromStatus) return fromStatus;
  const fromHealth = typeof health?.phase === 'string' ? health.phase.trim() : '';
  if (fromHealth) return fromHealth;
  return 'live';
}

/** Beat-age Stat sub. Honest bound when the wire sends `staleBoundSec`. */
export function lucernaBeatAgeSub(
  health?: Pick<LucernaHealthFields, 'lastBeat' | 'staleBoundSec'> | null,
): string {
  if (!health?.lastBeat) return 'no beat';
  const bound = health.staleBoundSec;
  if (typeof bound === 'number' && Number.isFinite(bound) && bound > 0) {
    return `bound ${Math.floor(bound)}s`;
  }
  return 'since lastBeat';
}

function formatActionEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const a = entry as Record<string, unknown>;
    if (typeof a.key === 'string' && a.key) {
      if (a.ok === true) return `${a.key}:ok`;
      if (a.ok === false) return `${a.key}:fail`;
      return a.key;
    }
    return String(a.action ?? a.type ?? a.name ?? JSON.stringify(entry));
  }
  return String(entry);
}

/**
 * Compact last-actions copy. Understands `{key, ok, detail?, at?}` plus the
 * older string / `{action|type|name}` / key-list shapes.
 */
export function lastActionsSummary(lastActions: unknown): string {
  if (Array.isArray(lastActions) && lastActions.length > 0) {
    const writerShaped = lastActions.every(
      (x) => x && typeof x === 'object' && typeof (x as Record<string, unknown>).key === 'string',
    );
    if (writerShaped) {
      return lastActions.slice(0, 3).map(formatActionEntry).join(' · ');
    }
    return formatActionEntry(lastActions[0]);
  }
  if (lastActions && typeof lastActions === 'object') {
    const rec = lastActions as Record<string, unknown>;
    if (typeof rec.key === 'string' && rec.key) return formatActionEntry(rec);
    const keys = Object.keys(rec);
    if (keys.length) return keys.slice(0, 3).join(', ');
  }
  return 'none yet';
}

/** Free-text activity label from the status wire (string or named object). */
export function activityDetail(activity: unknown): string {
  if (typeof activity === 'string' && activity) return activity;
  if (activity && typeof activity === 'object') {
    const a = activity as Record<string, unknown>;
    if (typeof a.name === 'string' && a.name) return a.name;
    if (typeof a.phase === 'string' && a.phase) return a.phase;
    if (typeof a.type === 'string' && a.type) return a.type;
  }
  return '';
}

/**
 * Last-actions line body: real activity detail (when present) sits here so the
 * Activity Stat value can stay the word "Running".
 */
export function formatLucernaLastActionsLine(
  status?: Pick<LucernaStatusFields, 'activity' | 'lastActions'> | null,
): string {
  const summary = lastActionsSummary(status?.lastActions);
  const detail = activityDetail(status?.activity);
  if (!detail) return summary;
  if (summary === 'none yet') return detail;
  if (summary.includes(detail)) return summary;
  return `${detail} · ${summary}`;
}

export interface LucernaPulseView {
  available: boolean;
  state: string;
  beatAgeSec?: number | null;
  pendingReview?: { total: number };
  phase?: string;
}

function formatPulseBeat(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '-';
  if (sec < 60) return `${Math.floor(sec)}s`;
  return `${Math.floor(sec / 60)}m`;
}

/**
 * Compact Dashboard Lucerna pulse status (right-hand clause).
 * Null/unfetched → loading ellipsis. `available === false` is the only
 * "not installed" path. Phase is included on the running line only when it
 * fits `width` (the caller still clamps via formatLucernaDisplayLine).
 */
export function formatLucernaPulseStatus(
  pulse: LucernaPulseView | null | undefined,
  width: number,
): string {
  if (pulse == null) return '…';
  const pend =
    pulse.pendingReview && pulse.pendingReview.total > 0
      ? ` · ${pulse.pendingReview.total} rev`
      : '';
  if (pulse.available === false) return `not installed${pend}`;
  if (pulse.state === 'running') {
    const beat = formatPulseBeat(pulse.beatAgeSec);
    const without = `live · beat ${beat}${pend}`;
    const phase = typeof pulse.phase === 'string' ? pulse.phase.trim() : '';
    if (phase) {
      const withPhase = `live · ${phase} · beat ${beat}${pend}`;
      if (withPhase.length <= width) return withPhase;
    }
    return without;
  }
  if (pulse.state === 'stale') return `hung${pend}`;
  return `stopped${pend}`;
}
