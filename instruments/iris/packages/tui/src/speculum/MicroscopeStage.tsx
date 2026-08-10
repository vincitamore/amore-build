/**
 * Microscope stage — session picker + kind-colored turn timeline.
 * Reads the derived index through openQueryService (readonly); never writes.
 *
 * Two-pane craft: fixed-slot lists grow by measured height; picker leads with
 * session titles; bordered Cards carry titleColor chrome; empty-timeline prompt
 * lives in the session header only (no double copy).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { Panel } from '../components/Panel';
import { useStableDimensions } from '../use-stable-dimensions';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { Card, CARD_CHROME } from './Card';
import {
  openQueryService,
  SUPPORTED_SCHEMA_VERSIONS,
  type QueryService,
  type SessionListRow,
  type TurnRow,
} from './query-service';

export type MicroscopeJump = {
  sessionId: string;
  eventId?: string | number;
  ts?: string;
};

/** Terminal width below this stacks picker over timeline (chunked; not flexWrap). */
export const STACK_BELOW_COLS = 100;
/** Fixed picker column width when side-by-side (must never wrap a session row). */
export const PICKER_COL_WIDTH = 32;
const PANE_GAP = 1;
/** Nested under SessionsMember: member pad (2) + stage pad (2) + panel border (2) + panel pad (2). */
const NESTED_CHROME = 8;

/**
 * Vertical chrome before list slots (stage pad, outer Panel, Card title/borders,
 * footer, nest allowance). Two-pane shares height; stacked spends extra on the
 * second card + split residual.
 */
export const MICRO_CHROME_TWO_PANE = 11;
export const MICRO_CHROME_STACKED = 12;
/** Session-info rows above the turn stream (title + facts, or empty prompt). */
export const TIMELINE_INFO_ROWS = 2;
export const MIN_SESSION_SLOTS = 4;
export const MIN_TURN_SLOTS = 4;
/** Prior fixed floors — used as fallbacks before first measure. */
export const DEFAULT_SESSION_SLOTS = 8;
export const DEFAULT_TURN_SLOTS = 12;

const EMPTY_INDEX_COPY = "no speculum index — run 'speculum ingest'";
const EMPTY_CORPUS_COPY = "no ingested sessions — run 'speculum ingest'";
const EMPTY_TIMELINE_PROMPT = 'enter a session to open its timeline';
const NO_EVENTS_COPY = 'no events in session';

type SoftMode =
  | 'loading'
  | 'missing'
  | 'schema'
  | 'busy'
  | 'empty'
  | 'ready';

type ViewMode = 'picker' | 'timeline';

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

/** Truncated summary body for a turn row (no pad). */
export function rowText(turn: TurnRow): string {
  const isErr = !!(turn.toolError || turn.kind === 'tool_error');
  if (isErr) {
    const tail = (turn.text ?? '').trim().replace(/\s+/g, ' ');
    const name = turn.toolName?.trim() || '';
    if (name && tail) return `${name}: ${tail}`;
    return name || tail || 'error';
  }
  if (turn.kind === 'tool_use' || turn.kind === 'tool_result') {
    const name = turn.toolName?.trim() || turn.kind;
    const extra = (turn.text ?? '').trim().replace(/\s+/g, ' ');
    return extra ? `${name} ${extra}` : name;
  }
  return (turn.text ?? '').trim().replace(/\s+/g, ' ') || turn.kind;
}

/** Short session id prefix for chrome (ellipsis after 12). */
export function shortSessionId(id: string): string {
  if (!id) return '?';
  return id.length > 12 ? `${id.slice(0, 11)}\u2026` : id;
}

/** Title when present; otherwise the id prefix (honest empty-title fallback). */
export function sessionDisplayTitle(s: SessionListRow): string {
  const title = (s.title ?? '').replace(/\s+/g, ' ').trim();
  return title || shortSessionId(s.id);
}

/**
 * Two-pane geometry from terminal width.
 * Wide (≥ STACK_BELOW_COLS): picker fixed ~32 cols, timeline gets the rest
 * (panel content budget = dims − NESTED_CHROME; house Panel −6 nested rule).
 * Narrow: both panes use full content width (stacked column).
 */
export function paneGeometry(termWidth: number): {
  twoPane: boolean;
  contentW: number;
  pickerW: number;
  timelineW: number;
} {
  const contentW = Math.max(16, Math.floor(termWidth) - NESTED_CHROME);
  const twoPane = Math.floor(termWidth) >= STACK_BELOW_COLS;
  if (!twoPane) {
    return { twoPane: false, contentW, pickerW: contentW, timelineW: contentW };
  }
  const pickerW = Math.min(34, Math.max(30, PICKER_COL_WIDTH));
  const timelineW = Math.max(16, contentW - pickerW - PANE_GAP);
  return { twoPane: true, contentW, pickerW, timelineW };
}

/**
 * Picker / timeline slot counts from measured terminal height.
 * Taller terminal → more rows; floors keep 80×24 usable without overflow.
 */
export function budgetSessionSlots(termH: number, twoPane: boolean): number {
  const h = Math.max(1, Math.floor(termH));
  if (twoPane) {
    return Math.max(MIN_SESSION_SLOTS, h - MICRO_CHROME_TWO_PANE);
  }
  const residual = Math.max(
    MIN_SESSION_SLOTS + MIN_TURN_SLOTS + TIMELINE_INFO_ROWS,
    h - MICRO_CHROME_STACKED,
  );
  return Math.max(MIN_SESSION_SLOTS, Math.floor(residual * 0.4));
}

export function budgetTurnSlots(
  termH: number,
  twoPane: boolean,
  sessionSlots?: number,
): number {
  const h = Math.max(1, Math.floor(termH));
  if (twoPane) {
    return Math.max(MIN_TURN_SLOTS, h - MICRO_CHROME_TWO_PANE - TIMELINE_INFO_ROWS);
  }
  const ss = sessionSlots ?? budgetSessionSlots(h, false);
  const residual = h - MICRO_CHROME_STACKED - ss - TIMELINE_INFO_ROWS;
  return Math.max(MIN_TURN_SLOTS, residual);
}

/**
 * Session-info facts line (middot register). Title is separate — see
 * formatSessionTitleLine — so this line never doubles the primary label when
 * a title is present; when title is empty the id already leads the title line
 * and is omitted here.
 */
export function formatSessionInfo(s: SessionListRow, now = Date.now()): string {
  const title = (s.title ?? '').replace(/\s+/g, ' ').trim();
  const id = shortSessionId(s.id);
  const proj = projectBasename(s.projectPath);
  const model = (s.modelId ?? '').trim();
  const age = relAge(s.startedAt, now);
  const parts: string[] = [];
  if (title) parts.push(id);
  parts.push(proj);
  if (model) parts.push(model);
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
 * One-row session picker line: title (or id fallback) leads; id + age + counts
 * trail as secondary. Caller pad-truncates to the picker inner width.
 */
export function formatSessionLine(
  s: SessionListRow,
  selected: boolean,
  now = Date.now(),
): string {
  const prefix = selected ? '>' : ' ';
  const title = (s.title ?? '').replace(/\s+/g, ' ').trim();
  const label = title || shortSessionId(s.id);
  const age = relAge(s.startedAt, now);
  const counts = `t:${s.turnCount} e:${s.eventCount}`;
  if (title) {
    return `${prefix}${label}  ${shortSessionId(s.id)}  ${age}  ${counts}`;
  }
  // Empty title: label is already the id — do not double it.
  return `${prefix}${label}  ${age}  ${counts}`;
}

/**
 * Full fixed-width turn timeline line (clock · kind · body · #<eventId>).
 * Kind is fixed-width for column alignment; kind color is applied by the row.
 */
export function formatTurnLine(turn: TurnRow, selected: boolean): string {
  const prefix = selected ? '>' : ' ';
  const clock = formatEventTs(turn.ts);
  const kind = (turn.kind || '?').slice(0, 11).padEnd(11);
  const body = rowText(turn);
  const idTag = `#${turn.eventId}`;
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

function isMissingIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /not found|ENOENT/i.test(msg);
}

// ── Component ────────────────────────────────────────────────────────────────

export function MicroscopeStage({
  inputActive,
  onFlash,
  jump,
  jumpKey,
  path,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  /** Consume-once jump target (shell openSession spine). */
  jump?: MicroscopeJump | null;
  /** Nonce — bumps on each openSession so repeat jumps fire. */
  jumpKey?: number;
  /** Explicit index path (test seam; wins over env resolution). */
  path?: string;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const svcRef = useRef<QueryService | null>(null);
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const lastJumpKey = useRef<number | undefined>(undefined);

  const [mode, setMode] = useState<SoftMode>('loading');
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [sessions, setSessions] = useState<SessionListRow[]>([]);
  const [sessionCursor, setSessionCursor] = useState(0);
  const [sessionScroll, setSessionScroll] = useState(0);
  const [view, setView] = useState<ViewMode>('picker');
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [turnCursor, setTurnCursor] = useState(0);
  const [turnScroll, setTurnScroll] = useState(0);

  const { twoPane, contentW, pickerW, timelineW } = paneGeometry(dims.width);
  const sessionSlots = budgetSessionSlots(dims.height, twoPane);
  const turnSlots = budgetTurnSlots(dims.height, twoPane, sessionSlots);
  const pickerInnerW = paneInnerWidth(pickerW);
  const timelineInnerW = paneInnerWidth(timelineW);
  // Live slot counts for openTimeline / jump scroll (avoid stale closures).
  const turnSlotsRef = useRef(turnSlots);
  turnSlotsRef.current = turnSlots;

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
        return null;
      }
      setMode('missing');
      setSessions([]);
      setTurns([]);
      return null;
    }
  }, [path]);

  const load = useCallback(
    (opts?: { keepOpen?: boolean }) => {
      const svc = ensureService();
      if (!svc) return;
      if (!aliveRef.current) return;

      if (!svc.schemaOK()) {
        setSchemaVersion(svc.getVersion());
        setMode('schema');
        setSessions([]);
        if (!opts?.keepOpen) {
          setTurns([]);
          setOpenSessionId(null);
          setView('picker');
        }
        return;
      }

      const list = svc.sessionList();
      if (!aliveRef.current) return;

      if (svc.busy()) {
        setMode('busy');
        // Keep prior rows if any; still surface the busy banner via mode.
        if (list.length === 0 && sessions.length === 0) {
          setSessions([]);
        } else if (list.length > 0) {
          setSessions(list);
        }
        return;
      }

      setSessions(list);
      setSchemaVersion(svc.getVersion());
      if (list.length === 0) {
        setMode('empty');
        setTurns([]);
        if (!opts?.keepOpen) {
          setOpenSessionId(null);
          setView('picker');
        }
        return;
      }

      setMode('ready');
      setSessionCursor((c) => Math.min(c, Math.max(0, list.length - 1)));

      // Refresh open timeline if still present.
      const openId = opts?.keepOpen ? openSessionId : openSessionId;
      if (openId) {
        const still = list.some((s) => s.id === openId);
        if (still) {
          const nextTurns = svc.turns(openId);
          if (!aliveRef.current) return;
          if (svc.busy()) {
            setMode('busy');
            return;
          }
          setTurns(nextTurns);
          setTurnCursor((c) => Math.min(c, Math.max(0, nextTurns.length - 1)));
        } else if (!opts?.keepOpen) {
          setOpenSessionId(null);
          setTurns([]);
          setView('picker');
        }
      }
    },
    [ensureService, openSessionId, sessions.length],
  );

  // Initial open + load
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; path changes remount tests
  }, [path]);

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
        return;
      }
    }
    load({ keepOpen: true });
    onFlashRef.current?.('microscope refreshed');
  }, [ensureService, load]);

  useRefreshOnActive(inputActive, () => {
    refresh();
  });

  const openTimeline = useCallback(
    (sessionId: string, eventId?: string | number) => {
      const svc = ensureService();
      if (!svc || !svc.schemaOK()) return;
      const nextTurns = svc.turns(sessionId);
      if (svc.busy()) {
        setMode('busy');
        return;
      }
      setOpenSessionId(sessionId);
      setTurns(nextTurns);
      setView('timeline');

      // Select the session in the picker + focus detail (master-detail).
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
        const win = Math.max(MIN_TURN_SLOTS, turnSlotsRef.current);
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
    [ensureService],
  );

  // Consume-once jump (D7: does not sticky-fight cursor after landing).
  useEffect(() => {
    if (jumpKey === undefined) return;
    if (jumpKey === lastJumpKey.current) return;
    lastJumpKey.current = jumpKey;
    if (!jump?.sessionId) return;
    // Ensure data is loaded before jumping.
    const svc = ensureService();
    if (!svc) return;
    if (!svc.schemaOK()) {
      setSchemaVersion(svc.getVersion());
      setMode('schema');
      return;
    }
    const list = svc.sessionList();
    if (svc.busy()) {
      setMode('busy');
      return;
    }
    setSessions(list);
    setMode(list.length === 0 ? 'empty' : 'ready');
    openTimeline(jump.sessionId, jump.eventId);
  }, [jumpKey, jump?.sessionId, jump?.eventId, ensureService, openTimeline]);

  // Keep session cursor in range + scroll window (slot count from height).
  useEffect(() => {
    if (sessionCursor >= sessions.length) {
      setSessionCursor(Math.max(0, sessions.length - 1));
    }
  }, [sessions.length, sessionCursor]);

  useEffect(() => {
    if (sessionCursor < sessionScroll) setSessionScroll(sessionCursor);
    else if (sessionCursor >= sessionScroll + sessionSlots) {
      setSessionScroll(sessionCursor - sessionSlots + 1);
    }
  }, [sessionCursor, sessionScroll, sessionSlots]);

  useEffect(() => {
    if (turnCursor >= turns.length) setTurnCursor(Math.max(0, turns.length - 1));
  }, [turns.length, turnCursor]);

  useEffect(() => {
    if (turnCursor < turnScroll) setTurnScroll(turnCursor);
    else if (turnCursor >= turnScroll + turnSlots) {
      setTurnScroll(turnCursor - turnSlots + 1);
    }
  }, [turnCursor, turnScroll, turnSlots]);

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');

    if (n === 'r') {
      refresh();
      return;
    }

    // Soft states that refuse navigation (still allow r).
    if (mode === 'missing' || mode === 'schema' || mode === 'loading') return;
    // busy/empty still allow picker nav if rows exist; empty has none.

    if (view === 'timeline') {
      if (n === 'escape' || n === 'backspace') {
        setView('picker');
        return;
      }
      if (n === 'up' || n === 'k') {
        setTurnCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (n === 'down' || n === 'j') {
        setTurnCursor((c) => Math.min(Math.max(0, turns.length - 1), c + 1));
        return;
      }
      return;
    }

    // Picker view
    if (n === 'up' || n === 'k') {
      setSessionCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (n === 'down' || n === 'j') {
      setSessionCursor((c) => Math.min(Math.max(0, sessions.length - 1), c + 1));
      return;
    }
    if (n === 'return' || n === 'enter' || n === 'o') {
      const sel = sessions[sessionCursor];
      if (sel) openTimeline(sel.id);
    }
  });

  const sessionSlice = sessions.slice(sessionScroll, sessionScroll + sessionSlots);
  const turnSlice = turns.slice(turnScroll, turnScroll + turnSlots);

  const openSession = useMemo(
    () => (openSessionId ? sessions.find((s) => s.id === openSessionId) ?? null : null),
    [openSessionId, sessions],
  );

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
    if (mode === 'empty') {
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
          {Array.from({ length: Math.max(0, sessionSlots - 1) }, (_, i) => (
            <FixedClearRow
              key={`e-${i}`}
              width={pickerInnerW}
              color={t.muted}
              text={emptyRow(pickerInnerW)}
            />
          ))}
        </box>
      );
    }
    return (
      <box flexDirection="column" flexShrink={0}>
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
        {Array.from({ length: sessionSlots }, (_, i) => {
          const row = sessionSlice[i];
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
          const absIdx = sessionScroll + i;
          const selected = absIdx === sessionCursor && view === 'picker';
          return (
            <FixedClearRow
              key={`s-${row.id}-${i}`}
              width={pickerInnerW}
              color={selected ? t.info : t.foreground}
              text={padRow(formatSessionLine(row, selected), pickerInnerW)}
            />
          );
        })}
      </box>
    );
  }, [
    softOnly,
    mode,
    banners,
    pickerInnerW,
    t,
    sessionSlice,
    sessions.length,
    sessionScroll,
    sessionCursor,
    sessionSlots,
    view,
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

  const timelineBody = useMemo(() => {
    if (!openSessionId) {
      return (
        <box flexDirection="column" flexShrink={0}>
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
        <box flexDirection="column" flexShrink={0}>
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
    return (
      <box flexDirection="column" flexShrink={0}>
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
              text={padRow(formatTurnLine(row, selected), timelineInnerW)}
            />
          );
        })}
      </box>
    );
  }, [
    view,
    openSessionId,
    turns.length,
    turnSlice,
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
                ? `${sessions.length} sess · ${turns.length} evt`
                : `${sessions.length} sessions`;

  // Footer is two-pane-aware but keeps E2E tokens (↑↓ / select / enter timeline / j/k).
  const footer =
    mode === 'missing' || mode === 'schema'
      ? 'r refresh'
      : view === 'timeline'
        ? twoPane
          ? '↑↓ j/k turns · esc sessions · r refresh'
          : '↑↓ j/k turns · esc picker · r refresh'
        : '↑↓ select · enter timeline · r refresh';

  const pickerRight =
    mode === 'ready' || mode === 'busy'
      ? `${sessions.length}`
      : mode === 'empty'
        ? '0'
        : undefined;

  const timelineRight = openSessionId
    ? turns.length > 0
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
      flexGrow={twoPane ? 1 : 0}
      flexShrink={twoPane ? 1 : 0}
      minHeight={0}
    >
      <box flexDirection="column" flexShrink={0} backgroundColor={t.background}>
        <FixedClearRow
          width={timelineInnerW}
          color={infoRows.titleColor}
          text={padRow(infoRows.title, timelineInnerW)}
        />
        <FixedClearRow
          width={timelineInnerW}
          color={infoRows.factsColor}
          text={padRow(infoRows.facts, timelineInnerW)}
        />
        {timelineBody}
      </box>
    </Card>
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
      {timelineColumn}
    </box>
  ) : (
    <box flexDirection="column" flexShrink={0} backgroundColor={t.background}>
      {pickerColumn}
      <box height={1} flexShrink={0} backgroundColor={t.background} />
      {timelineColumn}
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
          {padRow(footer, Math.max(16, dims.width - 2))}
        </text>
      </box>
    </box>
  );
}
