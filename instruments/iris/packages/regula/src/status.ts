// Orientation-count aggregation — the SessionStart-hook style compact summary, as a
// pure regula read composed from listTasks/listInbox/listReminders/listForge. Entirely
// daemon-independent (file reads only), so `iris status` works with the daemon down.

import { listTasks } from './task';
import { listInbox } from './inbox';
import { listReminders } from './reminder';
import { listForge } from './forge';
import { TASK_STATUSES, isTaskStatus, type TaskStatus } from './schema';

export type TaskStatusCounts = Record<TaskStatus, number>;

/** Task counts by status, across all folders — zero-filled for every declared status. */
export function summarizeTasks(orgRoot: string): TaskStatusCounts {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as TaskStatusCounts;
  for (const t of listTasks(orgRoot)) {
    if (t.status && isTaskStatus(t.status)) counts[t.status]++;
  }
  return counts;
}

/**
 * The everyday-triage inbox types — deliberately excludes `emails`/`tickets` (staging
 * surfaces, not the lifecycle'd/quick-capture queue orientation cares about).
 */
const INBOX_SUMMARY_TYPES = ['captures', 'ideas', 'decisions', 'investigations'] as const;
export type InboxSummary = Record<(typeof INBOX_SUMMARY_TYPES)[number], number> & { total: number };

/** Open (non-resolved) inbox counts for the four everyday-triage types. */
export function summarizeInbox(orgRoot: string): InboxSummary {
  const out = {} as InboxSummary;
  let total = 0;
  for (const t of INBOX_SUMMARY_TYPES) {
    // listInbox defaults to the OPEN queue (excludes resolved/) — exactly "non-resolved".
    const n = listInbox(orgRoot, { type: t }).length;
    out[t] = n;
    total += n;
  }
  out.total = total;
  return out;
}

export interface ReminderSummary {
  active: number;
  overdue: number;
  dueWithin7d: number;
}

const ACTIVE_REMINDER_STATUSES = new Set(['pending', 'ongoing', 'snoozed']);

/**
 * Active reminder count (pending/ongoing/snoozed — completed/dismissed excluded) plus
 * how many of those are overdue or due within the next 7 days, off `remind-at` (or
 * `snoozed-until` for a snoozed reminder). Mirrors scripts/hooks/session-start-orient.py's
 * `scan_reminders`. `now` is injectable for deterministic tests.
 */
export function summarizeReminders(orgRoot: string, now: Date = new Date()): ReminderSummary {
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  let active = 0;
  let overdue = 0;
  let dueWithin7d = 0;
  for (const r of listReminders(orgRoot)) {
    if (!r.status || !ACTIVE_REMINDER_STATUSES.has(r.status)) continue;
    active++;
    const at = r.snoozedUntil ?? r.remindAt;
    if (!at) continue;
    const ts = new Date(at);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts < now) overdue++;
    else if (ts <= horizon) dueWithin7d++;
  }
  return { active, overdue, dueWithin7d };
}

export interface ForgeReviewSummary {
  pendingDreams: number;
  pendingProposals: number;
}

/**
 * Pending forge review counts — dream pipelines awaiting review + proposals awaiting
 * a decision. Cheap: `listForge` is already scoped to the lightweight forge roots
 * (sessions/dreams/proposals/recipes), never the heavy handles/output trees.
 *
 * Dream pipelines are classified by `triggered-by: dream` (public spelling). The private
 * house used a longer lineage label; adopters migrating trees should rewrite that field.
 */
export function summarizeForgeReview(orgRoot: string): ForgeReviewSummary {
  const items = listForge(orgRoot);
  return {
    pendingDreams: items.filter((x) => x.triggeredBy === 'dream' && x.reviewStatus === 'pending').length,
    pendingProposals: items.filter((x) => x.path.startsWith('forge/proposals/') && x.status === 'pending').length,
  };
}

export interface StatusSummary {
  tasks: TaskStatusCounts;
  inbox: InboxSummary;
  reminders: ReminderSummary;
  forge: ForgeReviewSummary;
}

/** The full orientation-count summary — daemon-independent (pure regula/file reads). */
export function getStatusSummary(orgRoot: string, now: Date = new Date()): StatusSummary {
  return {
    tasks: summarizeTasks(orgRoot),
    inbox: summarizeInbox(orgRoot),
    reminders: summarizeReminders(orgRoot, now),
    forge: summarizeForgeReview(orgRoot),
  };
}
