/**
 * Turn detail pane — third-level view under the Microscope timeline.
 * Renders one turn's full content (text, tool payloads) in a scrollable
 * fixed-slot body. Mounted by MicroscopeStage over the timeline card's area;
 * stays mounted and toggles with `visible` (never mount/unmount on open).
 *
 * Key ownership while visible: this pane owns j/k (scroll), [ / ] (step turn
 * via onStep — the timeline cursor follows), y (copy), p (path collapse),
 * esc (close via onClose). MicroscopeStage defers its handler while open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { copyText } from '../clipboard';
import { Card, CARD_CHROME } from './Card';
import {
  openQueryService,
  type QueryService,
  type TurnDetail as TurnDetailRow,
} from './query-service';

/** Footer hint the stage shows while the detail pane is open. */
export const TURN_DETAIL_FOOTER = 'j/k scroll · [ ] prev/next · y copy · p paths · esc close';

/** Vertical chrome a bordered titled Card spends outside content rows. */
export const DETAIL_CARD_V_CHROME = 3;
/** Head-cap for tool payload sections (lines before the +N more tail). */
export const TOOL_PAYLOAD_HEAD_CAP = 200;

export type TurnDetailProps = {
  /** Pane visibility — the component stays mounted either way. */
  visible: boolean;
  /** events.id of the turn under the timeline cursor; null when none. */
  eventId: number | null;
  /** Resolved title line of the open session ('' when absent). */
  sessionTitle: string;
  /** Keys enabled (stage input chain AND pane visible). */
  inputActive: boolean;
  /** Close back to the timeline (esc). */
  onClose: () => void;
  /** Step the timeline cursor without closing; the pane re-targets. */
  onStep: (delta: 1 | -1) => void;
  /** Flash line for confirms (clipboard copy). */
  onFlash?: (msg: string) => void;
  /** Explicit index path (test seam; wins over env resolution). */
  path?: string;
  /** Outer width of the area the pane may paint (the timeline card's slot). */
  width: number;
  /** Rows available to the pane's host (same budget the timeline card gets). */
  height: number;
};

export type DetailLineTone = 'header' | 'title' | 'body' | 'section' | 'muted' | 'error';

export type DetailLine = {
  text: string;
  tone: DetailLineTone;
};

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Wall-clock HH:MM (UTC) from an event timestamp. */
export function formatEventTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Path → final path segment (works for / and \\ separators). */
export function fileBasename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Windows drive path or UNC-ish segment; replace match with basename. */
const WIN_ABS =
  /(?:[A-Za-z]:|\\\\)[^\\/:*?"<>|\r\n]*(?:\\[^\\/:*?"<>|\r\n]*)+/g;
/** Posix absolute paths with ≥2 segments. */
const POSIX_ABS = /(?:\/[\w.+@-]+){2,}/g;

/** Absolute paths → basenames; relative prose untouched. */
export function collapseAbsolutePaths(text: string): string {
  return text
    .replace(WIN_ABS, (m) => fileBasename(m))
    .replace(POSIX_ABS, (m) => fileBasename(m));
}

/**
 * Kind → palette semantic color.
 * user=primary · assistant=foreground · tool_use/usage/plan/task=info ·
 * tool_result/system=muted · tool_error (or toolError flag)=error · default=muted
 */
export function kindColor(kind: string, t: Palette, toolError?: boolean): RGBA {
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

/** toolError column is string ('0'/'1'/''); '1' means errored. */
export function isToolErrored(toolError: string | null | undefined): boolean {
  if (toolError == null || toolError === '') return false;
  return toolError === '1' || toolError === 'true';
}

/** Pretty-print when JSON-parseable; otherwise return raw text. */
export function prettyPayload(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  try {
    const v = JSON.parse(s) as unknown;
    return JSON.stringify(v, null, 2);
  } catch {
    return raw;
  }
}

/** Word-wrap plain text to width; hard-break single tokens longer than width. */
export function wrapPlain(s: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  if (!s) return [];
  const out: string[] = [];
  for (const para of s.split(/\r?\n/)) {
    if (para === '') {
      out.push('');
      continue;
    }
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (cur === '') cur = word;
      else if (cur.length + 1 + word.length <= w) cur = `${cur} ${word}`;
      else {
        out.push(cur);
        cur = word;
      }
      while (cur.length > w) {
        out.push(cur.slice(0, w));
        cur = cur.slice(w);
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Head-cap a line list; when over cap, keep first `cap` lines and append a
 * `… +N more lines` tail row.
 */
export function headCapLines(lines: string[], cap = TOOL_PAYLOAD_HEAD_CAP): string[] {
  if (lines.length <= cap) return lines;
  const kept = lines.slice(0, cap);
  const n = lines.length - cap;
  return [...kept, `\u2026 +${n} more lines`];
}

/** Content line budget inside the detail Card from host height (fit-clamp). */
export function budgetDetailLines(height: number): number {
  const h = Math.max(0, Math.floor(height));
  // Card title + borders spend DETAIL_CARD_V_CHROME; never paint past the host.
  return Math.max(0, h - DETAIL_CARD_V_CHROME);
}

/** Content width inside the detail Card (border 2 + pad 2). */
export function detailInnerWidth(outerW: number): number {
  return Math.max(0, Math.floor(outerW) - CARD_CHROME);
}

/** Header row: `#{eventId} · {kind} · {toolName?} · {HH:MM}`. */
export function formatDetailHeader(row: TurnDetailRow): string {
  const parts = [`#${row.eventId}`, row.kind];
  const tool = row.toolName.trim();
  if (tool) parts.push(tool);
  parts.push(formatEventTs(row.ts));
  return parts.join(' \u00b7 ');
}

/**
 * Build the full scrollable content line list for a turn (or soft-state).
 * Empty tool payloads omit their section headers entirely.
 */
export function buildTurnDetailLines(
  row: TurnDetailRow | null,
  opts: {
    sessionTitle: string;
    innerW: number;
    collapsePaths: boolean;
    soft?: string | null;
  },
): DetailLine[] {
  const innerW = Math.max(1, Math.floor(opts.innerW));
  const applyPaths = (s: string) => (opts.collapsePaths ? collapseAbsolutePaths(s) : s);

  if (opts.soft) {
    return [{ text: opts.soft, tone: 'muted' }];
  }
  if (!row) {
    return [{ text: 'turn not found', tone: 'muted' }];
  }

  const lines: DetailLine[] = [];
  const errored = isToolErrored(row.toolError);
  lines.push({
    text: formatDetailHeader(row),
    tone: errored ? 'error' : 'header',
  });

  const title = (opts.sessionTitle || '').trim();
  if (title) {
    lines.push({ text: title, tone: 'title' });
  }

  const bodyRaw = applyPaths(row.text ?? '');
  if (bodyRaw.trim()) {
    for (const ln of wrapPlain(bodyRaw, innerW)) {
      lines.push({ text: ln, tone: 'body' });
    }
  }

  const pushSection = (label: string, payload: string) => {
    const raw = (payload ?? '').trim();
    if (!raw) return;
    lines.push({ text: label, tone: 'section' });
    const pretty = applyPaths(prettyPayload(raw));
    const wrapped = wrapPlain(pretty, innerW);
    for (const ln of headCapLines(wrapped, TOOL_PAYLOAD_HEAD_CAP)) {
      lines.push({ text: ln, tone: 'body' });
    }
  };

  pushSection('tool input', row.toolInput);
  pushSection('tool output', row.toolOutput);

  return lines.length ? lines : [{ text: '(empty turn)', tone: 'muted' }];
}

/** Clamp scroll offset into [0, max(0, total − visible)]. */
export function clampScroll(scroll: number, total: number, visible: number): number {
  const max = Math.max(0, total - Math.max(0, visible));
  if (!Number.isFinite(scroll) || scroll < 0) return 0;
  return Math.min(Math.floor(scroll), max);
}

function padRow(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return '';
  if (text.length >= w) return text.slice(0, w);
  return text + ' '.repeat(w - text.length);
}

function FixedClearRow({ width, color, text }: { width: number; color: RGBA; text: string }) {
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

function toneColor(tone: DetailLineTone, t: Palette, headerColor: RGBA): RGBA {
  switch (tone) {
    case 'header':
      return headerColor;
    case 'error':
      return t.error;
    case 'title':
      return t.muted;
    case 'section':
      return t.info;
    case 'muted':
      return t.muted;
    case 'body':
    default:
      return t.foreground;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function TurnDetail({
  visible,
  eventId,
  sessionTitle,
  inputActive,
  onClose,
  onStep,
  onFlash,
  path,
  width,
  height,
}: TurnDetailProps) {
  const t = usePalette();
  const svcRef = useRef<QueryService | null>(null);
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;

  const [scroll, setScroll] = useState(0);
  const [collapsePaths, setCollapsePaths] = useState(true);
  const [row, setRow] = useState<TurnDetailRow | null>(null);
  const [soft, setSoft] = useState<string | null>(null);

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
        setSoft('no speculum index');
        setRow(null);
        return null;
      }
      setSoft('no speculum index');
      setRow(null);
      return null;
    }
  }, [path]);

  // Path remounts the service handle when the test seam changes.
  useEffect(() => {
    try {
      svcRef.current?.close();
    } catch {
      // ignore
    }
    svcRef.current = null;
  }, [path]);

  // Fetch on eventId change while visible; soft states never throw.
  useEffect(() => {
    if (!visible) return;
    if (eventId == null) {
      setRow(null);
      setSoft('no turn selected');
      setScroll(0);
      return;
    }
    setScroll(0);
    const svc = ensureService();
    if (!svc) return;
    try {
      if (!svc.schemaOK()) {
        if (!aliveRef.current) return;
        setRow(null);
        setSoft('index schema mismatch');
        return;
      }
      if (svc.busy()) {
        if (!aliveRef.current) return;
        setSoft('corpus busy');
        // Keep prior row if any so the pane stays readable under lock.
        return;
      }
      const detail = svc.turnDetail(eventId);
      if (!aliveRef.current) return;
      if (svc.busy()) {
        setSoft('corpus busy');
        return;
      }
      if (!detail) {
        setRow(null);
        setSoft('turn not found');
        return;
      }
      setRow(detail);
      setSoft(null);
    } catch (err) {
      if (!aliveRef.current) return;
      if (isMissingIndexError(err)) {
        setRow(null);
        setSoft('no speculum index');
        return;
      }
      setRow(null);
      setSoft('turn not found');
    }
  }, [visible, eventId, ensureService]);

  const innerW = detailInnerWidth(width);
  const visibleLines = budgetDetailLines(height);

  // Soft banner only when there is no row; busy with a prior row keeps content.
  const lines = useMemo(() => {
    if (!row) {
      return buildTurnDetailLines(null, {
        sessionTitle,
        innerW: Math.max(8, innerW),
        collapsePaths,
        soft: soft ?? 'turn not found',
      });
    }
    return buildTurnDetailLines(row, {
      sessionTitle,
      innerW: Math.max(8, innerW),
      collapsePaths,
      soft: null,
    });
  }, [row, soft, sessionTitle, innerW, collapsePaths]);

  const maxScroll = Math.max(0, lines.length - Math.max(0, visibleLines));
  const scrollClamped = clampScroll(scroll, lines.length, visibleLines);

  useEffect(() => {
    if (scroll !== scrollClamped) setScroll(scrollClamped);
  }, [scroll, scrollClamped]);

  const headerColor = useMemo(() => {
    if (!row) return t.muted;
    return kindColor(row.kind, t, isToolErrored(row.toolError));
  }, [row, t]);

  const copyBody = useCallback(() => {
    // Plain-text body of the full (unwindowed) content — app-driven clipboard.
    const text = lines.map((l) => l.text).join('\n');
    if (!text.trim()) {
      onFlashRef.current?.('nothing to copy');
      return;
    }
    const ok = copyText(text);
    onFlashRef.current?.(ok ? 'copied turn detail' : 'copy failed');
  }, [lines]);

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || !visible) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'escape' || n === 'backspace') {
      onClose();
      return;
    }
    if (n === ']') {
      onStep(1);
      return;
    }
    if (n === '[') {
      onStep(-1);
      return;
    }
    if (n === 'j' || n === 'down') {
      setScroll((s) => clampScroll(s + 1, lines.length, visibleLines));
      return;
    }
    if (n === 'k' || n === 'up') {
      setScroll((s) => clampScroll(s - 1, lines.length, visibleLines));
      return;
    }
    if (n === 'pagedown' || n === 'space') {
      setScroll((s) => clampScroll(s + Math.max(1, visibleLines), lines.length, visibleLines));
      return;
    }
    if (n === 'pageup') {
      setScroll((s) => clampScroll(s - Math.max(1, visibleLines), lines.length, visibleLines));
      return;
    }
    if (n === 'home') {
      setScroll(0);
      return;
    }
    if (n === 'end') {
      setScroll(maxScroll);
      return;
    }
    if (n === 'y') {
      copyBody();
      return;
    }
    if (n === 'p') {
      setCollapsePaths((v) => !v);
      return;
    }
  });

  const onScroll = (e: { scroll?: { direction?: string }; button?: number }) => {
    if (!inputActive || !visible) return;
    let d = e.scroll?.direction;
    if (!d && e.button === 4) d = 'up';
    if (!d && e.button === 5) d = 'down';
    if (d === 'up') setScroll((s) => clampScroll(s - 3, lines.length, visibleLines));
    else if (d === 'down') setScroll((s) => clampScroll(s + 3, lines.length, visibleLines));
  };

  if (!visible) {
    return <box height={0} overflow="hidden" />;
  }

  const slots = Math.max(0, visibleLines);
  const window = lines.slice(scrollClamped, scrollClamped + slots);
  const right =
    eventId != null
      ? `#${eventId}${lines.length > slots ? ` ${scrollClamped + 1}-${Math.min(lines.length, scrollClamped + slots)}/${lines.length}` : ''}`
      : undefined;

  return (
    <Card title="Turn" right={right} width={width} flexShrink={0}>
      <box
        flexDirection="column"
        flexShrink={0}
        overflow="hidden"
        onMouseScroll={onScroll}
        backgroundColor={t.background}
      >
        {Array.from({ length: slots }, (_, i) => {
          const line = window[i];
          if (!line) {
            return (
              <FixedClearRow
                key={`slot-${i}`}
                width={Math.max(1, innerW)}
                color={t.background}
                text={padRow('', Math.max(1, innerW))}
              />
            );
          }
          const color = toneColor(line.tone, t, headerColor);
          return (
            <FixedClearRow
              key={`slot-${i}`}
              width={Math.max(1, innerW)}
              color={color}
              text={padRow(line.text, Math.max(1, innerW))}
            />
          );
        })}
      </box>
    </Card>
  );
}
