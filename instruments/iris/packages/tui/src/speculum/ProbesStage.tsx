import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { useStableDimensions } from '../use-stable-dimensions';
import type { MeasuredSize } from '../use-measured-size';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { runSpeculum, type SpeculumResult } from './speculum-spawn';
import { openQueryService } from './query-service';
import { seedStageBox } from './sessions-layout';
import {
  Card,
  CardGrid,
  cardInnerWidth,
  cardsPerRow,
  cardWidthForRow,
  padTruncate,
} from './Card';
import { rewriteMachineTitle } from '../render/graph';

/** One hit row from a probe (subset of the CLI shape). */
export interface ProbeHit {
  sessionId: string;
  ts?: string;
  evidence: string;
  category?: string;
  /** jump grain when the CLI attaches it. */
  eventId?: string | number;
  eventIds?: Array<string | number>;
}

/** One probe row from `speculum scan --json` (bare array). */
export interface ScanRow {
  probe: string;
  value: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  partial: boolean;
  unit: 'session' | 'msg';
  summary?: string;
  data?: unknown;
  hits?: ProbeHit[];
  heuristic: true;
}

/** One window point from `scan --series --json`. */
export interface SeriesWindowPoint {
  since: string;
  until: string;
  value: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  partial: boolean;
}

/** One probe series from `scan --series --json`. */
export interface ProbeSeriesResult {
  probe: string;
  granularity: string;
  windows: SeriesWindowPoint[];
}

export type ProbesError = Extract<SpeculumResult<unknown>, { ok: false }>['error'];

/** Scope chips: all · 30d · 7d. */
export type ProbeScope = 'all' | '30d' | '7d';
export const PROBE_SCOPES: readonly ProbeScope[] = ['all', '30d', '7d'] as const;

/**
 * Probes excluded from the sparkline series spawn.
 * Criterion: privacy-gate full-text scanners whose per-probe weekly×12 series
 * wall dominates the full-registry series (measured on the live index).
 * `sensitive-content` alone is ~62% of an ~8.4 s full registry series.
 * No other registered probe is a privacy-gate text scan of comparable cost.
 */
export const SERIES_EXCLUDE_PROBES: readonly string[] = ['sensitive-content'];

/**
 * Full registry probe names known at dash author time (matches instrument registry).
 * Series spawn uses this minus SERIES_EXCLUDE_PROBES so one comma-list spawn
 * covers every trend-worthy probe without waiting for the board scan.
 */
export const REGISTRY_PROBE_NAMES: readonly string[] = [
  'rage-rate',
  'frustration-markers',
  'tool-mix',
  'stuck-loop',
  'apology-rate',
  'operator-correction',
  'sensitive-content',
  'stale-corpus',
  'session-phase',
  'contradiction',
  'session-overlap',
];

/** Trend-worthy probe names for the series spawn. */
export function seriesProbeList(
  registry: readonly string[] = REGISTRY_PROBE_NAMES,
  exclude: readonly string[] = SERIES_EXCLUDE_PROBES,
): string[] {
  const ban = new Set(exclude);
  return registry.filter((n) => !ban.has(n));
}

/**
 * Plain-language methodology for each known probe.
 * What the marker is, what the denominator is, what it does NOT claim.
 */
export const PROBE_METHODOLOGY: Readonly<Record<string, string>> = {
  'rage-rate':
    'Counts user messages matching a strong-language pattern bank. Denominator: user messages in scope. Does not measure actual anger — only surface markers.',
  'frustration-markers':
    'Counts milder frustration / impatience phrases in user text. Denominator: user messages. Not a mood model; bank is unvalidated.',
  'tool-mix':
    'Describes which tools fire most often across sessions. Denominator: tool-call events. Descriptive mix, not quality judgment.',
  'stuck-loop':
    'Flags repeated identical tool fingerprints without progress. Denominator: sessions in scope. Heuristic thrash detector, not a proof of failure.',
  'apology-rate':
    'Counts assistant self-corrections / apologies. Denominator: assistant messages. Surface politeness markers, not error truth.',
  'operator-correction':
    'Counts user turns that look like corrections of the agent. Denominator: user messages. Pattern bank only — not intent classification.',
  'sensitive-content':
    'Flags secret-shaped strings (keys, tokens, private keys) in event text and tool payloads. Denominator: sessions. Privacy gate — best-effort regex, not a guarantee of absence.',
  'stale-corpus':
    'Reports how old the newest ingested session is. Denominator: session count. Freshness of the index, not session quality.',
  'session-phase':
    'Buckets sessions by rough lifecycle phase from turn patterns. Denominator: sessions. Investigative heuristic, not a workflow truth.',
  contradiction:
    'Looks for operator/agent statement conflicts across nearby turns. Denominator: sessions. Unvalidated pattern pairs — false positives expected.',
  'session-overlap':
    'Finds concurrent sessions on the same project window. Denominator: session pairs. Calendar overlap only, not causal linking.',
};

export function probeMethodology(name: string): string {
  return (
    PROBE_METHODOLOGY[name] ??
    'Heuristic probe over the local session index. Pattern banks are unvalidated — rates are markers, not ground truth.'
  );
}

const INSTALL_RECIPE = 'amore init --with-speculum';
/** Outer floor for a probe card; board is 2-up when it fits, else 1-up. */
const MIN_PROBE_CARD = 36;
const GRID_GAP = 1;
/**
 * Rows per card on the board: top border + title + body + bottom border +
 * marginBottom(1) = 5. With a sparkline body line the card is 6.
 * Undercounting lets content paint onto the panel bottom border.
 */
export const CARD_ROW_H = 5;
export const CARD_ROW_H_SERIES = 6;
/**
 * Local stage chrome charged against the residual host (not terminal height):
 * padTop 1 + panel border/title 3 + stage footer 1 + scope row 1 + range line 1 = 7.
 */
export const PROBES_STAGE_CHROME = 7;

/** Board cursor unit: a live probe card or the collapsed no-signal summary. */
export type BoardItem =
  | { kind: 'probe'; row: ScanRow }
  | { kind: 'degenerate'; names: string[] };

/** Aggregated hits for one session inside a probe (detail pane). */
export interface SessionHitAgg {
  sessionId: string;
  title: string;
  hitCount: number;
  latestTs?: string;
  /** First hit in the flat list (enter opens at this grain). */
  firstHit: ProbeHit;
}

/**
 * Min card width that keeps the board at most 2-up (house probe board).
 * Floor is MIN_PROBE_CARD so a narrow strip collapses to 1-up.
 */
export function probeMinCardWidth(rowWidth: number, gap = GRID_GAP): number {
  const forceTwo = Math.floor((rowWidth + gap) / 3) - gap + 1;
  return Math.max(MIN_PROBE_CARD, forceTwo);
}

/**
 * Format a probe's primary value.
 * Session-unit proportions → percent; msg-unit (and session counts > 1) → raw number.
 */
export function formatProbeValue(value: number, unit: 'session' | 'msg'): string {
  if (unit === 'session' && value >= 0 && value <= 1) {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (unit === 'msg' && value >= 0 && value <= 1 && !Number.isInteger(value)) {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (unit === 'msg' && value >= 0 && value <= 1) {
    return String(value);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Wilson CI as a percent span — keeps [0,1] honesty for empty corpus. */
export function formatWilsonRange(ciLow: number, ciHigh: number): string {
  return `${(ciLow * 100).toFixed(1)}–${(ciHigh * 100).toFixed(1)}%`;
}

/** Card title-bar right annotation: hits count when present, else CI + heuristic tag. */
export function probeCardRight(row: ScanRow): string {
  const hitN = row.hits?.length ?? 0;
  if (hitN > 0) return `hits ${hitN}`;
  const ci = formatWilsonRange(row.ciLow, row.ciHigh);
  return row.heuristic ? `${ci} [heuristic]` : ci;
}

/**
 * Linear grid cursor move. ↑↓ step by per-row count; ←→ within the linear list.
 * Pure helper — unit-tested without mounting OpenTUI.
 */
export function moveProbeCursor(
  cursor: number,
  dir: 'up' | 'down' | 'left' | 'right',
  count: number,
  perRow: number,
): number {
  if (count <= 0) return 0;
  const max = count - 1;
  const c = Math.max(0, Math.min(max, cursor));
  const pr = Math.max(1, perRow);
  switch (dir) {
    case 'left':
      return Math.max(0, c - 1);
    case 'right':
      return Math.min(max, c + 1);
    case 'up':
      return Math.max(0, c - pr);
    case 'down':
      return Math.min(max, c + pr);
    default:
      return c;
  }
}

/** Visible probe index range for the scroll window (1-based for chrome). */
export function probeVisibleRange(
  count: number,
  rowScroll: number,
  visibleRows: number,
  perRow: number,
): { first: number; last: number } {
  if (count <= 0) return { first: 0, last: 0 };
  const pr = Math.max(1, perRow);
  const vr = Math.max(1, visibleRows);
  const start = Math.min(count - 1, Math.max(0, rowScroll) * pr);
  const end = Math.min(count, start + vr * pr);
  return { first: start + 1, last: end };
}

/** Keep the cursor's row inside the visible row window. */
export function clampRowScroll(
  cursor: number,
  rowScroll: number,
  visibleRows: number,
  perRow: number,
): number {
  const pr = Math.max(1, perRow);
  const vr = Math.max(1, visibleRows);
  const row = Math.floor(Math.max(0, cursor) / pr);
  if (row < rowScroll) return row;
  if (row >= rowScroll + vr) return row - vr + 1;
  return Math.max(0, rowScroll);
}

/**
 * Budget hit-list slots from Panel-body residual height.
 * Pure fit-clamp ≥ 1 — never a MIN floor that exceeds residual.
 */
export function budgetHitSlots(
  bodyH: number,
  gridRowsH: number,
  hitsHeaderRows: number = 1,
): number {
  const residual = Math.floor(
    bodyH - Math.max(0, gridRowsH) - Math.max(0, hitsHeaderRows),
  );
  if (residual <= 0) return 1;
  return residual;
}

/**
 * Visible card-grid rows from Panel-body residual height.
 * When the hits drill is open, leave residual height for the hits panel.
 */
export function budgetProbeVisibleRows(
  bodyH: number,
  hitsOpen: boolean,
  cardRowH: number = CARD_ROW_H,
): number {
  const h = Math.max(1, Math.floor(bodyH));
  const crh = Math.max(1, cardRowH);
  if (!hitsOpen) {
    return Math.max(1, Math.min(6, Math.floor(h / crh)));
  }
  const forHitsAndHeader = 2;
  const maxGrid = Math.max(1, Math.floor(Math.max(0, h - forHitsAndHeader) / crh));
  const targetGrid = Math.max(1, Math.floor(h / 3 / crh));
  return Math.max(1, Math.min(6, maxGrid, targetGrid));
}

/**
 * Keep the hit cursor inside the hit-scroll window (cursor-following).
 */
export function clampHitScroll(
  hitCursor: number,
  hitScroll: number,
  hitSlots: number,
  hitCount: number,
): number {
  const slots = Math.max(1, hitSlots);
  const maxScroll = Math.max(0, hitCount - slots);
  let s = Math.max(0, Math.min(maxScroll, hitScroll));
  if (hitCursor < s) s = hitCursor;
  else if (hitCursor >= s + slots) s = hitCursor - slots + 1;
  return Math.max(0, Math.min(maxScroll, s));
}

/** Resolve the eventId jump grain from a probe hit. */
export function hitEventId(h: ProbeHit): string | number | undefined {
  if (h.eventId != null && h.eventId !== '') return h.eventId;
  const first = h.eventIds?.[0];
  if (first != null && first !== '') return first;
  return undefined;
}

// ── Scope window arithmetic ─────────────────────────────────────────────────

/** Cycle scope chip left (`[`) or right (`]`). */
export function cycleProbeScope(scope: ProbeScope, dir: -1 | 1): ProbeScope {
  const i = PROBE_SCOPES.indexOf(scope);
  const idx = i < 0 ? 0 : i;
  const next = (idx + dir + PROBE_SCOPES.length) % PROBE_SCOPES.length;
  return PROBE_SCOPES[next]!;
}

/**
 * Inclusive lower bound ISO for a scope chip, or null for `all`.
 * Anchored at `now` (injectable for tests). Day windows use local midnight
 * of (today − N days) so the CLI `--since` floor is stable across a day.
 */
export function scopeSinceIso(scope: ProbeScope, now: Date = new Date()): string | null {
  if (scope === 'all') return null;
  const days = scope === '7d' ? 7 : 30;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return d.toISOString();
}

/** One-row scope chip line: `all · 30d · 7d` with active marked by case. */
export function formatScopeRow(scope: ProbeScope): string {
  return PROBE_SCOPES.map((s) => (s === scope ? s.toUpperCase() : s)).join(' · ');
}

// ── Ranking + collapse ──────────────────────────────────────────────────────

/** Hit count used for ranking (flat hits length). */
export function probeHitCount(row: ScanRow): number {
  return row.hits?.length ?? 0;
}

/** Wilson CI width (smaller = tighter / more informative). */
export function probeCiWidth(row: ScanRow): number {
  return Math.max(0, row.ciHigh - row.ciLow);
}

/**
 * Rank live (n > 0) probes: hits desc, then narrower CI first.
 * n = 0 probes are excluded — they collapse into the degenerate card.
 */
export function rankSignalProbes(rows: readonly ScanRow[]): ScanRow[] {
  return rows
    .filter((r) => r.n > 0)
    .slice()
    .sort((a, b) => {
      const ha = probeHitCount(a);
      const hb = probeHitCount(b);
      if (hb !== ha) return hb - ha;
      const cwa = probeCiWidth(a);
      const cwb = probeCiWidth(b);
      if (cwa !== cwb) return cwa - cwb;
      return a.probe.localeCompare(b.probe);
    });
}

/**
 * Build the board cursor list: ranked live probes, then one collapsed card
 * for every n = 0 probe (if any). Cursor treats the collapse as one unit.
 */
export function buildProbeBoard(rows: readonly ScanRow[]): BoardItem[] {
  const live = rankSignalProbes(rows);
  const quiet = rows.filter((r) => r.n === 0).map((r) => r.probe);
  const board: BoardItem[] = live.map((row) => ({ kind: 'probe' as const, row }));
  if (quiet.length > 0) {
    board.push({ kind: 'degenerate', names: quiet });
  }
  return board;
}

/** Dim summary body for the collapsed no-signal card. */
export function formatDegenerateBody(names: readonly string[], width?: number): string {
  const head = `no-signal probes (${names.length}): `;
  const joined = names.join(' · ');
  const full = `${head}${joined}`;
  if (width == null || width <= 0) return full;
  return padTruncate(full, width).trimEnd();
}

// ── Series / sparklines ─────────────────────────────────────────────────────

/** Braille ladder for sparkline cells (empty → full). Local helper — no import. */
const BRAILLE_LEVELS = ['⠀', '⢀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;

/**
 * 12-cell braille sparkline from window values.
 * Windows with n = 0 paint as blank (⠀). Scale is min–max over n > 0 cells.
 */
export function brailleSparkline(
  windows: readonly SeriesWindowPoint[],
  cells = 12,
): string {
  const n = Math.max(1, Math.floor(cells));
  const vals = windows.slice(-n);
  while (vals.length < n) vals.unshift({ since: '', until: '', value: 0, ciLow: 0, ciHigh: 0, n: 0, partial: true });

  let min = Infinity;
  let max = -Infinity;
  for (const w of vals) {
    if (w.n > 0 && Number.isFinite(w.value)) {
      if (w.value < min) min = w.value;
      if (w.value > max) max = w.value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return BRAILLE_LEVELS[0]!.repeat(n);
  }
  const span = max - min;
  let out = '';
  for (const w of vals) {
    if (w.n <= 0 || !Number.isFinite(w.value)) {
      out += BRAILLE_LEVELS[0];
      continue;
    }
    const t = span <= 0 ? 0.5 : (w.value - min) / span;
    const level = Math.max(0, Math.min(8, Math.round(t * 8)));
    out += BRAILLE_LEVELS[level];
  }
  return out;
}

/**
 * Δ of the newest window vs the prior window.
 * Rates in [0,1] as percentage-point delta; otherwise raw.
 * Empty when fewer than two informative windows.
 */
export function seriesDeltaLabel(windows: readonly SeriesWindowPoint[]): string {
  if (windows.length < 2) return '';
  const cur = windows[windows.length - 1]!;
  const prev = windows[windows.length - 2]!;
  if (cur.n <= 0 && prev.n <= 0) return '';
  const a = prev.n > 0 ? prev.value : 0;
  const b = cur.n > 0 ? cur.value : 0;
  const d = b - a;
  if (Math.abs(d) < 1e-12) return 'Δ 0';
  const rateLike =
    (a >= 0 && a <= 1 && b >= 0 && b <= 1) ||
    (cur.n > 0 && cur.value >= 0 && cur.value <= 1 && prev.n > 0 && prev.value >= 0 && prev.value <= 1);
  if (rateLike) {
    const pp = d * 100;
    const sign = pp > 0 ? '+' : '';
    return `Δ ${sign}${pp.toFixed(1)}pp`;
  }
  const sign = d > 0 ? '+' : '';
  return `Δ ${sign}${Number.isInteger(d) ? String(d) : d.toFixed(2)}`;
}

/** Second body line when series data is present: sparkline + delta. */
export function formatSeriesLine(
  windows: readonly SeriesWindowPoint[],
  width?: number,
): string {
  const spark = brailleSparkline(windows, 12);
  const delta = seriesDeltaLabel(windows);
  const line = delta ? `${spark}  ${delta}` : spark;
  if (width == null || width <= 0) return line;
  return padTruncate(line, width).trimEnd();
}

/** Parse series JSON from the CLI into a probe → windows map. Soft on bad shape. */
export function parseSeriesMap(
  json: unknown,
): ReadonlyMap<string, SeriesWindowPoint[]> {
  const m = new Map<string, SeriesWindowPoint[]>();
  if (!Array.isArray(json)) return m;
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as ProbeSeriesResult;
    if (typeof rec.probe !== 'string' || !Array.isArray(rec.windows)) continue;
    m.set(rec.probe, rec.windows as SeriesWindowPoint[]);
  }
  return m;
}

// ── Detail aggregation ──────────────────────────────────────────────────────

/**
 * Aggregate flat hits per session: title · k hits · latest HH:MM.
 * Order: most hits first, then most recent latestTs.
 */
export function aggregateHitsBySession(
  hits: readonly ProbeHit[],
  titleById?: ReadonlyMap<string, string>,
): SessionHitAgg[] {
  const by = new Map<string, SessionHitAgg>();
  for (const h of hits) {
    const id = h.sessionId;
    const existing = by.get(id);
    if (!existing) {
      const raw = titleById?.get(id)?.trim() ?? '';
      const title = raw
        ? rewriteMachineTitle(raw.replace(/\s+/g, ' ').trim())
        : id.length > 12
          ? `${id.slice(0, 11)}\u2026`
          : id;
      by.set(id, {
        sessionId: id,
        title,
        hitCount: 1,
        latestTs: h.ts,
        firstHit: h,
      });
    } else {
      existing.hitCount += 1;
      if (h.ts && (!existing.latestTs || h.ts > existing.latestTs)) {
        existing.latestTs = h.ts;
      }
    }
  }
  return [...by.values()].sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    const ta = a.latestTs ?? '';
    const tb = b.latestTs ?? '';
    return tb.localeCompare(ta);
  });
}

/** One detail session row: `title · k hits · latest HH:MM`. */
export function formatSessionAggLine(
  agg: SessionHitAgg,
  selected: boolean,
  width?: number,
): string {
  const mark = selected ? '>' : ' ';
  const parts = [
    agg.title,
    `${agg.hitCount} hit${agg.hitCount === 1 ? '' : 's'}`,
  ];
  if (agg.latestTs) parts.push(`latest ${formatHitClock(agg.latestTs)}`);
  const line = `${mark}${parts.join(' · ')}`;
  if (width == null || width <= 0) return line;
  return padTruncate(line, width);
}

/** Category rows from probe `data.categories` when present. */
export function probeCategories(
  data: unknown,
): Array<{ category: string; count: number }> {
  if (!data || typeof data !== 'object') return [];
  const cats = (data as { categories?: unknown }).categories;
  if (!Array.isArray(cats)) return [];
  const out: Array<{ category: string; count: number }> = [];
  for (const c of cats) {
    if (!c || typeof c !== 'object') continue;
    const cat = (c as { category?: unknown }).category;
    const count = (c as { count?: unknown }).count;
    if (typeof cat === 'string' && typeof count === 'number') {
      out.push({ category: cat, count });
    }
  }
  return out;
}

/** Budget detail body slots from residual host height after fixed header rows. */
export function budgetDetailSlots(bodyH: number, fixedHeaderRows: number): number {
  const residual = Math.floor(bodyH - Math.max(0, fixedHeaderRows));
  if (residual <= 0) return 1;
  return residual;
}

function padRow(text: string, width: number): string {
  if (width <= 0) return '';
  const ellipsis = '\u2026';
  const s = text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}${ellipsis}`;
  return s.length >= width ? s.slice(0, width) : s.padEnd(width, ' ');
}

function emptyRow(width: number): string {
  return width > 0 ? ' '.repeat(width) : '';
}

/** Opaque fixed-height list row — background fill clears prior OpenTUI cells. */
function FixedClearRow({
  text,
  width,
  color,
}: {
  text: string;
  width: number;
  color: RGBA;
}) {
  const t = usePalette();
  const cell = text.length === width ? text : padRow(text, width);
  return (
    <box
      height={1}
      width={width}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={t.background}
    >
      <text fg={color} wrapMode="none">
        {cell}
      </text>
    </box>
  );
}

/** Soft title cap when width unknown (tests / unbounded). When width known, derived. */
export const HIT_TITLE_SOFT_MAX = 48;
/** Reserve for mark + " · HH:MM" + " · " + minimal evidence tail. */
const HIT_FIXED_RESERVE = 32;

/** Truncate a label to maxLen with an ellipsis; no wrap. */
export function truncateHitLabel(text: string, maxLen: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(1, maxLen - 1))}…`;
}

/** Wall-clock HH:MM (UTC) from a hit timestamp — never full ISO. */
export function formatHitClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * One fixed hit row: >{title|id} · HH:MM · category · evidence.
 * Title leads when known (no parenthetical id); clock is HH:MM only.
 * Selection marker is a leading `>` (house list register).
 */
export function formatHitLine(
  h: ProbeHit,
  selected: boolean,
  titleById?: ReadonlyMap<string, string>,
  width?: number,
): string {
  const mark = selected ? '>' : ' ';
  const rawTitle = titleById?.get(h.sessionId)?.trim() ?? '';
  const rewritten = rawTitle
    ? rewriteMachineTitle(rawTitle.replace(/\s+/g, ' ').trim())
    : '';
  const idLabel =
    h.sessionId.length > 12
      ? `${h.sessionId.slice(0, 11)}\u2026`
      : h.sessionId;

  const w = width != null && width > 0 ? Math.floor(width) : undefined;
  const titleMax =
    w != null
      ? Math.max(20, Math.min(HIT_TITLE_SOFT_MAX, w - HIT_FIXED_RESERVE))
      : HIT_TITLE_SOFT_MAX;

  const label = rewritten ? truncateHitLabel(rewritten, titleMax) : idLabel;

  const parts: string[] = [label];
  if (h.ts) parts.push(formatHitClock(h.ts));
  const cat = (h.category ?? '').replace(/\s+/g, ' ').trim();
  if (cat) parts.push(cat);
  const evidence = (h.evidence ?? '').replace(/\s+/g, ' ').trim();
  if (evidence) parts.push(evidence);

  return `${mark}${parts.join(' · ')}`;
}

/**
 * Probe card body line — summary / value only.
 * Never restates the probe slug (title bar) or hits count (title-bar right).
 */
export function probeCardBody(row: ScanRow): string {
  return (
    row.summary ??
    `${formatProbeValue(row.value, row.unit)} · n=${row.n}${
      row.partial ? ' · partial' : ''
    }`
  );
}

function errorCopy(err: ProbesError): { title: string; lines: string[] } {
  if (err.kind === 'not-installed') {
    return {
      title: 'speculum not installed',
      lines: [
        'Probe board needs the speculum CLI on PATH (or SPECULUM_BIN).',
        `Install with: ${INSTALL_RECIPE}`,
        'r to retry after install',
      ],
    };
  }
  const msg = err.message ?? '';
  const tail = err.stderrTail?.trim() || err.stdoutTail?.trim() || '';
  if (/not found|no such|missing|ENOENT|no index|no corpus/i.test(`${msg} ${tail}`)) {
    return {
      title: 'index missing',
      lines: [
        'No derived session index found for scan.',
        "run 'speculum ingest'",
        'r to retry',
      ],
    };
  }
  if (/schema|version|unsupported/i.test(`${msg} ${tail}`)) {
    return {
      title: 'schema mismatch',
      lines: [
        'Index schema is not supported by this scan path.',
        'Upgrade the dash or re-ingest with a matching speculum CLI.',
        'r to retry',
      ],
    };
  }
  if (/busy|locked|database is locked|SQLITE_BUSY/i.test(`${msg} ${tail}`)) {
    return {
      title: 'corpus busy',
      lines: ['Session index is locked (ingest in progress).', 'Wait, then r to retry.'],
    };
  }
  const lines = [
    `${err.kind}: ${err.message}`,
    ...(tail ? [tail.slice(-200)] : []),
    'r to retry',
  ];
  return { title: `scan ${err.kind}`, lines };
}

/** Wrap methodology copy into fixed-width lines (plain text, no markdown). */
export function wrapPlainLines(text: string, width: number, maxLines = 6): string[] {
  const w = Math.max(8, Math.floor(width));
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    if (!word) continue;
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= w) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = word.length > w ? word.slice(0, w) : word;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === 0) lines.push('');
  return lines;
}

export function ProbesStage({
  inputActive,
  onFlash,
  onOpenSession,
  onLensSession,
  stageBox: stageBoxProp,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  onOpenSession?: (
    sessionId: string,
    opts?: { eventId?: string | number; ts?: string },
  ) => void;
  /** Hand a session to the lens picker (preselects it in the actions surface). */
  onLensSession?: (sessionId: string) => void;
  /** Residual host box from SessionsMember; optional for isolated stage smokes. */
  stageBox?: MeasuredSize;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const stageBox = stageBoxProp ?? seedStageBox(dims.width, dims.height);
  const [rows, setRows] = useState<ScanRow[] | null>(null);
  const [error, setError] = useState<ProbesError | null>(null);
  const [loading, setLoading] = useState(true);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesByProbe, setSeriesByProbe] = useState<ReadonlyMap<
    string,
    SeriesWindowPoint[]
  > | null>(null);
  const [scope, setScope] = useState<ProbeScope>('all');
  const [cursor, setCursor] = useState(0);
  const [hitsOpen, setHitsOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [hitCursor, setHitCursor] = useState(0);
  const [hitScroll, setHitScroll] = useState(0);
  const [detailCursor, setDetailCursor] = useState(0);
  const [detailScroll, setDetailScroll] = useState(0);
  const [rowScroll, setRowScroll] = useState(0);
  /** id → title map for hit rows (readonly index read at drill/detail open). */
  const [titleById, setTitleById] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const onOpenRef = useRef(onOpenSession);
  onOpenRef.current = onOpenSession;
  const onLensRef = useRef(onLensSession);
  onLensRef.current = onLensSession;
  const loadGenRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Cheap readonly title map when drill or detail opens.
  useEffect(() => {
    if (!hitsOpen && !detailOpen) return;
    try {
      const qs = openQueryService();
      try {
        const list = qs.sessionList(10_000, 0);
        const m = new Map<string, string>();
        for (const s of list) {
          if (s.title) m.set(s.id, s.title);
        }
        if (aliveRef.current) setTitleById(m);
      } finally {
        qs.close();
      }
    } catch {
      if (aliveRef.current) setTitleById(new Map());
    }
  }, [hitsOpen, detailOpen]);

  const load = useCallback(async (activeScope: ProbeScope) => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setSeriesLoading(true);

    const since = scopeSinceIso(activeScope);
    const scanArgs = ['--json'];
    if (since) {
      scanArgs.push('--since', since);
    }

    const seriesNames = seriesProbeList();
    const seriesArgs = [
      '--series',
      'weekly',
      '--windows',
      '12',
      '--probe',
      seriesNames.join(','),
      '--json',
    ];

    const scanP = runSpeculum<ScanRow[]>('scan', scanArgs);
    const seriesP = runSpeculum<ProbeSeriesResult[]>('scan', seriesArgs, {
      timeoutMs: 60_000,
    });

    const scanR = await scanP;
    if (!aliveRef.current || gen !== loadGenRef.current) return;

    if (scanR.ok) {
      const data = Array.isArray(scanR.json) ? scanR.json : [];
      setRows(data);
      setError(null);
      setCursor((c) => Math.min(c, Math.max(0, data.length - 1)));
      setHitsOpen(false);
      setDetailOpen(false);
      setHitCursor(0);
      setHitScroll(0);
      setDetailCursor(0);
      setDetailScroll(0);
      onFlashRef.current?.('scan updated');
    } else {
      setRows(null);
      setError(scanR.error);
      onFlashRef.current?.(`scan failed: ${scanR.error.message}`);
    }
    setLoading(false);

    // Series is independent — failure never blocks the board.
    try {
      const seriesR = await seriesP;
      if (!aliveRef.current || gen !== loadGenRef.current) return;
      if (seriesR.ok) {
        setSeriesByProbe(parseSeriesMap(seriesR.json));
      } else {
        setSeriesByProbe(null);
      }
    } catch {
      if (aliveRef.current && gen === loadGenRef.current) setSeriesByProbe(null);
    }
    if (aliveRef.current && gen === loadGenRef.current) setSeriesLoading(false);
  }, []);

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  useRefreshOnActive(inputActive, () => {
    void load(scope);
  });

  const list = rows ?? [];
  const board = useMemo(() => buildProbeBoard(list), [list]);
  const selectedItem = board[Math.min(cursor, Math.max(0, board.length - 1))] ?? null;
  const selectedRow =
    selectedItem?.kind === 'probe' ? selectedItem.row : null;
  const hits = selectedRow?.hits ?? [];
  const sessionAggs = useMemo(
    () => (selectedRow ? aggregateHitsBySession(hits, titleById) : []),
    [selectedRow, hits, titleById],
  );

  const hasAnySeries = useMemo(() => {
    if (!seriesByProbe || seriesByProbe.size === 0) return false;
    for (const item of board) {
      if (item.kind === 'probe' && seriesByProbe.has(item.row.probe)) return true;
    }
    return false;
  }, [seriesByProbe, board]);
  const cardRowH = hasAnySeries ? CARD_ROW_H_SERIES : CARD_ROW_H;

  // Width from residual host (stage pad L/R charged locally).
  const rowW = Math.max(16, stageBox.width - 4);
  const minCard = probeMinCardWidth(rowW, GRID_GAP);
  const perRow = Math.min(2, cardsPerRow(rowW, minCard, GRID_GAP));
  // Budget grid rows + hit slots from residual host height.
  // Detail overlay owns the full body when open (no grid/hits charge).
  const bodyH = Math.max(1, stageBox.height - PROBES_STAGE_CHROME);
  const overlayOpen = hitsOpen || detailOpen;
  const visibleRows = budgetProbeVisibleRows(bodyH, overlayOpen, cardRowH);
  const filledGridRows =
    hitsOpen || detailOpen
      ? Math.max(
          1,
          Math.min(
            visibleRows,
            Math.max(1, Math.ceil(board.length / Math.max(1, perRow))),
          ),
        )
      : visibleRows;
  const gridRowsH = filledGridRows * cardRowH;
  let hitSlots = hitsOpen ? budgetHitSlots(bodyH, gridRowsH, 1) : 1;
  if (hitsOpen) {
    const maxHits = Math.max(1, bodyH - gridRowsH - 1);
    hitSlots = Math.min(hitSlots, maxHits);
  }

  // Detail overlay: methodology (~3) + facts (1) + cats header+rows + sessions header.
  const detailCats = selectedRow ? probeCategories(selectedRow.data) : [];
  const methodLines = selectedRow
    ? wrapPlainLines(probeMethodology(selectedRow.probe), rowW, 4)
    : [];
  const detailFixed =
    1 /* title facts */ +
    methodLines.length +
    (detailCats.length > 0 ? 1 + Math.min(detailCats.length, 4) : 0) +
    1; /* sessions header */
  const detailSlots = detailOpen ? budgetDetailSlots(bodyH, detailFixed) : 1;

  useEffect(() => {
    if (cursor >= board.length) setCursor(Math.max(0, board.length - 1));
  }, [board.length, cursor]);

  useEffect(() => {
    setRowScroll((s) => clampRowScroll(cursor, s, visibleRows, perRow));
  }, [cursor, visibleRows, perRow]);

  useEffect(() => {
    setHitCursor(0);
    setHitScroll(0);
    setDetailCursor(0);
    setDetailScroll(0);
  }, [cursor]);

  useEffect(() => {
    if (!hitsOpen) return;
    setHitScroll((s) => clampHitScroll(hitCursor, s, hitSlots, hits.length));
  }, [hitsOpen, hitCursor, hitSlots, hits.length]);

  useEffect(() => {
    if (!detailOpen) return;
    setDetailScroll((s) =>
      clampHitScroll(detailCursor, s, detailSlots, sessionAggs.length),
    );
  }, [detailOpen, detailCursor, detailSlots, sessionAggs.length]);

  const openSelectedHit = useCallback(() => {
    const h = hits[hitCursor];
    if (!h) {
      onFlashRef.current?.('hits (none)');
      return;
    }
    const eid = hitEventId(h);
    onOpenRef.current?.(h.sessionId, {
      eventId: eid,
      ts: h.ts,
    });
    onFlashRef.current?.(
      eid != null ? `open ${h.sessionId.slice(0, 12)} #${eid}` : `open ${h.sessionId.slice(0, 12)}`,
    );
  }, [hits, hitCursor]);

  const openSelectedAgg = useCallback(() => {
    const a = sessionAggs[detailCursor];
    if (!a) {
      onFlashRef.current?.('sessions (none)');
      return;
    }
    const h = a.firstHit;
    const eid = hitEventId(h);
    onOpenRef.current?.(h.sessionId, {
      eventId: eid,
      ts: h.ts,
    });
    onFlashRef.current?.(
      eid != null ? `open ${h.sessionId.slice(0, 12)} #${eid}` : `open ${h.sessionId.slice(0, 12)}`,
    );
  }, [sessionAggs, detailCursor]);

  const handoffLens = useCallback((sessionId: string) => {
    if (!onLensRef.current) {
      onFlashRef.current?.('lens handoff unavailable');
      return;
    }
    onLensRef.current(sessionId);
    onFlashRef.current?.(`lens ← ${sessionId.slice(0, 12)}`);
  }, []);

  useKeyboard((key: { name?: string; sequence?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    const seq = key.sequence ?? '';
    if (n === 'r') {
      void load(scope);
      return;
    }
    if (error || !rows) return;

    // Detail overlay owns keys while open.
    if (detailOpen) {
      if (n === 'escape' || n === 'h') {
        setDetailOpen(false);
        return;
      }
      if (n === 'up') {
        setDetailCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (n === 'down') {
        setDetailCursor((c) =>
          Math.min(Math.max(0, sessionAggs.length - 1), c + 1),
        );
        return;
      }
      if (n === 'return' || n === 'enter') {
        if (sessionAggs.length === 0) {
          onFlashRef.current?.('sessions (none)');
          return;
        }
        openSelectedAgg();
        return;
      }
      if (n === 'l') {
        const a = sessionAggs[detailCursor];
        if (!a) {
          onFlashRef.current?.('lens (no session)');
          return;
        }
        handoffLens(a.sessionId);
        return;
      }
      return;
    }

    if (hitsOpen) {
      if (n === 'escape' || n === 'h') {
        setHitsOpen(false);
        return;
      }
      if (n === 'up') {
        setHitCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (n === 'down') {
        setHitCursor((c) => Math.min(Math.max(0, hits.length - 1), c + 1));
        return;
      }
      if (n === 'return' || n === 'enter') {
        if (hits.length === 0) {
          onFlashRef.current?.('hits (none)');
          return;
        }
        openSelectedHit();
        return;
      }
      if (n === 'l') {
        const h = hits[hitCursor];
        if (!h) {
          onFlashRef.current?.('lens (no session)');
          return;
        }
        handoffLens(h.sessionId);
        return;
      }
      return;
    }

    // Board keys.
    if (n === '[' || n === 'leftbracket' || seq === '[') {
      setScope((s) => cycleProbeScope(s, -1));
      return;
    }
    if (n === ']' || n === 'rightbracket' || seq === ']') {
      setScope((s) => cycleProbeScope(s, 1));
      return;
    }
    if (n === 'up') {
      setCursor((c) => moveProbeCursor(c, 'up', board.length, perRow));
      return;
    }
    if (n === 'down') {
      setCursor((c) => moveProbeCursor(c, 'down', board.length, perRow));
      return;
    }
    if (n === 'left') {
      setCursor((c) => moveProbeCursor(c, 'left', board.length, perRow));
      return;
    }
    if (n === 'right') {
      setCursor((c) => moveProbeCursor(c, 'right', board.length, perRow));
      return;
    }
    if (n === 'd') {
      if (!selectedRow) {
        onFlashRef.current?.('detail (pick a probe)');
        return;
      }
      setDetailOpen(true);
      setHitsOpen(false);
      setDetailCursor(0);
      setDetailScroll(0);
      return;
    }
    if (n === 'return' || n === 'enter' || n === 'h') {
      if (!selectedRow) {
        onFlashRef.current?.('hits (no-signal)');
        return;
      }
      setHitsOpen(true);
      setDetailOpen(false);
      setHitCursor(0);
      setHitScroll(0);
      return;
    }
  });

  const range = probeVisibleRange(board.length, rowScroll, visibleRows, perRow);
  const gridStart = Math.max(0, (range.first || 1) - 1);
  const gridEnd = range.last;
  const visibleBoard = board.slice(gridStart, gridEnd);
  const cardW = cardWidthForRow(
    rowW,
    Math.min(perRow, Math.max(1, visibleBoard.length || 1)),
    GRID_GAP,
  );
  const innerW = cardInnerWidth(cardW);

  const scopeRowEl = (
    <box flexDirection="row" height={1} flexShrink={0} overflow="hidden" width={rowW}>
      {PROBE_SCOPES.map((s, i) => {
        const active = s === scope;
        const label = i === 0 ? s : ` · ${s}`;
        return (
          <text
            key={s}
            fg={active ? t.info : t.muted}
            wrapMode="none"
            onMouseDown={() => setScope(s)}
          >
            {active ? label.toUpperCase() : label}
          </text>
        );
      })}
    </box>
  );

  const body = useMemo(() => {
    if (loading && !rows && !error) {
      return (
        <box flexDirection="column" flexShrink={0}>
          {scopeRowEl}
          <FixedClearRow width={rowW} color={t.muted} text={padRow('loading scan…', rowW)} />
        </box>
      );
    }
    if (error) {
      const copy = errorCopy(error);
      return (
        <box flexDirection="column" flexShrink={0}>
          {scopeRowEl}
          {copy.lines.map((line, i) => (
            <FixedClearRow
              key={`e-${i}`}
              width={rowW}
              color={i === 0 ? t.error : t.muted}
              text={padRow(line, rowW)}
            />
          ))}
        </box>
      );
    }
    if (list.length === 0) {
      return (
        <box flexDirection="column" flexShrink={0}>
          {scopeRowEl}
          <FixedClearRow width={rowW} color={t.muted} text={padRow('no probes returned', rowW)} />
        </box>
      );
    }

    // ── Detail overlay (keep-mounted via always-present branch + visible) ──
    if (detailOpen && selectedRow) {
      const facts = `${formatProbeValue(selectedRow.value, selectedRow.unit)} · ${formatWilsonRange(selectedRow.ciLow, selectedRow.ciHigh)} · n=${selectedRow.n}${selectedRow.partial ? ' · partial' : ''}`;
      const cats = detailCats.slice(0, 4);
      return (
        <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
          {scopeRowEl}
          <FixedClearRow
            width={rowW}
            color={t.info}
            text={padRow(`detail · ${selectedRow.probe}`, rowW)}
          />
          {methodLines.map((line, i) => (
            <FixedClearRow
              key={`m-${i}`}
              width={rowW}
              color={t.muted}
              text={padRow(line, rowW)}
            />
          ))}
          <FixedClearRow width={rowW} color={t.foreground} text={padRow(facts, rowW)} />
          {cats.length > 0 ? (
            <>
              <FixedClearRow
                width={rowW}
                color={t.muted}
                text={padRow('categories', rowW)}
              />
              {cats.map((c, i) => (
                <FixedClearRow
                  key={`c-${i}`}
                  width={rowW}
                  color={t.foreground}
                  text={padRow(`  ${c.category}  ${c.count}`, rowW)}
                />
              ))}
            </>
          ) : null}
          <FixedClearRow
            width={rowW}
            color={t.muted}
            text={padRow(
              sessionAggs.length > 0
                ? `sessions (${sessionAggs.length}) · enter open · L lens`
                : 'sessions (none)',
              rowW,
            )}
          />
          {Array.from({ length: detailSlots }, (_, slot) => {
            const absIdx = detailScroll + slot;
            const a = sessionAggs[absIdx];
            if (!a) {
              return (
                <FixedClearRow
                  key={`d-slot-${slot}`}
                  width={rowW}
                  color={t.muted}
                  text={emptyRow(rowW)}
                />
              );
            }
            const sel = absIdx === detailCursor;
            return (
              <FixedClearRow
                key={`d-slot-${slot}`}
                width={rowW}
                color={sel ? t.info : t.foreground}
                text={padRow(formatSessionAggLine(a, sel, rowW), rowW)}
              />
            );
          })}
        </box>
      );
    }

    const rangeLabel =
      board.length === 0
        ? 'probes 0 of 0'
        : `probes ${range.first}–${range.last} of ${board.length}`;

    return (
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        {scopeRowEl}
        <FixedClearRow
          width={rowW}
          color={t.muted}
          text={padRow(`${rangeLabel} · ↑↓←→ select · enter drill · d detail`, rowW)}
        />
        <CardGrid width={rowW} minCardWidth={minCard} gap={GRID_GAP}>
          {visibleBoard.map((item, i) => {
            const absIdx = gridStart + i;
            const isSel = absIdx === cursor;
            if (item.kind === 'degenerate') {
              return (
                <Card
                  key={`deg-${absIdx}`}
                  title="no-signal"
                  right={`${item.names.length}`}
                  selected={isSel}
                  width={cardW}
                  marginBottom={1}
                  onMouseDown={() => {
                    setCursor(absIdx);
                    setHitsOpen(false);
                    setDetailOpen(false);
                  }}
                >
                  <box height={1} flexShrink={0} overflow="hidden">
                    <text fg={t.muted} wrapMode="none">
                      {padTruncate(formatDegenerateBody(item.names, innerW), innerW)}
                    </text>
                  </box>
                </Card>
              );
            }
            const row = item.row;
            const hitN = row.hits?.length ?? 0;
            const bodyLine = probeCardBody(row);
            const seriesWins = seriesByProbe?.get(row.probe);
            const seriesLine =
              seriesWins && seriesWins.length > 0
                ? formatSeriesLine(seriesWins, innerW)
                : null;
            return (
              <Card
                key={`p-${row.probe}-${absIdx}`}
                title={row.probe}
                right={probeCardRight(row)}
                selected={isSel}
                width={cardW}
                marginBottom={1}
                onMouseDown={() => {
                  setCursor(absIdx);
                  setHitsOpen(false);
                  setDetailOpen(false);
                }}
              >
                <box height={1} flexShrink={0} overflow="hidden">
                  <text fg={hitN > 0 ? t.warning : t.muted} wrapMode="none">
                    {padTruncate(bodyLine, innerW)}
                  </text>
                </box>
                {seriesLine ? (
                  <box height={1} flexShrink={0} overflow="hidden">
                    <text fg={t.muted} wrapMode="none">
                      {padTruncate(seriesLine, innerW)}
                    </text>
                  </box>
                ) : null}
              </Card>
            );
          })}
        </CardGrid>

        {hitsOpen && selectedRow ? (
          <box flexDirection="column" flexShrink={0} marginTop={0} overflow="hidden">
            <FixedClearRow
              width={rowW}
              color={t.muted}
              text={padRow(
                hits.length > 0
                  ? `hits (${hits.length}) for ${selectedRow.probe}`
                  : `hits (none) for ${selectedRow.probe}`,
                rowW,
              )}
            />
            {Array.from({ length: hitSlots }, (_, slot) => {
              const absIdx = hitScroll + slot;
              const h = hits[absIdx];
              if (!h) {
                return (
                  <FixedClearRow
                    key={`h-slot-${slot}`}
                    width={rowW}
                    color={t.muted}
                    text={emptyRow(rowW)}
                  />
                );
              }
              const selHit = absIdx === hitCursor;
              return (
                <FixedClearRow
                  key={`h-slot-${slot}`}
                  width={rowW}
                  color={selHit ? t.info : t.foreground}
                  text={padRow(
                    formatHitLine(h, selHit, titleById, rowW),
                    rowW,
                  )}
                />
              );
            })}
          </box>
        ) : null}
      </box>
    );
  }, [
    loading,
    rows,
    error,
    rowW,
    minCard,
    t,
    list.length,
    range.first,
    range.last,
    visibleBoard,
    gridStart,
    cursor,
    cardW,
    innerW,
    hitsOpen,
    detailOpen,
    selectedRow,
    hits,
    hitCursor,
    hitScroll,
    hitSlots,
    titleById,
    board.length,
    seriesByProbe,
    seriesLoading,
    scope,
    sessionAggs,
    detailCursor,
    detailScroll,
    detailSlots,
    detailCats,
    methodLines,
    scopeRowEl,
  ]);

  // Keep-mounted empty detail host when closed so the branch identity is stable.
  // (Detail content is painted inside `body` when detailOpen — one surface.)
  void detailOpen;

  const headerRight = error
    ? error.kind
    : loading && !rows
      ? 'loading'
      : seriesLoading
        ? `${board.length} probes …`
        : board.length > 0
          ? `${board.length} probes`
          : 'empty';

  const footer = error
    ? `r retry · ${error.kind}`
    : detailOpen
      ? sessionAggs.length > 0
        ? '↑↓ session · enter open · L lens · h/esc close · r refresh'
        : 'sessions (none) · h/esc close · r refresh'
      : hitsOpen
        ? hits.length > 0
          ? '↑↓ hit · enter open session · L lens · h/esc close · r refresh'
          : 'hits (none) · h/esc close · r refresh'
        : '↑↓←→ select · enter/h drill · d detail · [ ] window · r refresh';

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      backgroundColor={t.background}
    >
      <Panel
        title="Probes"
        headerRight={headerRight}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        active={!!inputActive}
      >
        {body}
      </Panel>
      <box
        flexDirection="row"
        flexShrink={0}
        height={1}
        overflow="hidden"
        backgroundColor={t.background}
      >
        <text fg={t.muted} wrapMode="none">
          {padRow(footer, Math.max(16, stageBox.width - 2))}
        </text>
      </box>
    </box>
  );
}
