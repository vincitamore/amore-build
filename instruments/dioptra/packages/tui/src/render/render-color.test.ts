import { test, expect } from 'bun:test';
import { hsl, clusterColor, attentionShade } from './color';
import { familyEdgeColor, type SemanticLink } from './overlay';
import {
  nodeGlyph,
  typeColor,
  KNOWN_TYPES,
  ATTR_BOLD,
  layoutGraph,
  renderGraph,
  renderView,
  cellGridToAnsi,
  type GraphData,
  type WorldNode,
} from './graph';

const lum = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b;
const findGlyph = (cells: ({ char: string; fg: { r: number; g: number; b: number }; attr?: number } | null)[], ch: string) =>
  cells.find((c) => c && c.char === ch);

test('hsl produces pure primaries', () => {
  expect(hsl(0, 1, 0.5)).toEqual({ r: 255, g: 0, b: 0 });
  expect(hsl(120, 1, 0.5)).toEqual({ r: 0, g: 255, b: 0 });
  expect(hsl(240, 1, 0.5)).toEqual({ r: 0, g: 0, b: 255 });
});

test('attentionShade: tier 1 is identity, tier 0 darkens, tier 3 brightens', () => {
  const base = clusterColor(3);
  const lum = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b;
  expect(attentionShade(base, 1)).toEqual(base); // neutral node keeps its exact hue
  expect(lum(attentionShade(base, 0))).toBeLessThan(lum(base)); // dormant sinks
  expect(lum(attentionShade(base, 2))).toBeGreaterThan(lum(base)); // active lifts
  expect(lum(attentionShade(base, 3))).toBeGreaterThan(lum(attentionShade(base, 2))); // hot lifts more
});

test('clusterColor is always a valid RGB at any index', () => {
  for (const i of [0, 1, 7, 50]) {
    const c = clusterColor(i);
    for (const v of [c.r, c.g, c.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  }
});

test('nodeGlyph maps known types and falls back', () => {
  expect(nodeGlyph('task')).toBe('◆');
  expect(nodeGlyph('knowledge')).toBe('●');
  expect(nodeGlyph('inbox')).toBe('◧');
  expect(nodeGlyph('mystery')).toBe('•');
  expect(nodeGlyph(undefined)).toBe('•');
});

test('every known doc type has its OWN unique glyph (no shared fallback for real types)', () => {
  // the daemon emits these; each must be distinguishable on screen
  for (const ty of ['task', 'knowledge', 'inbox', 'reminder', 'forge', 'tag', 'project', 'archive', 'placeholder', 'other']) {
    expect(KNOWN_TYPES).toContain(ty);
    expect(nodeGlyph(ty)).not.toBe('•');
  }
  const glyphs = KNOWN_TYPES.map((t) => nodeGlyph(t));
  expect(new Set(glyphs).size).toBe(glyphs.length); // all distinct
});

test('typeColor is stable per type and valid RGB', () => {
  expect(typeColor('task')).toEqual(typeColor('task')); // deterministic
  expect(typeColor('task')).not.toEqual(typeColor('knowledge')); // distinct
  for (const c of [typeColor('forge'), typeColor('unknown-xyz')]) {
    for (const v of [c.r, c.g, c.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  }
});

test('renderView hiddenTypes filters those nodes AND their edges out of the render', () => {
  const g: GraphData = {
    nodes: [
      { id: 'a', type: 'task' },
      { id: 'b', type: 'knowledge' },
    ],
    links: [{ source: 'a', target: 'b' }],
  };
  const world: WorldNode[] = [
    { id: 'a', x: 0, y: 0, cluster: 0 },
    { id: 'b', x: 20, y: 0, cluster: 1 },
  ];
  const vp = { cx: 10, cy: 0, scale: 1 };
  const full = renderView(g, world, vp, { cols: 40, rows: 10 });
  expect(full.nodes.length).toBe(2); // both hit-testable
  const filtered = renderView(g, world, vp, { cols: 40, rows: 10, hiddenTypes: new Set(['knowledge']) });
  expect(filtered.nodes.length).toBe(1); // knowledge node gone from positioned/hit-test set
  expect(filtered.nodes[0].id).toBe('a');
  const kGlyphs = filtered.grid.cells.filter((c) => c && c.char === '●');
  expect(kGlyphs.length).toBe(0); // the ● knowledge glyph is not drawn
});

const G: GraphData = {
  nodes: [
    { id: 'a', type: 'task', group: 'x' },
    { id: 'b', type: 'knowledge', group: 'y' },
    { id: 'c', type: 'inbox', group: 'y' },
  ],
  links: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};

test('renderGraph overlays one colored type-glyph per node', () => {
  const { grid } = renderGraph(G, { cols: 40, rows: 20, iterations: 80 });
  const glyphs = grid.cells.filter((c) => c && ['◆', '●', '◧'].includes(c.char));
  expect(glyphs.length).toBe(3);
});

test('cellGridToAnsi emits truecolor escapes', () => {
  const { grid } = renderGraph(G, { cols: 20, rows: 10, iterations: 30 });
  expect(cellGridToAnsi(grid)).toContain('\x1b[38;2;');
});

test('renderView skips nodes outside the viewport (pan/zoom clipping)', () => {
  const g: GraphData = {
    nodes: [
      { id: 'a', type: 'task' },
      { id: 'b', type: 'task' },
    ],
    links: [],
  };
  const world: WorldNode[] = [
    { id: 'a', x: 0, y: 0, cluster: 0 },
    { id: 'b', x: 1000, y: 1000, cluster: 0 }, // far off-screen
  ];
  const { grid } = renderView(g, world, { cx: 0, cy: 0, scale: 1 }, { cols: 20, rows: 10 });
  const glyphs = grid.cells.filter((c) => c && c.char === '◆');
  expect(glyphs.length).toBe(1); // only 'a' (at center) is visible
});

test('renderView focus: selected node gets the ◉ ring and incident edges go hot', () => {
  const g: GraphData = {
    nodes: [
      { id: 'a', type: 'task' },
      { id: 'b', type: 'knowledge' },
      { id: 'c', type: 'inbox' },
    ],
    links: [{ source: 'a', target: 'b' }], // a–b linked; c isolated
  };
  const world: WorldNode[] = [
    { id: 'a', x: 0, y: 0, cluster: 0 },
    { id: 'b', x: 40, y: 0, cluster: 1 },
    { id: 'c', x: 0, y: 40, cluster: 2 },
  ];
  const { grid } = renderView(
    g,
    world,
    { cx: 20, cy: 20, scale: 1 },
    { cols: 40, rows: 20 },
    { selected: 'a', neighbors: new Set(['b']) }
  );
  const rings = grid.cells.filter((c) => c && c.char === '◉');
  expect(rings.length).toBe(1); // only the selected node
  const hotEdge = grid.cells.some((c) => c && c.fg.r === 236 && c.fg.g === 198 && c.fg.b === 120);
  expect(hotEdge).toBe(true); // incident edge a–b drawn in HOT_EDGE
});

test('renderView labels the focused node and its neighbors', () => {
  const g: GraphData = {
    nodes: [
      { id: 'a', type: 'task', label: 'Alpha' },
      { id: 'b', type: 'task', label: 'Beta' },
    ],
    links: [{ source: 'a', target: 'b' }],
  };
  const world: WorldNode[] = [
    { id: 'a', x: 0, y: 0, cluster: 0 },
    { id: 'b', x: 60, y: 0, cluster: 0 },
  ];
  const { grid } = renderView(g, world, { cx: 30, cy: 0, scale: 1 }, { cols: 60, rows: 20 }, {
    selected: 'a',
    neighbors: new Set(['b']),
  });
  const text = grid.cells.map((c) => c?.char ?? ' ').join('');
  expect(text).toContain('Alpha');
  expect(text).toContain('Beta');
});

test('z-order: a label paints over a dimmed node that shares its cells', () => {
  const g: GraphData = {
    nodes: [
      { id: 'a', type: 'task', label: 'Alpha' },
      { id: 'b', type: 'task', label: 'Beta' },
      { id: 'z', type: 'knowledge' }, // dimmed non-neighbor sitting in a's label path
    ],
    links: [{ source: 'a', target: 'b' }],
  };
  const world: WorldNode[] = [
    { id: 'a', x: 0, y: 0, cluster: 0 }, // → cell (20,5)
    { id: 'b', x: 30, y: 0, cluster: 0 }, // → cell (35,5)
    { id: 'z', x: 5, y: 2, cluster: 1 }, // → cell (22,5), where a's label 'A' lands
  ];
  const { grid } = renderView(g, world, { cx: 0, cy: 0, scale: 1 }, { cols: 40, rows: 10 }, {
    selected: 'a',
    neighbors: new Set(['b']),
  });
  expect(grid.cells[5 * 40 + 22]?.char).toBe('A'); // the label wins over z's dimmed glyph
});

test('render config: attention shading is applied by default and skippable', () => {
  const g: GraphData = { nodes: [{ id: 'a', type: 'task', status: 'blocked' }], links: [] };
  const world: WorldNode[] = [{ id: 'a', x: 0, y: 0, cluster: 0 }];
  const vp = { cx: 0, cy: 0, scale: 1 };
  const on = renderView(g, world, vp, { cols: 20, rows: 10 }); // attention default on → blocked lifts
  const off = renderView(g, world, vp, { cols: 20, rows: 10, attention: false }); // raw cluster hue
  const onGlyph = findGlyph(on.grid.cells, '◆')!;
  const offGlyph = findGlyph(off.grid.cells, '◆')!;
  expect(lum(onGlyph.fg)).toBeGreaterThan(lum(offGlyph.fg)); // tier-3 lift only when attention on
});

test('render config: recency fade dims an old node vs a fresh one', () => {
  const now = Date.parse('2026-07-01T00:00:00Z');
  const g: GraphData = {
    nodes: [
      { id: 'fresh', type: 'knowledge', updated: '2026-06-30T00:00:00Z' },
      { id: 'stale', type: 'knowledge', updated: '2024-01-01T00:00:00Z' },
    ],
    links: [],
  };
  const world: WorldNode[] = [
    { id: 'fresh', x: 0, y: 0, cluster: 0 },
    { id: 'stale', x: 40, y: 0, cluster: 0 }, // same cluster hue → only recency differs
  ];
  const vp = { cx: 20, cy: 0, scale: 1 };
  const { grid } = renderView(g, world, vp, { cols: 40, rows: 10, recencyFade: true, recencyNow: now });
  const glyphs = grid.cells.filter((c) => c && c.char === '●') as { fg: { r: number; g: number; b: number } }[];
  expect(glyphs.length).toBe(2);
  const [c1, c2] = glyphs.map((c) => lum(c.fg)).sort((x, y) => y - x);
  expect(c1).toBeGreaterThan(c2); // the stale node is dimmer than the fresh one
});

test('render config: emphasizeHubs bolds high-degree nodes only', () => {
  // hub linked to 8 leaves (degree 8 ≥ threshold); a leaf has degree 1
  const leaves = Array.from({ length: 8 }, (_, i) => `l${i}`);
  const g: GraphData = {
    nodes: [{ id: 'hub', type: 'knowledge' }, ...leaves.map((id) => ({ id, type: 'knowledge' }))],
    links: leaves.map((id) => ({ source: 'hub', target: id })),
  };
  const world: WorldNode[] = [
    { id: 'hub', x: 0, y: 0, cluster: 0 },
    ...leaves.map((id, i) => ({ id, x: 200 + i * 40, y: 0, cluster: 0 })), // leaves off to the side
  ];
  const vp = { cx: 0, cy: 0, scale: 1 };
  const { grid } = renderView(g, world, vp, { cols: 20, rows: 10, emphasizeHubs: true });
  const hubGlyph = findGlyph(grid.cells, '●')!; // only the hub is on-screen at (0,0)
  expect(hubGlyph.attr).toBe(ATTR_BOLD); // bold applied
  expect(grid.cells.some((c) => c && c.char === '░')).toBe(true); // size halo painted around it

  // without the toggle: no bold, no halo
  const plain = renderView(g, world, vp, { cols: 20, rows: 10 });
  expect(findGlyph(plain.grid.cells, '●')!.attr).toBeUndefined();
  expect(plain.grid.cells.some((c) => c && c.char === '░')).toBe(false);
});

test('emphasizeHubs: a node is NOT a hub if its hub-making neighbors are a hidden type', () => {
  // a task hub connected to 8 knowledge leaves — a hub via knowledge only
  const leaves = Array.from({ length: 8 }, (_, i) => `l${i}`);
  const g: GraphData = {
    nodes: [{ id: 'hub', type: 'task' }, ...leaves.map((id) => ({ id, type: 'knowledge' }))],
    links: leaves.map((id) => ({ source: 'hub', target: id })),
  };
  const world: WorldNode[] = [
    { id: 'hub', x: 0, y: 0, cluster: 0 },
    ...leaves.map((id, i) => ({ id, x: 200 + i * 40, y: 0, cluster: 0 })),
  ];
  const vp = { cx: 0, cy: 0, scale: 1 };
  // knowledge visible → hub has degree 8 → emphasized
  const shown = renderView(g, world, vp, { cols: 20, rows: 10, emphasizeHubs: true });
  expect(findGlyph(shown.grid.cells, '◆')!.attr).toBe(ATTR_BOLD);
  // knowledge hidden → hub's VISIBLE degree is 0 → no longer a hub
  const hiddenK = renderView(g, world, vp, { cols: 20, rows: 10, emphasizeHubs: true, hiddenTypes: new Set(['knowledge']) });
  expect(findGlyph(hiddenK.grid.cells, '◆')!.attr).toBeUndefined();
  expect(hiddenK.grid.cells.some((c) => c && c.char === '░')).toBe(false);
});

test('render: the neutralCluster index is drawn gray, not a community hue', () => {
  const g: GraphData = {
    nodes: [
      { id: 'real', type: 'task' },
      { id: 'misc', type: 'task' },
    ],
    links: [],
  };
  const world: WorldNode[] = [
    { id: 'real', x: 0, y: 0, cluster: 0 },
    { id: 'misc', x: 40, y: 0, cluster: 1 }, // cluster 1 = the misc bucket
  ];
  const vp = { cx: 20, cy: 0, scale: 1 };
  const { grid } = renderView(g, world, vp, { cols: 40, rows: 10, neutralCluster: 1 });
  const glyphs = grid.cells.filter((c) => c && c.char === '◆') as { fg: { r: number; g: number; b: number } }[];
  expect(glyphs.length).toBe(2);
  const gray = glyphs.find((c) => c.fg.r === 96 && c.fg.g === 102 && c.fg.b === 114);
  expect(gray).toBeDefined(); // the misc node is the neutral slate
  const colored = glyphs.find((c) => !(c.fg.r === 96 && c.fg.g === 102 && c.fg.b === 114));
  expect(colored).toBeDefined(); // the real community node keeps its hue
});

// ─── typed-edge overlay (render-time) ───
const OVERLAY_G: GraphData = {
  nodes: [
    { id: 'a', type: 'task' },
    { id: 'b', type: 'knowledge' },
  ],
  links: [], // no wiki edges — isolate the typed overlay
};
const OVERLAY_WORLD: WorldNode[] = [
  { id: 'a', x: 0, y: 0, cluster: 0 },
  { id: 'b', x: 40, y: 0, cluster: 1 },
];
const OVERLAY_VP = { cx: 20, cy: 0, scale: 1 };
const semLink = (relation: string, tier: string): SemanticLink => ({ source: 'a', target: 'b', relation, tier, edgeKind: 'semantic' });
const hasColor = (cells: ({ fg: { r: number; g: number; b: number } } | null)[], c: { r: number; g: number; b: number }) =>
  cells.some((cell) => cell && cell.fg.r === c.r && cell.fg.g === c.g && cell.fg.b === c.b);

test('overlay off: no typed edges drawn, no typed stats returned', () => {
  const res = renderView(OVERLAY_G, OVERLAY_WORLD, OVERLAY_VP, { cols: 40, rows: 10, semanticLinks: [semLink('refines', 'asserted')] });
  expect(res.typedVisible).toBeUndefined();
  expect(res.typedFamilies).toBeUndefined();
  expect(hasColor(res.grid.cells, familyEdgeColor('abstraction-ladder', 'asserted'))).toBe(false);
});

test('overlay on: draws a family-colored typed edge + returns typed stats', () => {
  const res = renderView(OVERLAY_G, OVERLAY_WORLD, OVERLAY_VP, {
    cols: 40,
    rows: 10,
    overlay: true,
    semanticLinks: [semLink('refines', 'asserted')], // abstraction-ladder
  });
  expect(res.typedVisible).toBe(1);
  expect(res.typedFamilies?.map((f) => f.family)).toEqual(['abstraction-ladder']);
  expect(hasColor(res.grid.cells, familyEdgeColor('abstraction-ladder', 'asserted'))).toBe(true);
});

test('overlay respects hiddenTypes: a typed edge to a hidden node is not drawn (count 0)', () => {
  const res = renderView(OVERLAY_G, OVERLAY_WORLD, OVERLAY_VP, {
    cols: 40,
    rows: 10,
    overlay: true,
    semanticLinks: [semLink('refines', 'asserted')],
    hiddenTypes: new Set(['knowledge']), // endpoint b hidden
  });
  expect(res.typedVisible).toBe(0);
  expect(hasColor(res.grid.cells, familyEdgeColor('abstraction-ladder', 'asserted'))).toBe(false);
});

test('overlay respects hiddenFamilies: a hidden family is not drawn but still listed', () => {
  const res = renderView(OVERLAY_G, OVERLAY_WORLD, OVERLAY_VP, {
    cols: 40,
    rows: 10,
    overlay: true,
    semanticLinks: [semLink('refines', 'asserted')],
    hiddenFamilies: new Set(['abstraction-ladder']),
  });
  expect(res.typedVisible).toBe(0);
  const row = res.typedFamilies?.find((f) => f.family === 'abstraction-ladder');
  expect(row?.hidden).toBe(true);
  expect(row?.count).toBe(1); // node-visible count stays, so the legend row can be toggled back on
});

test('cluster-mode layout keeps every node in bounds', () => {
  const g: GraphData = {
    nodes: Array.from({ length: 24 }, (_, i) => ({ id: `n${i}`, group: `g${i % 4}` })),
    links: [],
  };
  const { nodes } = layoutGraph(g, { width: 100, height: 80, mode: 'cluster', iterations: 100 });
  for (const n of nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x).toBeLessThanOrEqual(100);
    expect(n.y).toBeGreaterThanOrEqual(0);
    expect(n.y).toBeLessThanOrEqual(80);
  }
});
