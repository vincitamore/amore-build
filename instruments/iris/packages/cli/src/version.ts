/**
 * Package version for CLI --version.
 * Release builds inject via `bun build --define:__COMPANION_VERSION__=…`
 * (from GROK_VERSION). Source / unstamped compiles fall back to package.json.
 */

import pkg from '../package.json';

declare const __COMPANION_VERSION__: string | undefined;

export const IRIS_VERSION: string =
  (typeof __COMPANION_VERSION__ !== 'undefined' && __COMPANION_VERSION__) ||
  pkg.version ||
  '0.0.0';

/** One-line version banner printed by --version / -V / version. */
export function versionLine(): string {
  return `iris ${IRIS_VERSION}`;
}
