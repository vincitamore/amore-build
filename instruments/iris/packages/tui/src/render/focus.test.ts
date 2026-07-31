import { test, expect } from 'bun:test';
import {
  neighborhoodIds,
  focusSubset,
  clampHops,
  MIN_FOCUS_HOPS,
  MAX_FOCUS_HOPS,
  DEFAULT_FOCUS_HOPS,
  type FocusEdge,
} from './focus';
import type { GraphData } from './graph';
import type { SemanticLink } from './overlay';

const e = (source: string, target: string): FocusEdge => ({ source, target });

// A small path/star graph used across the hop tests:
//   a — b — c — d — e   (a chain), plus a star branch  b — x
const CHAIN: FocusEdge[] = [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('d', 'e'), e('b', 'x')];

test('clampHops clamps to 1..3 and falls back to the default on non-finite', () => {
  expect(clampHops(2)).toBe(2);
  expect(clampHops(0)).toBe(MIN_FOCUS_HOPS); // below floor → 1
  expect(clampHops(1)).toBe(1);
  expect(clampHops(3)).toBe(3);
  expect(clampHops(5)).toBe(MAX_FOCUS_HOPS); // above ceiling → 3
  expect(clampHops(2.7)).toBe(2); // floored
  expect(clampHops(undefined)).toBe(DEFAULT_FOCUS_HOPS);
  expect(clampHops(NaN)).toBe(DEFAULT_FOCUS_HOPS);
});

test('N=1 → seed plus its direct neighbors only', () => {
  const ids = neighborhoodIds(CHAIN, 'b', 1);
  expect([...ids].sort()).toEqual(['a', 'b', 'c', 'x']); // b's direct neighbors: a, c, x
});

test('N=2 → two hops out', () => {
  const ids = neighborhoodIds(CHAIN, 'b', 2);
  // b(0) → a,c,x(1) → d (via c)(2). a and x have no further neighbors.
  expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
});

test('N=3 → three hops out (reaches e)', () => {
  const ids = neighborhoodIds(CHAIN, 'b', 3);
  expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'x']);
});

test('BFS is UNDIRECTED — a neighbor reachable only as a link TARGET is included', () => {
  // seed is the TARGET of every edge; undirected BFS must still traverse them.
  const links = [e('a', 'seed'), e('b', 'a')];
  const ids = neighborhoodIds(links, 'seed', 2);
  expect([...ids].sort()).toEqual(['a', 'b', 'seed']);
});

test('a disconnected seed yields just {seed}', () => {
  const ids = neighborhoodIds(CHAIN, 'lonely', 3);
  expect([...ids]).toEqual(['lonely']);
});

test('hops <= 0 yields just {seed}', () => {
  expect([...neighborhoodIds(CHAIN, 'b', 0)]).toEqual(['b']);
  expect([...neighborhoodIds(CHAIN, 'b', -1)]).toEqual(['b']);
});

test('seed with a typed-edge-only neighbor: extraEdges extends scope, absence excludes it', () => {
  const wiki = [e('a', 'b')]; // seed `a` has one wiki neighbor `b`
  const typed = [e('a', 'z')]; // and one typed-edge-only neighbor `z`
  // Without the typed edges, z is unreachable from a over the wiki graph.
  expect([...neighborhoodIds(wiki, 'a', 1).values()].sort()).toEqual(['a', 'b']);
  // With the typed edges folded into adjacency, z is a 1-hop neighbor.
  expect([...neighborhoodIds(wiki, 'a', 1, typed).values()].sort()).toEqual(['a', 'b', 'z']);
});

// ── focusSubset ──────────────────────────────────────────────────────────────

const graph: GraphData = {
  nodes: [
    { id: 'a', type: 'knowledge' },
    { id: 'b', type: 'task' },
    { id: 'c', type: 'inbox' },
    { id: 'd', type: 'knowledge' },
    { id: 'e', type: 'knowledge' },
    { id: 'x', type: 'forge' },
    { id: 'z', type: 'knowledge' }, // reachable from b only via a typed edge
  ],
  links: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
    { source: 'd', target: 'e' },
    { source: 'b', target: 'x' },
  ],
};
const semantic: SemanticLink[] = [
  { source: 'b', target: 'z', relation: 'analogous-to', tier: 'asserted', edgeKind: 'semantic' },
  { source: 'a', target: 'c', relation: 'refines', tier: 'inferred', edgeKind: 'semantic' }, // both wiki-inside at N>=2
  { source: 'd', target: 'z', relation: 'builds-on', tier: 'asserted', edgeKind: 'semantic' }, // z outside at low N
];

test('focusSubset (wiki-only scope): nodes + inside links, edges to excluded nodes dropped', () => {
  const sub = focusSubset(graph, semantic, 'b', 1, false); // N=1, overlay not in scope
  expect([...sub.ids].sort()).toEqual(['a', 'b', 'c', 'x']);
  expect(sub.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'x']);
  // links fully inside the neighborhood: a-b, b-c, b-x. c-d and d-e are dropped (d,e excluded).
  expect(sub.links.map((l) => `${l.source}-${l.target}`).sort()).toEqual(['a-b', 'b-c', 'b-x']);
  // semantic links kept only when BOTH endpoints are inside: a-c is inside; b-z and d-z are not.
  expect(sub.semanticLinks.map((l) => `${l.source}-${l.target}`)).toEqual(['a-c']);
});

test('focusSubset (overlay in scope): a typed-edge-only neighbor is pulled into the neighborhood', () => {
  const sub = focusSubset(graph, semantic, 'b', 1, true); // includeSemanticInScope = true
  // z is now a 1-hop neighbor of b via the typed edge b-z.
  expect([...sub.ids].sort()).toEqual(['a', 'b', 'c', 'x', 'z']);
  expect(sub.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'x', 'z']);
  // the b-z typed edge is now inside and kept; a-c inside too; d-z still dropped (d excluded).
  expect(sub.semanticLinks.map((l) => `${l.source}-${l.target}`).sort()).toEqual(['a-c', 'b-z']);
});

test('focusSubset preserves node metadata (type) for the subset', () => {
  const sub = focusSubset(graph, semantic, 'a', 1, false);
  const b = sub.nodes.find((n) => n.id === 'b');
  expect(b?.type).toBe('task');
});

test('focusSubset with a disconnected seed → just the seed, no links', () => {
  const sub = focusSubset(graph, semantic, 'a', 0, true);
  expect(sub.nodes.map((n) => n.id)).toEqual(['a']);
  expect(sub.links).toEqual([]);
  expect(sub.semanticLinks).toEqual([]);
});
