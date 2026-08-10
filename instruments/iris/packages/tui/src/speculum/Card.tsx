import { Children, type ReactNode } from 'react';
import { usePalette } from '../ThemeProvider';

/**
 * Chrome cells a bordered Card spends on L/R border + L/R padding.
 * House content budget for consumers truncating inside a Card: outer − 6
 * (this chrome plus a typical parent pad of 1 each side). Prefer
 * `cardInnerWidth(outer)` over hand-rolled arithmetic.
 */
export const CARD_CHROME = 4;
/** Parent pad (1+1) + Card chrome → the full −6 content budget. */
export const CARD_NESTED_CHROME = 6;

export interface CardProps {
  /** Section label — rendered ALL-CAPS on a single fixed title row. */
  title: string;
  /** Parent-driven keyboard/cursor selection (Card is presentational). */
  selected?: boolean;
  /** Parent-driven hover highlight (use with a hover-throttle at the list). */
  hovered?: boolean;
  /** Override title ink (hex or theme-resolved string). Default: primary / muted. */
  titleColor?: string;
  /** Right-aligned title-bar annotation (Wilson range, count, tag). */
  right?: string;
  children?: ReactNode;
  /** Per-element click — no global mouse router. */
  onMouseDown?: () => void;
  /** Selection border/title accent override (hex). Default: palette borderActive/primary. */
  accent?: string;
  /** Outer width. When set, the title bar truncates to the inner budget. */
  width?: number;
  /** Flex passthrough for grid cells. */
  flexGrow?: number;
  flexShrink?: number;
  minHeight?: number | 'auto' | `${number}%`;
  marginRight?: number;
  marginBottom?: number;
}

/**
 * Content width inside a bordered Card given its outer width.
 * Uses the house −6 rule so nested consumers never overrun into wrap/interleave.
 */
export function cardInnerWidth(outerWidth: number): number {
  if (!Number.isFinite(outerWidth) || outerWidth <= 0) return 0;
  return Math.max(0, Math.floor(outerWidth) - CARD_NESTED_CHROME);
}

/** Truncate-then-pad a cell to an exact width (ellipsis when cut). */
export function padTruncate(text: string, width: number): string {
  if (width <= 0) return '';
  const ellipsis = '\u2026';
  if (text.length <= width) return text.padEnd(width, ' ');
  if (width === 1) return ellipsis;
  return `${text.slice(0, width - 1)}${ellipsis}`;
}

/**
 * Fit a one-row title bar: TITLE (left) + optional right annotation.
 * Both sides truncate-first; the right side keeps a short floor so counts/CIs
 * stay visible while a long title yields first. `left.length + right.length === width`
 * (trailing spaces on `left` are the visual gap).
 */
export function fitTitleBar(
  title: string,
  right: string | undefined,
  width: number,
  selected: boolean,
): { left: string; right: string } {
  if (width <= 0) return { left: '', right: '' };
  const caret = selected ? '\u25B8 ' : ''; // ▸
  const head = `${caret}${title}`.toUpperCase();
  const tail = right ?? '';
  if (!tail) {
    return { left: padTruncate(head, width), right: '' };
  }
  // Prefer keeping the right annotation; title yields first.
  const maxRight = Math.min(tail.length, Math.max(3, Math.floor(width * 0.4)));
  let rightW = Math.min(tail.length, maxRight);
  let leftW = width - rightW;
  if (leftW < 2) {
    leftW = Math.min(2, width);
    rightW = Math.max(0, width - leftW);
  }
  if (rightW <= 0) {
    return { left: padTruncate(head, width), right: '' };
  }
  return {
    left: padTruncate(head, leftW),
    right: padTruncate(tail, rightW),
  };
}

/**
 * How many equal cards fit in `width` given a minimum card width and gap.
 * Pure: the 2-up / 1-up engine for probe/usage card boards. Chunk in code —
 * do not rely on flexWrap string values.
 */
export function cardsPerRow(width: number, minCardWidth: number, gap = 1): number {
  if (!Number.isFinite(width) || !Number.isFinite(minCardWidth)) return 1;
  if (width <= 0 || minCardWidth <= 0) return 1;
  const g = Math.max(0, gap);
  return Math.max(1, Math.floor((width + g) / (minCardWidth + g)));
}

/** Split items into fixed-size row chunks (last row may be short). */
export function chunkByRow<T>(items: readonly T[], perRow: number): T[][] {
  const n = Math.max(1, Math.floor(perRow) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Equal outer width for each card in a row of `count` inside `rowWidth`. */
export function cardWidthForRow(rowWidth: number, count: number, gap = 1): number {
  if (count <= 0) return Math.max(0, rowWidth);
  const g = Math.max(0, gap);
  return Math.max(1, Math.floor((rowWidth - g * (count - 1)) / count));
}

export interface CardGridProps {
  children: ReactNode;
  /** Available row width (measured parent or terminal strip — not the full terminal if nested). */
  width: number;
  /** Minimum outer width a card needs before the row drops a column. */
  minCardWidth: number;
  /** Horizontal gap between cards in a row (cells). Default 1. */
  gap?: number;
}

/**
 * Responsive card grid: pure width math → chunked rows in code.
 * Children are cloned into equal-width cells; no flexWrap, no interleave.
 */
export function CardGrid({ children, width, minCardWidth, gap = 1 }: CardGridProps): ReactNode {
  const kids = Children.toArray(children);
  if (kids.length === 0) return null;
  const per = cardsPerRow(width, minCardWidth, gap);
  const rows = chunkByRow(kids, per);
  const w = Math.max(0, Math.floor(width));

  return (
    <box flexDirection="column" width={w > 0 ? w : undefined} flexShrink={0}>
      {rows.map((row, ri) => {
        const cw = cardWidthForRow(w, row.length, gap);
        return (
          <box key={ri} flexDirection="row" width={w > 0 ? w : undefined} flexShrink={0}>
            {row.map((child, ci) => (
              <box
                key={ci}
                width={cw}
                flexShrink={0}
                marginRight={ci < row.length - 1 ? gap : 0}
              >
                {child}
              </box>
            ))}
          </box>
        );
      })}
    </box>
  );
}

/**
 * Sessions-surface card: bordered, titled box with optional selection/hover.
 * Presentational — parent owns keyboard selection; Card only maps hover/click.
 *
 * Content rows are the consumer's job: truncate-then-pad every line to
 * `cardInnerWidth(outer)` (or a measured inner width) so nothing wraps past
 * one row. Fixed-slot lists inside children stay the consumer's concern.
 */
export function Card({
  title,
  selected = false,
  hovered = false,
  titleColor,
  right,
  children,
  onMouseDown,
  accent,
  width,
  flexGrow,
  flexShrink,
  minHeight,
  marginRight,
  marginBottom,
}: CardProps) {
  const t = usePalette();
  const active = selected || hovered;
  const borderCol = selected
    ? (accent ?? t.borderActive)
    : active
      ? t.borderActive
      : t.border;
  const bg = hovered ? t.selection : t.background;
  const titleFg = titleColor ?? (selected ? (accent ?? t.primary) : t.primary);

  // Title bar budget: when outer width is known, use house inner width so the
  // one-row chrome never wraps into the content area.
  const barW = width != null && width > 0 ? Math.max(0, Math.floor(width) - CARD_CHROME) : 0;
  const fitted = barW > 0 ? fitTitleBar(title, right, barW, selected) : null;
  const leftRaw = selected ? `\u25B8 ${title}`.toUpperCase() : title.toUpperCase();

  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={borderCol}
      backgroundColor={bg}
      paddingLeft={1}
      paddingRight={1}
      width={width}
      flexGrow={flexGrow}
      flexShrink={flexShrink ?? 0}
      minHeight={minHeight}
      marginRight={marginRight}
      marginBottom={marginBottom}
      onMouseDown={onMouseDown}
    >
      <box flexDirection="row" height={1} flexShrink={0} overflow="hidden">
        {fitted ? (
          <>
            <text fg={titleFg} wrapMode="none">
              {fitted.left}
            </text>
            {fitted.right ? (
              <text fg={t.muted} wrapMode="none">
                {fitted.right}
              </text>
            ) : null}
          </>
        ) : (
          <>
            <text fg={titleFg} wrapMode="none">
              {leftRaw}
            </text>
            <box flexGrow={1} />
            {right ? (
              <text fg={t.muted} wrapMode="none">
                {right}
              </text>
            ) : null}
          </>
        )}
      </box>
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        {children}
      </box>
    </box>
  );
}
