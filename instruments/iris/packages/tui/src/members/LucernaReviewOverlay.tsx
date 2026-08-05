import { useEffect, useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { useStableDimensions } from '../use-stable-dimensions';
import { renderMarkdown, type MdLine, type Tone } from '../md-render';
import { formatLucernaDisplayLine, emptyDisplayRow } from './lucerna-display';

/**
 * Full-screen-ish detail overlay for Lucerna review items (SearchOverlay layout:
 * centered, most of the terminal, fixed opaque row slots, Esc closes).
 * Renders body via the shared md-render pipeline (headings / lists / code tones).
 */

export interface ReviewOverlayModel {
  kind: 'dream' | 'proposal';
  id: string;
  title: string;
  statusLabel: string;
  path: string;
  /** Markdown (or plain) body — may include a linked report section for manifests. */
  body: string;
  pending: boolean;
  reportPath?: string;
}

function toneColor(
  t: ReturnType<typeof usePalette>,
  tone: Tone,
): string {
  switch (tone) {
    case 'h1':
    case 'h2':
      return t.primary;
    case 'h3':
      return t.secondary;
    case 'code':
    case 'codeblock':
    case 'kw':
    case 'str':
    case 'num':
      return t.info;
    case 'comment':
    case 'quote':
      return t.muted;
    case 'link':
      return t.info;
    case 'marker':
      return t.warning;
    case 'rule':
    case 'qbar':
    case 'tborder':
      return t.border;
    default:
      return t.foreground;
  }
}

/** Flatten an MdLine to plain text for fixed-width opaque rows. */
export function mdLineToText(line: MdLine): string {
  if (!line.length) return ' ';
  return line.map((s) => s.text).join('') || ' ';
}

/** Dominant tone for color (prefer heading/code/marker over body text). */
export function mdLineTone(line: MdLine): Tone {
  if (!line.length) return 'text';
  const prefer: Tone[] = ['h1', 'h2', 'h3', 'code', 'codeblock', 'marker', 'link', 'quote'];
  for (const p of prefer) {
    if (line.some((s) => s.tone === p)) return p;
  }
  return line[0]?.tone ?? 'text';
}

/**
 * Build display lines for tests / overlay: markdown → fixed-width plain rows
 * with a semantic tone per row (color only at the view layer).
 *
 * Uses the same `renderMarkdown` / `parseInline` pipeline as Forge's MarkdownView
 * (labels for `[[wikilinks]]` and `[text](url)` — no second link convention).
 * Lucerna's opaque-row scrub maps md-render's bullet (•) to ASCII hyphen so
 * list markers never become "?" on this surface.
 */
export function buildReviewOverlayLines(
  body: string,
  width: number,
): Array<{ text: string; tone: Tone }> {
  const w = Math.max(12, width);
  const md = renderMarkdown(body || ' ', w);
  return md.map((line) => ({
    text: formatLucernaDisplayLine(mdLineToText(line), w),
    tone: mdLineTone(line),
  }));
}

/** Footer hint vocabulary — ASCII, matches Activity Log / member footers (`up/dn`). */
export function reviewOverlayFooterHint(
  model: Pick<ReviewOverlayModel, 'kind' | 'pending'> | null,
): string {
  if (model == null) return 'esc close';
  if (!model.pending) return 'esc close · up/dn scroll';
  if (model.kind === 'dream') return 'esc close · up/dn scroll · v mark reviewed';
  return 'esc close · up/dn scroll · v apply (status) · x close proposal';
}

export function LucernaReviewOverlay({
  active = true,
  model,
  onClose,
  onReview,
  onApply,
  onCloseProposal,
}: {
  active?: boolean;
  model: ReviewOverlayModel | null;
  onClose: () => void;
  /** Mark dream reviewed (status flip). */
  onReview?: () => void;
  /** Mark proposal applied (status only). */
  onApply?: () => void;
  /** Mark proposal closed (status only). */
  onCloseProposal?: () => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    if (active) setScroll(0);
  }, [active, model?.id, model?.path]);

  const width = Math.min(dims.width - 4, 110);
  const left = Math.max(0, Math.floor((dims.width - width) / 2));
  const height = Math.max(10, dims.height - 4);
  const top = 1;
  // chrome: title border + meta + footer = ~4 rows inside padding
  const listRows = Math.max(4, height - 6);
  const innerW = Math.max(12, width - 4);

  const lines = useMemo(() => {
    if (!model) return [] as Array<{ text: string; tone: Tone }>;
    return buildReviewOverlayLines(model.body, innerW);
  }, [model, innerW]);

  const maxScroll = Math.max(0, lines.length - listRows);
  const clamped = Math.min(scroll, maxScroll);
  const shown = lines.slice(clamped, clamped + listRows);

  useKeyboard((key: { name?: string }) => {
    if (!active || !model) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'escape') return onClose();
    if (n === 'up') return setScroll((s) => Math.max(0, s - 1));
    if (n === 'down') return setScroll((s) => Math.min(maxScroll, s + 1));
    if (n === 'pageup') return setScroll((s) => Math.max(0, s - listRows));
    if (n === 'pagedown') return setScroll((s) => Math.min(maxScroll, s + listRows));
    if (n === 'home') return setScroll(0);
    if (n === 'end') return setScroll(maxScroll);
    if (n === 'v' && model.pending) {
      if (model.kind === 'dream') return onReview?.();
      return onApply?.();
    }
    if (n === 'x' && model.pending && model.kind === 'proposal') return onCloseProposal?.();
  });

  const title =
    model == null
      ? ' Review '
      : model.kind === 'dream'
        ? ` Dream · ${model.id} `
        : ` Proposal · ${model.id} `;

  const meta =
    model == null
      ? ''
      : `${model.statusLabel}${model.reportPath ? ` · report ${model.reportPath}` : ''} · ${model.path}`;

  const footer = reviewOverlayFooterHint(model);

  return (
    <box
      visible={active && !!model}
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={height}
      zIndex={200}
      border
      borderStyle="rounded"
      borderColor={t.borderActive}
      backgroundColor={t.background}
      title={title}
      titleAlignment="center"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Meta row — opaque clear */}
      <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.muted} wrapMode="none">
          {formatLucernaDisplayLine(meta || ' ', Math.max(8, width - 4))}
        </text>
      </box>
      {model?.title ? (
        <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
          <text fg={t.primary} wrapMode="none">
            {formatLucernaDisplayLine(model.title, Math.max(8, width - 4))}
          </text>
        </box>
      ) : null}

      {/* Body: fixed opaque slots (stale-cell craft) */}
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} backgroundColor={t.background}>
        {Array.from({ length: listRows }, (_, vi) => {
          const row = shown[vi];
          if (!row) {
            return (
              <box
                key={`r-${vi}`}
                height={1}
                flexShrink={0}
                overflow="hidden"
                backgroundColor={t.background}
              >
                <text fg={t.muted} wrapMode="none">
                  {emptyDisplayRow(innerW)}
                </text>
              </box>
            );
          }
          return (
            <box
              key={`r-${vi}`}
              height={1}
              flexShrink={0}
              overflow="hidden"
              backgroundColor={t.background}
            >
              <text fg={toneColor(t, row.tone)} wrapMode="none">
                {row.text.length === innerW ? row.text : formatLucernaDisplayLine(row.text, innerW)}
              </text>
            </box>
          );
        })}
      </box>

      <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.muted} wrapMode="none">
          {formatLucernaDisplayLine(
            `${footer}${maxScroll > 0 ? ` · ${clamped + 1}-${Math.min(clamped + listRows, lines.length)}/${lines.length}` : ''}`,
            Math.max(8, width - 4),
          )}
        </text>
      </box>
    </box>
  );
}
