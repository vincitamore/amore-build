import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTask, completeTask, setTaskStatus, listTasks, getTask } from './task';
import { createKnowledge, listKnowledge, getKnowledge } from './knowledge';
import { createReminder, completeReminder, listReminders, getReminder } from './reminder';
import { captureInbox, getInbox } from './inbox';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('listTasks spans folders; status filter narrows to one folder', () => {
  createTask(root, {  title: 'Alpha', allowThin: true });
  createTask(root, {  title: 'Beta', allowThin: true });
  completeTask(root, 'beta');
  expect(listTasks(root).map((t) => t.title).sort()).toEqual(['Alpha', 'Beta']);
  expect(listTasks(root, { status: 'complete' }).map((t) => t.title)).toEqual(['Beta']);
  expect(listTasks(root, { status: 'active' }).map((t) => t.title)).toEqual(['Alpha']);
});

test('listTasks --status distinguishes active from blocked in the shared tasks/ root', () => {
  createTask(root, {  title: 'Active One', allowThin: true });
  createTask(root, {  title: 'Blocked One', allowThin: true });
  setTaskStatus(root, 'blocked-one', 'blocked'); // stays in tasks/ root
  expect(listTasks(root, { status: 'active' }).map((t) => t.title)).toEqual(['Active One']);
  expect(listTasks(root, { status: 'blocked' }).map((t) => t.title)).toEqual(['Blocked One']);
});

test('getTask returns path + title + frontmatter + body', () => {
  createTask(root, {  title: 'Read Me', description: 'the body', allowThin: true });
  const d = getTask(root, 'read-me');
  expect(d.path).toBe('tasks/read-me.md');
  expect(d.title).toBe('Read Me');
  expect(d.frontmatter.status).toBe('active');
  expect(d.content).toContain('the body');
});

test('listKnowledge recurses subfolders; getKnowledge reads one', () => {
  createKnowledge(root, { title: 'Note A', content: 'x', folder: 'arch', tags: ['t'] });
  createKnowledge(root, { title: 'Note B', content: 'y', tags: ['t'] });
  expect(listKnowledge(root).map((k) => k.title).sort()).toEqual(['Note A', 'Note B']);
  expect(getKnowledge(root, 'knowledge/arch/note-a.md').title).toBe('Note A');
});

test('listReminders spans active + completed; status filter narrows', () => {
  createReminder(root, { title: 'R1', remindAt: 'x' });
  createReminder(root, { title: 'R2', remindAt: 'x' });
  completeReminder(root, 'r2');
  expect(listReminders(root).map((r) => r.title).sort()).toEqual(['R1', 'R2']);
  expect(listReminders(root, { status: 'pending' }).map((r) => r.title)).toEqual(['R1']);
});

test('getReminder resolves by slug or path and returns frontmatter + body', () => {
  createReminder(root, { title: 'Read Me Too', remindAt: '2026-07-01T09:00', description: 'the body' });
  const bySlug = getReminder(root, 'read-me-too');
  expect(bySlug.path).toBe('reminders/read-me-too.md');
  expect(bySlug.title).toBe('Read Me Too');
  expect(bySlug.frontmatter['remind-at']).toBe('2026-07-01T09:00');
  expect(bySlug.content).toContain('the body');
  expect(getReminder(root, 'reminders/read-me-too.md').path).toBe('reminders/read-me-too.md');
});

test('getInbox reads by org-relative path and rejects a non-inbox doc', () => {
  const r = captureInbox(root, { content: 'a thought', title: 'Quick One' });
  const d = getInbox(root, r.path);
  expect(d.type).toBe('captures');
  expect(d.title).toBe('Quick One');
  expect(d.content).toContain('a thought');
  createTask(root, {  title: 'Not Inbox', allowThin: true });
  expect(() => getInbox(root, 'tasks/not-inbox.md')).toThrow();
});
