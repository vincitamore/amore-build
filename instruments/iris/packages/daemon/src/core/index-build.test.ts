import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { IndexedDoc, LinkResolution, OrgIndex } from '../contract';
import { applyChanges, buildIndex, buildLookupMaps, computeBacklinks, reconcile } from './index-build';
import { resolveTarget } from './resolver';

function mkDoc(path: string, links: string[] = []): IndexedDoc {
  return { path, title: path, docType: 'knowledge', status: null, created: null, updated: null, tags: [], links, backlinks: [] };
}
function indexOf(docs: IndexedDoc[]): Map<string, IndexedDoc> {
  const m = new Map<string, IndexedDoc>();
  for (const d of docs) m.set(d.path, d);
  const maps = buildLookupMaps(m);
  const resolve = (t: string, src: string): LinkResolution => resolveTarget(t, src, maps);
  computeBacklinks(m, resolve);
  return m;
}

// ── lookup maps ───────────────────────────────────────────────────────────────

test('buildLookupMaps: pathMap has full + no-ext keys; projectMap prefers README', () => {
  const m = new Map<string, IndexedDoc>([
    ['knowledge/A/Foo.md', mkDoc('knowledge/A/Foo.md')],
    ['projects/bar/CLAUDE.md', mkDoc('projects/bar/CLAUDE.md')],
    ['projects/bar/README.md', mkDoc('projects/bar/README.md')],
  ]);
  const { pathMap, stemMap, projectMap } = buildLookupMaps(m);
  expect(pathMap.get('knowledge/a/foo.md')).toBe('knowledge/A/Foo.md');
  expect(pathMap.get('knowledge/a/foo')).toBe('knowledge/A/Foo.md');
  expect(stemMap.get('foo')).toEqual(['knowledge/A/Foo.md']);
  // README/CLAUDE excluded from the stem heal
  expect(stemMap.has('readme')).toBe(false);
  expect(stemMap.has('claude')).toBe(false);
  expect(projectMap.get('bar')).toBe('projects/bar/README.md');
});

// ── backlink accumulation (mirrors Rust rebuild_backlinks tests) ──────────────

test('backlinks use the unified resolver; sorted + deduped; no self-backlink', () => {
  const target = 'knowledge/routeros/parser-bug.md';
  const m = indexOf([
    mkDoc(target),
    mkDoc('tasks/completed/net.md', ['../../knowledge/routeros/parser-bug']), // doc-relative
    mkDoc('forge/h.md', ['knowledge/old/parser-bug']), // stale org-root path, unique stem → heals
    mkDoc('context/state.md', ['skill://oraculum']), // scheme → no backlink
  ]);
  const bl = m.get(target)!.backlinks;
  expect(bl).toEqual(['forge/h.md', 'tasks/completed/net.md']); // sorted, 2 entries
});

test('backlinks: one source linking a target twice contributes a single backlink', () => {
  const target = 'knowledge/x/foo.md';
  const m = indexOf([
    mkDoc(target),
    mkDoc('tasks/a.md', ['foo', 'knowledge/x/foo.md', 'knowledge/x/foo']), // 3 links → 1 target
  ]);
  expect(m.get(target)!.backlinks).toEqual(['tasks/a.md']);
});

test('ambiguous stem produces no backlink', () => {
  const m = indexOf([
    mkDoc('knowledge/a/dup.md'),
    mkDoc('knowledge/b/dup.md'),
    mkDoc('forge/ref.md', ['dup']),
  ]);
  expect(m.get('knowledge/a/dup.md')!.backlinks).toEqual([]);
  expect(m.get('knowledge/b/dup.md')!.backlinks).toEqual([]);
});

// ── buildIndex integration ────────────────────────────────────────────────────

test('buildIndex cold-builds from disk: docs, maps, backlinks, stats', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-'));
  try {
    const write = (rel: string, content: string): void => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
    };
    write('knowledge/target.md', '---\ntype: knowledge\n---\n\n# Target\n\nprose\n');
    write('tasks/source.md', '---\ntype: task\nstatus: active\n---\n\n# Source\n\nlinks to [[target]] here\n');
    write('node_modules/pkg/x.md', '# ignored\n');

    const { index, stats } = buildIndex(root);

    expect(stats.files).toBe(2); // node_modules pruned
    expect(stats.parsed).toBe(2);
    expect(stats.parseFailures).toBe(0);
    expect(index.docs.size).toBe(2);
    expect(index.docs.get('tasks/source.md')!.links).toEqual(['target']);
    expect(index.docs.get('knowledge/target.md')!.backlinks).toEqual(['tasks/source.md']);
    expect(index.resolve('target', 'tasks/source.md')).toEqual({ kind: 'resolved', path: 'knowledge/target.md' });
    expect(index.resolve('skill://x', 'tasks/source.md')).toEqual({ kind: 'skip' });
    expect(index.resolve('nonexistent', 'tasks/source.md')).toEqual({ kind: 'missing' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── applyChanges: cold-build equivalence (the mechanical post-condition gate) ────

/** Sorted [key, value] entries — order-insensitive Map comparison. */
function sortedEntries<V>(m: Map<string, V>): Array<[string, V]> {
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
/** stemMap normalized: keys sorted, each value array sorted — array ORDER within a
 *  stem bucket is not observable through resolve (only length-1 uniqueness is), so
 *  the observable post-condition compares bucket CONTENTS, not their order. */
function stemMapNormalized(m: Map<string, string[]>): Array<[string, string[]]> {
  return sortedEntries(m).map(([k, v]) => [k, [...v].sort()] as [string, string[]]);
}
/** Assert `a` observably deep-equals a cold-built `b`: docs (all fields incl.
 *  backlinks), all three maps, and resolve() over a probe set. */
function assertObservablyEqual(a: OrgIndex, b: OrgIndex, probes: Array<[string, string]>): void {
  expect(sortedEntries(a.docs)).toEqual(sortedEntries(b.docs));
  expect(sortedEntries(a.pathMap)).toEqual(sortedEntries(b.pathMap));
  expect(stemMapNormalized(a.stemMap)).toEqual(stemMapNormalized(b.stemMap));
  expect(sortedEntries(a.projectMap)).toEqual(sortedEntries(b.projectMap));
  for (const [t, s] of probes) expect(a.resolve(t, s)).toEqual(b.resolve(t, s));
}

test('applyChanges: index observably deep-equals a cold buildIndex after add/edit/delete', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-apply-'));
  try {
    const write = (rel: string, content: string): void => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
    };

    // Cold fixture: `shared` resolves uniquely; `gamma` is missing; `proj` resolves
    // via projectMap; README backlinks alpha.
    write('CLAUDE.md', '# Org\n');
    write('tasks/alpha.md', '---\ntype: task\n---\n# Alpha\n\nlinks [[shared]]\n');
    write('knowledge/shared.md', '---\ntype: knowledge\n---\n# Shared\n\nprose one\n');
    write('knowledge/beta.md', '---\ntype: knowledge\n---\n# Beta\n\nlinks [[gamma]]\n');
    write('knowledge/delta.md', '---\ntype: knowledge\n---\n# Delta\n\nlinks [[proj]]\n');
    write('projects/proj/README.md', '---\ntype: project\n---\n# Proj\n\nlinks [[alpha]]\n');

    const { index } = buildIndex(root);
    // Cold sanity: the pre-mutation state we will move away from.
    expect(index.docs.get('knowledge/shared.md')!.backlinks).toEqual(['tasks/alpha.md']);
    expect(index.docs.get('knowledge/beta.md')!.backlinks).toEqual([]);
    expect(index.resolve('gamma', 'knowledge/beta.md')).toEqual({ kind: 'missing' });
    expect(index.docs.get('projects/proj/README.md')!.backlinks).toEqual(['knowledge/delta.md']);

    // Mutate disk: add makes `shared` AMBIGUOUS; add HEALS `gamma`; edit adds a
    // second `gamma` source; delete removes the projectMap entry + alpha's backlink.
    write('tasks/shared.md', '---\ntype: task\n---\n# Task Shared\n\nprose two\n');
    write('knowledge/gamma.md', '---\ntype: knowledge\n---\n# Gamma\n\nprose three\n');
    write('tasks/alpha.md', '---\ntype: task\n---\n# Alpha\n\nlinks [[shared]] and [[gamma]]\n');
    rmSync(join(root, 'projects/proj/README.md'));

    const stats = applyChanges(index, root, {
      updated: ['tasks/shared.md', 'knowledge/gamma.md', 'tasks/alpha.md'],
      removed: ['projects/proj/README.md'],
    });
    expect(stats.updated).toBe(3);
    expect(stats.removed).toBe(1);
    expect(stats.parseFailures).toBe(0);
    expect(typeof stats.ms).toBe('number');

    // The gate: deep-equal to a fresh cold build of the mutated tree.
    const { index: fresh } = buildIndex(root);
    assertObservablyEqual(index, fresh, [
      ['shared', 'tasks/alpha.md'], // ambiguous now → missing
      ['gamma', 'knowledge/beta.md'], // healed → resolved
      ['gamma', 'tasks/alpha.md'], // healed, second source
      ['proj', 'knowledge/delta.md'], // projectMap entry gone → missing
      ['alpha', 'projects/proj/README.md'], // pure over maps (source deleted)
      ['shared', 'knowledge/beta.md'],
    ]);

    // Observable outcomes themselves (ambiguity + healing + removal).
    expect(index.resolve('shared', 'tasks/alpha.md')).toEqual({ kind: 'missing' });
    expect(index.resolve('gamma', 'knowledge/beta.md')).toEqual({ kind: 'resolved', path: 'knowledge/gamma.md' });
    expect(index.resolve('proj', 'knowledge/delta.md')).toEqual({ kind: 'missing' });
    expect(index.docs.get('knowledge/gamma.md')!.backlinks).toEqual(['knowledge/beta.md', 'tasks/alpha.md']);
    expect(index.docs.get('knowledge/shared.md')!.backlinks).toEqual([]); // ambiguity broke it
    expect(index.docs.get('tasks/alpha.md')!.backlinks).toEqual([]); // README gone
    expect(index.docs.has('projects/proj/README.md')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyChanges: a parse-failure update DROPS the doc (cold-build parity)', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-apply-fail-'));
  try {
    const abs = (rel: string): string => join(root, rel);
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    writeFileSync(abs('knowledge/a.md'), '# A\n', 'utf-8');
    const { index } = buildIndex(root);
    expect(index.docs.has('knowledge/a.md')).toBe(true);

    // File vanishes but the change is delivered as an `updated` (a create/edit event
    // whose file is unreadable by parse time) → parseDoc returns null → dropped.
    rmSync(abs('knowledge/a.md'));
    const stats = applyChanges(index, root, { updated: ['knowledge/a.md'], removed: [] });
    expect(stats.parseFailures).toBe(1);
    expect(stats.updated).toBe(0);
    expect(index.docs.has('knowledge/a.md')).toBe(false);
    // Matches a cold build of the now-empty tree.
    const { index: fresh } = buildIndex(root);
    expect([...index.docs.keys()]).toEqual([...fresh.docs.keys()]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcile: self-heals arbitrary on-disk drift through the applyChanges path', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-reconcile-'));
  try {
    const write = (rel: string, content: string): void => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
    };
    write('CLAUDE.md', '# Org\n');
    write('knowledge/keep.md', '---\ntype: knowledge\n---\n# Keep\n\nlinks [[added]]\n');
    write('knowledge/vanishing.md', '---\ntype: knowledge\n---\n# Vanishing\n');

    const { index } = buildIndex(root);
    expect(index.docs.has('knowledge/vanishing.md')).toBe(true);
    expect(index.resolve('added', 'knowledge/keep.md')).toEqual({ kind: 'missing' });

    // Drift the disk with NO changeset handed to the index.
    rmSync(join(root, 'knowledge/vanishing.md'));
    write('knowledge/added.md', '---\ntype: knowledge\n---\n# Added\n');

    const stats = reconcile(index, root);
    expect(stats.removed).toBe(1); // vanishing
    expect(stats.updated).toBeGreaterThanOrEqual(1); // added (+ re-parsed survivors)

    const { index: fresh } = buildIndex(root);
    assertObservablyEqual(index, fresh, [
      ['added', 'knowledge/keep.md'],
      ['vanishing', 'knowledge/keep.md'],
    ]);
    expect(index.docs.has('knowledge/vanishing.md')).toBe(false);
    expect(index.docs.get('knowledge/added.md')!.backlinks).toEqual(['knowledge/keep.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
