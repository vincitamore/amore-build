import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { Stat } from '../components/Stat';
import { useStableDimensions } from '../use-stable-dimensions';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { runSpeculum, type SpeculumResult } from './speculum-spawn';

export interface UsageTokens {
  input: number;
  output: number;
  cachedRead: number;
  reasoning: number;
  total: number;
}

export interface UsageModelRow {
  model: string;
  turns?: number;
  sessions?: number;
  tokens?: Partial<UsageTokens>;
}

export interface UsageJson {
  window: { since: string | null; until: string | null };
  models: UsageModelRow[];
  totals: {
    turns: number;
    sessions: number;
    tokens: UsageTokens;
  };
  note: string;
}

export type UsageError = Extract<SpeculumResult<unknown>, { ok: false }>['error'];

const MODEL_SLOTS = 4;
const INSTALL_RECIPE = 'amore init --with-speculum';

/** Compact token counts: 1.2K / 3.4M style. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
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

function errorCopy(err: UsageError): { lines: string[] } {
  if (err.kind === 'not-installed') {
    return {
      lines: [
        'speculum not installed — usage needs the CLI on PATH (or SPECULUM_BIN).',
        `Install with: ${INSTALL_RECIPE}`,
        'r to retry after install',
      ],
    };
  }
  const tail = err.stderrTail?.trim() || err.stdoutTail?.trim() || '';
  return {
    lines: [
      `${err.kind}: ${err.message}`,
      ...(tail ? [tail.slice(-200)] : []),
      'r to retry',
    ],
  };
}

function formatModelLine(m: UsageModelRow): string {
  const id = m.model || '(unknown)';
  const turns = m.turns ?? 0;
  const tok = m.tokens?.total ?? 0;
  const inn = m.tokens?.input;
  const out = m.tokens?.output;
  const bits = [`${id}`, `turns=${turns}`, `tok=${formatTokens(tok)}`];
  if (inn != null || out != null) {
    bits.push(`(in=${formatTokens(inn ?? 0)} out=${formatTokens(out ?? 0)})`);
  }
  return bits.join('  ');
}

export function UsageStage({
  inputActive,
  onFlash,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const [data, setData] = useState<UsageJson | null>(null);
  const [error, setError] = useState<UsageError | null>(null);
  const [loading, setLoading] = useState(true);
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
    const r = await runSpeculum<UsageJson>('usage', ['--json']);
    if (!aliveRef.current) return;
    if (r.ok) {
      setData(r.json);
      setError(null);
      setScroll(0);
      onFlashRef.current?.('usage updated');
    } else {
      setData(null);
      setError(r.error);
      onFlashRef.current?.(`usage failed: ${r.error.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshOnActive(inputActive, () => {
    void load();
  });

  const models = data?.models ?? [];
  // Cap model slots by terminal height so totals + note stay visible in short panes.
  const modelSlots = Math.max(1, Math.min(MODEL_SLOTS, Math.max(1, dims.height - 14)));
  const maxScroll = Math.max(0, models.length - modelSlots);

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'r') {
      void load();
      return;
    }
    if (error || !data) return;
    if (n === 'up') {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (n === 'down') {
      setScroll((s) => Math.min(maxScroll, s + 1));
    }
  });

  const rowW = Math.max(16, dims.width - 6);
  const totals = data?.totals;
  const tokens = totals?.tokens;
  const modelSlice = models.slice(scroll, scroll + modelSlots);

  const windowLabel = useMemo(() => {
    if (!data) return '';
    const { since, until } = data.window ?? { since: null, until: null };
    if (!since && !until) return 'all time';
    return `${since ?? '…'} → ${until ?? '…'}`;
  }, [data]);

  const headerRight = error
    ? error.kind
    : loading && !data
      ? 'loading'
      : windowLabel || 'usage';

  const footer = error
    ? `r retry · ${error.kind}`
    : models.length > modelSlots
      ? 'up/dn scroll models · r refresh'
      : 'r refresh';

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
        title="Usage"
        headerRight={headerRight}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        active={!!inputActive}
      >
        {loading && !data && !error ? (
          <FixedClearRow width={rowW} color={t.muted} text={padRow('loading usage…', rowW)} />
        ) : null}

        {error ? (
          <box flexDirection="column" flexShrink={0}>
            {errorCopy(error).lines.map((line, i) => (
              <FixedClearRow
                key={`e-${i}`}
                width={rowW}
                color={i === 0 ? t.error : t.muted}
                text={padRow(line, rowW)}
              />
            ))}
          </box>
        ) : null}

        {data && totals && tokens ? (
          <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
            {/* One Stat row when wide enough; keeps totals + models visible in short panes. */}
            <box flexDirection="row" flexShrink={0}>
              <Stat value={String(totals.turns)} label="Turns" color={t.primary} />
              <Stat value={String(totals.sessions)} label="Sessions" color={t.info} />
              <Stat value={formatTokens(tokens.input)} label="Input" color={t.success} />
              <Stat value={formatTokens(tokens.output)} label="Output" color={t.warning} />
              <Stat value={formatTokens(tokens.cachedRead)} label="Cached" color={t.muted} />
              <Stat value={formatTokens(tokens.reasoning)} label="Reason" color={t.secondary} />
              <Stat value={formatTokens(tokens.total)} label="Total" color={t.accent} />
            </box>

            <box flexDirection="column" flexShrink={0} marginTop={1}>
              <FixedClearRow
                width={rowW}
                color={t.muted}
                text={padRow(data.note || 'Token and turn counts only.', rowW)}
              />
              <FixedClearRow
                width={rowW}
                color={t.muted}
                text={padRow(
                  models.length === 0
                    ? 'by model: (none — ingest sessions with turn_completed events)'
                    : `by model (${models.length})`,
                  rowW,
                )}
              />
              {Array.from({ length: modelSlots }, (_, i) => {
                const m = modelSlice[i];
                if (!m) {
                  return (
                    <FixedClearRow
                      key={`m-${i}`}
                      width={rowW}
                      color={t.muted}
                      text={emptyRow(rowW)}
                    />
                  );
                }
                return (
                  <FixedClearRow
                    key={`m-${i}-${m.model}`}
                    width={rowW}
                    color={t.foreground}
                    text={padRow(`  ${formatModelLine(m)}`, rowW)}
                  />
                );
              })}
            </box>
          </box>
        ) : null}
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
