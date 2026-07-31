import { test, expect, describe } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from './build.ts';
import type { OrgIndex, IndexedDoc, LinkResolution, GraphNode } from '../contract.ts';

// ── Fakes ─────────────────────────────────────────────────────────────────────

const ORG = 'C:/fake/org'; // most tests never touch disk (no missing→file path)

function mkDoc(p: Partial<IndexedDoc> & { path: string }): IndexedDoc {
  return {
    path: p.path,
    title: p.title ?? p.path,
    docType: p.docType ?? 'other',
    status: p.status ?? null,
    created: p.created ?? null,
    updated: p.updated ?? null,
    tags: p.tags ?? [],
    links: p.links ?? [],
    backlinks: p.backlinks ?? [],
    ...(p.pipeline !== undefined ? { pipeline: p.pipeline } : {}),
  };
}

function mkIndex(docs: IndexedDoc[], resolve?: (t: string, s: string) => LinkResolution): OrgIndex {
  return {
    docs: new Map(docs.map((d) => [d.path, d])),
    pathMap: new Map(),
    stemMap: new Map(),
    projectMap: new Map(),
    resolve: resolve ?? (() => ({ kind: 'missing' })),
  };
}

const byId = (a: GraphNode, b: GraphNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ── Scope ─────────────────────────────────────────────────────────────────────

describe('scope parsing + filtering', () => {
  test('workspace (default): all docs, no value/depth in scope', () => {
    const idx = mkIndex([mkDoc({ path: 'a.md' }), mkDoc({ path: 'b.md' })]);
    const g = buildGraph(idx, {}, ORG);
    expect(g.nodes.length).toBe(2);
    expect(g.scope).toEqual({ kind: 'workspace', groupBy: 'type', nodeCount: 2, linkCount: 0 });
    expect(Object.keys(g.scope)).toEqual(['kind', 'groupBy', 'nodeCount', 'linkCount']);
  });

  test('folder scope: path==prefix OR startsWith prefix+/, boundary-safe', () => {
    const idx = mkIndex([
      mkDoc({ path: 'knowledge/architecture/a.md' }),
      mkDoc({ path: 'knowledge/architecture/sub/b.md' }),
      mkDoc({ path: 'knowledge/architecture' }), // exact match
      mkDoc({ path: 'knowledge/architecture.md' }), // NOT a match (boundary)
      mkDoc({ path: 'knowledge/other.md' }),
    ]);
    const g = buildGraph(idx, { scope: 'folder:knowledge/architecture' }, ORG);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['knowledge/architecture', 'knowledge/architecture/a.md', 'knowledge/architecture/sub/b.md']);
    expect(g.scope.value).toBe('knowledge/architecture');
    expect(g.scope.depth).toBeUndefined();
  });

  test('unknown scope kind → empty graph, kind/value echoed', () => {
    const idx = mkIndex([mkDoc({ path: 'a.md' })]);
    const g = buildGraph(idx, { scope: 'bogus:xyz' }, ORG);
    expect(g.nodes).toEqual([]);
    expect(g.links).toEqual([]);
    expect(g.scope).toEqual({ kind: 'bogus', value: 'xyz', groupBy: 'type', nodeCount: 0, linkCount: 0 });
  });

  test('seed BFS honours depth over links ∪ backlinks', () => {
    const docs = [
      mkDoc({ path: 'a.md', links: ['b.md'] }),
      mkDoc({ path: 'b.md', links: ['c.md'], backlinks: ['a.md'] }),
      mkDoc({ path: 'c.md', links: ['d.md'], backlinks: ['b.md'] }),
      mkDoc({ path: 'd.md', backlinks: ['c.md'] }),
    ];
    const known = new Set(docs.map((d) => d.path));
    // links point at real docs → resolve to those docs (no spurious placeholders).
    const idx = mkIndex(docs, (t) => (known.has(t) ? { kind: 'resolved', path: t } : { kind: 'missing' }));
    const d1 = buildGraph(idx, { scope: 'seed:a.md', depth: 1 }, ORG);
    expect(d1.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md']);
    expect(d1.scope.depth).toBe(1); // depth present only for seed

    const d2 = buildGraph(idx, { scope: 'seed:a.md', depth: 2 }, ORG);
    expect(d2.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(d2.scope.depth).toBe(2);
  });

  test('seed with no id → empty node set, depth still present', () => {
    const idx = mkIndex([mkDoc({ path: 'a.md' })]);
    const g = buildGraph(idx, { scope: 'seed' }, ORG);
    expect(g.nodes).toEqual([]);
    expect(g.scope).toEqual({ kind: 'seed', depth: 1, groupBy: 'type', nodeCount: 0, linkCount: 0 });
  });

  test('tag scope: exact tag membership; missing name → empty', () => {
    const idx = mkIndex([
      mkDoc({ path: 'a.md', tags: ['foo', 'bar'] }),
      mkDoc({ path: 'b.md', tags: ['baz'] }),
      mkDoc({ path: 'c.md', tags: ['foo'] }),
    ]);
    const g = buildGraph(idx, { scope: 'tag:foo' }, ORG);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'c.md']);
    expect(g.scope.value).toBe('foo');

    const none = buildGraph(idx, { scope: 'tag' }, ORG);
    expect(none.nodes).toEqual([]);
  });
});

// ── Node minting field table ───────────────────────────────────────────────────

describe('doc node minting (legacy field table + key order)', () => {
  test('doc node with status + updated', () => {
    const idx = mkIndex([
      mkDoc({ path: 'k/x.md', title: 'X', docType: 'knowledge', status: 'active', updated: '2026-06-03', tags: ['t1'], links: [], backlinks: [] }),
    ]);
    const n = buildGraph(idx, {}, ORG).nodes[0];
    expect(Object.keys(n)).toEqual(['id', 'label', 'kind', 'type', 'status', 'linkCount', 'folder', 'tags', 'group', 'updated']);
    expect(n).toMatchObject({ id: 'k/x.md', label: 'X', kind: 'doc', type: 'knowledge', status: 'active', linkCount: 0, folder: 'k', tags: ['t1'], group: 'knowledge', updated: '2026-06-03' });
  });

  test('doc node no status/updated: keys omit them', () => {
    const idx = mkIndex([mkDoc({ path: 'tags/t.md', docType: 'tag', links: ['x'], backlinks: [] })], () => ({ kind: 'skip' }));
    const n = buildGraph(idx, {}, ORG).nodes[0];
    expect(Object.keys(n)).toEqual(['id', 'label', 'kind', 'type', 'linkCount', 'folder', 'tags', 'group']);
  });

  test('doc node forge + pipeline: pipeline before group', () => {
    const idx = mkIndex([
      mkDoc({ path: 'forge/proposals/p.md', docType: 'forge', status: 'applied', pipeline: 'dream-x', tags: ['forge'] }),
    ]);
    const n = buildGraph(idx, {}, ORG).nodes[0];
    expect(Object.keys(n)).toEqual(['id', 'label', 'kind', 'type', 'status', 'linkCount', 'folder', 'tags', 'pipeline', 'group']);
    expect(n.pipeline).toBe('dream-x');
    expect(n.group).toBe('forge'); // legacy: no forge split
  });

  test('linkCount = links.length + backlinks.length', () => {
    const idx = mkIndex([mkDoc({ path: 'a.md', links: ['b.md', 'c.md'], backlinks: ['d.md'] }), mkDoc({ path: 'b.md' })], () => ({ kind: 'resolved', path: 'b.md' }));
    const a = buildGraph(idx, {}, ORG).nodes.find((n) => n.id === 'a.md')!;
    expect(a.linkCount).toBe(3);
  });
});

describe('placeholder nodes', () => {
  test('placeholder mint + dedup + byte-sorted append after doc nodes', () => {
    const idx = mkIndex(
      [
        mkDoc({ path: 'a.md', links: ['z-target', 'a-target', 'z-target'] }),
        mkDoc({ path: 'b.md', links: ['a-target'] }),
      ],
      () => ({ kind: 'missing' }),
    );
    const g = buildGraph(idx, {}, ORG);
    const placeholders = g.nodes.filter((n) => n.kind === 'placeholder');
    expect(placeholders.map((n) => n.id)).toEqual(['placeholder:a-target', 'placeholder:z-target']); // deduped + sorted
    // doc nodes come first
    expect(g.nodes.slice(0, 2).every((n) => n.kind === 'doc')).toBe(true);
    const p = placeholders[0];
    expect(Object.keys(p)).toEqual(['id', 'label', 'kind', 'type', 'linkCount', 'folder', 'tags', 'group']);
    expect(p).toMatchObject({ label: 'a-target', kind: 'placeholder', type: 'placeholder', linkCount: 0, folder: '', tags: [], group: 'placeholder' });
  });

  test('placeholder label = last / segment', () => {
    const idx = mkIndex([mkDoc({ path: 'a.md', links: ['foo/bar/baz'] })], () => ({ kind: 'missing' }));
    const p = buildGraph(idx, {}, ORG).nodes.find((n) => n.kind === 'placeholder')!;
    expect(p.id).toBe('placeholder:foo/bar/baz');
    expect(p.label).toBe('baz');
  });

  test('skip resolutions mint no node and no link', () => {
    const idx = mkIndex([mkDoc({ path: 'a.md', links: ['skill://x', 'https://y'] })], () => ({ kind: 'skip' }));
    const g = buildGraph(idx, {}, ORG);
    expect(g.nodes.length).toBe(1); // only the doc
    expect(g.links.length).toBe(0);
  });
});

describe('link emission from backlinks', () => {
  test('backlink in scope → {source: backlink, target: doc}; out-of-scope dropped', () => {
    const idx = mkIndex([
      mkDoc({ path: 'a.md' }),
      mkDoc({ path: 'b.md', backlinks: ['a.md', 'external.md'] }),
    ]);
    const g = buildGraph(idx, {}, ORG);
    expect(g.links).toEqual([{ source: 'a.md', target: 'b.md' }]);
  });

  test('placeholder edge {source: doc, target: placeholder-id}', () => {
    const idx = mkIndex([mkDoc({ path: 'a.md', links: ['gone'] })], () => ({ kind: 'missing' }));
    const g = buildGraph(idx, {}, ORG);
    expect(g.links).toEqual([{ source: 'a.md', target: 'placeholder:gone' }]);
  });
});

// ── Grouped mode ────────────────────────────────────────────────────────────────

describe('grouped mode (group_by=folder)', () => {
  const idx = mkIndex([
    mkDoc({ path: 'knowledge/arch/a.md', backlinks: ['knowledge/net/c.md', 'x1', 'x2'] }), // linkTotal 3
    mkDoc({ path: 'knowledge/arch/b.md', backlinks: ['knowledge/net/c.md'] }), // linkTotal 1
    mkDoc({ path: 'knowledge/net/c.md', backlinks: ['knowledge/arch/a.md'] }), // linkTotal 1
  ]);

  test('cluster nodes first in sorted key order; field table', () => {
    const g = buildGraph(idx, { scope: 'folder:knowledge', groupBy: 'folder' }, ORG);
    const clusters = g.nodes.filter((n) => n.kind === 'cluster');
    expect(clusters.map((n) => n.id)).toEqual([
      'cluster:folder:knowledge/arch',
      'cluster:folder:knowledge/net',
    ]);
    const arch = clusters[0];
    expect(Object.keys(arch)).toEqual(['id', 'label', 'kind', 'type', 'linkCount', 'folder', 'tags', 'group', 'memberCount']);
    expect(arch).toMatchObject({ label: 'arch', kind: 'cluster', type: 'folder-cluster', linkCount: 4, folder: 'knowledge', tags: [], group: 'knowledge/arch', memberCount: 2 });
  });

  test('clusters[] summary with reps by linkCount desc (≤3)', () => {
    const g = buildGraph(idx, { scope: 'folder:knowledge', groupBy: 'folder' }, ORG);
    const arch = g.clusters.find((c) => c.id === 'cluster:folder:knowledge/arch')!;
    expect(Object.keys(arch)).toEqual(['id', 'label', 'groupKey', 'memberCount', 'representatives']);
    expect(arch.representatives).toEqual(['knowledge/arch/a.md', 'knowledge/arch/b.md']); // a (3) before b (1)
  });

  test('aggregate weight present only when count > 1', () => {
    const g = buildGraph(idx, { scope: 'folder:knowledge', groupBy: 'folder' }, ORG);
    const netToArch = g.links.find((l) => l.source === 'cluster:folder:knowledge/net' && l.target === 'cluster:folder:knowledge/arch')!;
    const archToNet = g.links.find((l) => l.source === 'cluster:folder:knowledge/arch' && l.target === 'cluster:folder:knowledge/net')!;
    expect(netToArch.weight).toBe(2); // c→a and c→b both route net→arch
    expect(archToNet.weight).toBeUndefined(); // single a→c route
  });
});

// ── v2 shape ────────────────────────────────────────────────────────────────────

describe('v2 shape transforms', () => {
  test('forge pipeline/dream split (type + group when groupBy=type)', () => {
    const idx = mkIndex([
      mkDoc({ path: 'forge/dreams/sessions/d.md', docType: 'forge' }),
      mkDoc({ path: 'forge/output/p.md', docType: 'forge' }),
    ]);
    const v2 = buildGraph(idx, { shape: 'v2' }, ORG);
    const dream = v2.nodes.find((n) => n.id === 'forge/dreams/sessions/d.md')!;
    const pipe = v2.nodes.find((n) => n.id === 'forge/output/p.md')!;
    expect(dream.type).toBe('dream');
    expect(dream.group).toBe('dream');
    expect(pipe.type).toBe('pipeline');
    expect(pipe.group).toBe('pipeline');
  });

  test('forge split: group stays raw docType when groupBy != type', () => {
    // group_by=project → forge/output/p.md is a leaf doc (no projects/ prefix).
    const idx = mkIndex([mkDoc({ path: 'forge/output/p.md', docType: 'forge' })]);
    const g = buildGraph(idx, { shape: 'v2', groupBy: 'project' }, ORG);
    const pipe = g.nodes.find((n) => n.id === 'forge/output/p.md')!;
    expect(pipe.type).toBe('pipeline'); // type always splits
    expect(pipe.group).toBe('forge'); // group split ONLY when groupBy=type
  });

  test('subtype: task→status, inbox→subfolder, others→none', () => {
    const idx = mkIndex([
      mkDoc({ path: 'tasks/t.md', docType: 'task', status: 'active' }),
      mkDoc({ path: 'inbox/decisions/z.md', docType: 'inbox' }),
      mkDoc({ path: 'knowledge/k.md', docType: 'knowledge', status: 'whatever' }),
      mkDoc({ path: 'tasks/nostatus.md', docType: 'task', status: null }),
    ]);
    const g = buildGraph(idx, { shape: 'v2' }, ORG);
    const byid = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byid['tasks/t.md'].subtype).toBe('active');
    expect(byid['inbox/decisions/z.md'].subtype).toBe('decisions');
    expect(byid['knowledge/k.md'].subtype).toBeUndefined();
    expect(byid['tasks/nostatus.md'].subtype).toBeUndefined(); // no status → no subtype
  });

  test('subtype key is last in node key order', () => {
    const idx = mkIndex([mkDoc({ path: 'tasks/t.md', docType: 'task', status: 'active', updated: '2026-06-01' })]);
    const n = buildGraph(idx, { shape: 'v2' }, ORG).nodes[0];
    expect(Object.keys(n)).toEqual(['id', 'label', 'kind', 'type', 'status', 'linkCount', 'folder', 'tags', 'group', 'updated', 'subtype']);
  });

  describe('v2 file-node minting (real tmp org)', () => {
    let tmp: string;
    test('setup + file node vs bare-stem-placeholder vs legacy zero-v2', () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-graph-'));
      fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'lib', 'thing.ts'), 'export const x = 1;\n');

      const idx = mkIndex(
        [mkDoc({ path: 'a.md', links: ['lib/thing.ts', 'thing.ts', 'lib/nope.ts'] })],
        () => ({ kind: 'missing' }),
      );

      // v2: lib/thing.ts (exists, .ts) → file node; thing.ts (bare stem) → placeholder;
      //     lib/nope.ts (missing on disk) → placeholder.
      const v2 = buildGraph(idx, { shape: 'v2' }, tmp);
      const file = v2.nodes.find((n) => n.kind === 'file');
      expect(file).toBeDefined();
      expect(Object.keys(file!)).toEqual(['id', 'label', 'kind', 'type', 'linkCount', 'folder', 'tags', 'group']);
      expect(file).toMatchObject({ id: 'lib/thing.ts', label: 'thing.ts', kind: 'file', type: 'file', linkCount: 1, folder: 'lib', tags: [], group: 'file' });
      const phIds = v2.nodes.filter((n) => n.kind === 'placeholder').map((n) => n.id).sort();
      expect(phIds).toEqual(['placeholder:lib/nope.ts', 'placeholder:thing.ts']);
      // file edge present
      expect(v2.links).toContainEqual({ source: 'a.md', target: 'lib/thing.ts' });

      // legacy (shape absent): ZERO v2 artifacts — lib/thing.ts becomes a placeholder,
      // no file node, no kind:'file'.
      const legacy = buildGraph(idx, {}, tmp);
      expect(legacy.nodes.some((n) => n.kind === 'file')).toBe(false);
      const legacyPh = legacy.nodes.filter((n) => n.kind === 'placeholder').map((n) => n.id).sort();
      expect(legacyPh).toEqual(['placeholder:lib/nope.ts', 'placeholder:lib/thing.ts', 'placeholder:thing.ts']);

      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  test('shape absent/legacy/garbage all produce identical zero-v2 output', () => {
    const idx = mkIndex([mkDoc({ path: 'tasks/t.md', docType: 'task', status: 'active' }), mkDoc({ path: 'forge/dreams/x.md', docType: 'forge' })]);
    const absent = buildGraph(idx, {}, ORG).nodes.sort(byId);
    const legacy = buildGraph(idx, { shape: 'legacy' }, ORG).nodes.sort(byId);
    const garbage = buildGraph(idx, { shape: 'xyzzy' }, ORG).nodes.sort(byId);
    expect(legacy).toEqual(absent);
    expect(garbage).toEqual(absent);
    // none carry subtype; forge type stays 'forge'
    expect(absent.every((n) => !('subtype' in n))).toBe(true);
    expect(absent.find((n) => n.id === 'forge/dreams/x.md')!.type).toBe('forge');
  });
});
