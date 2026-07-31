import { test, expect } from 'bun:test';
import {
  taskFolder,
  isTaskStatus,
  TASK_STATUSES,
  reminderFolder,
  inboxFolder,
} from './schema';

test('taskFolder places active and blocked at the tasks/ root', () => {
  expect(taskFolder('active')).toBe('tasks');
  expect(taskFolder('blocked')).toBe('tasks');
});

test('taskFolder routes each non-root status to its subfolder', () => {
  expect(taskFolder('review')).toBe('tasks/review');
  expect(taskFolder('backlog')).toBe('tasks/backlog');
  expect(taskFolder('incubating')).toBe('tasks/incubating');
  expect(taskFolder('paused')).toBe('tasks/paused');
  // status value is `complete`, folder is `completed/`
  expect(taskFolder('complete')).toBe('tasks/completed');
});

test('every declared task status resolves to a folder (totality)', () => {
  for (const s of TASK_STATUSES) {
    expect(typeof taskFolder(s)).toBe('string');
  }
});

test('isTaskStatus guards the status domain', () => {
  expect(isTaskStatus('active')).toBe(true);
  expect(isTaskStatus('complete')).toBe(true);
  expect(isTaskStatus('done')).toBe(false);
  expect(isTaskStatus('completed')).toBe(false); // folder name, not a status value
});

test('reminderFolder moves terminal states to reminders/completed/', () => {
  expect(reminderFolder('pending')).toBe('reminders');
  expect(reminderFolder('snoozed')).toBe('reminders');
  expect(reminderFolder('ongoing')).toBe('reminders');
  expect(reminderFolder('completed')).toBe('reminders/completed');
  expect(reminderFolder('dismissed')).toBe('reminders/completed');
});

test('inboxFolder routes every terminal status to the single resolved/ folder', () => {
  expect(inboxFolder('decisions', 'open')).toBe('inbox/decisions');
  expect(inboxFolder('decisions', 'resolved')).toBe('inbox/decisions/resolved');
  expect(inboxFolder('ideas', 'superseded')).toBe('inbox/ideas/resolved');
  expect(inboxFolder('investigations', 'dropped')).toBe('inbox/investigations/resolved');
  expect(inboxFolder('captures')).toBe('inbox/captures');
});
