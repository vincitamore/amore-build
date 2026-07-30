// ─────────────────────────────────────────────────────────────────────────────
// GET /api/status — routes::status (Regime A struct order:
//   server{uptime,connectedClients,lastIndexed}, documents{total,byType,byStatus},
//   tags{total,top}, recent).
//
// Count semantics (spec §2, §4, index.rs::get_stats):
//   - documents.total   = ALL indexed docs (incl. archive/ and **/resolved/**).
//   - documents.byType / byStatus = EXCLUDE docs whose path starts_with "archive/"
//     OR contains "/resolved/"; byStatus counts only docs with a non-null status.
//   - tags.top          = tag→count over ALL docs, count-desc, take 10.
//   - tags.total        = top.length AFTER truncation (i.e. min(distinct, 10)).
//   - recent            = docs with updated != null, updated string-desc, take 5.
//
// Legacy tie order is HashMap-random; we impose a deterministic tiebreak (tag
// name asc for tags; path asc for recent). The parity harness canonicalizes
// intra-tie order, so this only guarantees our own determinism.
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonDeps } from '../contract.ts';
import { json, rfc3339Nanos } from './http.ts';

export function status(deps: DaemonDeps): Response {
  const docs = [...deps.index.docs.values()];

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const d of docs) {
    if (d.path.startsWith('archive/') || d.path.includes('/resolved/')) continue;
    byType[d.docType] = (byType[d.docType] ?? 0) + 1;
    if (d.status != null) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
  }

  const tagCounts = new Map<string, number>();
  for (const d of docs) {
    for (const tag of d.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const top = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  const recent = docs
    .filter((d) => d.updated != null)
    .sort((a, b) => {
      const au = a.updated as string;
      const bu = b.updated as string;
      if (au < bu) return 1; // string-descending on the ISO date
      if (au > bu) return -1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; // deterministic tiebreak
    })
    .slice(0, 5)
    .map((d) => ({ path: d.path, title: d.title, type: d.docType, updated: d.updated as string }));

  const uptime = Math.floor((Date.now() - deps.config.startedAt) / 1000);

  return json({
    server: { uptime, connectedClients: 1, lastIndexed: rfc3339Nanos(Date.now()) },
    documents: { total: deps.index.docs.size, byType, byStatus },
    tags: { total: top.length, top },
    recent,
  });
}
