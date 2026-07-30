import { test, expect } from 'bun:test';
import {
  familyOf,
  familyColor,
  familyEdgeColor,
  computeOverlay,
  EDGE_FAMILIES,
  type SemanticLink,
} from './overlay';

const lum = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b;
const link = (source: string, target: string, relation: string, tier?: string): SemanticLink => ({
  source,
  target,
  relation,
  tier,
  edgeKind: 'semantic',
});

test('familyOf maps every one of the 15 relation types to its family', () => {
  const expected: Record<string, string> = {
    'dual-of': 'lattice-structural',
    'contests-at-border': 'lattice-structural',
    'transmission-pair': 'lattice-structural',
    exemplifies: 'lattice-structural',
    'vice-of': 'lattice-structural',
    generalizes: 'abstraction-ladder',
    refines: 'abstraction-ladder',
    supersedes: 'lifecycle-lift',
    'resolved-by': 'lifecycle-lift',
    motivates: 'lifecycle-lift',
    'depends-on': 'task-graph',
    'analogous-to': 'analogy-tension',
    contradicts: 'analogy-tension',
    'builds-on': 'knowledge-functional',
    'addressed-by': 'knowledge-functional',
  };
  for (const [rel, fam] of Object.entries(expected)) expect(familyOf(rel)).toBe(fam as never);
  expect(Object.keys(expected).length).toBe(15); // all 15 covered
});

test('familyOf returns null for an unknown / dropped relation (e.g. similar-to)', () => {
  expect(familyOf('similar-to')).toBeNull();
  expect(familyOf('')).toBeNull();
});

test('every family has a distinct, valid-RGB color', () => {
  const seen = new Set<string>();
  for (const f of EDGE_FAMILIES) {
    const c = familyColor(f);
    for (const v of [c.r, c.g, c.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
    seen.add(`${c.r},${c.g},${c.b}`);
  }
  expect(seen.size).toBe(EDGE_FAMILIES.length); // all 6 distinct hues
});

test('familyEdgeColor: asserted is full brightness, inferred is dimmed (~60%)', () => {
  for (const f of EDGE_FAMILIES) {
    const asserted = familyEdgeColor(f, 'asserted');
    const inferred = familyEdgeColor(f, 'inferred');
    expect(asserted).toEqual(familyColor(f)); // asserted === the family hue
    expect(lum(inferred)).toBeLessThan(lum(asserted)); // inferred dimmer
  }
  // a missing/unknown tier is treated as non-asserted (dimmed), never full brightness
  const f = EDGE_FAMILIES[0];
  expect(familyEdgeColor(f, undefined)).toEqual(familyEdgeColor(f, 'inferred'));
});

test('computeOverlay only draws edges with BOTH endpoints visible', () => {
  const links = [link('a', 'b', 'refines', 'asserted'), link('a', 'z', 'refines', 'asserted')]; // z hidden
  const visible = new Set(['a', 'b']);
  const r = computeOverlay(links, (id) => visible.has(id), new Set());
  expect(r.edges.length).toBe(1);
  expect(r.edges[0].source).toBe('a');
  expect(r.edges[0].target).toBe('b');
  expect(r.visibleCount).toBe(1);
});

test('computeOverlay drops unknown relations entirely', () => {
  const links = [link('a', 'b', 'similar-to', 'asserted'), link('a', 'b', 'refines', 'asserted')];
  const r = computeOverlay(links, () => true, new Set());
  expect(r.edges.length).toBe(1); // only the known relation
  expect(r.families.map((f) => f.family)).toEqual(['abstraction-ladder']);
});

test('computeOverlay: a hidden family is COUNTED (legend) but not DRAWN', () => {
  const links = [
    link('a', 'b', 'refines', 'asserted'), // abstraction-ladder
    link('a', 'b', 'depends-on', 'asserted'), // task-graph
  ];
  const r = computeOverlay(links, () => true, new Set(['task-graph']));
  // task-graph edge is not drawn…
  expect(r.edges.every((e) => e.family !== 'task-graph')).toBe(true);
  expect(r.visibleCount).toBe(1);
  // …but it still has a legend row (node-visible count = 1) marked hidden, so it can be toggled back.
  const tg = r.families.find((f) => f.family === 'task-graph')!;
  expect(tg.count).toBe(1);
  expect(tg.hidden).toBe(true);
});

test('computeOverlay: family legend count is stable across the family toggle (node-visible tally)', () => {
  const links = [link('a', 'b', 'refines', 'asserted'), link('a', 'z', 'refines', 'asserted')]; // z hidden
  const visible = new Set(['a', 'b']);
  const shown = computeOverlay(links, (id) => visible.has(id), new Set());
  const hidden = computeOverlay(links, (id) => visible.has(id), new Set(['abstraction-ladder']));
  const cShown = shown.families.find((f) => f.family === 'abstraction-ladder')!.count;
  const cHidden = hidden.families.find((f) => f.family === 'abstraction-ladder')!.count;
  expect(cShown).toBe(1); // only the a–b edge is node-visible (a–z has a hidden endpoint)
  expect(cHidden).toBe(1); // hiding the family does NOT change the node-visible count
  expect(hidden.visibleCount).toBe(0); // …but nothing is drawn
});

test('computeOverlay: families are listed in fixed EDGE_FAMILIES order, present-only', () => {
  const links = [
    link('a', 'b', 'builds-on', 'asserted'), // knowledge-functional (last)
    link('a', 'b', 'dual-of', 'asserted'), // lattice-structural (first)
  ];
  const r = computeOverlay(links, () => true, new Set());
  expect(r.families.map((f) => f.family)).toEqual(['lattice-structural', 'knowledge-functional']);
});

test('computeOverlay: an asserted edge draws brighter than an inferred one of the same family', () => {
  const asserted = computeOverlay([link('a', 'b', 'refines', 'asserted')], () => true, new Set());
  const inferred = computeOverlay([link('a', 'b', 'refines', 'inferred')], () => true, new Set());
  expect(lum(asserted.edges[0].color)).toBeGreaterThan(lum(inferred.edges[0].color));
});

test('computeOverlay: each family carries its present-in-data relations, node-visible count desc', () => {
  const links = [
    link('a', 'b', 'refines', 'asserted'), // abstraction-ladder
    link('a', 'b', 'refines', 'asserted'), // abstraction-ladder (refines now count 2)
    link('a', 'b', 'generalizes', 'asserted'), // abstraction-ladder (count 1)
  ];
  const r = computeOverlay(links, () => true, new Set());
  const fam = r.families.find((f) => f.family === 'abstraction-ladder')!;
  expect(fam.relations.map((x) => x.relation)).toEqual(['refines', 'generalizes']); // count desc
  expect(fam.relations.map((x) => x.count)).toEqual([2, 1]);
  expect(fam.relations.every((x) => x.hidden === false)).toBe(true);
});

test('computeOverlay: a hidden RELATION is counted (legend) but not drawn; its family still draws', () => {
  const links = [
    link('a', 'b', 'refines', 'asserted'), // abstraction-ladder
    link('a', 'b', 'generalizes', 'asserted'), // abstraction-ladder
  ];
  const r = computeOverlay(links, () => true, new Set(), new Set(['generalizes']));
  // generalizes edge dropped, refines still drawn
  expect(r.edges.map((e) => e.family)).toEqual(['abstraction-ladder']);
  expect(r.visibleCount).toBe(1);
  const fam = r.families.find((f) => f.family === 'abstraction-ladder')!;
  expect(fam.hidden).toBe(false); // the family as a whole is still visible
  const gen = fam.relations.find((x) => x.relation === 'generalizes')!;
  expect(gen.count).toBe(1); // still counted
  expect(gen.hidden).toBe(true); // marked so it can be toggled back
});

test('computeOverlay: hiding the family suppresses every relation edge regardless of hiddenRelations', () => {
  const links = [
    link('a', 'b', 'refines', 'asserted'),
    link('a', 'b', 'generalizes', 'asserted'),
  ];
  const r = computeOverlay(links, () => true, new Set(['abstraction-ladder']), new Set());
  expect(r.visibleCount).toBe(0); // whole family hidden → nothing drawn
  const fam = r.families.find((f) => f.family === 'abstraction-ladder')!;
  expect(fam.relations.map((x) => x.count)).toEqual([1, 1]); // counts still stand
});

test('computeOverlay: relations are present-in-data even when both endpoints are hidden', () => {
  const links = [link('a', 'z', 'refines', 'asserted')]; // z hidden
  const visible = new Set(['a']);
  const r = computeOverlay(links, (id) => visible.has(id), new Set());
  const fam = r.families.find((f) => f.family === 'abstraction-ladder')!;
  expect(fam.relations.map((x) => x.relation)).toEqual(['refines']); // present so it can be toggled
  expect(fam.relations[0].count).toBe(0); // but node-visible count is 0
});

test('computeOverlay: the 3-arg call (no hiddenRelations) is backward-compatible', () => {
  const links = [link('a', 'b', 'refines', 'asserted')];
  const r = computeOverlay(links, () => true, new Set());
  expect(r.visibleCount).toBe(1);
  expect(r.families[0].relations.length).toBe(1); // relations present, additive to the old shape
});
