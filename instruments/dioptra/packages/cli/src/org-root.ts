import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Resolve the org root: `$DIOPTRA_ORG_ROOT` if set, else walk up from `start` looking
 * for org markers — `(AGENTS.md|AGENT.md|CLAUDE.md)` beside a `tasks/` dir. Returns null when
 * neither resolves — callers REFUSE rather than fall back to cwd (a silent cwd
 * fallback would scaffold tasks/ into whatever directory the command happened to
 * run from). AGENTS.md is selene's orientation surface; AGENT.md + CLAUDE.md remain
 * accepted as sibling-house lineage (foreign-root refusals happen elsewhere).
 */
export function resolveOrgRoot(start: string = process.cwd()): string | null {
  const env = process.env.DIOPTRA_ORG_ROOT;
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
