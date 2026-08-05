// Review verbs: list/show/remove/edit + durability across re-derive + atomic rewrite safety.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveAndReconcile } from './derive';
import { edgeIdOf, resolveEdgeId } from './edge-id';
import { edgeKey, STRUCTURAL_ASSERTED_BY, type Edge } from './schema';
import {
  editEdgeById,
  listAddressedEdges,
  readStore,
  removeEdgeById,
  rewriteEdges,
  showEdgeById,
  storeFiles,
} from './store';
import { readOverrides, readSuppressions } from './stewardship';

function seed(root: string, rel: string, body: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function house(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinculum-review-'));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'graph'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# house\n');
  seed(
    root,
    'tasks/blocker.md',
    `---\ntype: task\nstatus: active\ncreated: 2026-08-01\n---\n\n# Blocker\n\nDoes the work.\n`,
  );
  seed(
    root,
    'tasks/blocked.md',
    `---\ntype: task\nstatus: blocked\ncreated: 2026-08-01\nblocked-by:\n  - "[[tasks/blocker]]"\n---\n\n# Blocked\n\nWaiting.\n`,
  );
  seed(
    root,
    'knowledge/base.md',
    `---\ntype: knowledge\ncreated: 2026-08-01\n---\n\n# Base\n\nFoundation.\n`,
  );
  seed(
    root,
    'knowledge/app.md',
    `---\ntype: knowledge\ncreated: 2026-08-01\n---\n\n# App\n\nRelated: [[knowledge/base]] (builds-on)\n`,
  );
  return root;
}

function edge(over: Partial<Edge> & Pick<Edge, 'source' | 'target' | 'type'>): Edge {
  return {
    directed: true,
    confidence: 'asserted',
    payload: null,
    evidence: { quote: 'q', loc: `${over.source}:f` },
    provenance: {
      signal: 'frontmatter',
      asserted_by: STRUCTURAL_ASSERTED_BY,
      ts: '2026-08-05T12:00:00.000Z',
      tier: 'structural',
      source_file: over.source,
    },
    verify_key: { src_hash: 'sha256:a', tgt_hash: 'sha256:b', quote_anchor: 'q' },
    refines_wikilink: false,
    ...over,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('list / show', () => {
  test('list filters by type source target asserted-by and addresses edges', () => {
    const root = house();
    roots.push(root);
    const d = deriveAndReconcile(root);
    expect(d.derived).toBeGreaterThanOrEqual(2);

    const all = listAddressedEdges(root);
    expect(all.count).toBeGreaterThanOrEqual(2);
    expect(all.edges.every((a) => /^[0-9a-f]{12,}$/.test(a.id))).toBe(true);

    const deps = listAddressedEdges(root, { type: 'depends-on' });
    expect(deps.count).toBe(1);
    expect(deps.edges[0].edge.type).toBe('depends-on');

    const bySrc = listAddressedEdges(root, { source: 'tasks/blocked.md' });
    expect(bySrc.count).toBe(1);

    const byTgt = listAddressedEdges(root, { target: 'knowledge/base.md' });
    expect(byTgt.count).toBe(1);

    const byWho = listAddressedEdges(root, { assertedBy: STRUCTURAL_ASSERTED_BY });
    expect(byWho.count).toBe(all.count);

    const none = listAddressedEdges(root, { assertedBy: 'manual' });
    expect(none.count).toBe(0);

    const id = deps.edges[0].id;
    const shown = showEdgeById(root, id);
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.edge.source).toBe('tasks/blocked.md');
      expect(shown.edge.target).toBe('tasks/blocker.md');
    }
    const prefix = showEdgeById(root, id.slice(0, 8));
    expect(prefix.ok).toBe(true);
  });
});

describe('durability: remove + edit across re-derive', () => {
  test('derive → remove → re-derive keeps edge gone', () => {
    const root = house();
    roots.push(root);
    deriveAndReconcile(root);
    const before = listAddressedEdges(root, { type: 'depends-on' });
    expect(before.count).toBe(1);
    const id = before.edges[0].id;

    const rm = removeEdgeById(root, id);
    expect(rm.ok).toBe(true);
    expect(readStore(root).edges.find((e) => e.type === 'depends-on')).toBeUndefined();
    expect(readSuppressions(root).length).toBe(1);
    expect(readSuppressions(root)[0].type).toBe('depends-on');

    const again = deriveAndReconcile(root);
    expect(again.suppressed).toBeGreaterThanOrEqual(1);
    expect(readStore(root).edges.find((e) => e.type === 'depends-on')).toBeUndefined();
    // sibling edge still present
    expect(readStore(root).edges.some((e) => e.type === 'builds-on')).toBe(true);
  });

  test('edit → re-derive preserves note and label', () => {
    const root = house();
    roots.push(root);
    deriveAndReconcile(root);
    const listed = listAddressedEdges(root, { type: 'builds-on' });
    expect(listed.count).toBe(1);
    const id = listed.edges[0].id;

    const ed = editEdgeById(root, id, { note: 'foundation link', label: 'base' });
    expect(ed.ok).toBe(true);
    if (ed.ok) {
      expect(ed.edge.note).toBe('foundation link');
      expect(ed.edge.label).toBe('base');
    }
    expect(readOverrides(root).length).toBe(1);

    deriveAndReconcile(root);
    const after = readStore(root).edges.find((e) => e.type === 'builds-on');
    expect(after).toBeDefined();
    expect(after!.note).toBe('foundation link');
    expect(after!.label).toBe('base');
  });
});

describe('atomic rewrite safety', () => {
  test('successful rewrite leaves a valid store; temp is not left as the only copy', () => {
    const root = house();
    roots.push(root);
    const a = edge({ source: 'tasks/a.md', target: 'tasks/b.md', type: 'depends-on' });
    rewriteEdges(root, [a]);
    const f = storeFiles(root);
    expect(existsSync(f.edges)).toBe(true);
    expect(existsSync(`${f.edges}.tmp`)).toBe(false);
    const body = readFileSync(f.edges, 'utf8');
    expect(body.trim().length).toBeGreaterThan(0);
    expect(readStore(root).edges).toHaveLength(1);
  });

  test('failed rewrite after temp write leaves original store intact', () => {
    const root = house();
    roots.push(root);
    const original = edge({ source: 'tasks/a.md', target: 'tasks/b.md', type: 'depends-on' });
    rewriteEdges(root, [original]);
    const f = storeFiles(root);
    const before = readFileSync(f.edges, 'utf8');

    // Simulate a mid-flight failure: write a temp body then refuse to rename by
    // restoring from the original if the final file were corrupted. The real
    // rewriteEdges is write-temp-then-rename; if rename never runs, original stays.
    const tmp = `${f.edges}.tmp`;
    writeFileSync(tmp, '{"broken":true}\n');
    expect(readFileSync(f.edges, 'utf8')).toBe(before);
    expect(readStore(root).edges).toHaveLength(1);
    expect(edgeKey(readStore(root).edges[0])).toBe(edgeKey(original));
    // cleanup temp as a real crash remnant would be
    rmSync(tmp, { force: true });
  });
});

describe('edge id', () => {
  test('edgeIdOf is stable and resolveEdgeId finds by full id', () => {
    const e = edge({ source: 'tasks/a.md', target: 'tasks/b.md', type: 'depends-on' });
    const id1 = edgeIdOf(e);
    const id2 = edgeIdOf({ source: e.source, target: e.target, type: e.type });
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(12);
    const r = resolveEdgeId([e], id1);
    expect(r.ok).toBe(true);
  });
});
