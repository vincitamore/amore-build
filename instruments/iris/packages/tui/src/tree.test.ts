import { describe, expect, test } from 'bun:test';
import { buildTree, flattenTree, type TreeFolder } from './tree';

function leaf(id: string, label?: string) {
  return { path: id, label: label ?? id };
}

describe('buildTree', () => {
  test('strips the prefix; items outside it are skipped', () => {
    const t = buildTree([leaf('knowledge/a.md'), leaf('tasks/b.md'), leaf('knowledge/sub/c.md')], 'knowledge');
    expect(t.total).toBe(2);
    expect(t.leaves.map((l) => l.id)).toEqual(['knowledge/a.md']);
    expect(t.folders.map((f) => f.path)).toEqual(['sub']);
    expect(t.folders[0]!.leaves.map((l) => l.id)).toEqual(['knowledge/sub/c.md']);
  });

  test('folders and leaves are name-sorted', () => {
    const t = buildTree([leaf('knowledge/z.md'), leaf('knowledge/b.md'), leaf('knowledge/aa/x.md'), leaf('knowledge/ab/y.md')], 'knowledge');
    expect(t.leaves.map((l) => l.id)).toEqual(['knowledge/b.md', 'knowledge/z.md']);
    expect(t.folders.map((f) => f.path)).toEqual(['aa', 'ab']);
  });
});

describe('flattenTree', () => {
  test('REGRESSION: direct leaves of the type root render as depth-0 rows without expansion', () => {
    // A flat knowledge/ (all articles at the root, no subfolders) previously rendered ZERO rows:
    // flattenTree only walked root.folders, and the root itself was never a row, so its own
    // leaves were unreachable — the Knowledge tab showed empty with the header count non-zero.
    const t = buildTree(
      [leaf('knowledge/cause-ordering.md', 'Cause ordering'), leaf('knowledge/dnp3-ports.md', 'DNP3 ports')],
      'knowledge',
    );
    const rows = flattenTree(t, new Set());
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.kind)).toEqual(['leaf', 'leaf']);
    expect(rows[0]).toMatchObject({ kind: 'leaf', depth: 0 });
    expect(rows[0]!.kind === 'leaf' && rows[0].leaf.id).toBe('knowledge/cause-ordering.md');
    expect(rows[1]!.kind === 'leaf' && rows[1].leaf.id).toBe('knowledge/dnp3-ports.md');
  });

  test('subfolders are collapsed by default; their leaves appear only when expanded', () => {
    const t = buildTree(
      [leaf('knowledge/root.md'), leaf('knowledge/architecture/patterns/p1.md'), leaf('knowledge/architecture/sovereignty/s1.md')],
      'knowledge',
    );
    const collapsed = flattenTree(t, new Set());
    // root.md (depth 0) + the architecture folder row — its nested leaves hidden.
    expect(collapsed.length).toBe(2);
    expect(collapsed[0]!.kind === 'leaf' && collapsed[0].depth === 0).toBe(true);
    expect(collapsed[1]).toMatchObject({ kind: 'folder', depth: 0, expanded: false });

    const expanded = flattenTree(t, new Set(['architecture']));
    // root.md + architecture (open) + patterns + sovereignty (folders at depth 1, collapsed).
    expect(expanded.length).toBe(4);
    expect(expanded[1]).toMatchObject({ kind: 'folder', depth: 0, expanded: true });
    expect(expanded[2]).toMatchObject({ kind: 'folder', depth: 1, expanded: false });
    expect(expanded[3]).toMatchObject({ kind: 'folder', depth: 1, expanded: false });

    const deep = flattenTree(t, new Set(['architecture', 'architecture/patterns']));
    expect(deep.map((r) => (r.kind === 'leaf' ? `L:${r.leaf.id}` : `F:${r.node.path}${r.expanded ? '+' : '-'}`))).toEqual([
      'L:knowledge/root.md',
      'F:architecture+',
      'F:architecture/patterns+',
      'L:knowledge/architecture/patterns/p1.md',
      'F:architecture/sovereignty-',
    ]);
  });

  test('folder totals count descendants (buildTree)', () => {
    const t = buildTree(
      [leaf('knowledge/a.md'), leaf('knowledge/sub/b.md'), leaf('knowledge/sub/deep/c.md')],
      'knowledge',
    );
    expect(t.total).toBe(3);
    const sub = t.folders[0]!;
    expect(sub.total).toBe(2);
    expect(sub.folders[0]!.total).toBe(1);
  });
});
