import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import matter from 'gray-matter';
import { createTask, setTaskStatus } from './task';
import { captureInbox } from './inbox';
import { getStatusSummary, summarizeInbox, summarizeForgeReview, summarizeReminders, summarizeTasks } from './status';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-status-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, fm: Record<string, unknown>, body = 'Artifact') {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, matter.stringify(`# ${body}\n`, fm));
}

test('summarizeTasks counts every status, zero-filled where a synthetic tree has no tasks', () => {
  createTask(root, {  title: 'Active One', allowThin: true });
  createTask(root, {  title: 'To Block', allowThin: true });
  setTaskStatus(root, 'to-block', 'blocked');
  createTask(root, {  title: 'To Complete', allowThin: true });
  setTaskStatus(root, 'to-complete', 'complete');

  const counts = summarizeTasks(root);
  expect(counts.active).toBe(1);
  expect(counts.blocked).toBe(1);
  expect(counts.complete).toBe(1);
  expect(counts.review).toBe(0);
  expect(counts.backlog).toBe(0);
  expect(counts.incubating).toBe(0);
  expect(counts.paused).toBe(0);
});

test('summarizeInbox counts OPEN items across the four everyday types, excluding resolved/ and emails/tickets', () => {
  captureInbox(root, { content: 'a capture' });
  seed('inbox/ideas/idea-a.md', { type: 'inbox', created: '2026-06-20', status: 'open' });
  seed('inbox/decisions/resolved/done.md', { type: 'inbox', created: '2026-06-01', status: 'resolved' });
  seed('inbox/emails/e.md', { type: 'inbox', created: '2026-06-20', source: 'email' });

  const s = summarizeInbox(root);
  expect(s.captures).toBe(1);
  expect(s.ideas).toBe(1);
  expect(s.decisions).toBe(0); // the only decision is resolved
  expect(s.investigations).toBe(0);
  expect(s.total).toBe(2); // emails excluded from this everyday-triage summary
});

test('summarizeReminders counts active statuses and buckets overdue vs due-within-7d off a fixed now', () => {
  const now = new Date('2026-07-02T12:00:00');
  seed('reminders/overdue.md', {
    type: 'reminder', created: '2026-06-01', status: 'pending', 'remind-at': '2026-07-01T09:00',
  });
  seed('reminders/soon.md', {
    type: 'reminder', created: '2026-06-01', status: 'pending', 'remind-at': '2026-07-04T09:00',
  });
  seed('reminders/far.md', {
    type: 'reminder', created: '2026-06-01', status: 'ongoing', 'remind-at': '2026-08-01T09:00',
  });
  seed('reminders/completed/done.md', {
    type: 'reminder', created: '2026-06-01', status: 'completed', completed: '2026-06-30',
  });

  const s = summarizeReminders(root, now);
  expect(s.active).toBe(3); // 2 pending + 1 ongoing; completed excluded
  expect(s.overdue).toBe(1);
  expect(s.dueWithin7d).toBe(1);
});

test('summarizeReminders uses snoozed-until (not remind-at) for a snoozed reminder', () => {
  const now = new Date('2026-07-02T12:00:00');
  seed('reminders/snoozed.md', {
    type: 'reminder', created: '2026-06-01', status: 'snoozed',
    'remind-at': '2026-06-01T09:00', 'snoozed-until': '2026-07-03T09:00',
  });
  const s = summarizeReminders(root, now);
  expect(s.active).toBe(1);
  expect(s.overdue).toBe(0); // snoozed-until is in the future even though remind-at is long past
  expect(s.dueWithin7d).toBe(1);
});

test('summarizeForgeReview counts pending dream pipelines + pending proposals only', () => {
  seed('forge/dreams/sessions/dream-a.manifest.md', {
    type: 'forge', pipeline: 'dream-a', 'triggered-by': 'dream', 'review-status': 'pending', created: '2026-06-29',
  });
  seed('forge/dreams/sessions/dream-b.manifest.md', {
    type: 'forge', pipeline: 'dream-b', 'triggered-by': 'dream', 'review-status': 'reviewed', created: '2026-06-20',
  });
  seed('forge/sessions/custom.manifest.md', {
    type: 'forge', pipeline: 'custom', 'triggered-by': 'operator', status: 'complete', created: '2026-06-29',
  });
  seed('forge/proposals/p1.md', { type: 'forge', status: 'pending', created: '2026-06-29' });
  seed('forge/proposals/applied/p2.md', { type: 'forge', status: 'applied', created: '2026-06-01' });

  const s = summarizeForgeReview(root);
  expect(s.pendingDreams).toBe(1);
  expect(s.pendingProposals).toBe(1);
});

test('getStatusSummary composes all four sections on an empty tree', () => {
  createTask(root, {  title: 'Solo', allowThin: true });
  const s = getStatusSummary(root);
  expect(s.tasks.active).toBe(1);
  expect(s.inbox.total).toBe(0);
  expect(s.reminders.active).toBe(0);
  expect(s.forge.pendingDreams).toBe(0);
  expect(s.forge.pendingProposals).toBe(0);
});
