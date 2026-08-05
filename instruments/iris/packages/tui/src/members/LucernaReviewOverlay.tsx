import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { useStableDimensions } from '../use-stable-dimensions';
import { MarkdownView } from '../components/MarkdownView';
import { formatLucernaDisplayLine } from './lucerna-display';

/**
 * Lucerna review detail overlay — SearchOverlay layout (centered, most of the
 * terminal). BODY is the shared MarkdownView (same path as Forge DocView for
 * .md). This file owns only chrome: frame, status strip, title, footer keys,
 * and review keybinds (esc / v / x). Scroll and markdown paint live in MarkdownView.
 */

export interface ReviewOverlayModel {
  kind: 'dream' | 'proposal';
  id: string;
  title: string;
  statusLabel: string;
  path: string;
  /** Markdown body (may include a linked-report section for manifests). */
  body: string;
  pending: boolean;
  reportPath?: string;
}

/** Footer hint vocabulary — ASCII, matches Activity Log / member footers (`up/dn`). */
export function reviewOverlayFooterHint(
  model: Pick<ReviewOverlayModel, 'kind' | 'pending'> | null,
): string {
  if (model == null) return 'esc close';
  if (!model.pending) return 'esc close · up/dn scroll · y copy';
  if (model.kind === 'dream') return 'esc close · up/dn scroll · v mark reviewed · y copy';
  return 'esc close · up/dn scroll · v apply (status) · x close · y copy';
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
  onReview?: () => void;
  onApply?: () => void;
  onCloseProposal?: () => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();

  const width = Math.min(dims.width - 4, 110);
  const left = Math.max(0, Math.floor((dims.width - width) / 2));
  const height = Math.max(10, dims.height - 4);
  const top = 1;
  const metaW = Math.max(8, width - 4);

  // Chrome-only keys. Scroll / copy / selection are owned by MarkdownView when active.
  useKeyboard((key: { name?: string }) => {
    if (!active || !model) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'escape') return onClose();
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
      {/* Review-status strip */}
      <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.muted} wrapMode="none">
          {formatLucernaDisplayLine(meta || ' ', metaW)}
        </text>
      </box>
      {model?.title ? (
        <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
          <text fg={t.primary} wrapMode="none">
            {formatLucernaDisplayLine(model.title, metaW)}
          </text>
        </box>
      ) : null}

      {/* Body — shared MarkdownView (Forge DocView uses this for .md). */}
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        backgroundColor={t.background}
      >
        {model ? (
          <MarkdownView body={model.body || ' '} inputActive={active && !!model} />
        ) : null}
      </box>

      {/* Review keybind footer (chrome only) */}
      <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.muted} wrapMode="none">
          {formatLucernaDisplayLine(footer, metaW)}
        </text>
      </box>
    </box>
  );
}
