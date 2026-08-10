import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { useStableDimensions } from '../use-stable-dimensions';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { runSpeculum, type SpeculumResult } from './speculum-spawn';

/** One hit row from a probe (subset of the CLI shape). */
export interface ProbeHit {
  sessionId: string;
  ts?: string;
  evidence: string;
  category?: string;
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

const BOARD_SLOTS = 6;
const HIT_SLOTS = 3;
const INSTALL_RECIPE = 'amore init --with-speculum';

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

function formatHitLine(h: ProbeHit): string {
  const parts = [`${h.sessionId}`];
  if (h.ts) parts.push(h.ts);
  if (h.category) parts.push(h.category);
  parts.push(h.evidence ?? '');
  return parts.join('  ');
}

function formatProbeLine(row: ScanRow, selected: boolean): string {
  const prefix = selected ? '>' : ' ';
  const val = formatProbeValue(row.value, row.unit);
  const ci = formatWilsonRange(row.ciLow, row.ciHigh);
  const hits = row.hits && row.hits.length > 0 ? ` hits:${row.hits.length}` : '';
  const banner = row.heuristic ? ' [heuristic]' : '';
  const summary = row.summary ? `  ${row.summary}` : '';
  return `${prefix}${row.probe}  ${val}  ${ci}${hits}${banner}${summary}`;
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
  const tail = err.stderrTail?.trim() || err.stdoutTail?.trim() || '';
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
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const [rows, setRows] = useState<ScanRow[] | null>(null);
  const [error, setError] = useState<ProbesError | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [hitsOpen, setHitsOpen] = useState(false);
  const [scroll, setScroll] = useState(0);
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await runSpeculum<ScanRow[]>('scan', ['--json']);
    if (!aliveRef.current) return;
    if (r.ok) {
      const data = Array.isArray(r.json) ? r.json : [];
      setRows(data);
      setError(null);
      setCursor((c) => Math.min(c, Math.max(0, data.length - 1)));
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

  useEffect(() => {
    if (cursor >= list.length) setCursor(Math.max(0, list.length - 1));
  }, [list.length, cursor]);

  useEffect(() => {
    // Keep selection inside the visible board window.
    if (cursor < scroll) setScroll(cursor);
    else if (cursor >= scroll + BOARD_SLOTS) setScroll(cursor - BOARD_SLOTS + 1);
  }, [cursor, scroll]);

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'r') {
      void load();
      return;
    }
    if (error || !rows) return;
    if (n === 'up') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (n === 'down') {
      setCursor((c) => Math.min(Math.max(0, list.length - 1), c + 1));
      return;
    }
    if (n === 'return' || n === 'enter' || n === 'h') {
      setHitsOpen((o) => !o);
      return;
    }
    if (n === 'escape' && hitsOpen) {
      setHitsOpen(false);
    }
  });

  const rowW = Math.max(16, dims.width - 6);
  const slice = list.slice(scroll, scroll + BOARD_SLOTS);

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
    return (
      <box flexDirection="column" flexShrink={0}>
        {Array.from({ length: BOARD_SLOTS }, (_, i) => {
          const row = slice[i];
          if (!row) {
            return (
              <FixedClearRow
                key={`p-${i}`}
                width={rowW}
                color={t.muted}
                text={
                  i === 0 && list.length === 0
                    ? padRow('no probes returned', rowW)
                    : emptyRow(rowW)
                }
              />
            );
          }
          const absIdx = scroll + i;
          const selectedRow = absIdx === cursor;
          const color = selectedRow ? t.info : t.foreground;
          return (
            <FixedClearRow
              key={`p-${row.probe}-${i}`}
              width={rowW}
              color={color}
              text={padRow(formatProbeLine(row, selectedRow), rowW)}
            />
          );
        })}
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
            {Array.from({ length: HIT_SLOTS }, (_, i) => {
              const h = hits[i];
              if (!h) {
                return (
                  <FixedClearRow
                    key={`h-${i}`}
                    width={rowW}
                    color={t.muted}
                    text={emptyRow(rowW)}
                  />
                );
              }
              return (
                <FixedClearRow
                  key={`h-${i}-${h.sessionId}`}
                  width={rowW}
                  color={t.foreground}
                  text={padRow(`  ${formatHitLine(h)}`, rowW)}
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
    t,
    slice,
    list.length,
    scroll,
    cursor,
    hitsOpen,
    selected,
    hits,
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
      ? 'up/dn · enter/h close hits · r refresh'
      : 'up/dn · enter/h hits · r refresh';

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      backgroundColor={t.background}
    >
      <Panel title="Probes" headerRight={headerRight} flexGrow={1} flexShrink={1} minHeight={0} active={!!inputActive}>
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
          {padRow(footer, Math.max(16, dims.width - 2))}
        </text>
      </box>
    </box>
  );
}
