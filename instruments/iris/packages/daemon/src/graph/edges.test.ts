import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTypedEdges, parseEdgesMode, mergeTypedEdges } from './edges.ts';
import { buildGraph } from './build.ts';
import type { OrgIndex, IndexedDoc, GraphLink, TypedEdge } from '../contract.ts';

// ── parseEdgesMode ──────────────────────────────────────────────────────────────

describe('parseEdgesMode', () => {
  test('only exact "semantic"/"both" switch; everything else → wiki', () => {
    expect(parseEdgesMode('semantic')).toBe('semantic');
    expect(parseEdgesMode('both')).toBe('both');
    expect(parseEdgesMode(' both ')).toBe('both'); // trimmed
    expect(parseEdgesMode('wiki')).toBe('wiki');
    expect(parseEdgesMode('garbage')).toBe('wiki');
    expect(parseEdgesMode('')).toBe('wiki');
    expect(parseEdgesMode(undefined)).toBe('wiki');
  });
});

// ── loadTypedEdges ──────────────────────────────────────────────────────────────

describe('loadTypedEdges', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-edges-'));
    fs.mkdirSync(path.join(tmp, 'graph'), { recursive: true });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('absent file → []', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-noedges-'));
    expect(loadTypedEdges(bare)).toEqual([]);
    fs.rmSync(bare, { recursive: true, force: true });
  });

  test('parses valid lines; skips blank + malformed + missing-required; keeps extras out', () => {
    const lines = [
      '{"source":"a.md","target":"b.md","type":"analogous-to","confidence":"inferred","refines_wikilink":true,"payload":{"x":1}}',
      '', // blank
      '   ', // whitespace-only
      'not json at all', // malformed
      '{"source":"c.md","target":"d.md"}', // missing required `type` → skip
      '{"source":"e.md","target":"f.md","type":"refines"}', // no confidence/refines
    ];
    fs.writeFileSync(path.join(tmp, 'graph', 'edges.jsonl'), lines.join('\n'));
    const edges = loadTypedEdges(tmp);
    expect(edges).toEqual([
      { source: 'a.md', target: 'b.md', type: 'analogous-to', confidence: 'inferred', refines_wikilink: true },
      { source: 'e.md', target: 'f.md', type: 'refines' },
    ]);
  });

  test('CRLF line endings tolerated', () => {
    fs.writeFileSync(path.join(tmp, 'graph', 'edges.jsonl'), '{"source":"a","target":"b","type":"x"}\r\n{"source":"c","target":"d","type":"y"}\r\n');
    expect(loadTypedEdges(tmp).length).toBe(2);
  });
});

// ── mergeTypedEdges ─────────────────────────────────────────────────────────────

describe('mergeTypedEdges', () => {
  const nodeIds = new Set(['a.md', 'b.md', 'c.md']);
  const wiki: GraphLink[] = [
    { source: 'a.md', target: 'b.md' },
    { source: 'b.md', target: 'c.md' },
  ];
  const typed: TypedEdge[] = [
    { source: 'b.md', target: 'a.md', type: 'analogous-to', confidence: 'inferred', refines_wikilink: true }, // refines a↔b
    { source: 'a.md', target: 'c.md', type: 'refines', confidence: 'asserted' }, // non-refining, new pair
    { source: 'a.md', target: 'z.md', type: 'x', confidence: 'asserted' }, // endpoint z not a node → not servable
    { source: 'a.md', target: 'b.md', type: 'y', confidence: 'candidate' }, // candidate → never servable
  ];

  test('wiki mode returns links untouched', () => {
    expect(mergeTypedEdges(wiki, typed, nodeIds, 'wiki')).toBe(wiki);
  });

  test('semantic mode: only servable typed edges, correct link shape', () => {
    const out = mergeTypedEdges(wiki, typed, nodeIds, 'semantic');
    expect(out).toEqual([
      { source: 'b.md', target: 'a.md', relation: 'analogous-to', tier: 'inferred', edgeKind: 'semantic' },
      { source: 'a.md', target: 'c.md', relation: 'refines', tier: 'asserted', edgeKind: 'semantic' },
    ]);
    // candidate + non-node-endpoint excluded
    expect(out.some((l) => l.relation === 'y')).toBe(false);
    expect(out.some((l) => l.target === 'z.md')).toBe(false);
    // key order + weight omission
    expect(Object.keys(out[0])).toEqual(['source', 'target', 'relation', 'tier', 'edgeKind']);
  });

  test('both mode: wiki + typed, refining edge drops its wiki pair (unordered)', () => {
    const out = mergeTypedEdges(wiki, typed, nodeIds, 'both');
    // a↔b wiki link dropped (refined by the b→a typed edge); b→c wiki kept
    expect(out).toContainEqual({ source: 'b.md', target: 'c.md' });
    expect(out.some((l) => l.source === 'a.md' && l.target === 'b.md' && l.relation === undefined)).toBe(false);
    // typed edges appended
    expect(out).toContainEqual({ source: 'b.md', target: 'a.md', relation: 'analogous-to', tier: 'inferred', edgeKind: 'semantic' });
    expect(out).toContainEqual({ source: 'a.md', target: 'c.md', relation: 'refines', tier: 'asserted', edgeKind: 'semantic' });
    // total: 1 surviving wiki + 2 servable typed
    expect(out.length).toBe(3);
  });

  test('tier omitted when a typed edge carries no confidence', () => {
    const noConf: TypedEdge[] = [{ source: 'a.md', target: 'b.md', type: 'r' }];
    const out = mergeTypedEdges([], noConf, nodeIds, 'semantic');
    expect(out).toEqual([{ source: 'a.md', target: 'b.md', relation: 'r', edgeKind: 'semantic' }]);
    expect('tier' in out[0]).toBe(false);
  });
});

// ── Integration through buildGraph ──────────────────────────────────────────────

describe('edges wired through buildGraph', () => {
  function mkIndex(docs: IndexedDoc[]): OrgIndex {
    return {
      docs: new Map(docs.map((d) => [d.path, d])),
      pathMap: new Map(),
      stemMap: new Map(),
      projectMap: new Map(),
      resolve: () => ({ kind: 'resolved', path: 'x' }),
    };
  }
  const doc = (path: string, backlinks: string[] = []): IndexedDoc => ({
    path, title: path, docType: 'knowledge', status: null, created: null, updated: null, tags: [], links: [], backlinks,
  });

  test('semantic mode swaps wiki links for servable typed edges; nodes unchanged', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-edgewire-'));
    fs.mkdirSync(path.join(tmp, 'graph'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'graph', 'edges.jsonl'),
      ['{"source":"a.md","target":"b.md","type":"analogous-to","confidence":"asserted"}',
       '{"source":"a.md","target":"missing.md","type":"x","confidence":"asserted"}'].join('\n'),
    );
    const idx = mkIndex([doc('a.md'), doc('b.md', ['a.md'])]);
    const wikiG = buildGraph(idx, {}, tmp);
    expect(wikiG.links).toEqual([{ source: 'a.md', target: 'b.md' }]); // wiki: backlink-derived

    const semG = buildGraph(idx, { edges: 'semantic' }, tmp);
    expect(semG.nodes.length).toBe(wikiG.nodes.length); // node set unchanged
    expect(semG.links).toEqual([
      { source: 'a.md', target: 'b.md', relation: 'analogous-to', tier: 'asserted', edgeKind: 'semantic' },
    ]); // missing.md endpoint not a node → excluded
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('wiki (default) never reads edges.jsonl — malformed file is irrelevant', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-edgewiki-'));
    fs.mkdirSync(path.join(tmp, 'graph'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'graph', 'edges.jsonl'), 'total garbage that would throw if parsed strictly');
    const idx = mkIndex([doc('a.md'), doc('b.md', ['a.md'])]);
    const g = buildGraph(idx, {}, tmp); // default wiki
    expect(g.links).toEqual([{ source: 'a.md', target: 'b.md' }]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
