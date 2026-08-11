/**
 * Microscope stage — session picker + kind-colored turn timeline.
 * Reads the derived index through openQueryService (readonly); never writes.
 *
 * Two-pane craft: fixed-slot lists grow by measured height; picker pages the
 * full corpus with filter chips and title search; bordered Cards carry
 * titleColor chrome; empty-timeline prompt lives in the session header only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { Panel } from '../components/Panel';
import { useStableDimensions } from '../use-stable-dimensions';
import type { MeasuredSize } from '../use-measured-size';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { Card, CARD_CHROME } from './Card';
import { TurnDetail, TURN_DETAIL_FOOTER } from './TurnDetail';
import {
  MIN_SESSION_SLOTS as LAYOUT_MIN_SESSION_SLOTS,
  MIN_TURN_SLOTS as LAYOUT_MIN_TURN_SLOTS,
  seedStageBox,
} from './sessions-layout';
import {
  openQueryService,
  SUPPORTED_SCHEMA_VERSIONS,
  type QueryService,
  type SearchHit,
  type SessionListOpts,
  type SessionListRow,
  type SessionSort,
  type TurnRow,
} from './query-service';
import { rewriteMachineTitle } from '../render/graph';

export type MicroscopeJump = {
  sessionId: string;
  eventId?: string | number;
  ts?: string;
};

/** Terminal width below this stacks picker over timeline (chunked; not flexWrap). */
export const STACK_BELOW_COLS = 100;
/** Share of content width for the picker when side-by-side. */
export const PICKER_SHARE = 0.42;
/** Outer picker floor — titles need this much. */
export const PICKER_MIN_OUTER = 48;
/** Outer picker ceiling — leave timeline room on very wide terminals. */
export const PICKER_MAX_OUTER = 64;
/** Timeline outer floor when two-pane. */
export const TIMELINE_MIN_OUTER = 36;
const PANE_GAP = 1;
/** Stage pad L/R only — nest width already removed by residual host. */
const STAGE_PAD_COLS = 2;
/** Panel border (2) + panel pad (2) — charged so card outers fit the panel body. */
const PANEL_CHROME_COLS = 4;

/**
 * Local stage chrome charged against residual host height:
 * padTop 1 + panel border/title 3 + stage footer 1 = 5.
 */
export const MICRO_STAGE_CHROME = 5;
/** Session-info rows above the turn stream (title + facts, or empty prompt). */
export const TIMELINE_INFO_ROWS = 2;
export const MIN_SESSION_SLOTS = LAYOUT_MIN_SESSION_SLOTS;
export const MIN_TURN_SLOTS = LAYOUT_MIN_TURN_SLOTS;
/** Prior fixed floors — used as fallbacks before first measure. */
export const DEFAULT_SESSION_SLOTS = 8;
export const DEFAULT_TURN_SLOTS = 12;

const EMPTY_INDEX_COPY = "no speculum index — run 'speculum ingest'";
const EMPTY_CORPUS_COPY = "no ingested sessions — run 'speculum ingest'";
const EMPTY_TIMELINE_PROMPT = 'enter a session to open its timeline';
const NO_EVENTS_COPY = 'no events in session';

/** Max rows to scan when resolving a single session (jump / parent). */
const SESSION_RESOLVE_CAP = 5000;
/** Cap when client-filtering children of a primary (no parent filter on list API). */
const CHILDREN_FETCH_CAP = 5000;

type SoftMode =
  | 'loading'
  | 'missing'
  | 'schema'
  | 'busy'
  | 'empty'
  | 'ready';

type ViewMode = 'picker' | 'timeline';

/** Class filter chip values (maps to cwd_class exact match). */
export type ClassFilter = 'all' | 'op' | 'exp' | 'har';
/** Agent filter chip values (maps to sessions.agent). */
export type AgentFilter = 'all' | 'prim' | 'sub';
/** Time-window chip values. */
export type WinFilter = 'all' | '7d' | '30d';

export const CLASS_CYCLE: ClassFilter[] = ['all', 'op', 'exp', 'har'];
export const AGENT_CYCLE: AgentFilter[] = ['all', 'prim', 'sub'];
export const WIN_CYCLE: WinFilter[] = ['all', '7d', '30d'];
export const SORT_CYCLE: SessionSort[] = ['recent', 'turns', 'errors'];

type FilterSnapshot = {
  classF: ClassFilter;
  agentF: AgentFilter;
  winF: WinFilter;
  sortF: SessionSort;
  titleFilter: string;
  pageOffset: number;
  sessionCursor: number;
};

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Relative age: Xm ago / Xh ago / Xd ago (or `?` when unparseable). */
export function relAge(iso: string, now = Date.now()): string {
  if (!iso) return '?';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '?';
  const ms = Math.max(0, now - ts);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Wall-clock HH:MM (UTC) from an event timestamp. */
export function formatEventTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Project path → basename (works for / and \\ separators). */
export function projectBasename(p: string): string {
  if (!p) return '?';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * Kind → palette semantic color.
 * user=primary · assistant=foreground · tool_use/usage/plan/task=info ·
 * tool_result/system=muted · tool_error (or toolError flag)=error · default=muted
 */
export function kindColor(kind: string, t: Palette, toolError?: number | null): RGBA {
  if (toolError || kind === 'tool_error') return t.error;
  switch (kind) {
    case 'user':
      return t.primary;
    case 'assistant':
      return t.foreground;
    case 'tool_use':
    case 'usage':
    case 'plan':
    case 'task':
      return t.info;
    case 'tool_result':
    case 'system':
      return t.muted;
    default:
      return t.muted;
  }
}

/** Windows drive path or UNC-ish segment; replace match with basename. */
const WIN_ABS =
  /(?:[A-Za-z]:|\\\\)[^\\/:*?"<>|\r\n]*(?:\\[^\\/:*?"<>|\r\n]*)+/g;
/** Posix absolute paths with ≥2 segments. */
const POSIX_ABS = /(?:\/[\w.+@-]+){2,}/g;

/** Path → final path segment (works for / and \\ separators). */
export function fileBasename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Absolute paths → basenames; relative prose untouched. */
export function collapseAbsolutePaths(text: string): string {
  return text
    .replace(WIN_ABS, (m) => fileBasename(m))
    .replace(POSIX_ABS, (m) => fileBasename(m));
}

/**
 * Truncated summary body for a turn row (no pad).
 * Tool rows collapse absolute paths to basenames unless fullPaths is set.
 */
export function rowText(turn: TurnRow, opts?: { fullPaths?: boolean }): string {
  const isErr = !!(turn.toolError || turn.kind === 'tool_error');
  const collapse = (s: string) => (opts?.fullPaths ? s : collapseAbsolutePaths(s));
  if (isErr) {
    const tail = collapse((turn.text ?? '').trim().replace(/\s+/g, ' '));
    const name = turn.toolName?.trim() || '';
    if (name && tail) return `${name}: ${tail}`;
    return name || tail || 'error';
  }
  if (turn.kind === 'tool_use' || turn.kind === 'tool_result') {
    const name = turn.toolName?.trim() || turn.kind;
    const extra = collapse((turn.text ?? '').trim().replace(/\s+/g, ' '));
    return extra ? `${name} ${extra}` : name;
  }
  return (turn.text ?? '').trim().replace(/\s+/g, ' ') || turn.kind;
}

/** Short session id prefix for chrome (ellipsis after 12). */
export function shortSessionId(id: string): string {
  if (!id) return '?';
  return id.length > 12 ? `${id.slice(0, 11)}\u2026` : id;
}

/** Machine-title rewrite for picker/header labels (distinctive part first). */
export function sessionPickerLabel(title: string): string {
  return rewriteMachineTitle(title.replace(/\s+/g, ' ').trim());
}

/** Whether a row is a subagent (parent_session set or agent flag). */
export function isSubagentRow(s: SessionListRow): boolean {
  if ((s.parentSession ?? '').trim()) return true;
  return (s.agent ?? '').trim() === 'subagent';
}

/** Class glyph for picker rows (single cell). */
export function classGlyph(cwdClass: string): string {
  switch ((cwdClass ?? '').trim()) {
    case 'operator':
      return 'O';
    case 'experiment':
      return 'E';
    case 'harness':
      return 'H';
    case 'unknown':
      return '?';
    default:
      return (cwdClass ?? '').trim() ? '?' : '·';
  }
}

/** Agent glyph: P primary, S subagent. */
export function agentGlyph(s: SessionListRow): string {
  return isSubagentRow(s) ? 'S' : 'P';
}

/** Title when present (rewritten); else description (subagents); else id prefix. */
export function sessionDisplayTitle(s: SessionListRow): string {
  const title = (s.title ?? '').replace(/\s+/g, ' ').trim();
  if (title) return sessionPickerLabel(title);
  const desc = (s.description ?? '').replace(/\s+/g, ' ').trim();
  if (desc) return sessionPickerLabel(desc);
  return shortSessionId(s.id);
}

/**
 * Two-pane geometry from residual host width.
 * Wide (host + member pad ≥ STACK_BELOW_COLS): picker takes a flex share with a
 * hard min/max so real titles fit; timeline gets the rest. Narrow: both panes
 * use full content width (stacked column). Content width charges stage pad only
 * — nest width is already off the host.
 */
export function paneGeometry(hostWidth: number): {
  twoPane: boolean;
  contentW: number;
  pickerW: number;
  timelineW: number;
} {
  // Stage pad + Panel border/pad so card outers never exceed the panel body
  // (otherwise flex-shrink clips fixed-width turn rows and eats trailing #id).
  const contentW = Math.max(
    16,
    Math.floor(hostWidth) - STAGE_PAD_COLS - PANEL_CHROME_COLS,
  );
  // Stack threshold was terminal 100; host is terminal minus member pad (2).
  const twoPane = Math.floor(hostWidth) + sessionsMemberPadApprox() >= STACK_BELOW_COLS;
  if (!twoPane) {
    return { twoPane: false, contentW, pickerW: contentW, timelineW: contentW };
  }
  const raw = Math.floor(contentW * PICKER_SHARE);
  const maxAllowed = Math.min(
    PICKER_MAX_OUTER,
    Math.max(PICKER_MIN_OUTER, contentW - TIMELINE_MIN_OUTER - PANE_GAP),
  );
  const pickerW = Math.min(maxAllowed, Math.max(PICKER_MIN_OUTER, raw));
  const timelineW = contentW - pickerW - PANE_GAP;
  return { twoPane: true, contentW, pickerW, timelineW };
}

/** Member pad cols (matches sessions-layout; inlined to avoid circular export noise). */
function sessionsMemberPadApprox(): number {
  return 2;
}

/**
 * Vertical chrome a bordered titled Card spends outside content rows
 * (top border + title row + bottom border). Charged against listHost when
 * budgeting fixed slots so the painted stack cannot exceed the host.
 */
export const CARD_V_CHROME = 3;
/** Gap row between stacked Sessions and Timeline cards. */
export const STACK_GAP = 1;

/**
 * Picker / timeline slot counts from list-host residual height
 * (stageBox.height − MICRO_STAGE_CHROME). Pure fit-clamp: never force a
 * MIN_* floor that would overflow the host (card chrome + info rows count).
 */
/** Stacked list-host overhead (card chrome ×2 + optional gap + timeline info). */
function stackedOverhead(listHostH: number): number {
  const h = Math.max(0, Math.floor(listHostH));
  // Drop the inter-card gap when the host cannot hold chrome + 2 content rows.
  const needWithGap = 2 * CARD_V_CHROME + STACK_GAP + TIMELINE_INFO_ROWS + 2;
  const gap = h >= needWithGap ? STACK_GAP : 0;
  return 2 * CARD_V_CHROME + gap + TIMELINE_INFO_ROWS;
}

export function budgetSessionSlots(listHostH: number, twoPane: boolean): number {
  const h = Math.max(0, Math.floor(listHostH));
  if (twoPane) {
    // Content rows inside one Card: host − card chrome.
    return Math.max(1, h - CARD_V_CHROME);
  }
  // Stacked: two cards + gap + timeline info share the host.
  const available = Math.max(0, h - stackedOverhead(h));
  if (available <= 0) return 1;
  if (available === 1) return 1;
  // ~40% sessions, rest turns; both ≥1 and sum ≤ available.
  const s = Math.max(1, Math.floor(available * 0.4));
  return Math.min(s, available - 1);
}

export function budgetTurnSlots(
  listHostH: number,
  twoPane: boolean,
  sessionSlots?: number,
): number {
  const h = Math.max(0, Math.floor(listHostH));
  if (twoPane) {
    return Math.max(1, h - CARD_V_CHROME - TIMELINE_INFO_ROWS);
  }
  const available = Math.max(0, h - stackedOverhead(h));
  const ss = sessionSlots ?? budgetSessionSlots(h, false);
  if (available <= 0) return 1;
  if (available === 1) return Math.max(0, available - ss); // 0 when sessions took the only row
  return Math.max(1, available - ss);
}

/**
 * Session-info facts line (middot register). Title is separate — see
 * formatSessionTitleLine. Facets (class · agent_name/subagent_type · model ·
 * title_source) lead when present; operational project/age/turns/errors follow.
 */
export function formatSessionInfo(s: SessionListRow, now = Date.now()): string {
  const title = (s.title ?? '').replace(/\s+/g, ' ').trim();
  const id = shortSessionId(s.id);
  const proj = projectBasename(s.projectPath);
  const model = (s.modelId ?? '').trim();
  const age = relAge(s.startedAt, now);
  const parts: string[] = [];
  if (title) parts.push(id);
  const cls = (s.cwdClass ?? '').trim();
  if (cls) parts.push(cls);
  if (isSubagentRow(s)) {
    const st = (s.subagentType ?? '').trim();
    parts.push(st || 'subagent');
  } else {
    const an = (s.agentName ?? '').trim();
    if (an) parts.push(an);
  }
  parts.push(proj);
  if (model) parts.push(model);
  const tsrc = (s.titleSource ?? '').trim();
  if (tsrc) parts.push(tsrc);
  parts.push(age);
  parts.push(`${s.turnCount} turns`);
  parts.push(`${s.toolErrorCount} errors`);
  return parts.join(' · ');
}

/** Primary title line for the open-session header (title, else id prefix). */
export function formatSessionTitleLine(s: SessionListRow): string {
  return sessionDisplayTitle(s);
}

/**
 * One-row session picker line. Title leads; glyphs + meta drop under `width`.
 * Drop order when over budget: counts → age → glyphs (title head-slice last).
 * Subagent rows use description when title is empty.
 */
export function formatSessionLine(
  s: SessionListRow,
  selected: boolean,
  now = Date.now(),
  width?: number,
): string {
  const prefix = selected ? '>' : ' ';
  const label = sessionDisplayTitle(s);
  const glyphs = `${classGlyph(s.cwdClass ?? '')}${agentGlyph(s)}`;
  const age = relAge(s.startedAt, now);
  const counts = `t:${s.turnCount} e:${s.eventCount}`;

  // Full logical line when unconstrained.
  const full = `${prefix}${label} ${glyphs}  ${age}  ${counts}`;
  if (width == null || width <= 0) return full;

  const budget = Math.floor(width);
  const head = `${prefix}${label}`;
  if (head.length > budget) {
    return padRow(head, budget);
  }
  // Prefer fullest form that fits; drop counts, then age, then glyphs.
  const candidates = [
    `${head} ${glyphs}  ${age}  ${counts}`,
    `${head} ${glyphs}  ${age}`,
    `${head} ${glyphs}`,
    head,
  ];
  for (const c of candidates) {
    if (c.length <= budget) return c;
  }
  return padRow(head, budget);
}

/**
 * Full fixed-width turn timeline line (clock · kind · body · #<eventId>).
 * Kind is fixed-width for column alignment; kind color is applied by the row.
 * Tool bodies use basenames unless the row is selected and the full path fits.
 */
export function formatTurnLine(
  turn: TurnRow,
  selected: boolean,
  width?: number,
): string {
  const prefix = selected ? '>' : ' ';
  const clock = formatEventTs(turn.ts);
  const kind = (turn.kind || '?').slice(0, 11).padEnd(11);
  const idTag = `#${turn.eventId}`;
  const fixed =
    prefix.length + clock.length + 2 + kind.length + 1 + 2 + idTag.length;
  const bodyBudget =
    width != null && width > 0 ? Math.max(8, Math.floor(width) - fixed) : Infinity;

  const fullBody = rowText(turn, { fullPaths: true });
  const shortBody = rowText(turn, { fullPaths: false });
  let body =
    selected && fullBody.length <= bodyBudget ? fullBody : shortBody;
  // Clamp body so clock+kind+#id always fit the width (padRow must not eat the id).
  if (Number.isFinite(bodyBudget) && body.length > bodyBudget) {
    const ellipsis = '\u2026';
    body =
      bodyBudget <= 1
        ? ellipsis
        : `${body.slice(0, bodyBudget - 1)}${ellipsis}`;
  }

  return `${prefix}${clock}  ${kind} ${body}  ${idTag}`;
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

/** Content width inside a pane Card (border 2 + pad 2). */
export function paneInnerWidth(outerW: number): number {
  return Math.max(0, Math.floor(outerW) - CARD_CHROME);
}

/** Map UI class chip → sessionList cwdClass. */
export function classFilterToCwd(classF: ClassFilter): string | undefined {
  switch (classF) {
    case 'op':
      return 'operator';
    case 'exp':
      return 'experiment';
    case 'har':
      return 'harness';
    default:
      return undefined;
  }
}

/** Map UI agent chip → sessionList agent. */
export function agentFilterToAgent(agentF: AgentFilter): string | undefined {
  switch (agentF) {
    case 'prim':
      return 'primary';
    case 'sub':
      return 'subagent';
    default:
      return undefined;
  }
}

/** ISO lower bound for win chip (undefined = all). */
export function winFilterSince(winF: WinFilter, now = Date.now()): string | undefined {
  if (winF === '7d') return new Date(now - 7 * 86_400_000).toISOString();
  if (winF === '30d') return new Date(now - 30 * 86_400_000).toISOString();
  return undefined;
}

/** Build SessionListOpts from filter chips (limit/offset optional). */
export function buildListOpts(args: {
  classF: ClassFilter;
  agentF: AgentFilter;
  winF: WinFilter;
  sortF: SessionSort;
  titleFilter?: string;
  limit?: number;
  offset?: number;
  now?: number;
}): SessionListOpts {
  const opts: SessionListOpts = {
    sort: args.sortF,
  };
  const cwd = classFilterToCwd(args.classF);
  if (cwd) opts.cwdClass = cwd;
  const agent = agentFilterToAgent(args.agentF);
  if (agent) opts.agent = agent;
  const since = winFilterSince(args.winF, args.now);
  if (since) opts.since = since;
  const title = (args.titleFilter ?? '').trim();
  if (title) opts.title = title;
  if (args.limit != null) opts.limit = args.limit;
  if (args.offset != null) opts.offset = args.offset;
  return opts;
}

/** Cycle a chip value forward (or reverse when dir < 0). */
export function cycleChip<T>(cycle: readonly T[], current: T, dir = 1): T {
  const i = cycle.indexOf(current);
  const base = i < 0 ? 0 : i;
  const next = (base + (dir >= 0 ? 1 : -1) + cycle.length * 4) % cycle.length;
  return cycle[next]!;
}

/** N-of-M range label for the picker card right. */
export function pageRangeLabel(offset: number, pageLen: number, total: number): string {
  if (total <= 0) return '0–0 of 0';
  const first = pageLen <= 0 ? 0 : offset + 1;
  const last = offset + pageLen;
  return `${first}–${last} of ${total}`;
}

/** Compact sort label so the four-chip row fits picker min width (~44). */
export function sortChipLabel(sortF: SessionSort): string {
  return sortF === 'recent' ? 'rec' : sortF;
}

/** Filter chip row text (middot register). */
export function formatFilterRow(args: {
  classF: ClassFilter;
  agentF: AgentFilter;
  winF: WinFilter;
  sortF: SessionSort;
}): string {
  return `class:${args.classF} · agent:${args.agentF} · win:${args.winF} · sort:${sortChipLabel(args.sortF)}`;
}

function FixedClearRow({
  text,
  width,
  color,
  onMouseDown,
}: {
  text: string;
  width: number;
  color: RGBA;
  onMouseDown?: () => void;
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
      onMouseDown={onMouseDown}
    >
      <text fg={color} wrapMode="none">
        {cell}
      </text>
    </box>
  );
}

function isMissingIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /not found|ENOENT/i.test(msg);
}

function resolveSessionRow(
  svc: QueryService,
  sessionId: string,
  page: SessionListRow[],
): SessionListRow | null {
  const hit = page.find((s) => s.id === sessionId);
  if (hit) return hit;
  const scan = svc.sessionList({ limit: SESSION_RESOLVE_CAP, offset: 0 });
  return scan.find((s) => s.id === sessionId) ?? null;
}

// ── Component ────────────────────────────────────────────────────────────────

export function MicroscopeStage({
  inputActive,
  onFlash,
  onCapture,
  jump,
  jumpKey,
  path,
  stageBox: stageBoxProp,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  /** Typing-context bridge: true while a text input owns the keys. */
  onCapture?: (b: boolean) => void;
  /** Consume-once jump target (shell openSession spine). */
  jump?: MicroscopeJump | null;
  /** Nonce — bumps on each openSession so repeat jumps fire. */
  jumpKey?: number;
  /** Explicit index path (test seam; wins over env resolution). */
  path?: string;
  /** Residual host box from SessionsMember; optional for isolated stage smokes. */
  stageBox?: MeasuredSize;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const stageBox = stageBoxProp ?? seedStageBox(dims.width, dims.height);
  const svcRef = useRef<QueryService | null>(null);
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const lastJumpKey = useRef<number | undefined>(undefined);
  const titleInputRef = useRef<{ value?: string; focus?: () => void } | null>(null);
  const searchInputRef = useRef<{ value?: string; focus?: () => void } | null>(null);
  /** After loading a prev page via edge-up, park cursor at end. */
  const pendingCursorEnd = useRef(false);

  const [mode, setMode] = useState<SoftMode>('loading');
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [sessions, setSessions] = useState<SessionListRow[]>([]);
  const [sessionCursor, setSessionCursor] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [view, setView] = useState<ViewMode>('picker');
  // Turn detail pane over the timeline card (enter opens; the pane owns keys while open).
  const [detailOpen, setDetailOpen] = useState(false);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [openSessionRow, setOpenSessionRow] = useState<SessionListRow | null>(null);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [turnCursor, setTurnCursor] = useState(0);
  const [turnScroll, setTurnScroll] = useState(0);

  // Corpus navigator filters
  const [classF, setClassF] = useState<ClassFilter>('all');
  const [agentF, setAgentF] = useState<AgentFilter>('all');
  const [winF, setWinF] = useState<WinFilter>('all');
  const [sortF, setSortF] = useState<SessionSort>('recent');
  const [titleFilter, setTitleFilter] = useState('');
  const [titleTyping, setTitleTyping] = useState(false);
  const [childrenOf, setChildrenOf] = useState<{ id: string; label: string } | null>(null);
  const [savedFilters, setSavedFilters] = useState<FilterSnapshot | null>(null);

  // In-session search (timeline focus)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchHitIdx, setSearchHitIdx] = useState(0);

  const { twoPane, contentW, pickerW, timelineW } = paneGeometry(stageBox.width);
  const listHostH = Math.max(1, stageBox.height - MICRO_STAGE_CHROME);
  const sessionSlots = budgetSessionSlots(listHostH, twoPane);
  const turnSlots = budgetTurnSlots(listHostH, twoPane, sessionSlots);
  const pickerInnerW = paneInnerWidth(pickerW);
  const timelineInnerW = paneInnerWidth(timelineW);
  // Live slot counts for openTimeline / jump scroll (avoid stale closures).
  const turnSlotsRef = useRef(turnSlots);
  turnSlotsRef.current = turnSlots;

  // Filter/title/children row needs ≥2 content rows so list still gets ≥1.
  const softOnlyPreview =
    mode === 'missing' || mode === 'schema' || mode === 'loading';
  const showChromeRow = !softOnlyPreview && sessionSlots >= 2;
  const listSlots = Math.max(1, sessionSlots - (showChromeRow ? 1 : 0));
  const listSlotsRef = useRef(listSlots);
  listSlotsRef.current = listSlots;
  const pageOffsetRef = useRef(pageOffset);
  pageOffsetRef.current = pageOffset;
  const totalCountRef = useRef(totalCount);
  totalCountRef.current = totalCount;
  const sessionCursorRef = useRef(sessionCursor);
  sessionCursorRef.current = sessionCursor;
  const sessionsLenRef = useRef(sessions.length);
  sessionsLenRef.current = sessions.length;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const turnsLenRef = useRef(turns.length);
  turnsLenRef.current = turns.length;
  const turnCursorRef = useRef(turnCursor);
  turnCursorRef.current = turnCursor;
  const searchHitsRef = useRef(searchHits);
  searchHitsRef.current = searchHits;
  const searchHitIdxRef = useRef(searchHitIdx);
  searchHitIdxRef.current = searchHitIdx;

  // Capture bridge while either typing context is active.
  useEffect(() => {
    const capturing = titleTyping || searchOpen;
    onCaptureRef.current?.(capturing);
    return () => {
      onCaptureRef.current?.(false);
    };
  }, [titleTyping, searchOpen]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      try {
        svcRef.current?.close();
      } catch {
        // already closed
      }
      svcRef.current = null;
    };
  }, []);

  const ensureService = useCallback((): QueryService | null => {
    if (svcRef.current) return svcRef.current;
    try {
      const svc = openQueryService(path ? { path } : undefined);
      svcRef.current = svc;
      return svc;
    } catch (err) {
      if (isMissingIndexError(err)) {
        setMode('missing');
        setSessions([]);
        setTurns([]);
        setTotalCount(0);
        return null;
      }
      setMode('missing');
      setSessions([]);
      setTurns([]);
      setTotalCount(0);
      return null;
    }
  }, [path]);

  const loadPage = useCallback(
    (opts?: {
      keepOpen?: boolean;
      classF?: ClassFilter;
      agentF?: AgentFilter;
      winF?: WinFilter;
      sortF?: SessionSort;
      titleFilter?: string;
      pageOffset?: number;
      childrenOf?: { id: string; label: string } | null;
      flashCount?: boolean;
    }) => {
      const svc = ensureService();
      if (!svc) return;
      if (!aliveRef.current) return;

      if (!svc.schemaOK()) {
        setSchemaVersion(svc.getVersion());
        setMode('schema');
        setSessions([]);
        setTotalCount(0);
        if (!opts?.keepOpen) {
          setTurns([]);
          setOpenSessionId(null);
          setOpenSessionRow(null);
          setView('picker');
        }
        return;
      }

      const cf = opts?.classF ?? classF;
      const af = opts?.agentF ?? agentF;
      const wf = opts?.winF ?? winF;
      const sf = opts?.sortF ?? sortF;
      const tf = opts?.titleFilter !== undefined ? opts.titleFilter : titleFilter;
      const off = opts?.pageOffset !== undefined ? opts.pageOffset : pageOffsetRef.current;
      const kids = opts?.childrenOf !== undefined ? opts.childrenOf : childrenOf;
      const pageSize = Math.max(1, listSlotsRef.current);

      let list: SessionListRow[] = [];
      let total = 0;

      if (kids) {
        // No parent_session filter on the list API — fetch subagents and client-filter.
        const base = buildListOpts({
          classF: cf,
          agentF: 'sub',
          winF: wf,
          sortF: sf,
          titleFilter: tf,
          limit: CHILDREN_FETCH_CAP,
          offset: 0,
        });
        const raw = svc.sessionList(base);
        if (!aliveRef.current) return;
        if (svc.busy()) {
          setMode('busy');
          return;
        }
        const filtered = raw.filter((s) => (s.parentSession ?? '') === kids.id);
        total = filtered.length;
        list = filtered.slice(off, off + pageSize);
      } else {
        const base = buildListOpts({
          classF: cf,
          agentF: af,
          winF: wf,
          sortF: sf,
          titleFilter: tf,
          limit: pageSize,
          offset: off,
        });
        total = svc.sessionCount(base);
        if (!aliveRef.current) return;
        if (svc.busy()) {
          setMode('busy');
          return;
        }
        list = svc.sessionList(base);
        if (!aliveRef.current) return;
        if (svc.busy()) {
          setMode('busy');
          return;
        }
      }

      setSessions(list);
      setTotalCount(total);
      setSchemaVersion(svc.getVersion());
      setPageOffset(off);

      if (pendingCursorEnd.current) {
        pendingCursorEnd.current = false;
        setSessionCursor(Math.max(0, list.length - 1));
      } else {
        setSessionCursor((c) => Math.min(c, Math.max(0, list.length - 1)));
      }

      if (opts?.flashCount) {
        onFlashRef.current?.(`${list.length} of ${total}`);
      }

      if (list.length === 0 && total === 0) {
        setMode('empty');
        if (!opts?.keepOpen) {
          setTurns([]);
          // keep open session if keepOpen
        }
        return;
      }

      setMode(svc.busy() ? 'busy' : 'ready');

      const openId = openSessionId;
      if (openId && opts?.keepOpen) {
        const nextTurns = svc.turns(openId);
        if (!aliveRef.current) return;
        if (svc.busy()) {
          setMode('busy');
          return;
        }
        setTurns(nextTurns);
        setTurnCursor((c) => Math.min(c, Math.max(0, nextTurns.length - 1)));
      }
    },
    [
      ensureService,
      classF,
      agentF,
      winF,
      sortF,
      titleFilter,
      childrenOf,
      openSessionId,
    ],
  );

  // Initial open + load
  useEffect(() => {
    loadPage({ pageOffset: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; path changes remount tests
  }, [path]);

  // Reload when page size changes (resize) — keep offset, clamp later.
  useEffect(() => {
    if (mode === 'loading' || mode === 'missing' || mode === 'schema') return;
    loadPage({ keepOpen: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listSlots drives page size
  }, [listSlots]);

  const refresh = useCallback(() => {
    try {
      if (svcRef.current) {
        svcRef.current.reopen();
      } else {
        ensureService();
      }
    } catch (err) {
      if (isMissingIndexError(err)) {
        setMode('missing');
        setSessions([]);
        setTurns([]);
        setTotalCount(0);
        return;
      }
    }
    loadPage({ keepOpen: true });
    onFlashRef.current?.('microscope refreshed');
  }, [ensureService, loadPage]);

  useRefreshOnActive(inputActive, () => {
    refresh();
  });

  const resetPagingAndLoad = useCallback(
    (patch: {
      classF?: ClassFilter;
      agentF?: AgentFilter;
      winF?: WinFilter;
      sortF?: SessionSort;
      titleFilter?: string;
      childrenOf?: { id: string; label: string } | null;
    }) => {
      setPageOffset(0);
      setSessionCursor(0);
      loadPage({
        ...patch,
        pageOffset: 0,
        flashCount: true,
      });
    },
    [loadPage],
  );

  const openTimeline = useCallback(
    (sessionId: string, eventId?: string | number, rowHint?: SessionListRow | null) => {
      const svc = ensureService();
      if (!svc || !svc.schemaOK()) return;
      const nextTurns = svc.turns(sessionId);
      if (svc.busy()) {
        setMode('busy');
        return;
      }
      const row =
        rowHint ??
        resolveSessionRow(svc, sessionId, sessions) ??
        openSessionRow;
      setOpenSessionId(sessionId);
      setOpenSessionRow(row && row.id === sessionId ? row : rowHint ?? null);
      setTurns(nextTurns);
      setView('timeline');
      setDetailOpen(false);
      setSearchOpen(false);
      setSearchHits([]);
      setSearchHitIdx(0);

      // Select the session on the current page when present.
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === sessionId);
        if (idx >= 0) setSessionCursor(idx);
        return prev;
      });

      let cursor = 0;
      if (eventId != null && eventId !== '') {
        const want = Number(eventId);
        const found = nextTurns.findIndex((r) => r.eventId === want);
        if (found >= 0) cursor = found;
      }
      setTurnCursor(cursor);
      // Scroll window so the target is visible (slots from live height budget).
      setTurnScroll((sc) => {
        const win = Math.max(1, turnSlotsRef.current);
        if (cursor < sc) return cursor;
        if (cursor >= sc + win) return Math.max(0, cursor - win + 1);
        return sc;
      });
      onFlashRef.current?.(
        eventId != null && eventId !== ''
          ? `opened ${sessionId.slice(0, 12)} #${eventId}`
          : `opened ${sessionId.slice(0, 12)}`,
      );
    },
    [ensureService, sessions, openSessionRow],
  );

  // Consume-once jump (D7: does not sticky-fight cursor after landing).
  useEffect(() => {
    if (jumpKey === undefined) return;
    if (jumpKey === lastJumpKey.current) return;
    lastJumpKey.current = jumpKey;
    if (!jump?.sessionId) return;
    const svc = ensureService();
    if (!svc) return;
    if (!svc.schemaOK()) {
      setSchemaVersion(svc.getVersion());
      setMode('schema');
      return;
    }
    // Ensure a page is loaded for picker chrome, then open the target.
    loadPage({ keepOpen: true });
    const row = resolveSessionRow(svc, jump.sessionId, sessions);
    openTimeline(jump.sessionId, jump.eventId, row);
  }, [jumpKey, jump?.sessionId, jump?.eventId, ensureService, openTimeline, loadPage, sessions]);

  useEffect(() => {
    if (sessionCursor >= sessions.length) {
      setSessionCursor(Math.max(0, sessions.length - 1));
    }
  }, [sessions.length, sessionCursor]);

  useEffect(() => {
    if (turnCursor >= turns.length) setTurnCursor(Math.max(0, turns.length - 1));
  }, [turns.length, turnCursor]);

  useEffect(() => {
    if (turnSlots <= 0) return;
    if (turnCursor < turnScroll) setTurnScroll(turnCursor);
    else if (turnCursor >= turnScroll + turnSlots) {
      setTurnScroll(turnCursor - turnSlots + 1);
    }
  }, [turnCursor, turnScroll, turnSlots]);

  const exitTitleTyping = useCallback(
    (apply: boolean) => {
      const raw = (titleInputRef.current?.value ?? '').trim();
      setTitleTyping(false);
      if (apply) {
        setTitleFilter(raw);
        resetPagingAndLoad({ titleFilter: raw });
      } else {
        setTitleFilter('');
        if (titleInputRef.current) titleInputRef.current.value = '';
        resetPagingAndLoad({ titleFilter: '' });
      }
    },
    [resetPagingAndLoad],
  );

  const exitSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchHits([]);
    setSearchHitIdx(0);
    if (searchInputRef.current) searchInputRef.current.value = '';
  }, []);

  const runSessionSearch = useCallback(
    (query: string) => {
      const q = query.trim();
      if (!q || !openSessionId) {
        setSearchHits([]);
        setSearchHitIdx(0);
        return;
      }
      const svc = ensureService();
      if (!svc || !svc.schemaOK()) return;
      const hits = svc.search(q, { sessionId: openSessionId, limit: 100 });
      setSearchHits(hits);
      setSearchHitIdx(0);
      if (hits.length > 0) {
        const want = hits[0]!.eventId;
        const found = turns.findIndex((r) => r.eventId === want);
        if (found >= 0) setTurnCursor(found);
        onFlashRef.current?.(`search ${1}/${hits.length}`);
      } else {
        onFlashRef.current?.('no search hits');
      }
    },
    [ensureService, openSessionId, turns],
  );

  const stepSearchHit = useCallback((dir: 1 | -1) => {
    const hits = searchHitsRef.current;
    if (hits.length === 0) return;
    const next = (searchHitIdxRef.current + dir + hits.length * 4) % hits.length;
    searchHitIdxRef.current = next;
    setSearchHitIdx(next);
    const want = hits[next]!.eventId;
    const found = turns.findIndex((r) => r.eventId === want);
    // turns may be stale in closure — scan live state via service is overkill;
    // open timeline keeps turns in state; findIndex on last rendered turns is fine.
    if (found >= 0) {
      turnCursorRef.current = found;
      setTurnCursor(found);
    }
    onFlashRef.current?.(`search ${next + 1}/${hits.length}`);
  }, [turns]);

  const enterChildrenOf = useCallback(
    (row: SessionListRow) => {
      setSavedFilters({
        classF,
        agentF,
        winF,
        sortF,
        titleFilter,
        pageOffset: pageOffsetRef.current,
        sessionCursor,
      });
      const label = sessionDisplayTitle(row);
      const short =
        label.length > 18 ? `${label.slice(0, 17)}\u2026` : label;
      const kids = { id: row.id, label: short };
      setChildrenOf(kids);
      setPageOffset(0);
      setSessionCursor(0);
      loadPage({ childrenOf: kids, pageOffset: 0, flashCount: true });
      onFlashRef.current?.(`children of ${short}`);
    },
    [classF, agentF, winF, sortF, titleFilter, sessionCursor, loadPage],
  );

  const restoreFromChildren = useCallback(() => {
    const snap = savedFilters;
    setChildrenOf(null);
    setSavedFilters(null);
    if (snap) {
      setClassF(snap.classF);
      setAgentF(snap.agentF);
      setWinF(snap.winF);
      setSortF(snap.sortF);
      setTitleFilter(snap.titleFilter);
      setPageOffset(snap.pageOffset);
      setSessionCursor(snap.sessionCursor);
      loadPage({
        childrenOf: null,
        classF: snap.classF,
        agentF: snap.agentF,
        winF: snap.winF,
        sortF: snap.sortF,
        titleFilter: snap.titleFilter,
        pageOffset: snap.pageOffset,
        flashCount: true,
      });
    } else {
      loadPage({ childrenOf: null, pageOffset: 0, flashCount: true });
    }
  }, [savedFilters, loadPage]);

  useKeyboard((key: { name?: string; sequence?: string }) => {
    if (!inputActive) return;
    // While the turn detail pane is open it owns the keys (esc/step/scroll/copy).
    if (detailOpen) return;

    const rawName = (key.name ?? '').toLowerCase();
    const n = rawName.replace('arrow', '');

    // ── Title type-to-filter (uncontrolled input owns printables) ──────────
    if (titleTyping) {
      if (n === 'escape') {
        exitTitleTyping(false);
        return;
      }
      if (n === 'return' || n === 'enter') {
        exitTitleTyping(true);
        return;
      }
      // Printables fall through to the focused input.
      return;
    }

    // ── In-session search input ────────────────────────────────────────────
    if (searchOpen && view === 'timeline') {
      if (n === 'escape') {
        exitSearch();
        return;
      }
      if (n === 'return' || n === 'enter') {
        const q = searchInputRef.current?.value ?? '';
        runSessionSearch(q);
        setSearchOpen(false);
        return;
      }
      return;
    }

    if (n === 'r') {
      refresh();
      return;
    }

    // Soft states that refuse navigation (still allow r).
    if (mode === 'missing' || mode === 'schema' || mode === 'loading') return;

    if (view === 'timeline') {
      if (n === 'escape' || n === 'backspace') {
        if (searchHits.length > 0) {
          exitSearch();
          return;
        }
        setView('picker');
        return;
      }
      if (n === '/' || key.sequence === '/') {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus?.(), 0);
        return;
      }
      if (
        (n === 'n' || key.sequence === 'n' || key.sequence === 'N') &&
        searchHitsRef.current.length > 0
      ) {
        const shift =
          !!(key as { shift?: boolean }).shift ||
          key.sequence === 'N' ||
          (key.name ?? '') === 'N';
        stepSearchHit(shift ? -1 : 1);
        return;
      }
      if (n === 'up' || n === 'k') {
        setTurnCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (n === 'down' || n === 'j') {
        setTurnCursor((c) => Math.min(Math.max(0, turnsLenRef.current - 1), c + 1));
        return;
      }
      if ((n === 'return' || n === 'enter') && turnsLenRef.current > 0) {
        setDetailOpen(true);
        return;
      }
      return;
    }

    // ── Picker view ────────────────────────────────────────────────────────
    if (n === 'escape') {
      if (childrenOf) {
        restoreFromChildren();
        return;
      }
      if (titleFilter) {
        setTitleFilter('');
        resetPagingAndLoad({ titleFilter: '' });
        return;
      }
      return;
    }

    if (n === 't') {
      setTitleTyping(true);
      setTimeout(() => {
        if (titleInputRef.current) {
          titleInputRef.current.value = titleFilter;
          titleInputRef.current.focus?.();
        }
      }, 0);
      return;
    }

    if (n === 'f') {
      const next = cycleChip(CLASS_CYCLE, classF, 1);
      setClassF(next);
      resetPagingAndLoad({ classF: next });
      return;
    }
    if (n === 'a') {
      const next = cycleChip(AGENT_CYCLE, agentF, 1);
      setAgentF(next);
      resetPagingAndLoad({ agentF: next });
      return;
    }
    if (n === '[' || n === 'left') {
      // Window cycle reverse
      const next = cycleChip(WIN_CYCLE, winF, -1);
      setWinF(next);
      resetPagingAndLoad({ winF: next });
      return;
    }
    if (n === ']' || n === 'right') {
      const next = cycleChip(WIN_CYCLE, winF, 1);
      setWinF(next);
      resetPagingAndLoad({ winF: next });
      return;
    }
    if (n === ',' || key.sequence === ',') {
      const next = cycleChip(SORT_CYCLE, sortF, 1);
      setSortF(next);
      resetPagingAndLoad({ sortF: next });
      return;
    }

    if (n === 's') {
      const sel = sessionsRef.current[sessionCursorRef.current];
      if (!sel) return;
      if (isSubagentRow(sel) && sel.parentSession) {
        openTimeline(sel.parentSession);
        return;
      }
      // Primary → filter to children
      enterChildrenOf(sel);
      return;
    }

    const pageSize = Math.max(1, listSlotsRef.current);
    const total = totalCountRef.current;
    const off = pageOffsetRef.current;
    const cur = sessionCursorRef.current;
    const pageLen = sessionsLenRef.current;

    if (n === 'pageup' || n === 'page_up' || n === 'page up') {
      const newOff = Math.max(0, off - pageSize);
      setPageOffset(newOff);
      setSessionCursor(0);
      sessionCursorRef.current = 0;
      loadPage({ pageOffset: newOff });
      return;
    }
    if (n === 'pagedown' || n === 'page_down' || n === 'page down') {
      const maxOff = Math.max(0, total - pageSize);
      const newOff = Math.min(maxOff, off + pageSize);
      setPageOffset(newOff);
      setSessionCursor(0);
      sessionCursorRef.current = 0;
      loadPage({ pageOffset: newOff });
      return;
    }
    if (n === 'home') {
      setPageOffset(0);
      setSessionCursor(0);
      sessionCursorRef.current = 0;
      loadPage({ pageOffset: 0 });
      return;
    }
    if (n === 'end') {
      const maxOff = Math.max(0, total - pageSize);
      pendingCursorEnd.current = true;
      setPageOffset(maxOff);
      loadPage({ pageOffset: maxOff });
      return;
    }

    if (n === 'up' || n === 'k') {
      if (cur > 0) {
        const next = cur - 1;
        sessionCursorRef.current = next;
        setSessionCursor(next);
      } else if (off > 0) {
        const newOff = Math.max(0, off - pageSize);
        pendingCursorEnd.current = true;
        setPageOffset(newOff);
        pageOffsetRef.current = newOff;
        loadPage({ pageOffset: newOff });
      }
      return;
    }
    if (n === 'down' || n === 'j') {
      if (cur < pageLen - 1) {
        const next = cur + 1;
        sessionCursorRef.current = next;
        setSessionCursor(next);
      } else if (off + pageLen < total) {
        const newOff = off + pageSize;
        setPageOffset(newOff);
        pageOffsetRef.current = newOff;
        setSessionCursor(0);
        sessionCursorRef.current = 0;
        loadPage({ pageOffset: newOff });
      }
      return;
    }
    if (n === 'return' || n === 'enter' || n === 'o') {
      const sel = sessionsRef.current[sessionCursorRef.current];
      if (sel) openTimeline(sel.id, undefined, sel);
    }
  });

  const openSession = openSessionRow;

  const banners = useMemo(() => {
    const lines: { text: string; color: RGBA }[] = [];
    if (mode === 'missing') {
      lines.push({ text: EMPTY_INDEX_COPY, color: t.muted });
    } else if (mode === 'schema') {
      const supported = SUPPORTED_SCHEMA_VERSIONS.join(',');
      lines.push({
        text: `index at version ${schemaVersion}, this build supports ${supported}`,
        color: t.warning,
      });
    } else if (mode === 'busy') {
      lines.push({ text: 'corpus busy', color: t.warning });
    } else if (mode === 'empty') {
      lines.push({ text: EMPTY_CORPUS_COPY, color: t.muted });
    } else if (mode === 'loading') {
      lines.push({ text: 'loading microscope…', color: t.muted });
    }
    return lines;
  }, [mode, schemaVersion, t]);

  const softOnly = mode === 'missing' || mode === 'schema' || mode === 'loading';

  // ── Chrome row: filter chips | title input | children banner ─────────────
  const chromeRow = useMemo(() => {
    if (!showChromeRow) return null;
    if (titleTyping) {
      return (
        <box
          height={1}
          width={pickerInnerW}
          flexShrink={0}
          flexDirection="row"
          overflow="hidden"
          backgroundColor={t.background}
        >
          <text fg={t.info} wrapMode="none">
            {'title:'}
          </text>
          <input
            ref={titleInputRef as never}
            focused={!!inputActive && titleTyping}
            placeholder="substring…"
            backgroundColor={t.background}
            textColor={t.foreground}
            onInput={() => {
              /* uncontrolled — value read on enter */
            }}
          />
        </box>
      );
    }
    if (childrenOf) {
      const banner = `children of ${childrenOf.label}`;
      return (
        <FixedClearRow
          width={pickerInnerW}
          color={t.info}
          text={padRow(banner, pickerInnerW)}
          onMouseDown={() => restoreFromChildren()}
        />
      );
    }
    // Middot chip register — one row, chips clickable (cycle on click).
    const chips: { key: string; label: string; active: boolean; onClick: () => void }[] = [
      {
        key: 'class',
        label: `class:${classF}`,
        active: classF !== 'all',
        onClick: () => {
          const next = cycleChip(CLASS_CYCLE, classF, 1);
          setClassF(next);
          resetPagingAndLoad({ classF: next });
        },
      },
      {
        key: 'agent',
        label: `agent:${agentF}`,
        active: agentF !== 'all',
        onClick: () => {
          const next = cycleChip(AGENT_CYCLE, agentF, 1);
          setAgentF(next);
          resetPagingAndLoad({ agentF: next });
        },
      },
      {
        key: 'win',
        label: `win:${winF}`,
        active: winF !== 'all',
        onClick: () => {
          const next = cycleChip(WIN_CYCLE, winF, 1);
          setWinF(next);
          resetPagingAndLoad({ winF: next });
        },
      },
      {
        key: 'sort',
        label: `sort:${sortChipLabel(sortF)}`,
        active: sortF !== 'recent',
        onClick: () => {
          const next = cycleChip(SORT_CYCLE, sortF, 1);
          setSortF(next);
          resetPagingAndLoad({ sortF: next });
        },
      },
    ];
    return (
      <box
        height={1}
        width={pickerInnerW}
        flexShrink={0}
        flexDirection="row"
        overflow="hidden"
        backgroundColor={t.background}
      >
        {chips.map((c, i) => (
          <box
            key={c.key}
            flexShrink={0}
            flexDirection="row"
            onMouseDown={c.onClick}
            backgroundColor={t.background}
          >
            {i > 0 ? (
              <text fg={t.muted} wrapMode="none">
                {' · '}
              </text>
            ) : null}
            <text fg={c.active ? t.info : t.muted} wrapMode="none">
              {c.label}
            </text>
          </box>
        ))}
      </box>
    );
  }, [
    showChromeRow,
    titleTyping,
    childrenOf,
    pickerInnerW,
    t,
    inputActive,
    classF,
    agentF,
    winF,
    sortF,
    resetPagingAndLoad,
    restoreFromChildren,
  ]);

  const pickerBody = useMemo(() => {
    if (softOnly) {
      return (
        <box flexDirection="column" flexShrink={0}>
          {banners.map((b, i) => (
            <FixedClearRow
              key={`b-${i}`}
              width={pickerInnerW}
              color={b.color}
              text={padRow(b.text, pickerInnerW)}
            />
          ))}
        </box>
      );
    }
    return (
      <box flexDirection="column" flexShrink={0} overflow="hidden">
        {chromeRow}
        {mode === 'busy'
          ? banners.map((b, i) => (
              <FixedClearRow
                key={`busy-${i}`}
                width={pickerInnerW}
                color={b.color}
                text={padRow(b.text, pickerInnerW)}
              />
            ))
          : null}
        {mode === 'empty' && sessions.length === 0 ? (
          <>
            {banners.map((b, i) => (
              <FixedClearRow
                key={`e-${i}`}
                width={pickerInnerW}
                color={b.color}
                text={padRow(b.text, pickerInnerW)}
              />
            ))}
            {Array.from({ length: Math.max(0, listSlots - 1) }, (_, i) => (
              <FixedClearRow
                key={`ep-${i}`}
                width={pickerInnerW}
                color={t.muted}
                text={emptyRow(pickerInnerW)}
              />
            ))}
          </>
        ) : (
          Array.from({ length: listSlots }, (_, i) => {
            const row = sessions[i];
            if (!row) {
              return (
                <FixedClearRow
                  key={`s-${i}`}
                  width={pickerInnerW}
                  color={t.muted}
                  text={
                    i === 0 && sessions.length === 0
                      ? padRow(EMPTY_CORPUS_COPY, pickerInnerW)
                      : emptyRow(pickerInnerW)
                  }
                />
              );
            }
            const selected = i === sessionCursor && view === 'picker';
            return (
              <FixedClearRow
                key={`s-${row.id}-${i}`}
                width={pickerInnerW}
                color={selected ? t.info : t.foreground}
                text={padRow(
                  formatSessionLine(row, selected, Date.now(), pickerInnerW),
                  pickerInnerW,
                )}
              />
            );
          })
        )}
      </box>
    );
  }, [
    softOnly,
    mode,
    banners,
    pickerInnerW,
    t,
    sessions,
    sessionCursor,
    listSlots,
    view,
    chromeRow,
  ]);

  // Two fixed info rows: title (or empty prompt) + facts (or blank).
  // Empty prompt lives here only — body stays blank slots (no double copy).
  const infoRows = useMemo(() => {
    if (openSession) {
      return {
        title: formatSessionTitleLine(openSession),
        facts: formatSessionInfo(openSession),
        titleColor: t.foreground as RGBA,
        factsColor: t.muted as RGBA,
      };
    }
    if (mode === 'ready') {
      return {
        title: EMPTY_TIMELINE_PROMPT,
        facts: '',
        titleColor: t.muted as RGBA,
        factsColor: t.muted as RGBA,
      };
    }
    return {
      title: '',
      facts: '',
      titleColor: t.muted as RGBA,
      factsColor: t.muted as RGBA,
    };
  }, [openSession, mode, t]);

  const timelineSearchRow = searchOpen ? (
    <box
      height={1}
      width={timelineInnerW}
      flexShrink={0}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={t.background}
    >
      <text fg={t.info} wrapMode="none">
        {'/'}
      </text>
      <input
        ref={searchInputRef as never}
        focused={!!inputActive && searchOpen}
        placeholder="in-session search…"
        backgroundColor={t.background}
        textColor={t.foreground}
        onInput={() => {
          /* uncontrolled */
        }}
      />
    </box>
  ) : null;

  const timelineBody = useMemo(() => {
    if (!openSessionId) {
      return (
        <box flexDirection="column" flexShrink={0} overflow="hidden">
          {Array.from({ length: turnSlots }, (_, i) => (
            <FixedClearRow
              key={`t-empty-${i}`}
              width={timelineInnerW}
              color={t.muted}
              text={emptyRow(timelineInnerW)}
            />
          ))}
        </box>
      );
    }
    if (turns.length === 0) {
      return (
        <box flexDirection="column" flexShrink={0} overflow="hidden">
          <FixedClearRow
            width={timelineInnerW}
            color={t.muted}
            text={padRow(NO_EVENTS_COPY, timelineInnerW)}
          />
          {Array.from({ length: Math.max(0, turnSlots - 1) }, (_, i) => (
            <FixedClearRow
              key={`t-noevt-${i}`}
              width={timelineInnerW}
              color={t.muted}
              text={emptyRow(timelineInnerW)}
            />
          ))}
        </box>
      );
    }
    const turnSlice = turns.slice(turnScroll, turnScroll + turnSlots);
    return (
      <box flexDirection="column" flexShrink={0} overflow="hidden">
        {Array.from({ length: turnSlots }, (_, i) => {
          const row = turnSlice[i];
          if (!row) {
            return (
              <FixedClearRow
                key={`t-${i}`}
                width={timelineInnerW}
                color={t.muted}
                text={emptyRow(timelineInnerW)}
              />
            );
          }
          const absIdx = turnScroll + i;
          // Highlight turn cursor only while timeline owns focus.
          const selected = view === 'timeline' && absIdx === turnCursor;
          const color = selected ? t.info : kindColor(row.kind, t, row.toolError);
          return (
            <FixedClearRow
              key={`t-${row.eventId}-${i}`}
              width={timelineInnerW}
              color={color}
              text={padRow(
                formatTurnLine(row, selected, timelineInnerW),
                timelineInnerW,
              )}
            />
          );
        })}
      </box>
    );
  }, [
    view,
    openSessionId,
    turns,
    turnScroll,
    turnCursor,
    turnSlots,
    timelineInnerW,
    t,
  ]);

  const headerRight =
    mode === 'loading'
      ? 'loading'
      : mode === 'missing'
        ? 'no index'
        : mode === 'schema'
          ? `v${schemaVersion}`
          : mode === 'busy'
            ? 'busy'
            : mode === 'empty'
              ? 'empty'
              : openSessionId
                ? `${totalCount} sess · ${turns.length} evt`
                : `${totalCount} sessions`;

  // Footer is two-pane-aware but keeps E2E tokens (↑↓ / select / enter timeline / j/k).
  const footer =
    mode === 'missing' || mode === 'schema'
      ? 'r refresh'
      : view === 'timeline'
        ? detailOpen
          ? TURN_DETAIL_FOOTER
          : searchOpen
            ? 'type query · enter search · esc cancel'
            : searchHits.length > 0
              ? `n/N hits · ↑↓ j/k turns · esc sessions · r refresh`
              : twoPane
                ? '↑↓ j/k turns · / search · esc sessions · r refresh'
                : '↑↓ j/k turns · / search · esc picker · r refresh'
        : titleTyping
          ? 'type title · enter apply · esc clear'
          : childrenOf
            ? '↑↓ select · enter timeline · esc restore · r refresh'
            : '↑↓ select · enter timeline · f/a/[ ]/, filters · t title · r refresh';

  const pickerRight =
    mode === 'ready' || mode === 'busy' || mode === 'empty'
      ? pageRangeLabel(pageOffset, sessions.length, totalCount)
      : undefined;

  const timelineRight = openSessionId
    ? searchHits.length > 0
      ? `${searchHitIdx + 1}/${searchHits.length}`
      : turns.length > 0
        ? `${turns.length} evt`
        : '0 evt'
    : undefined;

  const pickerColumn = (
    <Card
      title="Sessions"
      right={pickerRight}
      titleColor={view === 'picker' ? t.primary : t.muted}
      selected={view === 'picker' && !!inputActive}
      width={pickerW}
      flexShrink={0}
    >
      {pickerBody}
    </Card>
  );

  const timelineColumn = (
    <Card
      title="Timeline"
      right={timelineRight}
      titleColor={view === 'timeline' ? t.primary : t.muted}
      selected={view === 'timeline' && !!inputActive}
      width={twoPane ? timelineW : contentW}
      flexGrow={0}
      flexShrink={0}
      minHeight={0}
    >
      <box flexDirection="column" flexShrink={0} backgroundColor={t.background}>
        <FixedClearRow
          width={timelineInnerW}
          color={infoRows.titleColor}
          text={padRow(infoRows.title, timelineInnerW)}
        />
        {searchOpen ? (
          timelineSearchRow
        ) : (
          <FixedClearRow
            width={timelineInnerW}
            color={infoRows.factsColor}
            text={padRow(infoRows.facts, timelineInnerW)}
          />
        )}
        {timelineBody}
      </box>
    </Card>
  );

  // Detail pane rides the timeline card's slot; the pane itself stays mounted
  // (visible toggle) and owns the keys while open.
  const detailPane = (
    <TurnDetail
      visible={detailOpen}
      eventId={turns[turnCursor]?.eventId ?? null}
      sessionTitle={openSession ? sessionDisplayTitle(openSession) : ''}
      inputActive={!!inputActive && detailOpen}
      onClose={() => setDetailOpen(false)}
      onStep={(d) =>
        setTurnCursor((c) => Math.min(Math.max(0, turns.length - 1), Math.max(0, c + d)))
      }
      onFlash={onFlash}
      path={path}
      width={twoPane ? timelineW : contentW}
      height={listHostH}
    />
  );
  const timelineSlot = (
    <>
      {detailOpen ? null : timelineColumn}
      {detailPane}
    </>
  );

  const stageBody = softOnly ? (
    <box flexDirection="column" flexShrink={0}>
      {banners.map((b, i) => (
        <FixedClearRow
          key={`soft-${i}`}
          width={contentW}
          color={b.color}
          text={padRow(b.text, contentW)}
        />
      ))}
    </box>
  ) : twoPane ? (
    <box flexDirection="row" flexShrink={0} overflow="hidden" backgroundColor={t.background}>
      {pickerColumn}
      <box width={PANE_GAP} flexShrink={0} backgroundColor={t.background} />
      {timelineSlot}
    </box>
  ) : (
    <box flexDirection="column" flexShrink={0} backgroundColor={t.background}>
      {pickerColumn}
      <box height={1} flexShrink={0} backgroundColor={t.background} />
      {timelineSlot}
    </box>
  );

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
        title="Microscope"
        headerRight={headerRight}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        active={!!inputActive}
      >
        {stageBody}
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
