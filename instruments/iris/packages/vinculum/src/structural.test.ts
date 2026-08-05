import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveAndReconcile } from './derive';
import { edgeKey, STRUCTURAL_ASSERTED_BY, type Edge } from './schema';
import { readStore, rewriteEdges } from './store';
import { deriveStructuralEdges } from './structural';

function seed(root: string, rel: string, body: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function house(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinculum-struct-'));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'inbox', 'decisions', 'resolved'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'graph'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# house\n');
  return root;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('derivers', () => {
  test('blocked-by → depends-on', () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'tasks/blocker.md',
      `---\ntype: task\nstatus: active\n---\n\n# Blocker\n\nDoes the work.\n`,
    );
    seed(
      root,
      'tasks/blocked.md',
      `---\ntype: task\nstatus: blocked\nblocked-by:\n  - "[[tasks/blocker]]"\n---\n\n# Blocked\n\nWaiting.\n`,
    );
    const edges = deriveStructuralEdges(root, '2026-08-05T12:00:00.000Z');
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe('depends-on');
    expect(edges[0].source).toBe('tasks/blocked.md');
    expect(edges[0].target).toBe('tasks/blocker.md');
    expect(edges[0].provenance.asserted_by).toBe(STRUCTURAL_ASSERTED_BY);
    expect(edges[0].provenance.field).toBe('blocked-by');
    expect(edges[0].evidence?.loc).toBe('tasks/blocked.md:blocked-by');
  });

  test('resolution wikilink → resolved-by', () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/landed.md',
      `---\ntype: knowledge\n---\n\n# Landed\n\nThe fix.\n`,
    );
    seed(
      root,
      'inbox/decisions/resolved/choose.md',
      `---\ntype: inbox\nstatus: resolved\nresolution: "Landed in [[knowledge/landed]]"\n---\n\n# Choose\n\nDone.\n`,
    );
    const edges = deriveStructuralEdges(root, '2026-08-05T12:00:00.000Z');
    const rb = edges.filter((e) => e.type === 'resolved-by');
    expect(rb).toHaveLength(1);
    expect(rb[0].source).toBe('inbox/decisions/resolved/choose.md');
    expect(rb[0].target).toBe('knowledge/landed.md');
  });

  test('self-label [[target]] (type) in body', () => {
    const root = house();
    roots.push(root);
    seed(root, 'knowledge/base.md', `---\ntype: knowledge\n---\n\n# Base\n\nFoundation.\n`);
    seed(
      root,
      'knowledge/app.md',
      `---\ntype: knowledge\n---\n\n# App\n\nRelated: [[knowledge/base]] (builds-on)\n`,
    );
    const edges = deriveStructuralEdges(root, '2026-08-05T12:00:00.000Z');
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe('builds-on');
    expect(edges[0].source).toBe('knowledge/app.md');
    expect(edges[0].target).toBe('knowledge/base.md');
    expect(edges[0].provenance.signal).toBe('prose-marker');
  });

  test('supersedes and superseded-by frontmatter', () => {
    const root = house();
    roots.push(root);
    seed(root, 'knowledge/old.md', `---\ntype: knowledge\n---\n\n# Old\n`);
    seed(
      root,
      'knowledge/new.md',
      `---\ntype: knowledge\nsupersedes:\n  - "[[knowledge/old]]"\n---\n\n# New\n`,
    );
    seed(
      root,
      'knowledge/retired.md',
      `---\ntype: knowledge\nsuperseded-by: "[[knowledge/new]]"\n---\n\n# Retired\n`,
    );
    const edges = deriveStructuralEdges(root, '2026-08-05T12:00:00.000Z');
    const ss = edges.filter((e) => e.type === 'supersedes');
    // new→old from supersedes field; new→retired from superseded-by on retired
    expect(ss.some((e) => e.source === 'knowledge/new.md' && e.target === 'knowledge/old.md')).toBe(true);
    expect(ss.some((e) => e.source === 'knowledge/new.md' && e.target === 'knowledge/retired.md')).toBe(
      true,
    );
  });
});

describe('idempotence / reconcile', () => {
  test('second derive is a no-op on counts; vanishing fact drops structural edge', () => {
    const root = house();
    roots.push(root);
    seed(root, 'tasks/blocker.md', `---\ntype: task\nstatus: active\n---\n\n# Blocker\n`);
    seed(
      root,
      'tasks/blocked.md',
      `---\ntype: task\nstatus: blocked\nblocked-by:\n  - "[[tasks/blocker]]"\n---\n\n# Blocked\n`,
    );
    const r1 = deriveAndReconcile(root);
    expect(r1.derived).toBe(1);
    expect(r1.added).toBe(1);
    const r2 = deriveAndReconcile(root);
    expect(r2.derived).toBe(1);
    expect(r2.added).toBe(0);
    expect(r2.removed).toBe(0);

    // remove the fact
    seed(
      root,
      'tasks/blocked.md',
      `---\ntype: task\nstatus: active\nblocked-by: []\n---\n\n# Unblocked\n`,
    );
    const r3 = deriveAndReconcile(root);
    expect(r3.derived).toBe(0);
    expect(r3.removed).toBe(1);
    expect(readStore(root).edges).toHaveLength(0);
  });

  test('never touches non-structural provenance edges', () => {
    const root = house();
    roots.push(root);
    seed(root, 'knowledge/a.md', `---\ntype: knowledge\n---\n\n# A\n`);
    seed(root, 'knowledge/b.md', `---\ntype: knowledge\n---\n\n# B\n`);
    const manual: Edge = {
      source: 'knowledge/a.md',
      target: 'knowledge/b.md',
      type: 'refines',
      directed: true,
      confidence: 'asserted',
      payload: null,
      evidence: { quote: 'hand', loc: 'knowledge/a.md:1' },
      provenance: {
        signal: 'manual',
        asserted_by: 'operator',
        ts: '2026-08-05T12:00:00.000Z',
      },
      verify_key: { src_hash: 'sha256:a', tgt_hash: 'sha256:b', quote_anchor: 'hand' },
      refines_wikilink: false,
    };
    rewriteEdges(root, [manual]);

    seed(
      root,
      'knowledge/c.md',
      `---\ntype: knowledge\n---\n\n# C\n\nSee [[knowledge/a]] (builds-on)\n`,
    );
    const r = deriveAndReconcile(root);
    expect(r.preserved).toBe(1);
    expect(r.derived).toBe(1);
    const { edges } = readStore(root);
    expect(edges).toHaveLength(2);
    expect(edges.some((e) => e.provenance.asserted_by === 'operator')).toBe(true);
    expect(edges.some((e) => e.type === 'builds-on')).toBe(true);
    // re-derive still keeps manual
    deriveAndReconcile(root);
    expect(readStore(root).edges.some((e) => edgeKey(e) === edgeKey(manual))).toBe(true);
  });
});
