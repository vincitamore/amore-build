// Minimal path / wikilink resolution against a known doc set (no daemon required).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface DocIndex {
  /** org-relative paths (forward slashes) */
  paths: Set<string>;
  /** lowercased stem → paths */
  byStem: Map<string, string[]>;
  /** lowercased path (with and without .md) → path */
  byPath: Map<string, string>;
}

export function buildDocIndex(paths: string[]): DocIndex {
  const pathSet = new Set(paths);
  const byStem = new Map<string, string[]>();
  const byPath = new Map<string, string>();
  for (const p of paths) {
    byPath.set(p.toLowerCase(), p);
    if (p.endsWith('.md')) {
      const noExt = p.slice(0, -3);
      if (!byPath.has(noExt.toLowerCase())) byPath.set(noExt.toLowerCase(), p);
    }
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    const stem = (base.endsWith('.md') ? base.slice(0, -3) : base).toLowerCase();
    if (!stem || stem === 'readme' || stem === 'agents' || stem === 'claude') continue;
    const arr = byStem.get(stem);
    if (arr) arr.push(p);
    else byStem.set(stem, [p]);
  }
  return { paths: pathSet, byStem, byPath };
}

/**
 * Resolve a raw target (wikilink inner text, path, or free-text path fragment)
 * to an org-relative `.md` path, or null when ambiguous / missing.
 */
export function resolveTarget(
  orgRoot: string,
  raw: string,
  index: DocIndex,
  _fromPath?: string,
): string | null {
  let t = raw.trim();
  if (!t) return null;
  // strip optional leading ./ and anchors
  t = t.replace(/^\.\//, '');
  const hash = t.indexOf('#');
  if (hash !== -1) t = t.slice(0, hash);
  t = t.replace(/\\/g, '/');
  if (!t) return null;

  // Exact path map hit
  const mapped = index.byPath.get(t.toLowerCase()) ?? index.byPath.get(`${t}.md`.toLowerCase());
  if (mapped) return mapped;

  // On-disk existence under org root
  const candidates = t.endsWith('.md') ? [t] : [t, `${t}.md`];
  for (const c of candidates) {
    if (existsSync(join(orgRoot, ...c.split('/'))) && c.endsWith('.md')) {
      return c.replace(/\\/g, '/');
    }
  }

  // Stem uniqueness
  const base = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t;
  const stem = (base.endsWith('.md') ? base.slice(0, -3) : base).toLowerCase();
  const stems = index.byStem.get(stem);
  if (stems && stems.length === 1) return stems[0];

  return null;
}

/** Extract `[[target]]` or `[[target|label]]` inners from a string. */
export function extractWikilinkTargets(text: string): string[] {
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}
