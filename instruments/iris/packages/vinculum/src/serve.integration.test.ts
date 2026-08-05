// End-to-end: derive structural edges, then buildGraph serves them at shape=v2.
// Uses the same buildGraph path the daemon HTTP route uses (see packages/daemon graph tests).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIndex } from '../../daemon/src/core/index-build.ts';
import { buildGraph } from '../../daemon/src/graph/build.ts';
import { deriveAndReconcile } from './derive.ts';
import { listAddressedEdges, removeEdgeById } from './store.ts';

function seed(root: string, rel: string, body: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function plantHouse(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinculum-serve-'));
  writeFileSync(join(root, 'AGENTS.md'), '# house\n');
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'graph'), { recursive: true });

  seed(
    root,
    'tasks/blocker.md',
    `---\ntype: task\nstatus: active\ncreated: 2026-08-01\n---\n\n# Blocker task\n\nDoes the work that unblocks others.\n`,
  );
  seed(
    root,
    'tasks/blocked.md',
    `---\ntype: task\nstatus: blocked\ncreated: 2026-08-01\nblocked-by:\n  - "[[tasks/blocker]]"\n---\n\n# Blocked task\n\nWaiting on the blocker.\n`,
  );
  seed(
    root,
    'knowledge/base.md',
    `---\ntype: knowledge\ncreated: 2026-08-01\n---\n\n# Base pattern\n\nFoundation.\n`,
  );
  seed(
    root,
    'knowledge/app.md',
    `---\ntype: knowledge\ncreated: 2026-08-01\n---\n\n# Application\n\nRelated: [[knowledge/base]] (builds-on)\n`,
  );
  return root;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('derive → serve integration', () => {
  test('buildGraph(shape=v2, edges=semantic) returns structural typed edges', () => {
    const root = plantHouse();
    roots.push(root);

    const derived = deriveAndReconcile(root);
    expect(derived.derived).toBeGreaterThanOrEqual(2);
    expect(derived.byType['depends-on']).toBe(1);
    expect(derived.byType['builds-on']).toBe(1);

    const { index } = buildIndex(root);
    const g = buildGraph(index, { shape: 'v2', edges: 'semantic' }, root);

    const semantic = g.links.filter((l) => l.edgeKind === 'semantic');
    expect(semantic.length).toBeGreaterThanOrEqual(2);

    const dep = semantic.find(
      (l) => l.source === 'tasks/blocked.md' && l.target === 'tasks/blocker.md',
    );
    expect(dep).toBeDefined();
    expect(dep!.relation).toBe('depends-on');
    expect(dep!.tier).toBe('asserted');

    const builds = semantic.find(
      (l) => l.source === 'knowledge/app.md' && l.target === 'knowledge/base.md',
    );
    expect(builds).toBeDefined();
    expect(builds!.relation).toBe('builds-on');
    expect(builds!.tier).toBe('asserted');

    // shape=v2 still present (nodes non-empty, nodes carry v2 fields when applicable)
    expect(g.nodes.length).toBeGreaterThanOrEqual(4);
    expect(g.nodes.every((n) => typeof n.id === 'string')).toBe(true);
  });

  test('remove → re-derive → serve omits the suppressed edge', () => {
    const root = plantHouse();
    roots.push(root);

    deriveAndReconcile(root);
    const dep = listAddressedEdges(root, { type: 'depends-on' });
    expect(dep.count).toBe(1);
    const rm = removeEdgeById(root, dep.edges[0].id);
    expect(rm.ok).toBe(true);

    deriveAndReconcile(root);

    const { index } = buildIndex(root);
    const g = buildGraph(index, { shape: 'v2', edges: 'semantic' }, root);
    const semantic = g.links.filter((l) => l.edgeKind === 'semantic');

    const gone = semantic.find(
      (l) => l.source === 'tasks/blocked.md' && l.target === 'tasks/blocker.md',
    );
    expect(gone).toBeUndefined();

    const builds = semantic.find(
      (l) => l.source === 'knowledge/app.md' && l.target === 'knowledge/base.md',
    );
    expect(builds).toBeDefined();
    expect(builds!.relation).toBe('builds-on');
  });
});
