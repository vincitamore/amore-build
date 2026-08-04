import type { ReactNode } from 'react';
import { usePalette } from '../ThemeProvider';

interface PanelProps {
  /** Section header, rendered in the primary accent (the GUI's bold card title). */
  title?: string;
  /** Optional right-aligned header annotation (muted) — e.g. a timestamp or count. */
  headerRight?: string;
  children: ReactNode;
  flexGrow?: number;
  flexShrink?: number;
  /** 0 lets a scrollbox-bearing panel shrink below its content (clip + scroll instead of overflow). */
  minHeight?: number | 'auto' | `${number}%`;
  width?: number | `${number}%` | 'auto';
  marginTop?: number;
  marginRight?: number;
  /** Use the active border color (hover/selected affordance). */
  active?: boolean;
}

/**
 * The repeating container unit of the Iris design language: a flat 1px-bordered
 * box with hard corners, a primary-accent header, and no fill beyond the theme bg.
 * Mirrors the GUI's `.border px-4 py-3` card. Borders go subtle by default, active
 * on focus. Every member composes from this so the views stay coherent.
 */
export function Panel({ title, headerRight, children, flexGrow, flexShrink, minHeight, width, marginTop, marginRight, active }: PanelProps) {
  const t = usePalette();
  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={active ? t.borderActive : t.border}
      backgroundColor={t.background}
      paddingLeft={1}
      paddingRight={1}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      minHeight={minHeight}
      width={width}
      marginTop={marginTop}
      marginRight={marginRight}
    >
      {title ? (
        // flexShrink 0: the header is chrome and must never squash. Without it,
        // Yoga shrinks this row to zero height when the panel is squeezed below
        // content size and the body paints OVER the title — interleaved text
        // with the title's letters showing through the body's spaces. Pinning
        // the chrome degrades overflow to bottom-edge clipping instead.
        <box flexDirection="row" flexShrink={0} height={1} overflow="hidden">
          <text fg={t.primary} wrapMode="none">{title}</text>
          <box flexGrow={1} />
          {headerRight ? <text fg={t.muted} wrapMode="none">{headerRight}</text> : null}
        </box>
      ) : null}
      {children}
    </box>
  );
}
