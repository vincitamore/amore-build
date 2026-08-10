/**
 * Microscope stage — session picker + kind-colored turn timeline.
 * Reads the derived index through openQueryService (readonly); never writes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { Panel } from '../components/Panel';
import { useStableDimensions } from '../use-stable-dimensions';
import { useRefreshOnActive } from '../use-refresh-on-active';
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

const SESSION_SLOTS = 8;
const TURN_SLOTS = 12;
const EMPTY_INDEX_COPY = "no speculum index — run 'speculum ingest'";
const EMPTY_CORPUS_COPY = "no ingested sessions — run 'speculum ingest'";

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

/** Full fixed-width session picker line. */
export function formatSessionLine(s: SessionListRow, selected: boolean, now = Date.now()): string {
  const prefix = selected ? '>' : ' ';
  const id = s.id.length > 12 ? `${s.id.slice(0, 11)}\u2026` : s.id;
  const age = relAge(s.startedAt, now);
  const counts = `t:${s.turnCount} e:${s.eventCount}`;
  const proj = projectBasename(s.projectPath);
  return `${prefix}${id}  ${age}  ${counts}  ${proj}`;
}

/** Full fixed-width turn timeline line (includes eventId grain). */
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

      // Select the session in the picker.
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
      // Scroll window so the target is visible.
      setTurnScroll((sc) => {
        if (cursor < sc) return cursor;
        if (cursor >= sc + TURN_SLOTS) return Math.max(0, cursor - TURN_SLOTS + 1);
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

  // Keep session cursor in range + window window.
  useEffect(() => {
    if (sessionCursor >= sessions.length) {
      setSessionCursor(Math.max(0, sessions.length - 1));
    }
  }, [sessions.length, sessionCursor]);

  useEffect(() => {
    if (sessionCursor < sessionScroll) setSessionScroll(sessionCursor);
    else if (sessionCursor >= sessionScroll + SESSION_SLOTS) {
      setSessionScroll(sessionCursor - SESSION_SLOTS + 1);
    }
  }, [sessionCursor, sessionScroll]);

  useEffect(() => {
    if (turnCursor >= turns.length) setTurnCursor(Math.max(0, turns.length - 1));
  }, [turns.length, turnCursor]);

  useEffect(() => {
    if (turnCursor < turnScroll) setTurnScroll(turnCursor);
    else if (turnCursor >= turnScroll + TURN_SLOTS) {
      setTurnScroll(turnCursor - TURN_SLOTS + 1);
    }
  }, [turnCursor, turnScroll]);

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

  // Nested under SessionsMember: member pad (2) + stage pad (2) + panel border (2) + panel pad (2) = 8.
  const rowW = Math.max(16, dims.width - 8);
  const sessionSlice = sessions.slice(sessionScroll, sessionScroll + SESSION_SLOTS);
  const turnSlice = turns.slice(turnScroll, turnScroll + TURN_SLOTS);

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

  const pickerBody = useMemo(() => {
    if (mode === 'missing' || mode === 'schema' || mode === 'loading') {
      return (
        <box flexDirection="column" flexShrink={0}>
          {banners.map((b, i) => (
            <FixedClearRow key={`b-${i}`} width={rowW} color={b.color} text={padRow(b.text, rowW)} />
          ))}
        </box>
      );
    }
    if (mode === 'empty') {
      return (
        <box flexDirection="column" flexShrink={0}>
          {banners.map((b, i) => (
            <FixedClearRow key={`b-${i}`} width={rowW} color={b.color} text={padRow(b.text, rowW)} />
          ))}
          {Array.from({ length: SESSION_SLOTS - 1 }, (_, i) => (
            <FixedClearRow key={`e-${i}`} width={rowW} color={t.muted} text={emptyRow(rowW)} />
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
                width={rowW}
                color={b.color}
                text={padRow(b.text, rowW)}
              />
            ))
          : null}
        {Array.from({ length: SESSION_SLOTS }, (_, i) => {
          const row = sessionSlice[i];
          if (!row) {
            return (
              <FixedClearRow
                key={`s-${i}`}
                width={rowW}
                color={t.muted}
                text={
                  i === 0 && sessions.length === 0
                    ? padRow(EMPTY_CORPUS_COPY, rowW)
                    : emptyRow(rowW)
                }
              />
            );
          }
          const absIdx = sessionScroll + i;
          const selected = absIdx === sessionCursor && view === 'picker';
          return (
            <FixedClearRow
              key={`s-${row.id}-${i}`}
              width={rowW}
              color={selected ? t.info : t.foreground}
              text={padRow(formatSessionLine(row, selected), rowW)}
            />
          );
        })}
      </box>
    );
  }, [
    mode,
    banners,
    rowW,
    t,
    sessionSlice,
    sessions.length,
    sessionScroll,
    sessionCursor,
    view,
  ]);

  const timelineBody = useMemo(() => {
    if (view !== 'timeline' || !openSessionId) {
      return (
        <FixedClearRow
          width={rowW}
          color={t.muted}
          text={padRow(
            mode === 'ready' ? 'enter a session to open its timeline' : '',
            rowW,
          )}
        />
      );
    }
    if (turns.length === 0) {
      return (
        <FixedClearRow
          width={rowW}
          color={t.muted}
          text={padRow('no events in session', rowW)}
        />
      );
    }
    return (
      <box flexDirection="column" flexShrink={0}>
        {Array.from({ length: TURN_SLOTS }, (_, i) => {
          const row = turnSlice[i];
          if (!row) {
            return (
              <FixedClearRow key={`t-${i}`} width={rowW} color={t.muted} text={emptyRow(rowW)} />
            );
          }
          const absIdx = turnScroll + i;
          const selected = absIdx === turnCursor;
          const color = selected ? t.info : kindColor(row.kind, t, row.toolError);
          return (
            <FixedClearRow
              key={`t-${row.eventId}-${i}`}
              width={rowW}
              color={color}
              text={padRow(formatTurnLine(row, selected), rowW)}
            />
          );
        })}
      </box>
    );
  }, [view, openSessionId, turns.length, turnSlice, turnScroll, turnCursor, rowW, t, mode]);

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

  const footer =
    mode === 'missing' || mode === 'schema'
      ? 'r refresh'
      : view === 'timeline'
        ? '↑↓ j/k turns · esc picker · r refresh'
        : '↑↓ select · enter timeline · r refresh';

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
        <box flexDirection="column" flexShrink={0}>
          <FixedClearRow
            width={rowW}
            color={t.muted}
            text={padRow('sessions', rowW)}
          />
          {pickerBody}
          <FixedClearRow
            width={rowW}
            color={t.muted}
            text={padRow(
              openSessionId
                ? `timeline ${openSessionId.length > 24 ? `${openSessionId.slice(0, 23)}\u2026` : openSessionId}`
                : 'timeline',
              rowW,
            )}
          />
          {timelineBody}
        </box>
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
