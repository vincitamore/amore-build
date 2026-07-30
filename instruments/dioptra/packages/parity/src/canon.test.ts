import { test, expect } from 'bun:test';
import { applyCanon } from './canon';
import { diffJson } from './diff';
import { CANON } from './cases';

// The scenario canon exists for: same content, hash-order permutation.
test('canonicalized permutations of the same array diff clean', () => {
  const golden = { items: [{ path: 'b.md', title: 'B' }, { path: 'a.md', title: 'A' }] };
  const target = { items: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }] };
  const canon = [{ path: 'items', by: ['path'] }];
  const diffs = diffJson(applyCanon(golden, canon), applyCanon(target, canon), {});
  expect(diffs).toEqual([]);
});

test('canonicalization never suppresses content divergence', () => {
  const golden = { items: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }] };
  const target = { items: [{ path: 'b.md', title: 'B-CHANGED' }, { path: 'a.md', title: 'A' }] };
  const canon = [{ path: 'items', by: ['path'] }];
  const diffs = diffJson(applyCanon(golden, canon), applyCanon(target, canon), {});
  expect(diffs.length).toBe(1);
  expect(diffs[0]!.path).toBe('items.1.title');
});

test('membership differences still surface (length + element diffs)', () => {
  const golden = { items: [{ path: 'a.md' }, { path: 'b.md' }] };
  const target = { items: [{ path: 'a.md' }] };
  const canon = [{ path: 'items', by: ['path'] }];
  const diffs = diffJson(applyCanon(golden, canon), applyCanon(target, canon), {});
  expect(diffs.some((d) => d.kind === 'length')).toBe(true);
});

test('arrays NOT listed stay order-significant', () => {
  const golden = { other: [1, 2] };
  const target = { other: [2, 1] };
  const diffs = diffJson(applyCanon(golden, []), applyCanon(target, []), {});
  expect(diffs.length).toBeGreaterThan(0);
});

test('multi-key sort orders links deterministically, JSON tiebreak total', () => {
  const canon = CANON['/api/graph']!;
  const links = [
    { source: 's1', target: 't1', relation: 'refines', edgeKind: 'semantic' },
    { source: 's1', target: 't1' },
    { source: 'a', target: 'z' },
  ];
  const out = applyCanon({ nodes: [], links, scope: {}, clusters: [] }, canon) as {
    links: { source: string; relation?: string }[];
  };
  expect(out.links[0]!.source).toBe('a');
  // {s1,t1} without relation sorts before the one with (missing key = '')
  expect(out.links[1]!.relation).toBeUndefined();
  expect(out.links[2]!.relation).toBe('refines');
});

test('missing path / non-array target is a structural no-op', () => {
  const body = { scope: { kind: 'workspace' } };
  expect(applyCanon(body, [{ path: 'items', by: ['path'] }])).toEqual(body);
  expect(applyCanon(body, [{ path: 'scope', by: ['kind'] }])).toEqual(body);
  expect(applyCanon(null, [{ path: 'items', by: ['path'] }])).toBe(null);
});

test('input bodies are not mutated', () => {
  const golden = { items: [{ path: 'b.md' }, { path: 'a.md' }] };
  applyCanon(golden, [{ path: 'items', by: ['path'] }]);
  expect(golden.items[0]!.path).toBe('b.md');
});
