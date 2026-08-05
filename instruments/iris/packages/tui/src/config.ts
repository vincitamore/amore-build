import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolveIrisHome } from '@amore/regula';

// Single on-disk config for the TUI (theme + per-view collapse state), at
// <iris-home>/config.json. All readers/writers go through here so independent
// settings (theme, collapsed groups) never clobber each other.

function configDir(): string {
  return resolveIrisHome();
}

function configFile(): string {
  return join(configDir(), 'config.json');
}

export interface IrisConfig {
  theme?: string;
  /** Collapsed group keys per view (e.g. { tasks: ['paused','complete'] }). */
  collapsed?: Record<string, string[]>;
}

export function readConfig(): IrisConfig {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8')) as IrisConfig;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: IrisConfig): void {
  try {
    const file = configFile();
    mkdirSync(configDir(), { recursive: true });
    // Atomic write: serialize to a temp file, then rename over the target (atomic on the same fs).
    // A torn direct write would leave invalid JSON that readConfig's catch silently resets to {} —
    // losing every persisted setting. tmp + rename makes the swap all-or-nothing.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // best-effort; a read-only home just means settings don't persist
  }
}

/** Persisted collapsed-group keys for a view, or null if the view has never been touched
 *  (so the caller can apply a default — iris defaults all groups collapsed). */
export function getCollapsed(key: string): Set<string> | null {
  const arr = readConfig().collapsed?.[key];
  return arr ? new Set(arr) : null;
}

export function setCollapsed(key: string, set: Set<string>): void {
  const cfg = readConfig();
  cfg.collapsed = { ...(cfg.collapsed ?? {}), [key]: [...set] };
  writeConfig(cfg);
}
