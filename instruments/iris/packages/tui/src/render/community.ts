import type { GraphData } from './graph';

// Community detection by label propagation — a fast, deterministic pass over the link structure
// (folder/type/status are node attributes; a community is not — it's discovered from who links whom).
// Each node starts alone, then repeatedly adopts the most common label among its neighbors until
// things settle; connected clusters fall out as communities. Ties break to the lowest label so runs
// are reproducible (no randomness — that would also break the layout cache).
//
// NB: we TRIED single-level Louvain (greedy modularity optimization) here and REVERTED — on this
// sparse graph (many degree-1 leaves) it fragments into many small hub+leaf communities, so the
// downstream min-size merge swept ~60% of nodes into the gray "misc" bucket (vs ~39% for label
// propagation, which forms larger, more visually useful communities). Multi-level Louvain (super-node
// aggregation) would likely beat both but is a bigger lift; label propagation is what ships.

/**
 * Map each node id → a community index. The index is **size-ranked** — the largest community is 0,
 * the next 1, and so on — so downstream `clusterColor(index)` gives the biggest modules the most
 * widely-separated golden-angle hues (identifiable), instead of an arbitrary encounter-order index.
 *
 * `minSize` merges every community below that member count into one shared "misc" bucket, and
 * isolated (degree-0) nodes always collapse into one community — together these stop a sparse graph
 * from exploding into hundreds of near-identical-colored singletons.
 */
export function detectCommunities(
  graph: GraphData,
  opts: { minSize?: number; maxIter?: number } = {}
): { labels: Map<string, number>; misc: number } {
  const { minSize = 1, maxIter = 12 } = opts;

  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const l of graph.links) {
    adj.get(l.source)?.push(l.target);
    adj.get(l.target)?.push(l.source);
  }

  const ids = graph.nodes.map((n) => n.id);
  const label = new Map<string, number>();
  ids.forEach((id, i) => label.set(id, i));

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const id of ids) {
      const nbrs = adj.get(id);
      if (!nbrs || nbrs.length === 0) continue;
      const counts = new Map<number, number>();
      for (const nb of nbrs) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id)!;
      let bestC = -1;
      for (const [l, c] of counts) {
        if (c > bestC || (c === bestC && l < best)) {
          best = l;
          bestC = c;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Isolated nodes → one shared community.
  const ISOLATED = -1;
  const MISC = -2; // the merged "too-small to matter" bucket (also degree-0 lumps here if tiny)
  const raw = new Map<string, number>();
  for (const id of ids) raw.set(id, (adj.get(id)?.length ?? 0) === 0 ? ISOLATED : label.get(id)!);

  // Merge communities below `minSize` into one shared "misc" bucket.
  if (minSize > 1) {
    const sizes = new Map<number, number>();
    for (const l of raw.values()) sizes.set(l, (sizes.get(l) ?? 0) + 1);
    for (const id of ids) if ((sizes.get(raw.get(id)!) ?? 0) < minSize) raw.set(id, MISC);
  }

  // Rank by size (largest → 0); tie-break by first appearance for determinism. The misc bucket is
  // always ranked LAST regardless of its size, so real communities keep the prominent early hues.
  const size = new Map<number, number>();
  const firstSeen = new Map<number, number>();
  ids.forEach((id, i) => {
    const l = raw.get(id)!;
    size.set(l, (size.get(l) ?? 0) + 1);
    if (!firstSeen.has(l)) firstSeen.set(l, i);
  });
  const ranked = [...size.keys()].sort((a, b) => {
    if (a === MISC) return 1;
    if (b === MISC) return -1;
    return size.get(b)! - size.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!;
  });
  const rank = new Map<number, number>();
  ranked.forEach((l, i) => rank.set(l, i));

  const out = new Map<string, number>();
  for (const id of ids) out.set(id, rank.get(raw.get(id)!)!);
  // The merged "misc" bucket's final index (or -1 if none) — the renderer colors it neutral gray
  // rather than a real community hue, so it reads as "too small to matter", not a genuine cluster.
  const misc = rank.has(MISC) ? rank.get(MISC)! : -1;
  return { labels: out, misc };
}
