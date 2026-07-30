import { test, expect } from 'bun:test';
import {
  blitGrid,
  buildFamilyLegendRows,
  buildTypeLegendRows,
  legendHitAt,
  legendWidth,
  type DrawBuffer,
  type LegendEntry,
} from './blit';
import type { CellGrid, GraphNode } from '../render/graph';
import type { FamilyStat } from '../render/overlay';

function recorder(): { buffer: DrawBuffer; calls: { x: number; y: number; char: string }[] } {
  const calls: { x: number; y: number; char: string }[] = [];
  return {
    calls,
    buffer: { setCell: (x, y, char) => calls.push({ x, y, char }) },
  };
}

test('blitGrid draws ink cells at the offset and skips empty cells', () => {
  const grid: CellGrid = {
    cols: 2,
    rows: 1,
    cells: [{ char: '◆', fg: { r: 1, g: 2, b: 3 } }, null],
  };
  const { buffer, calls } = recorder();
  blitGrid(buffer, grid, 5, 7, 2, 1);
  expect(calls).toEqual([{ x: 5, y: 7, char: '◆' }]);
});

test('blitGrid clamps to the given width/height', () => {
  const grid: CellGrid = {
    cols: 3,
    rows: 2,
    cells: Array(6).fill({ char: '●', fg: { r: 9, g: 9, b: 9 } }),
  };
  const { buffer, calls } = recorder();
  blitGrid(buffer, grid, 0, 0, 2, 1); // only 2×1 of the 3×2 grid
  expect(calls.length).toBe(2);
  expect(calls.every((c) => c.y === 0 && c.x < 2)).toBe(true);
});

test('blitGrid on a null grid is a no-op', () => {
  const { buffer, calls } = recorder();
  blitGrid(buffer, null, 0, 0, 10, 10);
  expect(calls.length).toBe(0);
});

// ─── Legend model build ──────────────────────────────────────────────────────────────────────────
const node = (p: Partial<GraphNode> & { id: string }): GraphNode => p;
const clusters = (nodes: GraphNode[]): Map<string, number> => new Map(nodes.map((n, i) => [n.id, i % 3]));
const EMPTY = new Set<string>();

test('buildTypeLegendRows: parents sort count desc; a status type is expandable with ≥2 statuses', () => {
  const nodes = [
    node({ id: 'tasks/a.md', type: 'task', status: 'active' }),
    node({ id: 'tasks/b.md', type: 'task', status: 'blocked' }),
    node({ id: 'tasks/c.md', type: 'task', status: 'active' }),
    node({ id: 'k/architecture/x.md', type: 'knowledge' }),
  ];
  const rows = buildTypeLegendRows(nodes, clusters(nodes), -1, EMPTY, EMPTY, EMPTY);
  const parents = rows.filter((r) => r.depth === 0);
  expect(parents.map((r) => r.label)).toEqual(['task', 'knowledge']); // 3 tasks > 1 knowledge
  const task = parents.find((r) => r.label === 'task')!;
  expect(task.expandable).toBe(true); // active + blocked = 2 distinct subs
  expect(task.expanded).toBe(false); // not in expandedTypes
});

test('buildTypeLegendRows: an expanded type inserts its subs (count desc) directly beneath', () => {
  const nodes = [
    node({ id: 'tasks/a.md', type: 'task', status: 'active' }),
    node({ id: 'tasks/b.md', type: 'task', status: 'blocked' }),
    node({ id: 'tasks/c.md', type: 'task', status: 'active' }),
  ];
  const rows = buildTypeLegendRows(nodes, clusters(nodes), -1, EMPTY, EMPTY, new Set(['task']));
  expect(rows.map((r) => [r.depth, r.label, r.count])).toEqual([
    [0, 'task', 3],
    [1, 'active', 2], // count desc
    [1, 'blocked', 1],
  ]);
  expect(rows[1].parentKey).toBe('task');
  expect(rows[1].color).toEqual(rows[0].color); // sub inherits the parent's resolved color
});

test('buildTypeLegendRows: a flat type (all nodes at the root) is not expandable', () => {
  const nodes = [
    node({ id: 'a.md', type: 'other' }), // single segment → ROOT_SUB
    node({ id: 'b.md', type: 'other' }),
  ];
  const rows = buildTypeLegendRows(nodes, clusters(nodes), -1, EMPTY, EMPTY, new Set(['other']));
  expect(rows.length).toBe(1); // no sub rows even though "expanded"
  expect(rows[0].expandable).toBe(false);
});

test('buildTypeLegendRows: a hidden sub marks partial on the parent and hidden on the sub row', () => {
  const nodes = [
    node({ id: 'i/decisions/a.md', type: 'inbox' }),
    node({ id: 'i/ideas/b.md', type: 'inbox' }),
  ];
  const hiddenSubs = new Set(['inbox decisions']); // hiddenSubKey('inbox','decisions')
  const rows = buildTypeLegendRows(nodes, clusters(nodes), -1, EMPTY, hiddenSubs, new Set(['inbox']));
  const parent = rows.find((r) => r.depth === 0)!;
  expect(parent.partial).toBe(true); // visible parent + a hidden sub
  const decisions = rows.find((r) => r.label === 'decisions')!;
  expect(decisions.hidden).toBe(true);
  const ideas = rows.find((r) => r.label === 'ideas')!;
  expect(ideas.hidden).toBe(false);
});

test('buildTypeLegendRows: hiding the whole type shows the parent as hidden (not partial)', () => {
  const nodes = [
    node({ id: 'i/decisions/a.md', type: 'inbox' }),
    node({ id: 'i/ideas/b.md', type: 'inbox' }),
  ];
  const rows = buildTypeLegendRows(nodes, clusters(nodes), -1, new Set(['inbox']), EMPTY, EMPTY);
  const parent = rows[0];
  expect(parent.hidden).toBe(true);
  expect(parent.partial).toBe(false); // a fully-hidden parent is not "partial"
});

test('buildTypeLegendRows: parents are capped at 14 but expanded subs do not count against the cap', () => {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 20; i++) nodes.push(node({ id: `t${i}/a.md`, type: `type${i}` }));
  // give type0 two statuses so it can expand — but it's a made-up type, uses folder subs instead:
  const withSubs = [
    node({ id: 'k/architecture/x.md', type: 'kk' }),
    node({ id: 'k/networking/y.md', type: 'kk' }),
    node({ id: 'k/networking/z.md', type: 'kk' }),
    ...nodes,
  ];
  const rows = buildTypeLegendRows(withSubs, clusters(withSubs), -1, EMPTY, EMPTY, new Set(['kk']));
  const parents = rows.filter((r) => r.depth === 0);
  expect(parents.length).toBe(14); // capped
  // kk (3 nodes, highest count) is a parent AND expanded → its subs are present on top of the 14
  expect(rows.some((r) => r.depth === 1 && r.parentKey === 'kk')).toBe(true);
});

// ─── Family legend build ─────────────────────────────────────────────────────────────────────────
const fam = (family: string, count: number, hidden: boolean, relations: FamilyStat['relations']): FamilyStat => ({
  family: family as FamilyStat['family'],
  color: { r: 1, g: 2, b: 3 },
  count,
  hidden,
  relations,
});

test('buildFamilyLegendRows: a family with ≥2 relations is expandable; expanded inserts relation rows', () => {
  const families = [
    fam('abstraction-ladder', 3, false, [
      { relation: 'refines', count: 2, hidden: false },
      { relation: 'generalizes', count: 1, hidden: false },
    ]),
  ];
  const rows = buildFamilyLegendRows(families, new Set(['abstraction-ladder']));
  expect(rows.map((r) => [r.depth, r.label])).toEqual([
    [0, 'abstraction-ladder'],
    [1, 'refines'],
    [1, 'generalizes'],
  ]);
  expect(rows[1].parentKey).toBe('abstraction-ladder');
});

test('buildFamilyLegendRows: a single-relation family is not expandable', () => {
  const families = [fam('task-graph', 1, false, [{ relation: 'depends-on', count: 1, hidden: false }])];
  const rows = buildFamilyLegendRows(families, new Set(['task-graph']));
  expect(rows.length).toBe(1);
  expect(rows[0].expandable).toBe(false);
});

test('buildFamilyLegendRows: a hidden relation marks the parent partial', () => {
  const families = [
    fam('abstraction-ladder', 3, false, [
      { relation: 'refines', count: 2, hidden: true },
      { relation: 'generalizes', count: 1, hidden: false },
    ]),
  ];
  const rows = buildFamilyLegendRows(families, new Set());
  expect(rows[0].partial).toBe(true);
});

// ─── Hit-test zone mapping (shares the draw geometry) ────────────────────────────────────────────
function typeRows(): LegendEntry[] {
  const nodes = [
    node({ id: 'tasks/a.md', type: 'task', status: 'active' }),
    node({ id: 'tasks/b.md', type: 'task', status: 'blocked' }),
    node({ id: 'tasks/c.md', type: 'task', status: 'active' }),
  ];
  return buildTypeLegendRows(nodes, clusters(nodes), -1, EMPTY, EMPTY, new Set(['task']));
}

test('legendHitAt (right): the caret zone of an expandable parent expands; the body toggles it', () => {
  const rows = typeRows(); // row0 = task (expandable, expanded), rows 1-2 = subs
  const cols = 60;
  const x0 = cols - legendWidth(rows);
  // caret zone = x0 and x0+1
  expect(legendHitAt(rows, cols, 40, 0, x0, 0, 'right')).toEqual({ kind: 'expand', key: 'task' });
  expect(legendHitAt(rows, cols, 40, 0, x0 + 1, 0, 'right')).toEqual({ kind: 'expand', key: 'task' });
  // body (past the caret zone) toggles the whole type
  expect(legendHitAt(rows, cols, 40, 0, x0 + 4, 0, 'right')).toEqual({ kind: 'toggle-parent', key: 'task' });
});

test('legendHitAt (right): a sub row toggles that sub regardless of column within the block', () => {
  const rows = typeRows();
  const cols = 60;
  const x0 = cols - legendWidth(rows);
  expect(legendHitAt(rows, cols, 40, 0, x0, 1, 'right')).toEqual({ kind: 'toggle-sub', parent: 'task', sub: 'active' });
  expect(legendHitAt(rows, cols, 40, 0, x0 + 5, 2, 'right')).toEqual({ kind: 'toggle-sub', parent: 'task', sub: 'blocked' });
});

test('legendHitAt: clicks outside the block or on an undrawn row return null (row clamp)', () => {
  const rows = typeRows();
  const cols = 60;
  const x0 = cols - legendWidth(rows);
  expect(legendHitAt(rows, cols, 40, 0, x0 - 1, 0, 'right')).toBeNull(); // left of the block
  expect(legendHitAt(rows, cols, 40, 0, x0, -1, 'right')).toBeNull(); // above oy
  expect(legendHitAt(rows, cols, 40, 0, x0, rows.length, 'right')).toBeNull(); // past the last row
  // the rows clamp mirrors the draw loop: a row index >= the visible `rows` is undrawn → null
  expect(legendHitAt(rows, cols, 1, 0, x0, 2, 'right')).toBeNull();
});

test('legendHitAt (left): the family legend is anchored at column 0 with the same zones', () => {
  const families = [
    fam('abstraction-ladder', 3, false, [
      { relation: 'refines', count: 2, hidden: false },
      { relation: 'generalizes', count: 1, hidden: false },
    ]),
  ];
  const rows = buildFamilyLegendRows(families, new Set(['abstraction-ladder']));
  expect(legendHitAt(rows, 80, 40, 0, 0, 0, 'left')).toEqual({ kind: 'expand', key: 'abstraction-ladder' });
  expect(legendHitAt(rows, 80, 40, 0, 5, 0, 'left')).toEqual({ kind: 'toggle-parent', key: 'abstraction-ladder' });
  expect(legendHitAt(rows, 80, 40, 0, 3, 1, 'left')).toEqual({ kind: 'toggle-sub', parent: 'abstraction-ladder', sub: 'refines' });
});

test('legendHitAt (right): a non-expandable parent has no caret zone — the whole row toggles it', () => {
  const nodes = [node({ id: 'a.md', type: 'other' }), node({ id: 'b.md', type: 'other' })];
  const rows = buildTypeLegendRows(nodes, clusters(nodes), -1, EMPTY, EMPTY, EMPTY);
  const cols = 60;
  const x0 = cols - legendWidth(rows);
  expect(legendHitAt(rows, cols, 40, 0, x0, 0, 'right')).toEqual({ kind: 'toggle-parent', key: 'other' });
});
