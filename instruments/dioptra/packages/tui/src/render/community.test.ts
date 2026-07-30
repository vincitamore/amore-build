import { test, expect } from 'bun:test';
import { detectCommunities } from './community';
import type { GraphData } from './graph';

test('two disconnected cliques resolve to two communities', () => {
  const g: GraphData = {
    nodes: ['a', 'b', 'c', 'x', 'y', 'z'].map((id) => ({ id })),
    links: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
      { source: 'x', target: 'y' },
      { source: 'y', target: 'z' },
      { source: 'z', target: 'x' },
    ],
  };
  const { labels: comm } = detectCommunities(g);
  // a/b/c share one community, x/y/z another, and the two differ
  expect(comm.get('a')).toBe(comm.get('b'));
  expect(comm.get('b')).toBe(comm.get('c'));
  expect(comm.get('x')).toBe(comm.get('y'));
  expect(comm.get('y')).toBe(comm.get('z'));
  expect(comm.get('a')).not.toBe(comm.get('x'));
  expect(new Set(comm.values()).size).toBe(2);
});

test('isolated nodes collapse into one shared community, not singletons', () => {
  const g: GraphData = {
    nodes: ['a', 'b', 'i1', 'i2', 'i3'].map((id) => ({ id })),
    links: [{ source: 'a', target: 'b' }],
  };
  const { labels: comm } = detectCommunities(g);
  expect(comm.get('i1')).toBe(comm.get('i2'));
  expect(comm.get('i2')).toBe(comm.get('i3'));
  expect(comm.get('i1')).not.toBe(comm.get('a')); // isolated ≠ the connected pair
});

test('community indices are dense (0..k-1) and deterministic across runs', () => {
  const g: GraphData = {
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id })),
    links: [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
    ],
  };
  const { labels: c1 } = detectCommunities(g);
  const { labels: c2 } = detectCommunities(g);
  for (const id of ['a', 'b', 'c', 'd']) expect(c1.get(id)).toBe(c2.get(id)!); // reproducible
  const idxs = [...new Set(c1.values())].sort((x, y) => x - y);
  expect(idxs).toEqual(idxs.map((_, i) => i)); // dense 0..k-1
});

test('minSize merges small communities into one misc bucket ranked LAST', () => {
  // one big 5-clique + two tiny pairs. minSize=4 folds the pairs into misc.
  const big = ['b0', 'b1', 'b2', 'b3', 'b4'];
  const g: GraphData = {
    nodes: [...big, 'p1', 'p2', 'q1', 'q2'].map((id) => ({ id })),
    links: [
      // fully connect the big clique
      ...big.flatMap((s, i) => big.slice(i + 1).map((t) => ({ source: s, target: t }))),
      { source: 'p1', target: 'p2' },
      { source: 'q1', target: 'q2' },
    ],
  };
  const { labels: comm, misc } = detectCommunities(g, { minSize: 4 });
  // the big clique is one community; the two pairs collapse into a single shared bucket
  expect(new Set(big.map((id) => comm.get(id))).size).toBe(1);
  expect(comm.get('p1')).toBe(comm.get('p2'));
  expect(comm.get('q1')).toBe(comm.get('q2'));
  expect(comm.get('p1')).toBe(comm.get('q1')); // both tiny pairs → same misc bucket
  // big clique (size 5) ranks ahead of misc (size 4) → lower index; misc is last
  expect(comm.get('b0')).toBe(0);
  expect(comm.get('p1')).toBe(1);
  expect(misc).toBe(1); // the misc bucket's index is surfaced (for gray rendering)
});

test('no merge → no misc bucket (misc index is -1)', () => {
  const g: GraphData = {
    nodes: ['a', 'b', 'c'].map((id) => ({ id })),
    links: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ],
  };
  expect(detectCommunities(g).misc).toBe(-1); // default minSize=1 → nothing merged
});

test('empty graph yields an empty map', () => {
  expect(detectCommunities({ nodes: [], links: [] }).labels.size).toBe(0);
});
