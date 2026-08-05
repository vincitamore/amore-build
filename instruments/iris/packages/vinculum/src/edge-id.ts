// Stable addressable edge ids — short hex of sha256(edgeKey), collision-checked in-store.

import { createHash } from 'node:crypto';
import { EDGE_TYPES, edgeKey, type Edge, type EdgeType } from './schema';

/** Default displayed id length (hex chars). Long enough for house-scale stores. */
export const EDGE_ID_LEN = 12;

/** Minimum accepted prefix length when resolving a partial id. */
export const EDGE_ID_MIN_PREFIX = 6;

export function edgeIdHash(key: string, len = EDGE_ID_LEN): string {
  return createHash('sha256').update(key).digest('hex').slice(0, len);
}

/** Deterministic short id for an edge from its normalized (type, source, target) key. */
export function edgeIdOf(e: Pick<Edge, 'source' | 'target' | 'type'>): string {
  const directed = EDGE_TYPES[e.type as EdgeType]?.directed ?? true;
  return edgeIdHash(edgeKey({ source: e.source, target: e.target, type: e.type as EdgeType, directed }));
}

export interface AddressedEdge {
  id: string;
  edge: Edge;
}

/**
 * Assign short ids to every edge. If two keys collide at EDGE_ID_LEN, lengthen the
 * id width for the whole batch until unique (still deterministic per edgeKey + width).
 */
export function addressEdges(edges: Edge[]): AddressedEdge[] {
  let len = EDGE_ID_LEN;
  for (;;) {
    const counts = new Map<string, number>();
    const ids = edges.map((e) => {
      const id = edgeIdHash(edgeKey(e), len);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return id;
    });
    const collides = [...counts.values()].some((n) => n > 1);
    if (!collides || len >= 64) {
      return edges.map((edge, i) => ({ id: ids[i], edge }));
    }
    len += 2;
  }
}

export type ResolveEdgeIdResult =
  | { ok: true; id: string; edge: Edge }
  | { ok: false; reason: 'not-found' | 'ambiguous'; matches?: string[] };

/** Resolve a full id or unique prefix against a store snapshot. */
export function resolveEdgeId(edges: Edge[], rawId: string): ResolveEdgeIdResult {
  const q = rawId.trim().toLowerCase();
  if (!q || !/^[0-9a-f]+$/.test(q)) return { ok: false, reason: 'not-found' };

  const addressed = addressEdges(edges);
  const exact = addressed.find((a) => a.id === q);
  if (exact) return { ok: true, id: exact.id, edge: exact.edge };

  if (q.length < EDGE_ID_MIN_PREFIX) return { ok: false, reason: 'not-found' };

  const prefixHits = addressed.filter((a) => a.id.startsWith(q));
  if (prefixHits.length === 1) return { ok: true, id: prefixHits[0].id, edge: prefixHits[0].edge };
  if (prefixHits.length > 1) {
    return { ok: false, reason: 'ambiguous', matches: prefixHits.map((h) => h.id) };
  }
  return { ok: false, reason: 'not-found' };
}
