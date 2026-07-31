// ─────────────────────────────────────────────────────────────────────────────
// /api/files — routes::list_files + routes::get_file.
//
//   GET /api/files                 → {count, items:[WireDoc,...]} (no content).
//     Filters (AND-composed, all optional): type (exact === derived type),
//     prefix (path.startsWith verbatim), exclude_prefix (drop path.startsWith).
//     Source = ALL indexed docs (no archive/resolved exclusion here). Order is
//     hash-random in legacy → we impose path-asc; the harness canonicalizes.
//
//   GET /api/files/{*path}         → WireDoc + content + resolvedBacklinks +
//     resolvedOutbound, or 404 (empty) when the path is not an indexed doc.
//     - content: file body with frontmatter stripped (core.extractBody), read
//       from disk per-request.
//     - resolvedBacklinks: for each backlink path that IS an indexed doc,
//       {path,title,type}; unresolvable dropped; order follows the backlinks array.
//     - resolvedOutbound: one entry per DISTINCT outbound target (first-seen
//       order): resolved → {resolvedPath,target,title,type} (title/type from the
//       target doc, may be null if the bound path isn't indexed); skip/missing →
//       {target} only.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DaemonDeps,
  ResolvedBacklink,
  ResolvedOutbound,
} from '../contract.ts';
import { emptyStatus, json } from './http.ts';

export interface ListFilesQuery {
  type?: string;
  prefix?: string;
  exclude_prefix?: string;
}

export function listFiles(deps: DaemonDeps, query: ListFilesQuery): Response {
  let docs = [...deps.index.docs.values()];
  if (query.type !== undefined) docs = docs.filter((d) => d.docType === query.type);
  if (query.prefix !== undefined) docs = docs.filter((d) => d.path.startsWith(query.prefix!));
  if (query.exclude_prefix !== undefined) {
    docs = docs.filter((d) => !d.path.startsWith(query.exclude_prefix!));
  }
  // Deterministic path-asc (legacy order is HashMap-random; harness canonicalizes).
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const items = docs.map((d) => deps.core.serializeDoc(d));
  return json({ count: items.length, items });
}

export function getFile(deps: DaemonDeps, path: string): Response {
  const doc = deps.index.docs.get(path);
  if (doc === undefined) return emptyStatus(404);

  // Body from disk, frontmatter stripped. If the on-disk file has gone missing
  // since indexing, serve an empty body rather than 404 (the doc IS indexed).
  let content = '';
  try {
    content = deps.core.extractBody(readFileSync(join(deps.config.orgRoot, path), 'utf8'));
  } catch {
    content = '';
  }

  const resolvedBacklinks: ResolvedBacklink[] = [];
  for (const p of doc.backlinks) {
    const d = deps.index.docs.get(p);
    if (d !== undefined) resolvedBacklinks.push({ path: d.path, title: d.title, type: d.docType });
  }

  const seen = new Set<string>();
  const resolvedOutbound: ResolvedOutbound[] = [];
  for (const link of doc.links) {
    if (seen.has(link)) continue;
    seen.add(link);
    const res = deps.index.resolve(link, doc.path);
    if (res.kind === 'resolved') {
      const target = deps.index.docs.get(res.path);
      // Alphabetical key order (Regime B): resolvedPath, target, title, type.
      resolvedOutbound.push({
        resolvedPath: res.path,
        target: link,
        title: target ? target.title : null,
        type: target ? target.docType : null,
      });
    } else {
      // Skip (scheme/cross-tree) and Missing both render as the bare {target}.
      resolvedOutbound.push({ target: link });
    }
  }

  const wire = deps.core.serializeDoc(doc, { content, resolvedBacklinks, resolvedOutbound });
  return json(wire);
}
