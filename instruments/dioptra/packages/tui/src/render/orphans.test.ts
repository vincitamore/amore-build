import { test, expect } from 'bun:test';
import { transientOrphans, isTransientPath, TRANSIENT_ORPHAN_PREFIXES, type OrphanGraph } from './orphans';

const node = (id: string) => ({ id });
const link = (source: string, target: string) => ({ source, target });

test('isTransientPath matches each of the five transient prefixes (forge/ covers the whole tree)', () => {
  expect(isTransientPath('archive/emails/x.md')).toBe(true);
  expect(isTransientPath('forge/dreams/sessions/d.manifest.md')).toBe(true);
  expect(isTransientPath('forge/handles/pipe/layer0-x.md')).toBe(true);
  expect(isTransientPath('forge/output/pipe/layer1.md')).toBe(true); // whole-forge widening 2026-07-02
  expect(isTransientPath('forge/proposals/p.md')).toBe(true);
  expect(isTransientPath('forge/sessions/run.manifest.md')).toBe(true);
  expect(isTransientPath('inbox/captures/note.md')).toBe(true);
  expect(isTransientPath('tasks/completed/done.md')).toBe(true);
  expect(isTransientPath('reminders/completed/r.md')).toBe(true);
  expect(TRANSIENT_ORPHAN_PREFIXES.length).toBe(5);
});

test('isTransientPath rejects paths outside the transient prefixes (incl. sibling paths)', () => {
  expect(isTransientPath('knowledge/architecture/x.md')).toBe(false);
  expect(isTransientPath('tasks/active-thing.md')).toBe(false); // tasks/ but not tasks/completed/
  expect(isTransientPath('forged/x.md')).toBe(false); // prefix boundary: 'forged' is NOT 'forge/'
  expect(isTransientPath('inbox/decisions/d.md')).toBe(false); // inbox/ but not captures
  expect(isTransientPath('reminders/pending.md')).toBe(false);
  expect(isTransientPath('archived/x.md')).toBe(false); // prefix boundary: 'archived' is NOT 'archive/'
});

test('a zero-link node under EACH transient prefix is hidden', () => {
  const nodes = TRANSIENT_ORPHAN_PREFIXES.map((p, i) => node(`${p}orphan-${i}.md`));
  const hidden = transientOrphans({ nodes, links: [] });
  expect(hidden.size).toBe(TRANSIENT_ORPHAN_PREFIXES.length);
  for (const n of nodes) expect(hidden.has(n.id)).toBe(true);
});

test('a LINKED doc under a transient prefix is NOT hidden — as the link TARGET', () => {
  const graph: OrphanGraph = {
    nodes: [node('archive/emails/kept.md'), node('knowledge/k.md')],
    links: [link('knowledge/k.md', 'archive/emails/kept.md')],
  };
  const hidden = transientOrphans(graph);
  expect(hidden.has('archive/emails/kept.md')).toBe(false);
  expect(hidden.size).toBe(0);
});

test('a LINKED doc under a transient prefix is NOT hidden — as the link SOURCE', () => {
  const graph: OrphanGraph = {
    nodes: [node('archive/emails/src.md'), node('knowledge/k.md')],
    links: [link('archive/emails/src.md', 'knowledge/k.md')],
  };
  expect(transientOrphans(graph).has('archive/emails/src.md')).toBe(false);
});

test('an orphan OUTSIDE the transient prefixes is NOT hidden (genuinely fix-worthy)', () => {
  const graph: OrphanGraph = {
    nodes: [node('knowledge/architecture/lonely.md'), node('tasks/active-orphan.md'), node('inbox/decisions/open-q.md')],
    links: [],
  };
  expect(transientOrphans(graph).size).toBe(0);
});

test('path-separator robustness — backslash ids match the same prefixes', () => {
  const graph: OrphanGraph = {
    nodes: [node('archive\\emails\\win.md'), node('tasks\\completed\\win.md'), node('knowledge\\k.md')],
    links: [],
  };
  const hidden = transientOrphans(graph);
  expect(hidden.has('archive\\emails\\win.md')).toBe(true);
  expect(hidden.has('tasks\\completed\\win.md')).toBe(true);
  expect(hidden.has('knowledge\\k.md')).toBe(false); // non-transient, backslash or not
  expect(isTransientPath('archive\\emails\\win.md')).toBe(true);
});

test('mixed real-graph shape: only transient orphans hidden; linked + non-transient survive', () => {
  const graph: OrphanGraph = {
    nodes: [
      node('archive/a.md'), // transient orphan → hidden
      node('forge/handles/p/h.md'), // transient orphan → hidden
      node('archive/linked.md'), // transient path but LINKED → kept
      node('knowledge/orphan.md'), // orphan but non-transient → kept
      node('knowledge/hub.md'), // linked → kept
    ],
    links: [link('knowledge/hub.md', 'archive/linked.md')],
  };
  const hidden = transientOrphans(graph);
  expect([...hidden].sort()).toEqual(['archive/a.md', 'forge/handles/p/h.md']);
});
