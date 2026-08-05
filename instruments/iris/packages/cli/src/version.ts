/**
 * Package version for CLI --version. Imported from package.json so
 * `bun build --compile` embeds it; never hardcode the number.
 */

import pkg from '../package.json';

export const IRIS_VERSION: string =
  typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';

/** One-line version banner printed by --version / -V / version. */
export function versionLine(): string {
  return `iris ${IRIS_VERSION}`;
}
