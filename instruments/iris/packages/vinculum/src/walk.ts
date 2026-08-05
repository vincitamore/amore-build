// Walk durable house roots for tier-0 derivation. Scope matches the product
// durable set: tasks/, inbox/, knowledge/, context/.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DURABLE_ROOTS = ['tasks', 'inbox', 'knowledge', 'context'] as const;

const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'dist', 'build', '.next', 'target']);

/**
 * Collect org-relative forward-slash paths of every `.md` file under durable
 * roots. Sorted for stable derive output.
 */
export function walkDurableDocs(orgRoot: string): string[] {
  const out: string[] = [];
  for (const root of DURABLE_ROOTS) {
    const abs = join(orgRoot, root);
    if (!existsSync(abs)) continue;
    walkDir(orgRoot, root, out);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function walkDir(orgRoot: string, rel: string, out: string[]): void {
  const abs = join(orgRoot, rel);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = join(orgRoot, childRel);
    let st;
    try {
      st = statSync(childAbs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(orgRoot, childRel, out);
    } else if (st.isFile() && name.endsWith('.md')) {
      out.push(childRel.replace(/\\/g, '/'));
    }
  }
}
