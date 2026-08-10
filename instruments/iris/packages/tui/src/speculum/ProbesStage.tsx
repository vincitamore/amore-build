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
import { MIN_HIT_SLOTS, seedStageBox } from './sessions-layout';
import {
  Card,
  CardGrid,
  cardInnerWidth,
  cardsPerRow,
  cardWidthForRow,
  padTruncate,
} from './Card';

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

export type ProbesError = Extract<SpeculumResult<unknown>, { ok: false }>['error'];

const INSTALL_RECIPE = 'amore init --with-speculum';
/** Outer floor for a probe card; board is 2-up when it fits, else 1-up. */
const MIN_PROBE_CARD = 36;
const GRID_GAP = 1;
/** Rough rows per card (border + title + body + margin). */
const CARD_ROW_H = 4;
/**
 * Local stage chrome charged against the residual host (not terminal height):
 * padTop 1 + panel border/title 3 + stage footer 1 + range line 1 = 6.
 */
export const PROBES_STAGE_CHROME = 6;

/**
 * Min card width that keeps the board at most 2-up (house probe board).
 * Floor is MIN_PROBE_CARD so a narrow strip collapses to 1-up.
 */
export function probeMinCardWidth(rowWidth: number, gap = GRID_GAP): number {
  // cardsPerRow = floor((w+g)/(min+g)); force ≤2 → min > (w+g)/3 − g
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
  // msg-unit rates in the live CLI are still proportions in [0,1].
  if (unit === 'msg' && value >= 0 && value <= 1 && !Number.isInteger(value)) {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (unit === 'msg' && value >= 0 && value <= 1) {
    // Integer 0/1 on msg unit: still a count-ish value; show plain.
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
 * `gridRowsH` is the card grid's claimed height; `hitsHeaderRows` is 1 when the
 * drill is open (header charged only when present). Always ≥ MIN_HIT_SLOTS.
 */
export function budgetHitSlots(
  bodyH: number,
  gridRowsH: number,
  hitsHeaderRows: number = 1,
): number {
  return Math.max(
    MIN_HIT_SLOTS,
    Math.floor(bodyH - Math.max(0, gridRowsH) - Math.max(0, hitsHeaderRows)),
  );
}

/**
 * Visible card-grid rows from Panel-body residual height.
 * When the hits drill is open, leave residual height for the hits panel
 * (prefer hits growth — no hard mini-grid clamp).
 */
export function budgetProbeVisibleRows(
  bodyH: number,
  hitsOpen: boolean,
  cardRowH: number = CARD_ROW_H,
): number {
  const h = Math.max(1, Math.floor(bodyH));
  const crh = Math.max(1, cardRowH);
  if (!hitsOpen) {
    return Math.max(1, Math.min(6, Math.floor(Math.max(4, h) / crh)));
  }
  // Prefer hits: ~2/3 of body after header is owned by hit slots.
  const body = Math.max(crh + 1, h - 1 /* hits header */);
  const targetHits = Math.max(4, Math.floor((body * 2) / 3));
  const maxGrid = Math.max(1, Math.floor((body - 1) / crh));
  const fromTarget = Math.max(1, Math.floor((body - targetHits) / crh));
  return Math.max(1, Math.min(maxGrid, fromTarget));
}

/**
 * Keep the hit cursor inside the hit-scroll window (cursor-following).
 * Pure — unit-tested without mounting OpenTUI.
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

/** Max title width in a probe hit row (id stays secondary). */
const HIT_TITLE_MAX = 28;

/** Truncate a label to maxLen with an ellipsis; no wrap. */
export function truncateHitLabel(text: string, maxLen: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(1, maxLen - 1))}…`;
}

/**
 * One fixed hit row: title (when known) with id secondary · ts · category · evidence.
 * Selection marker is a leading `>` (house list register).
 */
export function formatHitLine(
  h: ProbeHit,
  selected: boolean,
  titleById?: ReadonlyMap<string, string>,
): string {
  const mark = selected ? '>' : ' ';
  const title = titleById?.get(h.sessionId)?.trim() ?? '';
  const sid =
    h.sessionId.length > 14 ? `${h.sessionId.slice(0, 13)}…` : h.sessionId;
  const head = title
    ? `${truncateHitLabel(title, HIT_TITLE_MAX)}  (${sid})`
    : h.sessionId;
  const parts = [head];
  if (h.ts) parts.push(h.ts);
  if (h.category) parts.push(h.category);
  parts.push(h.evidence ?? '');
  return `${mark}${parts.join('  ·  ')}`;
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
  // Soft-state honesty when the CLI reports a missing / locked / schema-skew index.
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

export function ProbesStage({
  inputActive,
  onFlash,
  onOpenSession,
  stageBox: stageBoxProp,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  onOpenSession?: (
    sessionId: string,
    opts?: { eventId?: string | number; ts?: string },
  ) => void;
  /** Residual host box from SessionsMember; optional for isolated stage smokes. */
  stageBox?: MeasuredSize;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const stageBox = stageBoxProp ?? seedStageBox(dims.width, dims.height);
  const [rows, setRows] = useState<ScanRow[] | null>(null);
  const [error, setError] = useState<ProbesError | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [hitsOpen, setHitsOpen] = useState(false);
  const [hitCursor, setHitCursor] = useState(0);
  const [hitScroll, setHitScroll] = useState(0);
  const [rowScroll, setRowScroll] = useState(0);
  /** id → title map for hit rows (readonly index read at drill-open). */
  const [titleById, setTitleById] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const onOpenRef = useRef(onOpenSession);
  onOpenRef.current = onOpenSession;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Cheap readonly title map when the hits drill opens (id secondary, title primary).
  useEffect(() => {
    if (!hitsOpen) return;
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
      // Missing / locked index — hit rows fall back to id-only labels.
      if (aliveRef.current) setTitleById(new Map());
    }
  }, [hitsOpen]);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await runSpeculum<ScanRow[]>('scan', ['--json']);
    if (!aliveRef.current) return;
    if (r.ok) {
      const data = Array.isArray(r.json) ? r.json : [];
      setRows(data);
      setError(null);
      setCursor((c) => Math.min(c, Math.max(0, data.length - 1)));
      setHitsOpen(false);
      setHitCursor(0);
      setHitScroll(0);
      onFlashRef.current?.('scan updated');
    } else {
      setRows(null);
      setError(r.error);
      onFlashRef.current?.(`scan failed: ${r.error.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshOnActive(inputActive, () => {
    void load();
  });

  const list = rows ?? [];
  const selected = list[Math.min(cursor, Math.max(0, list.length - 1))] ?? null;
  const hits = selected?.hits ?? [];

  // Width from residual host (stage pad L/R charged locally).
  const rowW = Math.max(16, stageBox.width - 4);
  const minCard = probeMinCardWidth(rowW, GRID_GAP);
  const perRow = Math.min(2, cardsPerRow(rowW, minCard, GRID_GAP));
  // Budget grid rows + hit slots from residual host height (grow-by-height).
  const bodyH = Math.max(1, stageBox.height - PROBES_STAGE_CHROME);
  const visibleRows = budgetProbeVisibleRows(bodyH, hitsOpen, CARD_ROW_H);
  // When the drill is open, charge only the card rows that actually paint — a
  // short probe list leaves residual height for the hits panel, not phantom rows.
  const filledGridRows = hitsOpen
    ? Math.max(
        1,
        Math.min(
          visibleRows,
          Math.max(1, Math.ceil(list.length / Math.max(1, perRow))),
        ),
      )
    : visibleRows;
  const gridRowsH = filledGridRows * CARD_ROW_H;
  const hitSlots = hitsOpen ? budgetHitSlots(bodyH, gridRowsH, 1) : 1;

  useEffect(() => {
    if (cursor >= list.length) setCursor(Math.max(0, list.length - 1));
  }, [list.length, cursor]);

  useEffect(() => {
    setRowScroll((s) => clampRowScroll(cursor, s, visibleRows, perRow));
  }, [cursor, visibleRows, perRow]);

  useEffect(() => {
    // Changing the selected probe resets the hits panel selection + scroll.
    setHitCursor(0);
    setHitScroll(0);
  }, [cursor]);

  useEffect(() => {
    if (!hitsOpen) return;
    setHitScroll((s) => clampHitScroll(hitCursor, s, hitSlots, hits.length));
  }, [hitsOpen, hitCursor, hitSlots, hits.length]);

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

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'r') {
      void load();
      return;
    }
    if (error || !rows) return;

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
      return;
    }

    if (n === 'up') {
      setCursor((c) => moveProbeCursor(c, 'up', list.length, perRow));
      return;
    }
    if (n === 'down') {
      setCursor((c) => moveProbeCursor(c, 'down', list.length, perRow));
      return;
    }
    if (n === 'left') {
      setCursor((c) => moveProbeCursor(c, 'left', list.length, perRow));
      return;
    }
    if (n === 'right') {
      setCursor((c) => moveProbeCursor(c, 'right', list.length, perRow));
      return;
    }
    if (n === 'return' || n === 'enter' || n === 'h') {
      setHitsOpen(true);
      setHitCursor(0);
      setHitScroll(0);
      return;
    }
  });

  const range = probeVisibleRange(list.length, rowScroll, visibleRows, perRow);
  const gridStart = Math.max(0, (range.first || 1) - 1);
  const gridEnd = range.last;
  const visibleList = list.slice(gridStart, gridEnd);
  const cardW = cardWidthForRow(rowW, Math.min(perRow, Math.max(1, visibleList.length || 1)), GRID_GAP);
  const innerW = cardInnerWidth(cardW);

  const body = useMemo(() => {
    if (loading && !rows && !error) {
      return (
        <FixedClearRow width={rowW} color={t.muted} text={padRow('loading scan…', rowW)} />
      );
    }
    if (error) {
      const copy = errorCopy(error);
      return (
        <box flexDirection="column" flexShrink={0}>
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
        <FixedClearRow width={rowW} color={t.muted} text={padRow('no probes returned', rowW)} />
      );
    }

    const rangeLabel =
      list.length === 0
        ? 'probes 0 of 0'
        : `probes ${range.first}–${range.last} of ${list.length}`;

    return (
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        <FixedClearRow
          width={rowW}
          color={t.muted}
          text={padRow(`${rangeLabel} · ↑↓←→ select · enter drill`, rowW)}
        />
        <CardGrid width={rowW} minCardWidth={minCard} gap={GRID_GAP}>
          {visibleList.map((row, i) => {
            const absIdx = gridStart + i;
            const isSel = absIdx === cursor;
            const hitN = row.hits?.length ?? 0;
            // Body keeps the raw probe id (lowercase) so headless name asserts still
            // see the registry slug — Card titles are forced ALL-CAPS.
            const summary =
              row.summary ??
              `${formatProbeValue(row.value, row.unit)}  n=${row.n}`;
            // One body row always (equal card height). hits N uses warning ink.
            const bodyLine =
              hitN > 0
                ? `hits ${hitN}  ${row.probe}  ${summary}`
                : `${row.probe}  ${summary}`;
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
                }}
              >
                <box height={1} flexShrink={0} overflow="hidden">
                  <text fg={hitN > 0 ? t.warning : t.muted} wrapMode="none">
                    {padTruncate(bodyLine, innerW)}
                  </text>
                </box>
              </Card>
            );
          })}
        </CardGrid>

        {hitsOpen && selected ? (
          <box flexDirection="column" flexShrink={0} marginTop={0}>
            <FixedClearRow
              width={rowW}
              color={t.muted}
              text={padRow(
                hits.length > 0
                  ? `hits (${hits.length}) for ${selected.probe}`
                  : `hits (none) for ${selected.probe}`,
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
                  text={padRow(formatHitLine(h, selHit, titleById), rowW)}
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
    visibleList,
    gridStart,
    cursor,
    cardW,
    innerW,
    hitsOpen,
    selected,
    hits,
    hitCursor,
    hitScroll,
    hitSlots,
    titleById,
  ]);

  const headerRight = error
    ? error.kind
    : loading && !rows
      ? 'loading'
      : list.length > 0
        ? `${list.length} probes`
        : 'empty';

  const footer = error
    ? `r retry · ${error.kind}`
    : hitsOpen
      ? hits.length > 0
        ? '↑↓ hit · enter open session · h/esc close · r refresh'
        : 'hits (none) · h/esc close · r refresh'
      : '↑↓←→ select · enter/h drill · r refresh';

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
