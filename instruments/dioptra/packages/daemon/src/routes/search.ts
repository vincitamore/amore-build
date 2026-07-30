// ─────────────────────────────────────────────────────────────────────────────
// GET /api/search — routes::search. Regime A envelope {query,count,total,items},
// Regime B items (no content). Missing `q` → 400 text/plain (axum QueryRejection);
// any present `q` (even empty) → 200. count == total == items.length.
// The handler ignores type/tag/limit (SearchQuery is {q} only). `query` echoes
// the raw `q` verbatim; the compose lowercases internally.
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonDeps } from '../contract.ts';
import { json, text } from './http.ts';

/** The exact axum QueryRejection body for a missing required field. */
export const MISSING_Q_BODY = 'Failed to deserialize query string: missing field `q`';

/** `q` is null when the param is absent entirely (→ 400); '' when present-empty
 *  (→ 200 with an empty result set). */
export function searchRoute(deps: DaemonDeps, q: string | null): Response {
  if (q === null) return text(400, MISSING_Q_BODY, 'text/plain; charset=utf-8');

  const results = deps.search.search(deps.index, q);
  const items = results.map((d) => deps.core.serializeDoc(d));
  return json({ query: q, count: items.length, total: items.length, items });
}
