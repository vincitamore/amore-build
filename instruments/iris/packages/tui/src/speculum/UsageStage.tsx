import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { useStableDimensions } from '../use-stable-dimensions';
import type { MeasuredSize } from '../use-measured-size';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { runSpeculum, type SpeculumResult } from './speculum-spawn';
import { MIN_USAGE_MODEL_SLOTS, seedStageBox } from './sessions-layout';
import {
  Card,
  CardGrid,
  cardInnerWidth,
  cardsPerRow,
  cardWidthForRow,
  padTruncate,
} from './Card';

/**
 * Local stage chrome against residual host (pad + panel + totals block + note + footer).
 * Model region budgets from residual − this constant only.
 */
export const USAGE_STAGE_CHROME = 11;

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

const INSTALL_RECIPE = 'amore init --with-speculum';
/** House 6/3/2-up for totals: min outer so 120→6, ~68→3, narrow→2/1. */
const MIN_STAT_CARD = 16;
/** Models need a wider floor so ids stay readable (2/1-up). */
const MIN_MODEL_CARD = 28;
const GRID_GAP = 1;

/** Compact token counts: 1.2K / 3.4M style. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

export interface UsageStatCard {
  key: string;
  title: string;
  value: string;
  kind: 'total' | 'model';
  detail?: string;
}

/** Build the stat + model card list (pure — unit-tested). Price-free. */
export function buildUsageCards(data: UsageJson): UsageStatCard[] {
  const totals = data.totals;
  const tokens = totals.tokens;
  const cards: UsageStatCard[] = [
    { key: 'turns', title: 'Turns', value: String(totals.turns), kind: 'total' },
    { key: 'sessions', title: 'Sessions', value: String(totals.sessions), kind: 'total' },
    { key: 'input', title: 'Input', value: formatTokens(tokens.input), kind: 'total' },
    { key: 'output', title: 'Output', value: formatTokens(tokens.output), kind: 'total' },
    {
      key: 'cached',
      title: 'Cached-read',
      value: formatTokens(tokens.cachedRead),
      kind: 'total',
    },
    {
      key: 'reasoning',
      title: 'Reasoning',
      value: formatTokens(tokens.reasoning),
      kind: 'total',
    },
    { key: 'total', title: 'Total', value: formatTokens(tokens.total), kind: 'total' },
  ];
  for (const m of data.models ?? []) {
    const id = m.model || '(unknown)';
    const turns = m.turns ?? 0;
    const tok = m.tokens?.total ?? 0;
    const inn = m.tokens?.input;
    const out = m.tokens?.output;
    let detail = `turns=${turns}  tok=${formatTokens(tok)}`;
    if (inn != null || out != null) {
      detail += `  (in=${formatTokens(inn ?? 0)} out=${formatTokens(out ?? 0)})`;
    }
    cards.push({
      key: `m-${id}`,
      title: id,
      value: formatTokens(tok),
      kind: 'model',
      detail,
    });
  }
  return cards;
}

function padRow(text: string, width: number): string {
  if (width <= 0) return '';
  const ellipsis = '\u2026';
  const s = text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}${ellipsis}`;
  return s.length >= width ? s.slice(0, width) : s.padEnd(width, ' ');
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
  const msg = err.message ?? '';
  const tail = err.stderrTail?.trim() || err.stdoutTail?.trim() || '';
  if (/not found|no such|missing|ENOENT|no index|no corpus/i.test(`${msg} ${tail}`)) {
    return {
      lines: [
        'No derived session index found for usage.',
        "run 'speculum ingest'",
        'r to retry',
      ],
    };
  }
  if (/schema|version|unsupported/i.test(`${msg} ${tail}`)) {
    return {
      lines: [
        'schema mismatch — upgrade index or re-ingest with a matching CLI.',
        'r to retry',
      ],
    };
  }
  if (/busy|locked|database is locked|SQLITE_BUSY/i.test(`${msg} ${tail}`)) {
    return {
      lines: ['corpus busy — wait for ingest, then r to retry.'],
    };
  }
  return {
    lines: [
      `${err.kind}: ${err.message}`,
      ...(tail ? [tail.slice(-200)] : []),
      'r to retry',
    ],
  };
}

export function UsageStage({
  inputActive,
  onFlash,
  stageBox: stageBoxProp,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  /** Residual host box from SessionsMember; optional for isolated stage smokes. */
  stageBox?: MeasuredSize;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const stageBox = stageBoxProp ?? seedStageBox(dims.width, dims.height);
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

  const rowW = Math.max(16, stageBox.width - 4);
  const cards = useMemo(() => (data ? buildUsageCards(data) : []), [data]);
  const totalCards = useMemo(() => cards.filter((c) => c.kind === 'total'), [cards]);
  const modelCards = useMemo(() => cards.filter((c) => c.kind === 'model'), [cards]);
  const perModel = cardsPerRow(rowW, MIN_MODEL_CARD, GRID_GAP);
  // Scroll model cards when many models overflow the residual model host.
  const modelHostH = Math.max(1, stageBox.height - USAGE_STAGE_CHROME);
  const modelSlots = Math.max(
    MIN_USAGE_MODEL_SLOTS,
    Math.min(6, Math.floor(Math.max(2, modelHostH) / 3) * perModel),
  );
  const maxScroll = Math.max(0, modelCards.length - modelSlots);
  const modelSlice = modelCards.slice(scroll, scroll + modelSlots);
  const totalPer = cardsPerRow(rowW, MIN_STAT_CARD, GRID_GAP);
  const totalW = cardWidthForRow(rowW, Math.min(totalPer, Math.max(1, totalCards.length || 1)), GRID_GAP);
  const modelW = cardWidthForRow(rowW, Math.min(perModel, Math.max(1, modelSlice.length || 1)), GRID_GAP);
  const totalInner = cardInnerWidth(totalW);
  const modelInner = cardInnerWidth(modelW);

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'r') {
      void load();
      return;
    }
    if (error || !data) return;
    if (n === 'up') {
      setScroll((s) => Math.max(0, s - perModel));
      return;
    }
    if (n === 'down') {
      setScroll((s) => Math.min(maxScroll, s + perModel));
    }
  });

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
    : modelCards.length > modelSlots
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

        {data ? (
          <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
            <CardGrid width={rowW} minCardWidth={MIN_STAT_CARD} gap={GRID_GAP}>
              {totalCards.map((c) => (
                <Card key={c.key} title={c.title} width={totalW} marginBottom={1}>
                  <box height={1} flexShrink={0} overflow="hidden">
                    <text fg={t.primary} wrapMode="none">
                      {padTruncate(c.value, totalInner)}
                    </text>
                  </box>
                </Card>
              ))}
            </CardGrid>

            {/* Note is essential chrome — pin it, never let models push it off. */}
            <box flexDirection="column" flexShrink={0} marginTop={1}>
              <FixedClearRow
                width={rowW}
                color={t.muted}
                text={padRow(data.note || 'Token and turn counts only.', rowW)}
              />
              {(data.models?.length ?? 0) === 0 ? (
                <FixedClearRow
                  width={rowW}
                  color={t.muted}
                  text={padRow(
                    'by model: (none — ingest sessions with turn_completed events)',
                    rowW,
                  )}
                />
              ) : (
                <FixedClearRow
                  width={rowW}
                  color={t.muted}
                  text={padRow(`by model (${modelCards.length})`, rowW)}
                />
              )}
            </box>

            {modelSlice.length > 0 ? (
              <box flexDirection="column" flexShrink={0} marginTop={0}>
                <CardGrid width={rowW} minCardWidth={MIN_MODEL_CARD} gap={GRID_GAP}>
                  {modelSlice.map((c) => (
                    <Card
                      key={c.key}
                      title={c.title}
                      right={c.value}
                      width={modelW}
                      marginBottom={1}
                    >
                      <box height={1} flexShrink={0} overflow="hidden">
                        <text fg={t.foreground} wrapMode="none">
                          {padTruncate(c.detail ?? c.value, modelInner)}
                        </text>
                      </box>
                    </Card>
                  ))}
                </CardGrid>
              </box>
            ) : null}
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
          {padRow(footer, Math.max(16, stageBox.width - 2))}
        </text>
      </box>
    </box>
  );
}
