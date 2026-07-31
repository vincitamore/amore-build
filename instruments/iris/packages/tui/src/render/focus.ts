// Focus / neighborhood scoping — the pure predicate that reduces the full graph to the N-hop
// neighborhood of a seed node, for the graph's FOCUS MODE (press `n` on a selected node).
//
// This module is PURE (BFS + set arithmetic + subsetting only — no positions, no layout, no config,
// no OpenTUI): given the full node/link set (and, when the overlay contributes to scope, the typed
// edges) it returns the id set within N hops of the seed and the subset graph to lay out + render.
// `GraphView` computes the subgraph layout LOCALLY (a mode switch is a legitimate reflow) and renders
// the subset; the full-graph layout cache in the shell is never touched, so exiting focus restores
// the full graph exactly. Same exclusion semantics as the transient-orphan filter (`render/orphans.ts`):
// a node outside the neighborhood gets no screen position → not drawn, not hit-testable, not selectable.
//
// Daemon note: the legacy daemon exposes an equivalent `/api/graph?scope=seed:<id>&depth=N` BFS, but
// the full graph is already in memory in the client (Shell owns the fetch), so scoping client-side
// avoids a second round-trip, works with the daemon down, and keeps the typed overlay in sync from the
// already-fetched semantic links. See `.build-summary-graph-focus.md` for the choice rationale.

import type { GraphData, GraphNode, GraphLink } from './graph';
import type { SemanticLink } from './overlay';

/** Minimal directed-pair shape shared by wiki links and typed edges (BFS treats both undirected). */
export interface FocusEdge {
  source: string;
  target: string;
}

/** The supported focus hop-radius window (the config knob's domain). */
export const MIN_FOCUS_HOPS = 1;
export const MAX_FOCUS_HOPS = 3;
export const DEFAULT_FOCUS_HOPS = 2;

/** Clamp a requested hop radius to the supported 1..3 window; non-finite → the default. */
export function clampHops(hops: number | undefined): number {
  if (hops === undefined || !Number.isFinite(hops)) return DEFAULT_FOCUS_HOPS;
  return Math.min(MAX_FOCUS_HOPS, Math.max(MIN_FOCUS_HOPS, Math.floor(hops)));
}

/**
 * The set of node ids within `hops` UNDIRECTED hops of `seed`, over the union of `links` and the
 * optional `extraEdges` (the typed overlay edges — they extend scope when the overlay is part of the
 * focused view, so a typed-edge-only neighbor is reachable). The seed is ALWAYS included, even when
 * disconnected (→ just `{seed}`). `hops <= 0` → just `{seed}`. Pure: ids + set arithmetic only.
 */
export function neighborhoodIds(
  links: FocusEdge[],
  seed: string,
  hops: number,
  extraEdges?: FocusEdge[]
): Set<string> {
  const visited = new Set<string>([seed]);
  if (hops <= 0) return visited;

  // Undirected adjacency over the union of the given edge lists (both endpoints point at each other).
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = []));
    s.push(b);
  };
  const ingest = (es: FocusEdge[]) => {
    for (const e of es) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
  };
  ingest(links);
  if (extraEdges) ingest(extraEdges);

  // Level-synchronous BFS: expand the frontier exactly `hops` times.
  let frontier: string[] = [seed];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: string[] = [];
    for (const node of frontier) {
      const neighbors = adj.get(node);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

/** The focus subset: the neighborhood nodes + the links / typed edges fully inside it, plus the id set. */
export interface FocusSubset {
  nodes: GraphNode[];
  links: GraphLink[];
  semanticLinks: SemanticLink[];
  ids: Set<string>;
}

/**
 * Subset the full graph + typed edges to the `hops`-hop neighborhood of `seed`. Nodes = those in the
 * neighborhood; `links` / `semanticLinks` = those with BOTH endpoints in the neighborhood (an edge to
 * an excluded node is dropped — the same render-side exclusion the orphan filter uses). When
 * `includeSemanticInScope` is true the typed edges also EXTEND the BFS adjacency (used when the
 * overlay contributes to the focused view — the default in focus mode), so a typed-edge-only neighbor
 * is pulled in; when false, scope is wiki-only and the typed edges are merely subset for rendering.
 */
export function focusSubset(
  graph: GraphData,
  semanticLinks: SemanticLink[],
  seed: string,
  hops: number,
  includeSemanticInScope: boolean
): FocusSubset {
  const ids = neighborhoodIds(graph.links, seed, hops, includeSemanticInScope ? semanticLinks : undefined);
  const nodes = graph.nodes.filter((n) => ids.has(n.id));
  const links = graph.links.filter((l) => ids.has(l.source) && ids.has(l.target));
  const semantic = semanticLinks.filter((l) => ids.has(l.source) && ids.has(l.target));
  return { nodes, links, semanticLinks: semantic, ids };
}
