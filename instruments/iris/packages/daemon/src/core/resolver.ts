// ─────────────────────────────────────────────────────────────────────────────
// core/resolver.ts — the 6-step wikilink resolution ladder, ported from
// src-tauri/src/server/index.rs::resolve_link_ctx. Pure w.r.t. the built maps.
//
// For a target `T` written in doc `sourcePath`:
//   0. Strip `|label` + `#anchor`, trim. Empty → missing.
//   5. Scheme-qualified (`^[a-z][a-z0-9+.-]*://`) → skip (checked FIRST).
//   1/2. Exact / org-root-relative path (lowercased, ± `.md`) via pathMap → resolved.
//   3. Doc-relative (`./` or `../`): normalize against the source dir. Escapes the
//      org root → skip. In-root exact (± `.md`) → resolved; else fall through.
//   4. Unique-stem fallback: basename stem (trailing `.md` stripped ONLY — so
//      `governance.ts` keeps its extension), lowercased, ≠ readme/claude; exactly
//      ONE indexed doc with that stem → resolved. ≥2 → abstain (fall through).
//   4b. Project-name: `projects/<name>` folder → its README/CLAUDE.
//   6. Else → missing.
// ─────────────────────────────────────────────────────────────────────────────

import type { LinkResolution } from '../contract';

export interface ResolverMaps {
  /** lowercased org-relative path AND path-without-`.md` → real path. */
  pathMap: Map<string, string>;
  /** lowercased stem → real paths (length 1 = unique; ≥2 = ambiguous, abstain). */
  stemMap: Map<string, string[]>;
  /** lowercased `projects/<name>` folder → its README/CLAUDE doc path. */
  projectMap: Map<string, string>;
}

/**
 * True when `t` begins with a URI scheme (`^[a-z][a-z0-9+.-]*://`) — e.g.
 * `skill://regula`, `https://…`. Legacy `is_scheme_qualified`: `find("://")`
 * with `Some(0) | None → false`.
 */
export function isSchemeQualified(t: string): boolean {
  const pos = t.indexOf('://');
  if (pos <= 0) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(t.slice(0, pos));
}

/**
 * Basename stem of a wikilink target: last `/`-segment minus a trailing `.md`
 * ONLY (legacy `target_stem`). `governance.ts` stays `governance.ts`;
 * `x/foo.manifest` stays `foo.manifest`.
 */
export function targetStem(t: string): string {
  const seg = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t;
  return seg.endsWith('.md') ? seg.slice(0, -3) : seg;
}

/**
 * Lexically normalize a doc-relative target (`rel`, starting `./`/`../`) against
 * `sourceDir` (`/`-joined, no trailing slash, `''` for a root-level doc). Returns
 * the normalized in-root path, or null if it escapes above the org root. Legacy
 * `normalize_relative`.
 */
export function normalizeRelative(sourceDir: string, rel: string): string | null {
  const stack: string[] = sourceDir === '' ? [] : sourceDir.split('/').filter((c) => c.length > 0);
  for (const comp of rel.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp === '..') {
      if (stack.pop() === undefined) return null;
    } else {
      stack.push(comp);
    }
  }
  return stack.join('/');
}

/** Resolve `target` written in `sourcePath` via the 6-step ladder against `maps`. */
export function resolveTarget(target: string, sourcePath: string, maps: ResolverMaps): LinkResolution {
  // (0) strip |label + #anchor, trim.
  let t = target.trim();
  const pipe = t.indexOf('|');
  if (pipe !== -1) t = t.slice(0, pipe);
  const hash = t.indexOf('#');
  if (hash !== -1) t = t.slice(0, hash);
  t = t.trim();
  if (t === '') return { kind: 'missing' };

  // (5) scheme-qualified → skip.
  if (isSchemeQualified(t)) return { kind: 'skip' };

  const tLower = t.toLowerCase();

  // (1)+(2) exact / org-root-relative path (± .md).
  const exact = maps.pathMap.get(tLower);
  if (exact !== undefined) return { kind: 'resolved', path: exact };
  const exactMd = maps.pathMap.get(`${tLower}.md`);
  if (exactMd !== undefined) return { kind: 'resolved', path: exactMd };

  // (3) doc-relative.
  if (t.startsWith('./') || t.startsWith('../')) {
    const slash = sourcePath.lastIndexOf('/');
    const sourceDir = slash !== -1 ? sourcePath.slice(0, slash) : '';
    const norm = normalizeRelative(sourceDir, t);
    if (norm === null) return { kind: 'skip' }; // escaped the org root → cross-tree
    const n = norm.toLowerCase();
    const hit = maps.pathMap.get(n);
    if (hit !== undefined) return { kind: 'resolved', path: hit };
    const hitMd = maps.pathMap.get(`${n}.md`);
    if (hitMd !== undefined) return { kind: 'resolved', path: hitMd };
    // in-root but unmatched → fall through to the unique-stem heal.
  }

  // (4) unique-stem fallback (never guesses on ambiguity).
  const stem = targetStem(t).toLowerCase();
  if (stem !== '' && stem !== 'readme' && stem !== 'claude') {
    const paths = maps.stemMap.get(stem);
    if (paths !== undefined && paths.length === 1) return { kind: 'resolved', path: paths[0] };
  }

  // (4b) project-folder-name.
  const proj = maps.projectMap.get(tLower);
  if (proj !== undefined) return { kind: 'resolved', path: proj };

  // (6) genuinely unresolved.
  return { kind: 'missing' };
}
