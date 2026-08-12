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

/** Wall-clock HH:MM from a snapshot instant (civil time in the ISO, not client TZ). */
export function formatResumesClock(iso?: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

/** Activity Stat sub: phase when running, else the uiState token. */
export function lucernaActivitySub(
  uiState: LucernaUiState,
  status?: Pick<LucernaStatusFields, 'phase'> | null,
  health?: Pick<LucernaHealthFields, 'phase'> | null,
  capability?: { state?: string; resumesAt?: string } | null,
): string {
  if (uiState === 'running' && capability?.state === 'refusing') {
    const clock = formatResumesClock(capability.resumesAt);
    return clock ? `refusing · resumes ${clock}` : 'refusing';
  }
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
  capability?: { state?: string; resumesAt?: string; reasonCode?: string };
  tokens?: string;
  actionsToday?: number;
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
function formatRefusingPulseStatus(
  resumesAt: string | undefined,
  pend: string,
  width: number,
): string {
  const clock = formatResumesClock(resumesAt);
  const candidates: string[] = [];
  if (clock) {
    candidates.push(`refusing · resumes ${clock}${pend}`);
    candidates.push(`refusing · resumes ${clock}`);
    candidates.push(`refusing · ${clock}${pend}`);
    candidates.push(`refusing · ${clock}`);
  }
  if (pend) candidates.push(`refusing${pend}`);
  candidates.push('refusing');
  for (const c of candidates) {
    if (c.length <= width) return c;
  }
  return 'refusing';
}

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
  if (pulse.state === 'stale') return `hung${pend}`;
  if (pulse.state === 'running' && pulse.capability?.state === 'refusing') {
    return formatRefusingPulseStatus(pulse.capability.resumesAt, pend, width);
  }
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
  return `stopped${pend}`;
}

/**
 * Pulse sub-line while refusing. Ceiling first; chores clause only when the
 * snapshot can say zero without inventing a count.
 */
export function formatPulseRefusingSubLine(
  tokens: string | undefined,
  choresToday: number | undefined,
  innerWidth: number,
  home: string = homedir(),
): string {
  const tok = tokens && tokens.trim() ? tokens.trim() : '';
  const chores =
    typeof choresToday === 'number' && choresToday === 0 ? '0 chores today' : '';
  const candidates: string[] = [];
  if (tok) {
    if (chores) candidates.push(`   token ceiling ${tok} · ${chores}`);
    candidates.push(`   token ceiling ${tok}`);
    candidates.push(`   ceiling ${tok}`);
  } else {
    candidates.push('   token ceiling');
  }
  let body = candidates[candidates.length - 1] ?? '   token ceiling';
  for (const c of candidates) {
    if (c.length <= innerWidth) {
      body = c;
      break;
    }
  }
  return formatLucernaDisplayLine(body, innerWidth, home);
}

// ── Budgets panel + chores overlay (reads of the persisted snapshot) ──────────

export const BUDGETS_EMPTY_NEVER_RAN =
  'no cycle has run yet · caps shipped at 12/day, 6/week, 200K tokens';
export const BUDGETS_EMPTY_UNAVAILABLE =
  'budgets unavailable — restart Lucerna to populate';
export const BUDGETS_HINT = 'b edit caps · c chores';

export type BudgetsPanelKind = 'never-ran' | 'unavailable' | 'rows';

export interface LucernaCapabilityView {
  state: 'ready' | 'cooling' | 'refusing';
  reasonCode?: string;
  reason?: string;
  resumesAt?: string;
}

export interface BudgetWindowView {
  used: number;
  cap: number;
  remaining?: number;
  resetsAt?: string;
  readyAt?: string;
  source?: string;
  aboveShipped?: boolean;
  over?: number;
  bySource?: { planner?: number; agentic?: number; autoCommit?: number };
}

export interface LucernaChoreEntryView {
  key: string;
  class: string;
  tier: string;
  enabled: boolean;
  lastRun: string | null;
}

export interface LucernaRosterView {
  enabledCount: number;
  shippedCount: number;
  disabled: string[];
  entries: LucernaChoreEntryView[];
}

export interface LucernaBudgetsView {
  actions: string;
  weekly: string;
  tokens: string;
  actionsToday: number;
  dailyCap: number;
  tokensToday: number;
  dailyTokenCeiling: number;
  capability?: LucernaCapabilityView;
  windows?: {
    daily?: BudgetWindowView;
    weekly?: BudgetWindowView;
    tokens?: BudgetWindowView;
    cycle?: BudgetWindowView;
  };
  roster?: LucernaRosterView;
}

export type BudgetPanelTone = 'muted' | 'warning';

export interface BudgetPanelLine {
  text: string;
  tone: BudgetPanelTone;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseWindow(raw: unknown): BudgetWindowView | undefined {
  if (!isRecord(raw) || typeof raw.used !== 'number' || typeof raw.cap !== 'number') {
    return undefined;
  }
  const by =
    isRecord(raw.bySource)
      ? {
          planner: typeof raw.bySource.planner === 'number' ? raw.bySource.planner : undefined,
          agentic: typeof raw.bySource.agentic === 'number' ? raw.bySource.agentic : undefined,
          autoCommit:
            typeof raw.bySource.autoCommit === 'number' ? raw.bySource.autoCommit : undefined,
        }
      : undefined;
  return {
    used: raw.used,
    cap: raw.cap,
    remaining: typeof raw.remaining === 'number' ? raw.remaining : undefined,
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : undefined,
    readyAt: typeof raw.readyAt === 'string' ? raw.readyAt : undefined,
    source: typeof raw.source === 'string' ? raw.source : undefined,
    aboveShipped: raw.aboveShipped === true,
    over: typeof raw.over === 'number' ? raw.over : undefined,
    bySource: by,
  };
}

function parseCapability(raw: unknown): LucernaCapabilityView | undefined {
  if (!isRecord(raw)) return undefined;
  const state = raw.state;
  if (state !== 'ready' && state !== 'cooling' && state !== 'refusing') return undefined;
  return {
    state,
    reasonCode: typeof raw.reasonCode === 'string' ? raw.reasonCode : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    resumesAt: typeof raw.resumesAt === 'string' ? raw.resumesAt : undefined,
  };
}

function parseRoster(raw: unknown): LucernaRosterView | undefined {
  if (!isRecord(raw)) return undefined;
  const entries: LucernaChoreEntryView[] = [];
  if (Array.isArray(raw.entries)) {
    for (const e of raw.entries) {
      if (!isRecord(e) || typeof e.key !== 'string' || !e.key) continue;
      entries.push({
        key: e.key,
        class: typeof e.class === 'string' ? e.class : '',
        tier: typeof e.tier === 'string' ? e.tier : '',
        enabled: e.enabled !== false,
        lastRun: typeof e.lastRun === 'string' ? e.lastRun : null,
      });
    }
  }
  const disabled = Array.isArray(raw.disabled)
    ? raw.disabled.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  return {
    enabledCount: typeof raw.enabledCount === 'number' ? raw.enabledCount : entries.filter((e) => e.enabled).length,
    shippedCount: typeof raw.shippedCount === 'number' ? raw.shippedCount : entries.length,
    disabled,
    entries,
  };
}

/** Parse the persisted EffectiveBudgetsDisplay. Null when the snapshot is absent or pre-wire. */
export function parseLucernaBudgets(budgets: unknown): LucernaBudgetsView | null {
  if (!isRecord(budgets)) return null;
  if (
    typeof budgets.actions !== 'string' ||
    typeof budgets.weekly !== 'string' ||
    typeof budgets.tokens !== 'string'
  ) {
    return null;
  }
  const windows = isRecord(budgets.windows)
    ? {
        daily: parseWindow(budgets.windows.daily),
        weekly: parseWindow(budgets.windows.weekly),
        tokens: parseWindow(budgets.windows.tokens),
        cycle: parseWindow(budgets.windows.cycle),
      }
    : undefined;
  return {
    actions: budgets.actions,
    weekly: budgets.weekly,
    tokens: budgets.tokens,
    actionsToday: typeof budgets.actionsToday === 'number' ? budgets.actionsToday : 0,
    dailyCap: typeof budgets.dailyCap === 'number' ? budgets.dailyCap : 0,
    tokensToday: typeof budgets.tokensToday === 'number' ? budgets.tokensToday : 0,
    dailyTokenCeiling:
      typeof budgets.dailyTokenCeiling === 'number' ? budgets.dailyTokenCeiling : 0,
    capability: parseCapability(budgets.capability) ?? parseCapability(budgets),
    windows,
    roster: parseRoster(budgets.roster),
  };
}

export function budgetsPanelKind(
  budgets: unknown,
  hasOtherState: boolean,
): BudgetsPanelKind {
  if (parseLucernaBudgets(budgets)) return 'rows';
  if (hasOtherState) return 'unavailable';
  return 'never-ran';
}

/** Abbreviate counts ≥ 10,000 with K (display only). */
export function formatBudgetTokenCount(n: number): string {
  if (n >= 10_000 || n <= -10_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function tokenOverPercent(used: number, cap: number): string | null {
  if (!(cap > 0) || used <= cap) return null;
  return `${Math.round((used / cap) * 100)}%`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function weekdayFromIso(iso: string): string | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return WEEKDAYS[d.getUTCDay()] ?? null;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
  if (h >= 1) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

function remainingUntil(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return formatDurationMs(t - now);
}

function padCell(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s.padEnd(n, ' ');
}

function formatSourceMark(source?: string, aboveShipped?: boolean): string {
  if (!source || source === 'shipped' || source === 'default') return '';
  return aboveShipped ? `${source} !` : source;
}

function formatResetWindow(
  resetsAt: string | undefined,
  inner: number,
  now: number,
  weekly: boolean,
): string {
  const clock = formatResumesClock(resetsAt);
  if (!clock) return '';
  const day = weekly && resetsAt ? weekdayFromIso(resetsAt) : null;
  const clockPart = day ? `${day} ${clock}` : clock;
  if (inner < 28) return clockPart;
  if (weekly || inner < 40) return `resets ${clockPart}`;
  const dur = remainingUntil(resetsAt, now);
  return dur ? `resets ${clockPart} (${dur})` : `resets ${clockPart}`;
}

function composeGaugeRow(
  label: string,
  gauge: string,
  window: string,
  source: string,
  inner: number,
): string {
  const showSourceCol = inner >= 56;
  const left = `${padCell(label, 10)}${padCell(gauge, 16)}${padCell(window, inner >= 40 ? 24 : Math.max(8, window.length))}`;
  if (!source) return left.trimEnd();
  if (showSourceCol) return `${left}${padCell(source, 6)}`.trimEnd();
  return `${left.trimEnd()}  ${source}`;
}

function tokensGauge(view: LucernaBudgetsView): { text: string; over: boolean } {
  const used = view.windows?.tokens?.used ?? view.tokensToday;
  const cap = view.windows?.tokens?.cap ?? view.dailyTokenCeiling;
  const pct = tokenOverPercent(used, cap);
  const base = view.tokens;
  if (!pct) return { text: base, over: false };
  return { text: `${base} ${pct}`, over: true };
}

function attributionLines(view: LucernaBudgetsView): string[] {
  const by = view.windows?.tokens?.bySource;
  if (!by) return [];
  const dreams = (by.planner ?? 0) + (by.agentic ?? 0);
  const ac = by.autoCommit ?? 0;
  const out: string[] = [];
  if (dreams > 0) out.push(`  dreams      ${formatBudgetTokenCount(dreams)}`);
  if (ac > 0) out.push(`  auto-commit ${formatBudgetTokenCount(ac)}`);
  return out;
}

function cooldownGauge(view: LucernaBudgetsView): { text: string; window: string } {
  const cycle = view.windows?.cycle;
  const remaining = cycle?.remaining ?? 0;
  if (remaining > 0) {
    const clock = formatResumesClock(cycle?.readyAt);
    return {
      text: formatDurationMs(remaining) || 'cooling',
      window: clock ? `ready ${clock}` : '',
    };
  }
  return { text: 'ready', window: '' };
}

/** Live Budgets panel rows from a parsed snapshot. Artifact join omitted (no count on the wire). */
export function formatBudgetPanelLines(
  view: LucernaBudgetsView,
  inner: number,
  now: number = Date.now(),
): BudgetPanelLine[] {
  const daily = view.windows?.daily;
  const weekly = view.windows?.weekly;
  const tokens = view.windows?.tokens;
  const tok = tokensGauge(view);
  const cool = cooldownGauge(view);
  const lines: BudgetPanelLine[] = [
    {
      text: composeGaugeRow(
        'actions',
        view.actions,
        formatResetWindow(daily?.resetsAt, inner, now, false),
        formatSourceMark(daily?.source, daily?.aboveShipped),
        inner,
      ),
      tone: daily?.aboveShipped ? 'warning' : 'muted',
    },
    {
      text: composeGaugeRow(
        'expensive',
        view.weekly,
        formatResetWindow(weekly?.resetsAt, inner, now, true),
        formatSourceMark(weekly?.source, weekly?.aboveShipped),
        inner,
      ),
      tone: weekly?.aboveShipped ? 'warning' : 'muted',
    },
    {
      text: composeGaugeRow(
        'tokens',
        tok.text,
        formatResetWindow(tokens?.resetsAt, inner, now, false),
        formatSourceMark(tokens?.source, tokens?.aboveShipped),
        inner,
      ),
      tone: tok.over || tokens?.aboveShipped ? 'warning' : 'muted',
    },
  ];
  for (const a of attributionLines(view)) {
    lines.push({ text: a, tone: 'muted' });
  }
  lines.push({
    text: composeGaugeRow(
      'cooldown',
      cool.text,
      cool.window,
      formatSourceMark(view.windows?.cycle?.source, view.windows?.cycle?.aboveShipped),
      inner,
    ),
    tone: view.windows?.cycle?.aboveShipped ? 'warning' : 'muted',
  });
  lines.push({ text: BUDGETS_HINT, tone: 'muted' });
  return lines;
}

export function formatChoresOverlayHeader(roster: LucernaRosterView): string {
  const n = roster.enabledCount;
  const m = roster.shippedCount;
  const k =
    roster.disabled.length > 0
      ? roster.disabled.length
      : Math.max(0, m - n, roster.entries.filter((e) => !e.enabled).length);
  return `planner may pick ${n} of ${m} chores · ${k} disabled`;
}

function formatAgeAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'ready';
  const ms = now - t;
  if (ms < 0) return 'ready';
  const dur = formatDurationMs(ms) || '0m';
  return `ran ${dur} ago`;
}

export function formatChoreOverlayRow(
  entry: LucernaChoreEntryView,
  selected: boolean,
  now: number = Date.now(),
): string {
  const prefix = selected ? '>' : ' ';
  const mark = entry.enabled ? '[on ]' : '[off]';
  const tail = entry.enabled
    ? entry.lastRun
      ? formatAgeAgo(entry.lastRun, now)
      : 'ready'
    : 'planner will not pick';
  const cls = entry.class ? ` ${entry.class}` : '';
  const tier = entry.tier ? ` ${entry.tier}` : '';
  return `${prefix} ${mark} ${entry.key}${cls}${tier}  ${tail}`;
}

export function formatUnknownChoreRow(key: string, selected: boolean): string {
  const prefix = selected ? '>' : ' ';
  return `${prefix} [??] ${key}    unknown — this build ships no such chore`;
}

export function choreOverlayItems(roster: LucernaRosterView): Array<
  | { kind: 'entry'; entry: LucernaChoreEntryView }
  | { kind: 'unknown'; key: string }
> {
  const known = new Set(roster.entries.map((e) => e.key));
  const items: Array<
    | { kind: 'entry'; entry: LucernaChoreEntryView }
    | { kind: 'unknown'; key: string }
  > = roster.entries.map((entry) => ({ kind: 'entry' as const, entry }));
  for (const key of roster.disabled) {
    if (!known.has(key)) items.push({ kind: 'unknown', key });
  }
  return items;
}
