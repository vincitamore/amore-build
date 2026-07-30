import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import matter from 'gray-matter';
import { archiveInbox, captureInbox, listInbox, moveInbox, resolveInbox } from './inbox';
import { deleteDoc } from './doc';
import { today } from './util';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const fmOf = (rel: string) => matter(readFileSync(join(root, rel), 'utf-8')).data;

/** Seed an inbox item directly on disk. */
function seed(rel: string, fm: Record<string, unknown>, body = 'Item') {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, matter.stringify(`# ${body}\n`, fm));
}

test('captureInbox writes a timestamped file in inbox/captures with source=capture', () => {
  const r = captureInbox(root, {
    content: 'a thought',
    title: 'Quick One',
    nowIso: '2026-06-29T12:34:56.789Z',
  });
  expect(r.path).toBe('inbox/captures/2026-06-29T12-34-56-quick-one.md');
  const fm = fmOf(r.path);
  expect(fm.type).toBe('inbox');
  expect(fm.source).toBe('capture');
});

test('listInbox returns the OPEN queue and EXCLUDES resolved/ by default (the examen fix)', () => {
  seed('inbox/decisions/open-one.md', { type: 'inbox', created: '2026-06-20', status: 'open' });
  seed('inbox/decisions/resolved/done-one.md', { type: 'inbox', created: '2026-06-21', status: 'resolved' });

  const open = listInbox(root);
  expect(open.map((i) => i.path)).toEqual(['inbox/decisions/open-one.md']);

  const all = listInbox(root, { includeResolved: true });
  expect(all.map((i) => i.path).sort()).toEqual([
    'inbox/decisions/open-one.md',
    'inbox/decisions/resolved/done-one.md',
  ]);
});

test('resolveInbox flips status, stamps resolved + resolution, moves to resolved/', () => {
  seed('inbox/decisions/choose.md', { type: 'inbox', created: '2026-06-20', status: 'open' });
  const r = resolveInbox(root, 'inbox/decisions/choose.md', { resolution: 'landed in [[foo]]' });
  expect(r.to).toBe('resolved');
  expect(r.newPath).toBe('inbox/decisions/resolved/choose.md');
  expect(existsSync(join(root, 'inbox/decisions/choose.md'))).toBe(false);
  const fm = fmOf('inbox/decisions/resolved/choose.md');
  expect(fm.status).toBe('resolved');
  expect(fm.resolved).toBe(today());
  expect(fm.resolution).toBe('landed in [[foo]]');
});

test('resolveInbox refuses a non-lifecycled type (captures)', () => {
  seed('inbox/captures/note.md', { type: 'inbox', created: '2026-06-20' });
  expect(() => resolveInbox(root, 'inbox/captures/note.md')).toThrow();
});

test('moveInbox triages an item from one subtype folder to another', () => {
  seed('inbox/captures/idea-ish.md', { type: 'inbox', created: '2026-06-20' });
  const r = moveInbox(root, 'inbox/captures/idea-ish.md', 'ideas');
  expect(r.newPath).toBe('inbox/ideas/idea-ish.md');
  expect(existsSync(join(root, 'inbox/captures/idea-ish.md'))).toBe(false);
  expect(existsSync(join(root, 'inbox/ideas/idea-ish.md'))).toBe(true);
});

test('moveInbox rejects a non-inbox type and a non-inbox doc', () => {
  seed('inbox/captures/x.md', { type: 'inbox', created: '2026-06-20' });
  expect(() => moveInbox(root, 'inbox/captures/x.md', 'bogus' as never)).toThrow();
  seed('tasks/t.md', { type: 'task', created: '2026-06-20', status: 'active' });
  expect(() => moveInbox(root, 'tasks/t.md', 'ideas')).toThrow();
});

test('archiveInbox moves an item to archive/inbox/<type>/', () => {
  seed('inbox/investigations/old.md', { type: 'inbox', created: '2026-06-20' });
  const r = archiveInbox(root, 'inbox/investigations/old.md');
  expect(r.newPath).toBe('archive/inbox/investigations/old.md');
  expect(existsSync(join(root, 'inbox/investigations/old.md'))).toBe(false);
  expect(existsSync(join(root, 'archive/inbox/investigations/old.md'))).toBe(true);
});

test('resolveInbox re-resolve of an already-resolved item patches in place (no move, no throw)', () => {
  seed('inbox/decisions/redo.md', { type: 'inbox', created: '2026-06-20', status: 'open' });
  resolveInbox(root, 'inbox/decisions/redo.md', { resolution: 'first' });
  const r = resolveInbox(root, 'inbox/decisions/resolved/redo.md', { status: 'superseded', resolution: 'second' });
  expect(r.newPath).toBe('inbox/decisions/resolved/redo.md');
  const fm = fmOf('inbox/decisions/resolved/redo.md');
  expect(fm.status).toBe('superseded');
  expect(fm.resolution).toBe('second');
});

test('resolveInbox CONFLICT (target occupied) leaves the source untouched', () => {
  seed('inbox/decisions/dup.md', { type: 'inbox', created: '2026-06-20', status: 'open' });
  seed('inbox/decisions/resolved/dup.md', { type: 'inbox', created: '2026-06-01', status: 'resolved' });
  expect(() => resolveInbox(root, 'inbox/decisions/dup.md')).toThrow('Move target already exists');
  const fm = fmOf('inbox/decisions/dup.md');
  expect(fm.status).toBe('open'); // no status flip, no resolved stamp
  expect(fm.resolved).toBeUndefined();
});

test('deleteDoc removes a file and throws NOT_FOUND when absent', () => {
  seed('inbox/captures/trash.md', { type: 'inbox', created: '2026-06-20' });
  deleteDoc(root, 'inbox/captures/trash.md');
  expect(existsSync(join(root, 'inbox/captures/trash.md'))).toBe(false);
  expect(() => deleteDoc(root, 'inbox/captures/trash.md')).toThrow();
});
