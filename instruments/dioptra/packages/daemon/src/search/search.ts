// ─────────────────────────────────────────────────────────────────────────────
// search.ts — the legacy search compose (src-tauri/src/server/index.rs::search).
//
// Faithful port of the scoring/ordering:
//   let query_lower = query.to_lowercase();          // lowercased ONCE, up front
//   for each doc:
//     title_score = fuzzy_match(title, query_lower).unwrap_or(0)   // None → 0
//     path_score  = fuzzy_match(path,  query_lower).unwrap_or(0)
//     tag_score   = doc.tags.iter().filter_map(|t| fuzzy_match(t, query_lower))
//                     .max().unwrap_or(0)            // max over MATCHED tags only
//     total = title_score*3 + path_score + tag_score*2
//     keep if total > 0
//   results.sort_by(|a,b| b.score.cmp(&a.score))     // STABLE, descending
//   results.take(50)
//
// Notes on faithfulness:
//   - fuzzy scores can be negative; title/path use unwrap_or(0) (None→0, Some(n)
//     kept even if <0). Tag score is the max over ONLY the tags that matched
//     (filter_map drops non-matches), or 0 when no tag matched — subtly distinct
//     from a per-tag unwrap_or(0). Replicated exactly.
//   - Rust `Vec::sort_by` is stable; JS `Array.sort` is stable (ES2019+). Ties
//     keep incoming order = the index Map's insertion (walk) order. Legacy's is
//     HashMap hash-order; the parity harness canonicalizes intra-tier order.
// ─────────────────────────────────────────────────────────────────────────────

import type { IndexedDoc, OrgIndex } from '../contract.ts';
import { fuzzyMatch } from './skim.ts';

export function search(index: OrgIndex, query: string): IndexedDoc[] {
  const queryLower = query.toLowerCase();

  const scored: { doc: IndexedDoc; total: number }[] = [];
  for (const doc of index.docs.values()) {
    const titleScore = fuzzyMatch(doc.title, queryLower) ?? 0;
    const pathScore = fuzzyMatch(doc.path, queryLower) ?? 0;

    let maxTag: number | null = null;
    for (const tag of doc.tags) {
      const s = fuzzyMatch(tag, queryLower);
      if (s !== null && (maxTag === null || s > maxTag)) maxTag = s;
    }
    const tagScore = maxTag ?? 0;

    const total = titleScore * 3 + pathScore + tagScore * 2;
    if (total > 0) scored.push({ doc, total });
  }

  // Stable descending sort by score, then hard-cap at 50.
  scored.sort((a, b) => b.total - a.total);
  return scored.slice(0, 50).map((x) => x.doc);
}
