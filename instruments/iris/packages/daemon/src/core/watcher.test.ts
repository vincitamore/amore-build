import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { IndexedDoc } from '../contract';
import { classifyEvents, normalizeToRel, startWatcher } from './watcher';
import { buildIndex } from './index-build';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-watch-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = '# doc\n'): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}
function mkdir(rel: string): void {
  mkdirSync(join(root, rel), { recursive: true });
}
function mkDoc(path: string): IndexedDoc {
  return { path, title: path, docType: 'knowledge', status: null, created: null, updated: null, tags: [], links: [], backlinks: [] };
}

// ── normalizeToRel ─────────────────────────────────────────────────────────────

test('normalizeToRel: backslash relative → forward-slash org-relative', () => {
  // Windows fs.watch delivers relative backslash filenames (live-probed).
  expect(normalizeToRel('tasks\\foo.md', root)).toBe('tasks/foo.md');
  expect(normalizeToRel('knowledge\\deep\\b.md', root)).toBe('knowledge/deep/b.md');
});

test('normalizeToRel: absolute path under orgRoot → stripped to org-relative', () => {
  expect(normalizeToRel(join(root, 'tasks', 'foo.md'), root)).toBe('tasks/foo.md');
  expect(normalizeToRel(root, root)).toBe(''); // the org root itself
});

// ── classifyEvents (the pure decision core) ────────────────────────────────────
//
// THE ONE-ADMISSION-FILTER PIN: admitted-vs-dropped is decided ONLY by the walk's
// `shouldExclude`. The legacy watcher's separate `is_excluded` (a stale fork of
// `should_exclude`) let excluded events into the index; this build routes every
// event through the same filter the walk uses. The `.claude/worktrees` case below
// is that pin — an event under the ratified dot-prefix exclusion must be dropped.

test('PIN(one-admission-filter): .claude/worktrees/*.md write is dropped', () => {
  write('.claude/worktrees/x.md');
  const c = classifyEvents(['.claude/worktrees/x.md'], new Map(), root);
  expect(c).toEqual({ kind: 'noop' }); // dropped → nothing to apply
});

test('admitted .md file event → updated', () => {
  write('tasks/foo.md');
  expect(classifyEvents(['tasks/foo.md'], new Map(), root)).toEqual({
    kind: 'batch',
    changes: { updated: ['tasks/foo.md'], removed: [] },
  });
});

test('too-deep projects file → dropped; projects/<name>/README.md → updated', () => {
  write('projects/x/deep/file.md');
  write('projects/x/README.md');
  expect(classifyEvents(['projects/x/deep/file.md'], new Map(), root)).toEqual({ kind: 'noop' });
  expect(classifyEvents(['projects/x/README.md'], new Map(), root)).toEqual({
    kind: 'batch',
    changes: { updated: ['projects/x/README.md'], removed: [] },
  });
});

test('non-md file (sentinel.halt) → dropped', () => {
  write('instruments/example/sentinel.halt', 'halt');
  expect(classifyEvents(['instruments/example/sentinel.halt'], new Map(), root)).toEqual({ kind: 'noop' });
  write('tasks/notes.txt', 'x');
  expect(classifyEvents(['tasks/notes.txt'], new Map(), root)).toEqual({ kind: 'noop' });
});

test('deletion of a tracked doc → removed', () => {
  // file absent on disk, present in the index.
  const docs = new Map([['tasks/gone.md', mkDoc('tasks/gone.md')]]);
  expect(classifyEvents(['tasks/gone.md'], docs, root)).toEqual({
    kind: 'batch',
    changes: { updated: [], removed: ['tasks/gone.md'] },
  });
});

test('deletion of an unknown (untracked, absent) path → dropped', () => {
  expect(classifyEvents(['tasks/never-seen.md'], new Map(), root)).toEqual({ kind: 'noop' });
});

test('deletion of a dir holding tracked docs → reconcile', () => {
  // `archive/2020` is absent on disk but the index holds docs under it (a win32
  // dir rename can move many docs with no per-file events).
  const docs = new Map([['archive/2020/old.md', mkDoc('archive/2020/old.md')]]);
  expect(classifyEvents(['archive/2020'], docs, root)).toEqual({ kind: 'reconcile' });
});

test('admitted DIR event → reconcile; excluded DIR event → dropped', () => {
  mkdir('knowledge/newdir');
  expect(classifyEvents(['knowledge/newdir'], new Map(), root)).toEqual({ kind: 'reconcile' });
  mkdir('node_modules');
  expect(classifyEvents(['node_modules'], new Map(), root)).toEqual({ kind: 'noop' });
});

test('null filename → reconcile (unknown scope)', () => {
  expect(classifyEvents([null], new Map(), root)).toEqual({ kind: 'reconcile' });
  expect(classifyEvents(['tasks/foo.md', undefined], new Map(), root)).toEqual({ kind: 'reconcile' });
});

test('more than 200 distinct paths → reconcile (checkout storm)', () => {
  const many = Array.from({ length: 201 }, (_, i) => `knowledge/n${i}.md`);
  expect(classifyEvents(many, new Map(), root)).toEqual({ kind: 'reconcile' });
});

test('backslash normalization: tasks\\foo.md classifies as tasks/foo.md updated', () => {
  write('tasks/foo.md');
  expect(classifyEvents(['tasks\\foo.md'], new Map(), root)).toEqual({
    kind: 'batch',
    changes: { updated: ['tasks/foo.md'], removed: [] },
  });
});

test('create pair (rename+change on same path) dedupes to one updated', () => {
  write('tasks/foo.md');
  // fs.watch emits both events for a create; the debounce Set dedupes.
  expect(classifyEvents(['tasks/foo.md', 'tasks/foo.md'], new Map(), root)).toEqual({
    kind: 'batch',
    changes: { updated: ['tasks/foo.md'], removed: [] },
  });
});

test('an org-root-scoped event alone → noop (never reconciles on its own)', () => {
  expect(classifyEvents([''], new Map(), root)).toEqual({ kind: 'noop' });
});

// ── real watcher over a temp tree (integration; deterministic polling) ─────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(intervalMs);
  }
  return cond();
}

test('startWatcher: a real add reflects in the live index (create + backlink)', async () => {
  write('knowledge/target.md', '---\ntype: knowledge\n---\n\n# Target\n\nprose\n');
  const { index } = buildIndex(root);
  expect(index.docs.size).toBe(1);

  const prev = process.env.IRIS_WATCH_DEBOUNCE_MS;
  process.env.IRIS_WATCH_DEBOUNCE_MS = '50';
  const watcher = startWatcher(index, root);
  try {
    // Add a doc that links to the existing target.
    write('tasks/source.md', '---\ntype: task\n---\n\n# Source\n\nlinks to [[target]]\n');
    const added = await until(() => index.docs.has('tasks/source.md'));
    expect(added).toBe(true);
    // Backlink recomputed on the existing doc.
    const backlinked = await until(() => index.docs.get('knowledge/target.md')!.backlinks.includes('tasks/source.md'));
    expect(backlinked).toBe(true);
    expect(index.docs.get('tasks/source.md')!.links).toEqual(['target']);
    expect(index.resolve('target', 'tasks/source.md')).toEqual({ kind: 'resolved', path: 'knowledge/target.md' });

    // Delete reflects too.
    rmSync(join(root, 'tasks', 'source.md'));
    const removed = await until(() => !index.docs.has('tasks/source.md'));
    expect(removed).toBe(true);
    const unlinked = await until(() => index.docs.get('knowledge/target.md')!.backlinks.length === 0);
    expect(unlinked).toBe(true);
  } finally {
    watcher.stop();
    if (prev === undefined) delete process.env.IRIS_WATCH_DEBOUNCE_MS;
    else process.env.IRIS_WATCH_DEBOUNCE_MS = prev;
  }
});
