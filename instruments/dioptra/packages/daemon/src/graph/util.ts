// ─────────────────────────────────────────────────────────────────────────────
// graph/util.ts — small shared helpers for the graph builder.
//
// `byteCompare` reproduces Rust's `String`/`&str` `Ord` (UTF-8 byte-lexicographic
// comparison) so BTreeSet/BTreeMap-derived orderings — placeholder nodes, cluster
// keys — sort byte-for-byte like the legacy daemon. Plain JS `<` compares UTF-16
// code units, which diverges from UTF-8 byte order for supplementary-plane
// characters; encoding to bytes first is exact for all inputs.
// ─────────────────────────────────────────────────────────────────────────────

const ENC = new TextEncoder();

/** Compare two strings by their UTF-8 byte sequences (Rust `str::cmp` order). */
export function byteCompare(a: string, b: string): number {
  if (a === b) return 0;
  const ba = ENC.encode(a);
  const bb = ENC.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

/**
 * Top-level folder segment of an org-relative path. `knowledge/architecture/x.md`
 * → `"knowledge"`; a path with no `/` returns the whole string (Rust
 * `top_folder`: `path.split('/').next().unwrap_or("")`).
 */
export function topFolder(p: string): string {
  const idx = p.indexOf('/');
  return idx === -1 ? p : p.slice(0, idx);
}
