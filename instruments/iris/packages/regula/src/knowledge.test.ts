import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { createKnowledge, updateKnowledge } from './knowledge';
import { createTask } from './task';
import { today } from './util';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const fmOf = (rel: string) => matter(readFileSync(join(root, rel), 'utf-8')).data;

test('createKnowledge writes under knowledge/<folder>/ with stamps', () => {
  const r = createKnowledge(root, {
    title: 'My Note',
    content: 'body',
    folder: 'architecture/patterns',
    tags: ['x'],
  });
  expect(r.path).toBe('knowledge/architecture/patterns/my-note.md');
  const fm = fmOf(r.path);
  expect(fm.type).toBe('knowledge');
  expect(fm.created).toBe(today());
  expect(fm.updated).toBe(today());
  expect(fm.title).toBeUndefined(); // off-schema title field dropped — H1 is the title source
  expect(fm.tags).toEqual(['x']);
});

test('createKnowledge refuses a duplicate slug', () => {
  createKnowledge(root, { title: 'Dup', content: 'a' });
  expect(() => createKnowledge(root, { title: 'Dup', content: 'b' })).toThrow();
});

test('updateKnowledge appends, edits tags, restamps updated', () => {
  createKnowledge(root, { title: 'Note', content: 'orig', tags: ['a'] });
  updateKnowledge(root, 'knowledge/note.md', { append: 'more', addTags: ['b'], removeTags: ['a'] });
  const fm = fmOf('knowledge/note.md');
  expect(fm.tags).toEqual(['b']);
  const body = readFileSync(join(root, 'knowledge/note.md'), 'utf-8');
  expect(body).toContain('orig');
  expect(body).toContain('more');
});

test('updateKnowledge refuses a non-knowledge doc (climb over examen)', () => {
  createTask(root, {  title: 'A Task', allowThin: true });
  expect(() => updateKnowledge(root, 'tasks/a-task.md', { append: 'x' })).toThrow();
});
