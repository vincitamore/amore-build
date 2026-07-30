// regula — the rule that governs correct org-document form, lifecycle, and placement.
//
// This is the single WRITE/schema authority for the org system, shared by the dioptra
// CLI (agent surface) and TUI (operator surface). Canonical orient surface: selene
// AGENTS.md — domain statuses/folders aligned with the sibling-house surface
// (review/incubating admitted 2026-07-30). This module is a faithful machine-readable
// encoding, not a second source of truth.
//
// This file is the pure spine — types, status domains, and placement rules as total
// functions with no I/O. The verbs (create/update/complete/resolve…) build on it.

// ─────────────────────────────────────────────────────────────────────────────
// Document types
// ─────────────────────────────────────────────────────────────────────────────

export type DocType = 'task' | 'knowledge' | 'inbox' | 'reminder' | 'forge' | 'ticket';

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

export const TASK_STATUSES = [
  'active',
  'blocked',
  'review',
  'backlog',
  'incubating',
  'paused',
  'complete',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

/**
 * The directory (relative to the org root) a task with this status MUST live in.
 * `active` and `blocked` live at the `tasks/` root; every other status has a
 * subfolder. Note the historical asymmetry: the status value is `complete`, but
 * the folder is `completed/`.
 */
export function taskFolder(status: TaskStatus): string {
  switch (status) {
    case 'active':
    case 'blocked':
      return 'tasks';
    case 'review':
      return 'tasks/review';
    case 'backlog':
      return 'tasks/backlog';
    case 'incubating':
      return 'tasks/incubating';
    case 'paused':
      return 'tasks/paused';
    case 'complete':
      return 'tasks/completed';
  }
}

/**
 * Structured classifier for WHY a task is blocked, carried alongside the free-text
 * `blocked-by`. Optional enrichment retained from the port lineage (ratified 2026-05-11
 * lineage-side): the query value is "what am I gating?" by class — `decision`-blocked
 * items become a candidate `inbox/decisions/` triage batch, `peer`-blocked items become
 * the next handle-exchange queue, etc. Selene's AGENTS.md schema names `blocked-by`;
 * `blocked-on` rides as an adopted optional field.
 */
export const BLOCKED_ON_REASONS = ['decision', 'peer', 'corpus', 'hardware', 'external'] as const;
export type BlockedOnReason = (typeof BLOCKED_ON_REASONS)[number];

export function isBlockedOnReason(s: string): s is BlockedOnReason {
  return (BLOCKED_ON_REASONS as readonly string[]).includes(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reminders
// ─────────────────────────────────────────────────────────────────────────────

export const REMINDER_STATUSES = [
  'pending',
  'snoozed',
  'ongoing',
  'completed',
  'dismissed',
] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export function isReminderStatus(s: string): s is ReminderStatus {
  return (REMINDER_STATUSES as readonly string[]).includes(s);
}

/** `completed` and `dismissed` reminders move to `reminders/completed/`; the rest live at `reminders/`. */
export function reminderFolder(status: ReminderStatus): string {
  return status === 'completed' || status === 'dismissed'
    ? 'reminders/completed'
    : 'reminders';
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox
// ─────────────────────────────────────────────────────────────────────────────

export const INBOX_TYPES = [
  'emails',
  'tickets',
  'ideas',
  'decisions',
  'investigations',
  'captures',
] as const;
export type InboxType = (typeof INBOX_TYPES)[number];

/**
 * The lifecycle'd inbox types carry a status domain of open | resolved | dropped |
 * superseded. `captures` is triage-to-empty (no lifecycle); `emails`/`tickets` are
 * staging surfaces.
 */
export const LIFECYCLED_INBOX_TYPES = ['ideas', 'decisions', 'investigations'] as const;
export type LifecycledInboxType = (typeof LIFECYCLED_INBOX_TYPES)[number];

export const INBOX_TERMINAL_STATUSES = ['resolved', 'dropped', 'superseded'] as const;
export type InboxStatus = 'open' | (typeof INBOX_TERMINAL_STATUSES)[number];

export function isInboxTerminalStatus(s: string): boolean {
  return (INBOX_TERMINAL_STATUSES as readonly string[]).includes(s);
}

/**
 * A lifecycle'd inbox item moves to `inbox/<type>/resolved/` on ANY terminal status
 * (resolved | dropped | superseded all land in the single `resolved/` folder); an
 * open item lives at `inbox/<type>/`.
 */
export function inboxFolder(type: InboxType, status: InboxStatus = 'open'): string {
  return isInboxTerminalStatus(status) ? `inbox/${type}/resolved` : `inbox/${type}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter shape (the schema'd surface; index signature for type-specific fields)
// ─────────────────────────────────────────────────────────────────────────────

export interface Frontmatter {
  type: DocType;
  status?: string;
  created?: string;
  updated?: string;
  completed?: string | null;
  tags?: string[];
  [key: string]: unknown;
}
