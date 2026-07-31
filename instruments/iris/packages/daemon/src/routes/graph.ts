// ─────────────────────────────────────────────────────────────────────────────
// GET /api/graph — routes::graph. This route parses the query params per legacy
// semantics and delegates ALL construction to deps.graph.buildGraph (the graph
// module owns scope resolution, node/link build, the edges.jsonl overlay, and
// the shape switch).
//
// Param parsing (matches routes.rs):
//   - scope: raw string, passed through (buildGraph's parse_scope owns it).
//   - depth (u32, default 1): seed-BFS only; absent/invalid → 1.
//   - group_by: trimmed; empty → "type"; unknown values pass through (buildGraph
//     degrades to doc-only).
//   - edges: ONLY the exact strings "semantic"/"both" switch mode; everything
//     else (incl. unknown / empty) → "wiki".  (parse_edges_mode.)
//   - shape: passed through verbatim (the ratified legacy|v2 switch).
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonDeps, GraphParams } from '../contract.ts';
import { json } from './http.ts';

function parseEdges(raw: string | null): GraphParams['edges'] {
  const e = (raw ?? '').trim();
  return e === 'semantic' ? 'semantic' : e === 'both' ? 'both' : 'wiki';
}

function parseGroupBy(raw: string | null): string {
  const g = (raw ?? '').trim();
  return g === '' ? 'type' : g;
}

function parseDepth(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

export function graphRoute(deps: DaemonDeps, q: URLSearchParams): Response {
  const params: GraphParams = {
    scope: q.get('scope') ?? undefined,
    depth: parseDepth(q.get('depth')),
    groupBy: parseGroupBy(q.get('group_by')),
    edges: parseEdges(q.get('edges')),
    shape: q.get('shape') ?? undefined,
  };
  return json(deps.graph.buildGraph(deps.index, params, deps.config.orgRoot));
}
