// ─────────────────────────────────────────────────────────────────────────────
// Ratified order-canonicalization (added with the Bun-daemon milestone,
// 2026-07-02).
//
// Discovery: the legacy daemon's collection ordering is Rust `HashMap`
// iteration order — stable within one process, RESEEDED on every restart.
// The element order of `/api/files.items`, `/api/search.items` (intra-tier),
// and `/api/graph.nodes`/`.links` (doc-order segments) is therefore not a
// contract any client can rely on and not a behavior ANY rewrite can
// reproduce (milestone-1 self-replay never exercised this: same process ⇒
// same hash order). Ratified consequence: for the arrays listed in
// `CANON` (cases.ts), BOTH the golden body and the target body are sorted by
// the same key spec before diffing. Every element is still fully compared —
// this suppresses ORDER only, never content. Everything not listed remains
// order-significant (the differ's default).
// ─────────────────────────────────────────────────────────────────────────────

export interface CanonSort {
  /** Dot-path from the body root to the array (plain segments, no wildcards). */
  path: string;
  /** Element keys to sort by, in precedence order (string compare; a missing
   *  key sorts as ''). Full-element JSON is the final tiebreak, so the order
   *  is total and deterministic on both sides. */
  by: string[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function elementComparator(by: string[]): (a: unknown, b: unknown) => number {
  return (a, b) => {
    const ao = (a ?? {}) as Record<string, unknown>;
    const bo = (b ?? {}) as Record<string, unknown>;
    for (const k of by) {
      const c = cmp(String(ao[k] ?? ''), String(bo[k] ?? ''));
      if (c !== 0) return c;
    }
    return cmp(JSON.stringify(a), JSON.stringify(b));
  };
}

/**
 * Return `body` with each CANON-listed array sorted (a structural copy along
 * the touched paths; untouched regions are shared). Missing paths and
 * non-array targets are no-ops — canonicalization must never invent shape.
 */
export function applyCanon(body: unknown, canons: CanonSort[]): unknown {
  let out = body;
  for (const c of canons) {
    out = sortAt(out, c.path.split('.'), elementComparator(c.by));
  }
  return out;
}

function sortAt(
  value: unknown,
  segments: string[],
  comparator: (a: unknown, b: unknown) => number,
): unknown {
  if (segments.length === 0) {
    return Array.isArray(value) ? [...value].sort(comparator) : value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const [head, ...rest] = segments;
  const obj = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, head)) return value;
  const sorted = sortAt(obj[head], rest, comparator);
  if (sorted === obj[head]) return value;
  return { ...obj, [head]: sorted };
}
