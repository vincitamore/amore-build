// ─────────────────────────────────────────────────────────────────────────────
// core/index-build.ts — walk + parse the whole org, build the resolution maps,
// then the backlink pass. Ports src-tauri/src/server/index.rs
// (`rebuild_lookup_maps` + `rebuild_backlinks`) exactly.
// ─────────────────────────────────────────────────────────────────────────────

import type { ApplyStats, ChangeSet, IndexBuildStats, IndexedDoc, LinkResolution, OrgIndex } from '../contract';
import { parseDoc } from './parse';
import { resolveTarget, type ResolverMaps } from './resolver';
import { walk } from './walk';

/**
 * Build `pathMap` / `stemMap` / `projectMap` from the document set — legacy
 * `rebuild_lookup_maps`. `pathMap`: lowercased full path (last-wins) AND
 * path-without-`.md` (first-wins, `or_insert`). `stemMap`: lowercased stem
 * (readme/claude excluded) → all paths. `projectMap`: `projects/<name>` folder →
 * project doc (README preferred over CLAUDE).
 */
export function buildLookupMaps(docs: Map<string, IndexedDoc>): ResolverMaps {
  const pathMap = new Map<string, string>();
  const stemMap = new Map<string, string[]>();
  const projectMap = new Map<string, string>();

  for (const path of docs.keys()) {
    const lower = path.toLowerCase();
    pathMap.set(lower, path);
    if (lower.endsWith('.md')) {
      const noExt = lower.slice(0, -3);
      if (!pathMap.has(noExt)) pathMap.set(noExt, path);
    }

    const filename = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    const stem = (filename.endsWith('.md') ? filename.slice(0, -3) : filename).toLowerCase();
    if (stem !== '' && stem !== 'readme' && stem !== 'claude') {
      const arr = stemMap.get(stem);
      if (arr) arr.push(path);
      else stemMap.set(stem, [path]);
    }

    if (path.startsWith('projects/')) {
      const parts = path.slice('projects/'.length).split('/');
      if (parts.length === 2 && (parts[1] === 'README.md' || parts[1] === 'CLAUDE.md')) {
        const key = parts[0].toLowerCase();
        if (parts[1] === 'README.md' || !projectMap.has(key)) projectMap.set(key, path);
      }
    }
  }

  return { pathMap, stemMap, projectMap };
}

/**
 * Recompute every doc's `backlinks` by FORWARD resolution — legacy
 * `rebuild_backlinks`. For each doc's outbound links, resolve via the ladder;
 * a resolved target (≠ the source itself, deduped per source) accumulates the
 * source path. Final `backlinks` are sorted + deduped (deterministic — legacy
 * sorts because HashMap order is not stable).
 */
export function computeBacklinks(
  docs: Map<string, IndexedDoc>,
  resolve: (target: string, sourcePath: string) => LinkResolution,
): void {
  for (const doc of docs.values()) doc.backlinks = [];

  const additions: Array<[string, string]> = [];
  for (const [srcPath, doc] of docs) {
    const seen = new Set<string>();
    for (const link of doc.links) {
      const res = resolve(link, srcPath);
      if (res.kind !== 'resolved') continue;
      if (res.path === srcPath) continue; // no self-backlink
      if (seen.has(res.path)) continue;
      seen.add(res.path);
      additions.push([res.path, srcPath]);
    }
  }

  for (const [target, source] of additions) {
    docs.get(target)?.backlinks.push(source);
  }

  for (const doc of docs.values()) {
    doc.backlinks.sort();
    doc.backlinks = doc.backlinks.filter((v, i, a) => i === 0 || v !== a[i - 1]);
  }
}

/**
 * Cold-build the in-memory org index: full walk → parse each file → lookup maps →
 * backlink pass. Doc insertion order is walk order (contract: serving code must not
 * depend on it; sort where order is contractual). Unreadable files are counted as
 * `parseFailures` and dropped; malformed frontmatter is NOT a failure (the doc is
 * still indexed with recovered/empty fields).
 */
export function buildIndex(orgRoot: string): { index: OrgIndex; stats: IndexBuildStats } {
  const t0 = Date.now();
  const relPaths = walk(orgRoot);

  const docs = new Map<string, IndexedDoc>();
  let parseFailures = 0;
  for (const rel of relPaths) {
    const doc = parseDoc(orgRoot, rel);
    if (doc === null) {
      parseFailures += 1;
      continue;
    }
    docs.set(doc.path, doc);
  }

  const maps = buildLookupMaps(docs);
  const resolve = (target: string, sourcePath: string): LinkResolution =>
    resolveTarget(target, sourcePath, maps);
  computeBacklinks(docs, resolve);

  const index: OrgIndex = {
    docs,
    pathMap: maps.pathMap,
    stemMap: maps.stemMap,
    projectMap: maps.projectMap,
    resolve,
  };
  const stats: IndexBuildStats = {
    files: relPaths.length,
    parsed: docs.size,
    parseFailures,
    ms: Date.now() - t0,
  };
  return { index, stats };
}

/** Clear `target` and refill it from `source` (same instance kept — see applyChanges). */
function refill<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [k, v] of source) target.set(k, v);
}

/**
 * Apply a debounced ChangeSet to the LIVE index in place — the incremental dual of
 * `buildIndex`. Removals delete their doc; updates (re)parse via `parseDoc`, a null
 * parse DROPPING the doc (cold-build parity: an unreadable file is never indexed,
 * so a stale prior copy is removed and the event counts as a parseFailure). Then
 * the lookup maps + ALL backlinks are recomputed from the full doc set (cheap at
 * corpus scale — no surgical map edits, whose last-wins/first-wins subtleties are
 * error-prone).
 *
 * RESOLVE-CLOSURE MECHANISM (clear-and-refill, not rebind): `index.resolve` is the
 * closure `buildIndex` captured over its `maps` object, and `index.pathMap` /
 * `stemMap` / `projectMap` ARE those same Map instances (buildIndex assigns them by
 * reference). Refilling those instances in place — rather than swapping in new Maps
 * and rebinding `index.resolve` — means the existing closure observes the update
 * with nothing to rebind: `resolve`, the three index map properties, and the
 * backlink pass all read one shared set of Maps. (Cold-build parity depends on this
 * invariant: an OrgIndex whose `resolve` did NOT close over `index.pathMap` must be
 * rebuilt via `buildIndex`, not patched here.)
 *
 * POST-CONDITION (pinned by test): after applyChanges the index observably
 * deep-equals a cold `buildIndex(orgRoot)` of the same on-disk state — docs (every
 * field incl. backlinks), all three maps, and `resolve` outcomes alike. Runs
 * synchronously: no request handler observes a half-applied batch.
 */
export function applyChanges(index: OrgIndex, orgRoot: string, changes: ChangeSet): ApplyStats {
  const t0 = Date.now();
  let updated = 0;
  let removed = 0;
  let parseFailures = 0;

  for (const rel of changes.removed) {
    if (index.docs.delete(rel)) removed += 1;
  }
  for (const rel of changes.updated) {
    const doc = parseDoc(orgRoot, rel);
    if (doc === null) {
      index.docs.delete(rel); // parse failure = drop (cold-build behavior)
      parseFailures += 1;
      continue;
    }
    index.docs.set(doc.path, doc);
    updated += 1;
  }

  const fresh = buildLookupMaps(index.docs);
  refill(index.pathMap, fresh.pathMap);
  refill(index.stemMap, fresh.stemMap);
  refill(index.projectMap, fresh.projectMap);
  computeBacklinks(index.docs, index.resolve);

  return { updated, removed, parseFailures, ms: Date.now() - t0 };
}

/**
 * Full reconcile expressed as a ChangeSet through `applyChanges` — the ONE
 * index-update path (never a separate mutation). Re-walks `orgRoot`, treats every
 * walked path as `updated` and every currently-indexed key absent from the walk as
 * `removed`. The watcher falls back to this whenever a batch cannot be classified
 * to admitted `.md` file deltas (null filename, admitted dir-scoped event, a
 * vanished dir holding tracked docs, oversized burst).
 */
export function reconcile(index: OrgIndex, orgRoot: string): ApplyStats {
  const walked = walk(orgRoot);
  const walkedSet = new Set(walked);
  const removed: string[] = [];
  for (const key of index.docs.keys()) {
    if (!walkedSet.has(key)) removed.push(key);
  }
  return applyChanges(index, orgRoot, { updated: walked, removed });
}
