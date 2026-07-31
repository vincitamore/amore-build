import { test, expect } from 'bun:test';
import type { IndexedDoc, LinkResolution } from '../contract';
import { isSchemeQualified, targetStem, normalizeRelative, resolveTarget } from './resolver';
import { buildLookupMaps } from './index-build';

function mkDoc(path: string, links: string[] = []): IndexedDoc {
  return { path, title: path, docType: 'knowledge', status: null, created: null, updated: null, tags: [], links, backlinks: [] };
}
function mapsFromPaths(paths: string[]) {
  const docs = new Map<string, IndexedDoc>();
  for (const p of paths) docs.set(p, mkDoc(p));
  return buildLookupMaps(docs);
}
const resolved = (p: string): LinkResolution => ({ kind: 'resolved', path: p });

// ── helper units (mirror the Rust unit tests) ─────────────────────────────────

test('isSchemeQualified', () => {
  expect(isSchemeQualified('skill://regula')).toBe(true);
  expect(isSchemeQualified('https://example.com/x')).toBe(true);
  expect(isSchemeQualified('mailto+x://y')).toBe(true);
  expect(isSchemeQualified('://leading')).toBe(false);
  expect(isSchemeQualified('tasks/foo')).toBe(false);
  expect(isSchemeQualified('../rel/path')).toBe(false);
  expect(isSchemeQualified('Skill://caps')).toBe(false); // scheme must be lowercase-led
});

test('targetStem strips only a trailing .md', () => {
  expect(targetStem('a/b/foo.md')).toBe('foo');
  expect(targetStem('foo')).toBe('foo');
  expect(targetStem('governance.ts')).toBe('governance.ts'); // NOT "governance"
  expect(targetStem('x/dream-2026.manifest')).toBe('dream-2026.manifest');
});

test('normalizeRelative in and out of root', () => {
  expect(normalizeRelative('tasks/completed', '../../knowledge/routeros/foo')).toBe('knowledge/routeros/foo');
  expect(normalizeRelative('knowledge', './bar')).toBe('knowledge/bar');
  expect(normalizeRelative('knowledge/architecture', '../../../outside/x')).toBeNull();
  expect(normalizeRelative('', '../outside/x')).toBeNull();
});

// ── the ladder ────────────────────────────────────────────────────────────────

test('step 5: scheme-qualified → skip', () => {
  const m = mapsFromPaths(['instruments/oraculum/README.md']);
  expect(resolveTarget('skill://oraculum', 'context/current-state.md', m)).toEqual({ kind: 'skip' });
  expect(resolveTarget('https://example.com/x', 'a.md', m)).toEqual({ kind: 'skip' });
});

test('step 0: empty after label/anchor strip → missing', () => {
  const m = mapsFromPaths(['tasks/foo.md']);
  expect(resolveTarget('   ', 'a.md', m)).toEqual({ kind: 'missing' });
  expect(resolveTarget('#only-anchor', 'a.md', m)).toEqual({ kind: 'missing' });
});

test('step 1/2: exact path resolves with and without .md; label + anchor stripped', () => {
  const p = 'knowledge/routeros/parser-bug.md';
  const m = mapsFromPaths([p]);
  expect(resolveTarget(p, 'a.md', m)).toEqual(resolved(p));
  expect(resolveTarget('knowledge/routeros/parser-bug', 'a.md', m)).toEqual(resolved(p));
  expect(resolveTarget('knowledge/routeros/parser-bug#heading', 'a.md', m)).toEqual(resolved(p));
});

test('step 1: bare stem that is a unique top-level file resolves', () => {
  const m = mapsFromPaths(['tasks/completed/fork-examen-mcp-for-house.md']);
  expect(resolveTarget('foo|Some Label', 'a.md', mapsFromPaths(['tasks/foo.md']))).toEqual(resolved('tasks/foo.md'));
  expect(resolveTarget('fork-examen-mcp-for-house', 'forge/handles/x.md', m)).toEqual(
    resolved('tasks/completed/fork-examen-mcp-for-house.md'),
  );
});

test('step 3: doc-relative path resolves; escaping the org root → skip', () => {
  const target = 'knowledge/routeros/parser-bug.md';
  const src = 'tasks/completed/net.md';
  const m = mapsFromPaths([target, src]);
  expect(resolveTarget('../../knowledge/routeros/parser-bug', src, m)).toEqual(resolved(target));
  expect(resolveTarget('../../../outside/knowledge/bar', 'knowledge/architecture/foo.md', m)).toEqual({ kind: 'skip' });
  expect(resolveTarget('../outside/bar', 'foo.md', m)).toEqual({ kind: 'skip' });
});

test('step 4: unique stem heals a moved file (org-root + doc-relative stale forms)', () => {
  const moved = 'tasks/completed/scaffold-stele-engine-v0.md';
  const m = mapsFromPaths([moved, 'inbox/decisions/resolved/stele-engine.md']);
  expect(resolveTarget('tasks/scaffold-stele-engine-v0', 'forge/x.md', m)).toEqual(resolved(moved));
  expect(
    resolveTarget('../../tasks/scaffold-stele-engine-v0.md', 'inbox/decisions/resolved/stele-engine.md', m),
  ).toEqual(resolved(moved));
});

test('step 4: ambiguous stem abstains → missing', () => {
  const m = mapsFromPaths(['knowledge/a/dup.md', 'knowledge/b/dup.md']);
  expect(resolveTarget('dup', 'forge/x.md', m)).toEqual({ kind: 'missing' });
});

test('step 4: non-.md target does not bind to a .md doc; the .md stem still resolves', () => {
  const m = mapsFromPaths(['knowledge/x/governance.md']);
  expect(resolveTarget('governance.ts', 'a.md', m)).toEqual({ kind: 'missing' });
  expect(resolveTarget('governance', 'a.md', m)).toEqual(resolved('knowledge/x/governance.md'));
});

test('step 4: readme/claude stems are excluded from the unique-stem heal', () => {
  const m = mapsFromPaths(['projects/foo/README.md']);
  // bare `readme` must NOT stem-heal to the project readme
  expect(resolveTarget('readme', 'a.md', m)).toEqual({ kind: 'missing' });
});

test('step 4b: bare project name resolves to its README (preferred over CLAUDE)', () => {
  const m = mapsFromPaths(['projects/taildown/README.md', 'projects/taildown/CLAUDE.md']);
  expect(resolveTarget('taildown', 'knowledge/x.md', m)).toEqual(resolved('projects/taildown/README.md'));
});
