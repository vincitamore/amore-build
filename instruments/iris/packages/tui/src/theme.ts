import { RGBA } from '@opentui/core';
import { readConfig, writeConfig } from './config';

// ─────────────────────────────────────────────────────────────────────────────
// Vitrum design language — swappable themes, mirrored from the GUI's theme system.
// Flat + dark/light + border-based: 1px borders, HARD corners (no radius), no
// shadows/blur. Hierarchy is carried by SEMANTIC COLOR, not size. Monospace is a
// given (terminal). The first six themes mirror the Tauri client EXACTLY
// (packages/client/src/lib/theme.tsx, the `--term-*` custom properties); the rest
// are curated additions covering the gamut (incl. light themes). Default: Horizon.
// The canonical contract lives in the /vitrum skill "Design language" section.
// ─────────────────────────────────────────────────────────────────────────────

export type ColorKey =
  | 'background'
  | 'foreground'
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'border'
  | 'borderActive'
  | 'muted'
  | 'selection';

export interface RawTheme {
  name: string;
  label: string;
  colors: Record<ColorKey, string>;
}

/** The active theme resolved to terminal-ready RGBA values. */
export type Palette = Record<ColorKey, RGBA>;

export const DEFAULT_THEME = 'horizon';

// The registry. Keys are stable ids; `label` is the human name shown in the picker.
export const THEMES: Record<string, RawTheme> = {
  // ── Mirrors the Tauri client (exact) ──────────────────────────────────────
  horizon: {
    name: 'horizon',
    label: 'Horizon',
    colors: {
      background: '#1c1e26', foreground: '#d5d8da', primary: '#e95678', secondary: '#fab795',
      accent: '#29d398', success: '#29d398', warning: '#fab795', error: '#e95678', info: '#26bbd9',
      border: '#2e303e', borderActive: '#e95678', muted: '#6c6f93', selection: '#2e303e',
    },
  },
  dracula: {
    name: 'dracula',
    label: 'Dracula',
    colors: {
      background: '#282a36', foreground: '#f8f8f2', primary: '#bd93f9', secondary: '#ff79c6',
      accent: '#50fa7b', success: '#50fa7b', warning: '#f1fa8c', error: '#ff5555', info: '#8be9fd',
      border: '#44475a', borderActive: '#bd93f9', muted: '#6272a4', selection: '#44475a',
    },
  },
  nord: {
    name: 'nord',
    label: 'Nord',
    colors: {
      background: '#2e3440', foreground: '#eceff4', primary: '#88c0d0', secondary: '#81a1c1',
      accent: '#a3be8c', success: '#a3be8c', warning: '#ebcb8b', error: '#bf616a', info: '#5e81ac',
      border: '#3b4252', borderActive: '#88c0d0', muted: '#4c566a', selection: '#434c5e',
    },
  },
  tokyonight: {
    name: 'tokyonight',
    label: 'Tokyo Night',
    colors: {
      background: '#1a1b26', foreground: '#c0caf5', primary: '#7aa2f7', secondary: '#bb9af7',
      accent: '#9ece6a', success: '#9ece6a', warning: '#e0af68', error: '#f7768e', info: '#7dcfff',
      border: '#292e42', borderActive: '#7aa2f7', muted: '#565f89', selection: '#33467c',
    },
  },
  catppuccin: {
    name: 'catppuccin',
    label: 'Catppuccin Mocha',
    colors: {
      background: '#1e1e2e', foreground: '#cdd6f4', primary: '#cba6f7', secondary: '#f5c2e7',
      accent: '#a6e3a1', success: '#a6e3a1', warning: '#f9e2af', error: '#f38ba8', info: '#89dceb',
      border: '#313244', borderActive: '#cba6f7', muted: '#6c7086', selection: '#45475a',
    },
  },
  gruvbox: {
    name: 'gruvbox',
    label: 'Gruvbox',
    colors: {
      background: '#282828', foreground: '#ebdbb2', primary: '#fabd2f', secondary: '#83a598',
      accent: '#b8bb26', success: '#b8bb26', warning: '#fabd2f', error: '#fb4934', info: '#83a598',
      border: '#3c3836', borderActive: '#fabd2f', muted: '#665c54', selection: '#504945',
    },
  },
  // ── Curated additions (canonical published palettes) ──────────────────────
  onedark: {
    name: 'onedark',
    label: 'One Dark',
    colors: {
      background: '#282c34', foreground: '#abb2bf', primary: '#61afef', secondary: '#c678dd',
      accent: '#98c379', success: '#98c379', warning: '#e5c07b', error: '#e06c75', info: '#56b6c2',
      border: '#3e4451', borderActive: '#61afef', muted: '#5c6370', selection: '#3e4451',
    },
  },
  monokai: {
    name: 'monokai',
    label: 'Monokai',
    colors: {
      background: '#272822', foreground: '#f8f8f2', primary: '#f92672', secondary: '#ae81ff',
      accent: '#a6e22e', success: '#a6e22e', warning: '#fd971f', error: '#f92672', info: '#66d9ef',
      border: '#3e3d32', borderActive: '#f92672', muted: '#75715e', selection: '#49483e',
    },
  },
  rosepine: {
    name: 'rosepine',
    label: 'Rosé Pine',
    colors: {
      background: '#191724', foreground: '#e0def4', primary: '#c4a7e7', secondary: '#ebbcba',
      accent: '#9ccfd8', success: '#31748f', warning: '#f6c177', error: '#eb6f92', info: '#9ccfd8',
      border: '#26233a', borderActive: '#c4a7e7', muted: '#6e6a86', selection: '#403d52',
    },
  },
  everforest: {
    name: 'everforest',
    label: 'Everforest',
    colors: {
      background: '#2d353b', foreground: '#d3c6aa', primary: '#7fbbb3', secondary: '#a7c080',
      accent: '#83c092', success: '#a7c080', warning: '#dbbc7f', error: '#e67e80', info: '#83c092',
      border: '#475258', borderActive: '#7fbbb3', muted: '#859289', selection: '#543a48',
    },
  },
  solarized: {
    name: 'solarized',
    label: 'Solarized Dark',
    colors: {
      background: '#002b36', foreground: '#839496', primary: '#268bd2', secondary: '#6c71c4',
      accent: '#859900', success: '#859900', warning: '#b58900', error: '#dc322f', info: '#2aa198',
      border: '#073642', borderActive: '#268bd2', muted: '#586e75', selection: '#073642',
    },
  },
  ayu: {
    name: 'ayu',
    label: 'Ayu Dark',
    colors: {
      background: '#0d1017', foreground: '#bfbdb6', primary: '#59c2ff', secondary: '#d2a6ff',
      accent: '#e6b450', success: '#aad94c', warning: '#ffb454', error: '#f26d78', info: '#39bae6',
      border: '#1c2330', borderActive: '#59c2ff', muted: '#565b66', selection: '#1c2330',
    },
  },
  // ── Light themes ──────────────────────────────────────────────────────────
  solarizedlight: {
    name: 'solarizedlight',
    label: 'Solarized Light',
    colors: {
      background: '#fdf6e3', foreground: '#657b83', primary: '#268bd2', secondary: '#6c71c4',
      accent: '#859900', success: '#859900', warning: '#b58900', error: '#dc322f', info: '#2aa198',
      border: '#eee8d5', borderActive: '#268bd2', muted: '#93a1a1', selection: '#eee8d5',
    },
  },
  catppuccinlatte: {
    name: 'catppuccinlatte',
    label: 'Catppuccin Latte',
    colors: {
      background: '#eff1f5', foreground: '#4c4f69', primary: '#8839ef', secondary: '#ea76cb',
      accent: '#40a02b', success: '#40a02b', warning: '#df8e1d', error: '#d20f39', info: '#04a5e5',
      border: '#ccd0da', borderActive: '#8839ef', muted: '#6c6f85', selection: '#bcc0cc',
    },
  },
  gruvboxlight: {
    name: 'gruvboxlight',
    label: 'Gruvbox Light',
    colors: {
      background: '#fbf1c7', foreground: '#3c3836', primary: '#458588', secondary: '#689d6a',
      accent: '#98971a', success: '#98971a', warning: '#d79921', error: '#cc241d', info: '#458588',
      border: '#ebdbb2', borderActive: '#d79921', muted: '#7c6f64', selection: '#ebdbb2',
    },
  },
};

/** Stable display order for the picker (registry insertion order). */
export const THEME_ORDER = Object.keys(THEMES);

export function hexToRgba(hex: string): RGBA {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return RGBA.fromInts(r, g, b);
}

const paletteCache = new Map<string, Palette>();

/** Resolve a theme's hex colors into terminal-ready RGBA (cached per theme id). */
export function toPalette(name: string): Palette {
  const cached = paletteCache.get(name);
  if (cached) return cached;
  const raw = THEMES[name] ?? THEMES[DEFAULT_THEME];
  const out = {} as Palette;
  for (const key of Object.keys(raw.colors) as ColorKey[]) {
    out[key] = hexToRgba(raw.colors[key]);
  }
  paletteCache.set(name, out);
  return out;
}

/** Badge/accent color for a document type, drawn from the active palette. */
export function typeColor(p: Palette, type?: string): RGBA {
  switch (type) {
    case 'task':
      return p.success;
    case 'knowledge':
      return p.info;
    case 'reminder':
      return p.error;
    case 'forge':
      return p.primary;
    case 'inbox':
      return p.warning;
    default:
      return p.secondary;
  }
}

/** Badge color for a task status, drawn from the active palette. */
export function taskStatusColor(p: Palette, status?: string): RGBA {
  switch (status) {
    case 'active':
      return p.success;
    case 'blocked':
      return p.error;
    case 'review':
      return p.warning;
    case 'incubating':
      return p.info;
    case 'paused':
      return p.secondary;
    default: // backlog, complete
      return p.muted;
  }
}

/** Badge color for a reminder status, drawn from the active palette. */
export function reminderStatusColor(p: Palette, status?: string): RGBA {
  switch (status) {
    case 'pending':
      return p.info;
    case 'ongoing':
      return p.success;
    case 'snoozed':
      return p.secondary;
    default: // completed, dismissed
      return p.muted;
  }
}

// ── Persistence (env override wins for smokes/screenshots) ────────────────────
export function loadThemeName(): string {
  const env = process.env.IRIS_THEME;
  if (env && env in THEMES) return env;
  const theme = readConfig().theme;
  return theme && theme in THEMES ? theme : DEFAULT_THEME;
}

export function saveThemeName(name: string): void {
  writeConfig({ ...readConfig(), theme: name });
}
