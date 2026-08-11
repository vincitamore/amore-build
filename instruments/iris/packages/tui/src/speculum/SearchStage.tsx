/**
 * Sessions Search stage — debounced FTS over the derived index.
 * Open-on-hit hands the shell's openSession spine (sessionId + eventId).
 * Chip filters (kind / window / scope) compose after FTS; the always-focused
 * input owns plain keys — chips are click or ctrl-key driven.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { useStableDimensions } from '../use-stable-dimensions';
import type { MeasuredSize } from '../use-measured-size';
import {
  openQueryService,
  SUPPORTED_SCHEMA_VERSIONS,
  type QueryService,
  type SearchHit,
} from './query-service';
import { seedStageBox } from './sessions-layout';

/** Debounce before FTS read (ms). */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Local stage chrome against residual host:
 * padTop 1 + panel 3 + input 1 + chip row 1 + status 1 + stage footer 1 = 8.
 */
export const SEARCH_STAGE_CHROME = 8;
const IDLE_HINT = 'type to search sessions';
const NO_MATCH = 'no matches';
const PENDING = 'pending…';
const MISSING_COPY = "index not found — run 'speculum ingest'";
const BUSY_COPY = 'corpus busy';

/** Kind chip options (post-filter on hit.kind). */
export const SEARCH_KIND_OPTIONS = ['all', 'user', 'assistant', 'tool'] as const;
export type SearchKind = (typeof SEARCH_KIND_OPTIONS)[number];

/** Window chip options (post-filter on hit.ts when present). */
export const SEARCH_WIN_OPTIONS = ['all', '30d', '7d'] as const;
export type SearchWin = (typeof SEARCH_WIN_OPTIONS)[number];

/** Scope chip: corpus vs a handed-in session id. */
export type SearchScope = 'corpus' | 'session';

/**
 * Hit shape for post-filters. `ts` is optional — the query-service surface
 * currently omits it; window filtering applies only when present. Kind always
 * post-filters; session scope uses the existing `search(q, { sessionId })`.
 */
export type FilterableSearchHit = SearchHit & { ts?: string };

export type SearchStageProps = {
  inputActive?: boolean;
  onCapture?: (c: boolean) => void;
  onFlash?: (msg: string) => void;
  onOpenSession?: (
    sessionId: string,
    opts?: { eventId?: string | number; ts?: string },
  ) => void;
  /** Residual host box from SessionsMember; optional for isolated stage smokes. */
  stageBox?: MeasuredSize;
  /**
   * Session context when Search was reached from an open session / jump path.
   * When null, the scope chip stays corpus-only (session arm gated off).
   */
  scopeSession?: { id: string; title?: string } | null;
};

/** Trim; empty / whitespace → '' (skip FTS). */
export function parseQuery(raw: string): string {
  return (raw ?? '').trim();
}

/** Cycle a chip option list (wraps). */
export function cycleOption<T extends string>(
  options: readonly T[],
  current: T,
  dir: 1 | -1 = 1,
): T {
  const idx = options.indexOf(current);
  const i = idx < 0 ? 0 : idx;
  return options[(i + dir + options.length) % options.length]!;
}

/** Short label for a session scope chip. */
export function scopeChipLabel(
  scope: SearchScope,
  scopeSession: { id: string; title?: string } | null | undefined,
): string {
  if (scope !== 'session' || !scopeSession?.id) return 'corpus';
  const title = (scopeSession.title ?? '').replace(/\s+/g, ' ').trim();
  if (title) return title.length > 14 ? `${title.slice(0, 13)}\u2026` : title;
  const id = scopeSession.id;
  return id.length > 12 ? `${id.slice(0, 11)}\u2026` : id;
}

/** Inclusive lower bound ISO for a window chip (null = all). */
export function searchWinSince(win: SearchWin, now = new Date()): string | null {
  if (win === 'all') return null;
  const days = win === '7d' ? 7 : 30;
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

/**
 * Post-filter FTS hits by kind + window. Session scope is applied at the
 * query-service call (`search(q, { sessionId })`), not here.
 * Window needs `hit.ts`; hits without ts pass the window arm (fail-open on
 * missing timestamp so kind filters still work on today's index shape).
 */
export function filterSearchHits(
  hits: readonly FilterableSearchHit[],
  opts: { kind: SearchKind; win: SearchWin; now?: Date },
): FilterableSearchHit[] {
  const since = searchWinSince(opts.win, opts.now);
  return hits.filter((h) => {
    if (opts.kind !== 'all' && h.kind !== opts.kind) return false;
    if (since) {
      const ts = h.ts;
      if (typeof ts === 'string' && ts.length > 0) {
        if (ts < since) return false;
      }
      // no ts → keep (query-service does not yet surface event timestamps)
    }
    return true;
  });
}

/** Max title width in a search hit row (id stays secondary). */
const SEARCH_TITLE_MAX = 24;

/**
 * One fixed hit row: title (when known) · session prefix · kind · eventId · snippet.
 * Selection marker is a leading `>` (house list register).
 */
export function hitRowText(hit: SearchHit, selected: boolean): string {
  const mark = selected ? '>' : ' ';
  const sid =
    hit.sessionId.length > 14 ? `${hit.sessionId.slice(0, 13)}…` : hit.sessionId;
  const title = (hit.title ?? '').replace(/\s+/g, ' ').trim();
  const titlePart =
    title.length === 0
      ? ''
      : title.length <= SEARCH_TITLE_MAX
        ? `${title}  `
        : `${title.slice(0, SEARCH_TITLE_MAX - 1)}…  `;
  const kind = hit.kind || '?';
  const eid = String(hit.eventId);
  const snip = (hit.snippet ?? '').replace(/\s+/g, ' ').trim();
  return `${mark}${titlePart}${sid}  [${kind}]  #${eid}  ${snip}`;
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
  onMouseOver,
  onMouseDown,
  bg,
}: {
  text: string;
  width: number;
  color: RGBA;
  onMouseOver?: () => void;
  onMouseDown?: () => void;
  bg?: RGBA;
}) {
  const t = usePalette();
  const cell = text.length === width ? text : padRow(text, width);
  const backgroundColor = bg ?? t.background;
  return (
    <box
      height={1}
      width={width}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={backgroundColor}
      onMouseOver={onMouseOver}
      onMouseDown={onMouseDown}
    >
      <text fg={color} wrapMode="none">
        {cell}
      </text>
    </box>
  );
}

function schemaBanner(version: number): string {
  const need = SUPPORTED_SCHEMA_VERSIONS.join(',');
  return `schema v${version} unsupported (need ${need})`;
}

export function SearchStage({
  inputActive,
  onCapture,
  onFlash,
  onOpenSession,
  stageBox: stageBoxProp,
  scopeSession = null,
}: SearchStageProps) {
  const t = usePalette();
  const dims = useStableDimensions();
  const stageBox = stageBoxProp ?? seedStageBox(dims.width, dims.height);
  const listHostH = Math.max(1, stageBox.height - SEARCH_STAGE_CHROME);
  // Fit-clamp: one slot per residual row, never a MIN floor past the host.
  const hitSlots = Math.max(1, Math.floor(listHostH));
  const inputRef = useRef<{ value?: string } | null>(null);
  const qsRef = useRef<QueryService | null>(null);
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const onOpenRef = useRef(onOpenSession);
  onOpenRef.current = onOpenSession;

  const [query, setQuery] = useState('');
  const [rawHits, setRawHits] = useState<FilterableSearchHit[]>([]);
  const [pending, setPending] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [missing, setMissing] = useState(false);
  const [schemaOk, setSchemaOk] = useState(true);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<SearchKind>('all');
  const [win, setWin] = useState<SearchWin>('all');
  const [scope, setScope] = useState<SearchScope>('corpus');

  // Session scope only when a session context was handed in.
  const sessionScopeAvailable = !!(scopeSession && scopeSession.id);
  const effectiveScope: SearchScope =
    scope === 'session' && sessionScopeAvailable ? 'session' : 'corpus';

  // Drop session scope when the handoff clears.
  useEffect(() => {
    if (!sessionScopeAvailable && scope === 'session') setScope('corpus');
  }, [sessionScopeAvailable, scope]);

  // Open readonly query-service once; never write; close on unmount.
  useEffect(() => {
    aliveRef.current = true;
    try {
      const qs = openQueryService();
      qsRef.current = qs;
      setMissing(false);
      setSchemaOk(qs.schemaOK());
      setSchemaVersion(qs.getVersion());
      setBusy(qs.busy());
    } catch {
      qsRef.current = null;
      setMissing(true);
      setSchemaOk(true);
      setBusy(false);
    }
    return () => {
      aliveRef.current = false;
      try {
        qsRef.current?.close();
      } catch {
        // already closed
      }
      qsRef.current = null;
    };
  }, []);

  // Capture: while this stage is the active input surface the shell must not race printables.
  useEffect(() => {
    onCapture?.(!!inputActive);
  }, [inputActive, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  // Release capture + clear focus artifacts when the stage is hidden-but-mounted.
  useEffect(() => {
    if (!inputActive) {
      // Keep query/hits; only ensure we do not hold capture (effect above handles that).
    }
  }, [inputActive]);

  const runSearch = useCallback(
    (q: string, sessionId: string | undefined) => {
      const qs = qsRef.current;
      if (!qs || missing) {
        if (aliveRef.current) {
          setRawHits([]);
          setPending(false);
          setBusy(false);
        }
        return;
      }
      if (!qs.schemaOK()) {
        if (aliveRef.current) {
          setSchemaOk(false);
          setSchemaVersion(qs.getVersion());
          setRawHits([]);
          setPending(false);
        }
        return;
      }
      try {
        // Over-fetch so post-filters (kind/window) still have room after FTS rank.
        const rows = qs.search(q, {
          limit: 80,
          ...(sessionId ? { sessionId } : {}),
        }) as FilterableSearchHit[];
        if (!aliveRef.current) return;
        setRawHits(rows);
        setCursor(0);
        setScroll(0);
        setBusy(qs.busy());
        setSchemaOk(qs.schemaOK());
        setSchemaVersion(qs.getVersion());
      } catch {
        if (!aliveRef.current) return;
        setRawHits([]);
        setBusy(true);
      } finally {
        if (aliveRef.current) setPending(false);
      }
    },
    [missing],
  );

  // Debounced FTS — skip empty/whitespace; show pending while waiting + in flight.
  // Session scope re-runs the query (QS already supports { sessionId }).
  const scopeSessionId =
    effectiveScope === 'session' && scopeSession?.id ? scopeSession.id : undefined;

  useEffect(() => {
    const q = parseQuery(query);
    if (!q) {
      setRawHits([]);
      setPending(false);
      setCursor(0);
      setScroll(0);
      return;
    }
    if (missing || !schemaOk) {
      setRawHits([]);
      setPending(false);
      return;
    }
    setPending(true);
    const timer = setTimeout(() => {
      runSearch(q, scopeSessionId);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, missing, schemaOk, runSearch, scopeSessionId]);

  // Kind / window post-filter (compose with FTS results).
  const hits = useMemo(
    () => filterSearchHits(rawHits, { kind, win }),
    [rawHits, kind, win],
  );

  useEffect(() => {
    if (cursor >= hits.length) setCursor(Math.max(0, hits.length - 1));
  }, [hits.length, cursor]);

  useEffect(() => {
    if (cursor < scroll) setScroll(cursor);
    else if (cursor >= scroll + hitSlots) setScroll(cursor - hitSlots + 1);
  }, [cursor, scroll, hitSlots]);

  // Reset cursor when filters change.
  useEffect(() => {
    setCursor(0);
    setScroll(0);
  }, [kind, win, effectiveScope]);

  const openHit = useCallback((hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpenRef.current?.(hit.sessionId, { eventId: hit.eventId });
    onFlashRef.current?.(`open ${hit.sessionId} #${hit.eventId}`);
  }, []);

  const cycleKind = useCallback((dir: 1 | -1 = 1) => {
    setKind((k) => cycleOption(SEARCH_KIND_OPTIONS, k, dir));
  }, []);
  const cycleWin = useCallback((dir: 1 | -1 = 1) => {
    setWin((w) => cycleOption(SEARCH_WIN_OPTIONS, w, dir));
  }, []);
  const cycleScope = useCallback(() => {
    if (!sessionScopeAvailable) {
      onFlashRef.current?.('session scope needs a session context');
      return;
    }
    setScope((s) => (s === 'session' ? 'corpus' : 'session'));
  }, [sessionScopeAvailable]);

  useKeyboard((key: { name?: string; ctrl?: boolean; sequence?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    const ctrl = !!key.ctrl;

    // Chip chords — plain keys stay with the always-focused input.
    // Ctrl+K kind · Ctrl+W window · Ctrl+O scope (reliable in OpenTUI/Windows).
    if (ctrl && (n === 'k' || key.sequence === '\u000b')) {
      cycleKind(1);
      return;
    }
    if (ctrl && (n === 'w' || key.sequence === '\u0017')) {
      cycleWin(1);
      return;
    }
    if (ctrl && (n === 'o' || key.sequence === '\u000f')) {
      cycleScope();
      return;
    }

    if (n === 'up') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (n === 'down') {
      setCursor((c) => Math.min(Math.max(0, hits.length - 1), c + 1));
      return;
    }
    if (n === 'return' || n === 'enter') {
      const hit = hits[Math.min(cursor, Math.max(0, hits.length - 1))];
      openHit(hit);
      return;
    }
    // Printable keys fall through to the focused <input>.
  });

  const rowW = Math.max(16, stageBox.width - 4);
  const slice = hits.slice(scroll, scroll + hitSlots);
  const qTrim = parseQuery(query);

  const statusLine = useMemo(() => {
    if (missing) return MISSING_COPY;
    if (!schemaOk) return schemaBanner(schemaVersion);
    if (busy) return BUSY_COPY;
    if (!qTrim) return IDLE_HINT;
    if (pending) return PENDING;
    if (hits.length === 0) return NO_MATCH;
    return `${hits.length} hit${hits.length === 1 ? '' : 's'}`;
  }, [missing, schemaOk, schemaVersion, busy, qTrim, pending, hits.length]);

  const headerRight = useMemo(() => {
    if (missing) return 'missing';
    if (!schemaOk) return `v${schemaVersion}`;
    if (busy) return 'busy';
    if (pending && qTrim) return '…';
    if (qTrim && hits.length > 0) return String(hits.length);
    return 'search';
  }, [missing, schemaOk, schemaVersion, busy, pending, qTrim, hits.length]);

  const body = useMemo(() => {
    if (missing) {
      return (
        <FixedClearRow width={rowW} color={t.warning} text={padRow(MISSING_COPY, rowW)} />
      );
    }
    if (!schemaOk) {
      return (
        <FixedClearRow
          width={rowW}
          color={t.warning}
          text={padRow(schemaBanner(schemaVersion), rowW)}
        />
      );
    }
    if (busy && hits.length === 0) {
      return (
        <FixedClearRow width={rowW} color={t.muted} text={padRow(BUSY_COPY, rowW)} />
      );
    }

    return (
      <box flexDirection="column" flexShrink={0} overflow="hidden">
        {Array.from({ length: hitSlots }, (_, i) => {
          const hit = slice[i];
          if (!hit) {
            // Idle hint lives only on statusLine (once). Body slot 0 stays blank when idle
            // so fixed-clear rows do not stack the same copy under the status line.
            let placeholder = emptyRow(rowW);
            if (i === 0 && qTrim) {
              if (pending) placeholder = padRow(PENDING, rowW);
              else if (hits.length === 0) placeholder = padRow(NO_MATCH, rowW);
            }
            return (
              <FixedClearRow
                key={`s-${i}`}
                width={rowW}
                color={t.muted}
                text={placeholder}
              />
            );
          }
          const absIdx = scroll + i;
          const selected = absIdx === cursor;
          return (
            <FixedClearRow
              key={`s-${hit.eventId}-${i}`}
              width={rowW}
              color={selected ? t.info : t.foreground}
              bg={selected ? t.selection : undefined}
              text={padRow(hitRowText(hit, selected), rowW)}
              onMouseOver={() => setCursor(absIdx)}
              onMouseDown={() => openHit(hit)}
            />
          );
        })}
      </box>
    );
  }, [
    missing,
    schemaOk,
    schemaVersion,
    busy,
    hits.length,
    hitSlots,
    slice,
    scroll,
    cursor,
    qTrim,
    pending,
    rowW,
    t,
    openHit,
  ]);

  const footer = missing
    ? `run 'speculum ingest'`
    : !schemaOk
      ? 'schema mismatch — upgrade index'
      : 'type · ^k kind · ^w win · ^o scope · up/dn · enter open';

  const scopeLabel = scopeChipLabel(effectiveScope, scopeSession);
  const chipKind = (k: SearchKind) => {
    const on = k === kind;
    const label = k === 'assistant' ? 'asst' : k;
    return (
      <box
        key={`k-${k}`}
        flexShrink={0}
        marginRight={1}
        backgroundColor={on ? t.selection : t.background}
        onMouseDown={inputActive ? () => setKind(k) : undefined}
      >
        <text fg={on ? t.primary : t.muted} wrapMode="none">
          {on ? `[${label}]` : label}
        </text>
      </box>
    );
  };
  const chipWin = (w: SearchWin) => {
    const on = w === win;
    return (
      <box
        key={`w-${w}`}
        flexShrink={0}
        marginRight={1}
        backgroundColor={on ? t.selection : t.background}
        onMouseDown={inputActive ? () => setWin(w) : undefined}
      >
        <text fg={on ? t.primary : t.muted} wrapMode="none">
          {on ? `[${w}]` : w}
        </text>
      </box>
    );
  };

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
        title="Search"
        headerRight={headerRight}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        active={!!inputActive}
      >
        <input
          ref={inputRef as never}
          focused={!!inputActive}
          placeholder="search sessions…"
          backgroundColor={t.background}
          textColor={t.foreground}
          onInput={(v: string) => {
            setQuery(v);
            setCursor(0);
          }}
        />
        {/* Budgeted chip row: kind · win · scope (click / ctrl-key; input owns plain keys). */}
        <box
          flexDirection="row"
          flexShrink={0}
          height={1}
          overflow="hidden"
          backgroundColor={t.background}
        >
          <text fg={t.muted} wrapMode="none">
            kind:
          </text>
          {SEARCH_KIND_OPTIONS.map((k) => chipKind(k))}
          <text fg={t.muted} wrapMode="none">
            {' · win:'}
          </text>
          {SEARCH_WIN_OPTIONS.map((w) => chipWin(w))}
          <text fg={t.muted} wrapMode="none">
            {' · scope:'}
          </text>
          <box
            flexShrink={0}
            marginLeft={1}
            backgroundColor={
              effectiveScope === 'session' ? t.selection : t.background
            }
            onMouseDown={
              inputActive
                ? () => {
                    if (!sessionScopeAvailable) {
                      onFlashRef.current?.('session scope needs a session context');
                      return;
                    }
                    setScope((s) => (s === 'session' ? 'corpus' : 'session'));
                  }
                : undefined
            }
          >
            <text
              fg={
                effectiveScope === 'session'
                  ? t.primary
                  : sessionScopeAvailable
                    ? t.muted
                    : t.muted
              }
              wrapMode="none"
            >
              {effectiveScope === 'session'
                ? `[${scopeLabel}]`
                : sessionScopeAvailable
                  ? `corpus|${scopeChipLabel('session', scopeSession)}`
                  : 'corpus'}
            </text>
          </box>
        </box>
        <box flexShrink={0} backgroundColor={t.background}>
          <text fg={t.muted} wrapMode="none">
            {padRow(statusLine, rowW)}
          </text>
        </box>
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
