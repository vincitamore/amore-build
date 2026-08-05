// ─────────────────────────────────────────────────────────────────────────────
// GET /api/search — routes::search.
//
// mode=index (default): Regime A envelope {query,count,total,items}, Regime B
// items (no content). Byte-compatible with the legacy fuzzy index path.
// Missing `q` → 400 text/plain (axum QueryRejection); any present `q` (even
// empty) → 200. count == total == items.length. `query` echoes the raw `q`
// verbatim; the compose lowercases internally.
//
// mode=lex|vec|query: proxy to the managed qmd companion. Same envelope shape
// plus backend:"qmd", mode, snippets when provided. Backend missing → HTTP 200
// with {available:false, reason, items:[]} (never a silent empty list).
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonDeps } from '../contract.ts';
import type { QmdSearchMode } from '../proxies/qmd.ts';
import { json, text } from './http.ts';

/** The exact axum QueryRejection body for a missing required field. */
export const MISSING_Q_BODY = 'Failed to deserialize query string: missing field `q`';

const QMD_MODES = new Set<string>(['lex', 'vec', 'query']);

function parseLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 40;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 40;
  return Math.min(Math.floor(n), 100);
}

/** `q` is null when the param is absent entirely (→ 400); '' when present-empty
 *  (→ 200 with an empty result set). */
export function searchRoute(
  deps: DaemonDeps,
  q: string | null,
  mode: string | null = null,
  limit: string | null = null,
): Response | Promise<Response> {
  if (q === null) return text(400, MISSING_Q_BODY, 'text/plain; charset=utf-8');

  const m = (mode ?? 'index').toLowerCase();
  if (m === 'index' || m === '') {
    const results = deps.search.search(deps.index, q);
    const items = results.map((d) => deps.core.serializeDoc(d));
    return json({ query: q, count: items.length, total: items.length, items });
  }

  if (!QMD_MODES.has(m)) {
    return json({
      query: q,
      count: 0,
      total: 0,
      items: [],
      available: false,
      reason: `unknown search mode '${mode}' (expected index|lex|vec|query)`,
      mode: m,
    });
  }

  return qmdSearchRoute(deps, q, m as QmdSearchMode, parseLimit(limit));
}

async function qmdSearchRoute(
  deps: DaemonDeps,
  q: string,
  mode: QmdSearchMode,
  limit: number,
): Promise<Response> {
  if (!deps.qmd) {
    return json({
      query: q,
      count: 0,
      total: 0,
      items: [],
      available: false,
      reason: 'qmd backend not configured',
      mode,
      backend: 'qmd',
    });
  }

  const result = await deps.qmd.search(deps.config.orgRoot, q, mode, limit);
  if (!result.available) {
    return json({
      query: q,
      count: 0,
      total: 0,
      items: [],
      available: false,
      reason: result.reason ?? 'qmd unavailable',
      mode,
      backend: 'qmd',
    });
  }

  // Merge qmd hits with index metadata when the path is indexed; otherwise emit
  // a minimal wire-shaped item with path/title/snippet/score.
  const items = result.items.map((hit) => {
    const doc = deps.index.docs.get(hit.path);
    if (doc) {
      const wire = { ...(deps.core.serializeDoc(doc) as unknown as Record<string, unknown>) };
      if (hit.score !== undefined) wire.score = hit.score;
      if (hit.snippet) wire.snippet = hit.snippet;
      return wire;
    }
    return {
      path: hit.path,
      title: hit.title,
      type: 'other',
      status: null,
      created: null,
      updated: null,
      tags: [] as string[],
      links: [] as string[],
      backlinks: [] as string[],
      ...(hit.score !== undefined ? { score: hit.score } : {}),
      ...(hit.snippet ? { snippet: hit.snippet } : {}),
    };
  });

  return json({
    query: q,
    count: items.length,
    total: items.length,
    items,
    available: true,
    mode,
    backend: 'qmd',
  });
}
