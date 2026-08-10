/**
 * Sessions Search stage — debounced FTS over the derived index.
 * Open-on-hit hands the shell's openSession spine (sessionId + eventId).
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
import { MIN_SEARCH_HIT_SLOTS, seedStageBox } from './sessions-layout';

/** Debounce before FTS read (ms). */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Local stage chrome against residual host:
 * padTop 1 + panel 3 + input 1 + status 1 + stage footer 1 = 7.
 */
export const SEARCH_STAGE_CHROME = 7;
const IDLE_HINT = 'type to search sessions';
const NO_MATCH = 'no matches';
const PENDING = 'pending…';
const MISSING_COPY = "index not found — run 'speculum ingest'";
const BUSY_COPY = 'corpus busy';

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
};

/** Trim; empty / whitespace → '' (skip FTS). */
export function parseQuery(raw: string): string {
  return (raw ?? '').trim();
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
}: SearchStageProps) {
  const t = usePalette();
  const dims = useStableDimensions();
  const stageBox = stageBoxProp ?? seedStageBox(dims.width, dims.height);
  const listHostH = Math.max(1, stageBox.height - SEARCH_STAGE_CHROME);
  const hitSlots = Math.max(MIN_SEARCH_HIT_SLOTS, Math.floor(listHostH));
  const inputRef = useRef<{ value?: string } | null>(null);
  const qsRef = useRef<QueryService | null>(null);
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const onOpenRef = useRef(onOpenSession);
  onOpenRef.current = onOpenSession;

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pending, setPending] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [missing, setMissing] = useState(false);
  const [schemaOk, setSchemaOk] = useState(true);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [busy, setBusy] = useState(false);

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

  const runSearch = useCallback((q: string) => {
    const qs = qsRef.current;
    if (!qs || missing) {
      if (aliveRef.current) {
        setHits([]);
        setPending(false);
        setBusy(false);
      }
      return;
    }
    if (!qs.schemaOK()) {
      if (aliveRef.current) {
        setSchemaOk(false);
        setSchemaVersion(qs.getVersion());
        setHits([]);
        setPending(false);
      }
      return;
    }
    try {
      const rows = qs.search(q, { limit: 40 });
      if (!aliveRef.current) return;
      setHits(rows);
      setCursor(0);
      setScroll(0);
      setBusy(qs.busy());
      setSchemaOk(qs.schemaOK());
      setSchemaVersion(qs.getVersion());
    } catch {
      if (!aliveRef.current) return;
      setHits([]);
      setBusy(true);
    } finally {
      if (aliveRef.current) setPending(false);
    }
  }, [missing]);

  // Debounced FTS — skip empty/whitespace; show pending while waiting + in flight.
  useEffect(() => {
    const q = parseQuery(query);
    if (!q) {
      setHits([]);
      setPending(false);
      setCursor(0);
      setScroll(0);
      return;
    }
    if (missing || !schemaOk) {
      setHits([]);
      setPending(false);
      return;
    }
    setPending(true);
    const timer = setTimeout(() => {
      runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, missing, schemaOk, runSearch]);

  useEffect(() => {
    if (cursor >= hits.length) setCursor(Math.max(0, hits.length - 1));
  }, [hits.length, cursor]);

  useEffect(() => {
    if (cursor < scroll) setScroll(cursor);
    else if (cursor >= scroll + hitSlots) setScroll(cursor - hitSlots + 1);
  }, [cursor, scroll, hitSlots]);

  const openHit = useCallback((hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpenRef.current?.(hit.sessionId, { eventId: hit.eventId });
    onFlashRef.current?.(`open ${hit.sessionId} #${hit.eventId}`);
  }, []);

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
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
      <box flexDirection="column" flexShrink={0}>
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
      : 'type · up/dn · enter open';

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
