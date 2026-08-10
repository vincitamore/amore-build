import { test, expect } from 'bun:test';
import { displayLabel, graphSignature, layoutGraph, layoutWorld, renderGraphToCanvas, rewriteMachineTitle, type GraphData } from './graph';

const SQUARE: GraphData = {
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
  links: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
    { source: 'd', target: 'a' },
  ],
};

test('layoutGraph positions every node within the canvas bounds, finite', () => {
  const { nodes } = layoutGraph(SQUARE, { width: 100, height: 80, iterations: 150 });
  expect(nodes.length).toBe(4);
  for (const n of nodes) {
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Number.isFinite(n.y)).toBe(true);
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x).toBeLessThanOrEqual(100);
    expect(n.y).toBeGreaterThanOrEqual(0);
    expect(n.y).toBeLessThanOrEqual(80);
  }
});

test('connected nodes settle to distinct positions', () => {
  const { nodes } = layoutGraph(SQUARE, { width: 100, height: 80, iterations: 200 });
  const keys = new Set(nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
  expect(keys.size).toBe(4);
});

test('empty graph lays out to nothing', () => {
  expect(layoutGraph({ nodes: [], links: [] }, { width: 50, height: 50 }).nodes).toEqual([]);
});

test('community-mode layout keeps every node in bounds', () => {
  // two disconnected triangles → two communities
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
  const { nodes } = layoutGraph(g, { width: 100, height: 80, mode: 'community', iterations: 120 });
  expect(nodes.length).toBe(6);
  for (const n of nodes) {
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x).toBeLessThanOrEqual(100);
    expect(n.y).toBeGreaterThanOrEqual(0);
    expect(n.y).toBeLessThanOrEqual(80);
  }
});

test('statusForce=0 disables the attention bias in force mode (still finite + in bounds)', () => {
  const g: GraphData = {
    nodes: [
      { id: 'a', type: 'task', status: 'blocked' },
      { id: 'b', type: 'task', status: 'complete' },
    ],
    links: [{ source: 'a', target: 'b' }],
  };
  const { nodes } = layoutGraph(g, { width: 100, height: 80, mode: 'force', statusForce: 0, iterations: 120 });
  for (const n of nodes) {
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Number.isFinite(n.y)).toBe(true);
  }
});

test('renderGraphToCanvas draws ink (non-empty) and returns node positions', () => {
  const { canvas, nodes } = renderGraphToCanvas(SQUARE, { cols: 40, rows: 20, iterations: 150 });
  expect(nodes.length).toBe(4);
  const ink = canvas.toString().replace(/[ \n]/g, '').length;
  expect(ink).toBeGreaterThan(0);
});

test('radial layout ranks by attention: the hottest node sits nearest the origin', () => {
  const g: GraphData = {
    nodes: [
      { id: 'done', type: 'task', status: 'complete' }, // tier 0
      { id: 'active', type: 'task', status: 'active' }, // tier 2
      { id: 'blocked', type: 'task', status: 'blocked' }, // tier 3 — hottest
      { id: 'note', type: 'knowledge' }, // tier 1
    ],
    links: [],
  };
  const { nodes } = layoutWorld(g, { mode: 'radial' });
  expect(nodes.length).toBe(4);
  const dist = (id: string) => {
    const n = nodes.find((w) => w.id === id)!;
    return Math.hypot(n.x, n.y);
  };
  // Hottest is placed first (i=0 → radius 0 → origin); dormant is pushed outward.
  expect(dist('blocked')).toBeLessThan(dist('active'));
  expect(dist('active')).toBeLessThan(dist('note'));
  expect(dist('note')).toBeLessThan(dist('done'));
  for (const n of nodes) {
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Number.isFinite(n.y)).toBe(true);
  }
});

test('status-aware force pulls hot work toward the center, dormant toward the rim', () => {
  // Disconnected nodes so only charge + the attention-radial bias act; hot (blocked) targets a
  // small ring, dormant (complete) a large one → hot settles nearer the origin.
  const g: GraphData = {
    nodes: [
      { id: 'hot', type: 'task', status: 'blocked' },
      { id: 'cold', type: 'task', status: 'complete' },
      { id: 'mid', type: 'task', status: 'active' },
    ],
    links: [],
  };
  const { nodes } = layoutWorld(g, { mode: 'force', iterations: 300 });
  const dist = (id: string) => {
    const n = nodes.find((w) => w.id === id)!;
    return Math.hypot(n.x, n.y);
  };
  expect(dist('hot')).toBeLessThan(dist('mid'));
  expect(dist('mid')).toBeLessThan(dist('cold'));
});

test('radial layout gives every node a distinct position', () => {
  const g: GraphData = {
    nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, type: 'knowledge' })),
    links: [],
  };
  const { nodes } = layoutWorld(g, { mode: 'radial' });
  const keys = new Set(nodes.map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`));
  expect(keys.size).toBe(30);
});

test('graphSignature: metadata-only changes keep it; a rewire at constant counts changes it', () => {
  const base = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ source: 'a', target: 'b' }] } as unknown as GraphData;
  const meta = { nodes: [{ id: 'a', status: 'active' }, { id: 'b' }, { id: 'c' }], links: [{ source: 'a', target: 'b' }] } as unknown as GraphData;
  const rewired = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ source: 'a', target: 'c' }] } as unknown as GraphData;
  expect(graphSignature(meta)).toBe(graphSignature(base));
  expect(graphSignature(rewired)).not.toBe(graphSignature(base)); // same node/link COUNTS, different endpoint
});

// ── displayLabel — machine-slug manifest titles must not truncate to one shared prefix ──────────

test('displayLabel: dream-manifest slugs lead with recipe + date, not the shared prefix', () => {
  expect(displayLabel('Pipeline: dream-2026-02-14T08-19-40-project-health')).toBe('project-health 202'.slice(0, 18));
  // Two different dreams must render DIFFERENT truncated labels (the bug this fixes).
  const a = displayLabel('Pipeline: dream-2026-02-17T09-31-56-dream-digest');
  const b = displayLabel('Pipeline: dream-2026-02-17T12-42-09-self-orient');
  expect(a).not.toBe(b);
  expect(a.startsWith('dream-digest')).toBe(true);
  expect(b.startsWith('self-orient')).toBe(true);
});

test('displayLabel: operator pipeline titles drop the redundant prefix; plain labels untouched', () => {
  expect(displayLabel('Pipeline: iron-rod-platform-design')).toBe('iron-rod-platform-'.slice(0, 18));
  expect(displayLabel('KB Link Density Report')).toBe('KB Link Density Re');
  expect(displayLabel('short')).toBe('short');
});

test('rewriteMachineTitle: full distinctive form without slice', () => {
  expect(rewriteMachineTitle('Pipeline: dream-2026-02-14T08-19-40-project-health')).toBe(
    'project-health 2026-02-14',
  );
  expect(rewriteMachineTitle('Pipeline: iron-rod-platform-design')).toBe(
    'iron-rod-platform-design',
  );
  expect(rewriteMachineTitle('KB Link Density Report')).toBe('KB Link Density Report');
  expect(displayLabel('Pipeline: dream-2026-02-14T08-19-40-project-health')).toBe(
    rewriteMachineTitle('Pipeline: dream-2026-02-14T08-19-40-project-health').slice(0, 18),
  );
});
