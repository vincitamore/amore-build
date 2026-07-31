import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Resolve the org root: `$IRIS_ORG_ROOT` if set, else walk up from `start` looking
 * for org markers — `(AGENTS.md|AGENT.md|CLAUDE.md)` beside a `tasks/` dir. Returns null when
 * neither resolves — callers REFUSE rather than fall back to cwd (a silent cwd
 * fallback would scaffold tasks/ into whatever directory the command happened to
 * run from). Marker recognition for walk-up is separate from mutation trust
 * (`@arcus/regula` root-trust): reads work on any resolved root; writes need a
 * house root or explicit opt-in.
 */
export function resolveOrgRoot(start: string = process.cwd()): string | null {
  const env = process.env.IRIS_ORG_ROOT;
  if (env) return resolve(env);
  let dir = resolve(start);
  for (;;) {
    const hasOrient =
      existsSync(join(dir, 'AGENTS.md')) ||
      existsSync(join(dir, 'AGENT.md')) ||
      existsSync(join(dir, 'CLAUDE.md'));
    if (hasOrient && existsSync(join(dir, 'tasks'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
