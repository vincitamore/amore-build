import { useEffect, useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import {
  StyledText,
  stringToStyledText,
  fg,
  bold,
  italic,
  underline,
  type StylableInput,
} from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { useStableDimensions } from '../use-stable-dimensions';
import { renderMarkdown, type MdLine, type MdSeg, type Tone } from '../md-render';
import { emptyDisplayRow, formatLucernaDisplayLine, sanitizeDisplayText } from './lucerna-display';

/**
 * Full-screen-ish detail overlay for Lucerna review items (SearchOverlay layout:
 * centered, most of the terminal, fixed opaque row slots, Esc closes).
 * Renders body via the shared md-render pipeline (headings / lists / code tones)
 * with SPAN-scoped colors — same segment model as Forge MarkdownView.
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

/** One display segment after Lucerna glyph scrub (link style is span-only). */
export interface OverlaySeg {
  text: string;
  tone: Tone;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Present when md-render marked a wikilink / markdown link. */
  wikilink?: string;
}

export interface OverlayLine {
  /** Exact-width row string (for residual / pad tests). */
  text: string;
  /** Per-span tones — only path/wikilink tokens use tone `link`. */
  segs: OverlaySeg[];
}

/**
 * Per-segment glyph scrub (same policy as formatLogCell / sanitizeDisplayText).
 * Span-aligned so styles do not shift.
 */
export function scrubOverlayGlyphs(s: string): string {
  return sanitizeDisplayText(s);
}

/**
 * Map md-render tones → palette.
 * **code** uses `secondary` (warm accent) so backtick spans are distinct from
 * **link** which stays `info` (cyan) — whole-line blue wash fixed by spans + this split.
 * **italic** is an attribute (OpenTUI italic()), not a tone.
 */
function toneColor(t: Palette, tone: Tone): string {
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
      // Distinct from link (info): secondary accent for inline/fenced code.
      return t.secondary;
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

/** Flatten an MdLine to plain text (tests / residual helpers). */
export function mdLineToText(line: MdLine): string {
  if (!line.length) return ' ';
  return line.map((s) => s.text).join('') || ' ';
}

/**
 * Dominant tone for a line — used only by tests/legacy; the overlay paints
 * spans, not this aggregate (which caused whole-line link color).
 */
export function mdLineTone(line: MdLine): Tone {
  if (!line.length) return 'text';
  const prefer: Tone[] = ['h1', 'h2', 'h3', 'code', 'codeblock', 'marker', 'link', 'quote'];
  for (const p of prefer) {
    if (line.some((s) => s.tone === p)) return p;
  }
  return line[0]?.tone ?? 'text';
}

/**
 * True only for md-render link segments (wikilink / markdown link). Bare
 * short hex, parenthesized dates, and plain prose never get link tone —
 * same matcher as Forge MarkdownView (`parseInline` only).
 */
export function isLinkSeg(seg: Pick<OverlaySeg, 'tone' | 'wikilink' | 'text'>): boolean {
  return seg.tone === 'link';
}

/** Pad scrubbed segments to exact row width (opaque clear). */
export function padOverlaySegs(segs: OverlaySeg[], width: number): OverlaySeg[] {
  const w = Math.max(1, width);
  let out: OverlaySeg[] = segs.length
    ? segs.map((s) => ({ ...s, text: scrubOverlayGlyphs(s.text) }))
    : [{ text: ' ', tone: 'text' }];

  // Drop empty segments after scrub
  out = out.filter((s) => s.text.length > 0);
  if (out.length === 0) out = [{ text: ' ', tone: 'text' }];

  let len = out.reduce((a, s) => a + s.text.length, 0);
  if (len > w) {
    // Hard trim from the end (renderMarkdown already wraps; scrub length drift is rare)
    const trimmed: OverlaySeg[] = [];
    let used = 0;
    for (const s of out) {
      if (used >= w) break;
      const take = Math.min(s.text.length, w - used);
      trimmed.push({ ...s, text: s.text.slice(0, take) });
      used += take;
    }
    out = trimmed;
    len = used;
  }
  if (len < w) {
    out.push({ text: ' '.repeat(w - len), tone: 'text' });
  }
  return out;
}

/**
 * Build display lines: markdown → wrapped MdLines (Forge pipeline) → scrubbed
 * span rows of exact width. Link tone stays on the matched token only.
 */
export function buildReviewOverlayLines(body: string, width: number): OverlayLine[] {
  const w = Math.max(12, width);
  const md = renderMarkdown(body || ' ', w);
  return md.map((line) => {
    const raw: OverlaySeg[] = (line.length ? line : [{ text: ' ', tone: 'text' as Tone }]).map(
      (s: MdSeg) => ({
        text: s.text,
        tone: s.tone,
        bold: s.bold,
        italic: s.italic,
        underline: s.underline,
        wikilink: s.wikilink,
      }),
    );
    const segs = padOverlaySegs(raw, w);
    return {
      segs,
      text: segs.map((s) => s.text).join(''),
    };
  });
}

/** Span list → OpenTUI StyledText (mirrors MarkdownView.toStyled). */
export function overlayLineToStyled(line: OverlayLine, p: Palette): StyledText {
  if (!line.segs.length) return stringToStyledText(' ');
  const chunks = line.segs.map((seg) => {
    let c: StylableInput = seg.text.length ? seg.text : ' ';
    if (seg.italic) c = italic(c);
    if (seg.bold) c = bold(c);
    if (seg.underline || seg.tone === 'link') c = underline(c);
    return fg(toneColor(p, seg.tone))(c);
  });
  return new StyledText(chunks);
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
  onReview?: () => void;
  onApply?: () => void;
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
  const listRows = Math.max(4, height - 6);
  const innerW = Math.max(12, width - 4);

  const lines = useMemo(() => {
    if (!model) return [] as OverlayLine[];
    return buildReviewOverlayLines(model.body, innerW);
  }, [model, innerW]);

  const blankStyled = useMemo(() => stringToStyledText(emptyDisplayRow(innerW)), [innerW]);

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

      {/* Body: fixed opaque slots; span-scoped StyledText (Forge MarkdownView pattern). */}
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} backgroundColor={t.background}>
        {Array.from({ length: listRows }, (_, vi) => {
          const row = shown[vi];
          return (
            <box
              key={`r-${vi}`}
              height={1}
              flexShrink={0}
              overflow="hidden"
              backgroundColor={t.background}
            >
              <text
                wrapMode="none"
                content={row ? overlayLineToStyled(row, t) : blankStyled}
              />
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
