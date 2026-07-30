import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { dlog } from './debug';
import { loadThemeName, saveThemeName, toPalette, type Palette } from './theme';

interface ThemeContextValue {
  /** The active theme resolved to terminal RGBA. */
  palette: Palette;
  /** The active theme id (key into THEMES). */
  themeName: string;
  /** Apply + persist a theme (the committed choice). */
  setTheme: (name: string) => void;
  /** Apply a theme transiently without persisting (live preview while picking). */
  previewTheme: (name: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Holds the active theme. Reads the persisted choice (or DIOPTRA_THEME / Horizon
 * default) on mount; `setTheme` persists, `previewTheme` doesn't. Any view under
 * the provider re-renders on a switch, so theme changes are live everywhere.
 */
export function ThemeProvider({ children, initial }: { children: ReactNode; initial?: string }) {
  const [themeName, setThemeName] = useState<string>(() => initial ?? loadThemeName());
  const palette = useMemo(() => toPalette(themeName), [themeName]);

  // dlog: a theme change re-renders EVERY usePalette consumer (all members at once) — one of the
  // two global-invalidation suspects for the A0 native crash (the other: resize). Breadcrumb both.
  const setTheme = useCallback((name: string) => {
    dlog('theme', `commit ${name}`);
    setThemeName(name);
    saveThemeName(name);
  }, []);
  const previewTheme = useCallback((name: string) => {
    dlog('theme', `preview ${name}`);
    setThemeName(name);
  }, []);

  const value = useMemo(
    () => ({ palette, themeName, setTheme, previewTheme }),
    [palette, themeName, setTheme, previewTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

/** Convenience for views that only need the colors. */
export function usePalette(): Palette {
  return useTheme().palette;
}
