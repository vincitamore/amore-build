import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import {
  createReminder,
  completeReminder,
  snoozeReminder,
  updateReminder,
  setReminderStatus,
} from './reminder';
import { today } from './util';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const fmOf = (rel: string) => matter(readFileSync(join(root, rel), 'utf-8')).data;

test('createReminder: one-shot is pending, repeating is ongoing', () => {
  const a = createReminder(root, { title: 'Once', remindAt: '2026-07-01T09:00' });
  expect(a.status).toBe('pending');
  const b = createReminder(root, {
    title: 'Weekly Thing',
    remindAt: '2026-07-01T09:00',
    repeat: 'weekly',
  });
  expect(b.status).toBe('ongoing');
  expect(fmOf('reminders/once.md')['remind-at']).toBe('2026-07-01T09:00');
});

test('completeReminder moves to reminders/completed/ and stamps the date', () => {
  createReminder(root, { title: 'Do It', remindAt: 'x' });
  const r = completeReminder(root, 'do-it');
  expect(r.newPath).toBe('reminders/completed/do-it.md');
  expect(existsSync(join(root, 'reminders/do-it.md'))).toBe(false);
  expect(fmOf('reminders/completed/do-it.md').completed).toBe(today());
});

test('snoozeReminder sets snoozed-until and stays in reminders/', () => {
  createReminder(root, { title: 'Later', remindAt: 'x' });
  const r = snoozeReminder(root, 'later', '2026-07-05T09:00');
  expect(r.moved).toBe(false);
  expect(r.newPath).toBe('reminders/later.md');
  expect(fmOf('reminders/later.md')['snoozed-until']).toBe('2026-07-05T09:00');
});

test('un-completing a reminder clears the date and moves it back', () => {
  createReminder(root, { title: 'Reopen R', remindAt: 'x' });
  completeReminder(root, 'reopen-r');
  const r = setReminderStatus(root, 'reopen-r', 'pending');
  expect(r.newPath).toBe('reminders/reopen-r.md');
  expect(fmOf('reminders/reopen-r.md').completed).toBe(null);
});

test('updateReminder bumps a pending reminder to ongoing when repeat is set', () => {
  createReminder(root, { title: 'Becomes Repeat', remindAt: 'x' });
  updateReminder(root, 'becomes-repeat', { repeat: 'daily' });
  expect(fmOf('reminders/becomes-repeat.md').status).toBe('ongoing');
});
