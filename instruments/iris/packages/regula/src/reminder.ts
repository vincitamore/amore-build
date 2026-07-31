import { basename, join, resolve as resolvePath } from 'path';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { readDoc, tryReadDoc, writeDoc } from './doc';
import { extractTitle, relPath, slugify, today } from './util';
import { RegulaError } from './errors';
import { isReminderStatus, reminderFolder, type Frontmatter, type ReminderStatus } from './schema';

export type RepeatType = 'daily' | 'weekly' | 'monthly' | 'custom';

const REMINDER_FOLDERS = ['reminders', 'reminders/completed'] as const;

export interface CreateReminderInput {
  title: string;
  remindAt: string;
  description?: string;
  repeat?: RepeatType;
  repeatUntil?: string;
  tags?: string[];
}

/** Create a reminder. A repeating reminder is born `ongoing`; a one-shot is `pending`. */
export function createReminder(
  orgRoot: string,
  input: CreateReminderInput
): { path: string; slug: string; status: ReminderStatus } {
  const slug = slugify(input.title);
  if (!slug) throw new RegulaError('USAGE', 'Reminder title produced an empty slug');
  const dir = join(orgRoot, 'reminders');
  const filePath = join(dir, `${slug}.md`);
  if (existsSync(filePath)) {
    throw new RegulaError('EXISTS', `Reminder already exists: ${relPath(orgRoot, filePath)}`);
  }
  mkdirSync(dir, { recursive: true });

  const status: ReminderStatus = input.repeat ? 'ongoing' : 'pending';
  const frontmatter: Frontmatter = {
    type: 'reminder',
    status,
    created: today(),
    'remind-at': input.remindAt,
    repeat: input.repeat ?? null,
    'repeat-until': input.repeatUntil ?? null,
    'snoozed-until': null,
    completed: null,
    tags: input.tags ?? [],
  };
  writeDoc(filePath, frontmatter, `# ${input.title}\n\n${input.description ?? ''}\n`);
  return { path: relPath(orgRoot, filePath), slug, status };
}

/** Locate a reminder by org-relative path or bare slug (across reminders/ + reminders/completed/). */
export function findReminder(orgRoot: string, ref: string): string {
  if (ref.endsWith('.md') || ref.includes('/') || ref.includes('\\')) {
    const p = join(orgRoot, ref);
    if (existsSync(p)) return p;
  }
  const slug = ref.replace(/\.md$/, '');
  for (const dir of REMINDER_FOLDERS) {
    const p = join(orgRoot, dir, `${slug}.md`);
    if (existsSync(p)) return p;
  }
  throw new RegulaError('NOT_FOUND', `Reminder not found: ${ref}`);
}

export interface ReminderStatusResult {
  from: string;
  to: ReminderStatus;
  oldPath: string;
  newPath: string;
  moved: boolean;
}

/**
 * Atomic status + folder reconcile for reminders (same shape as setTaskStatus): terminal
 * states (completed/dismissed) stamp the date and move to reminders/completed/; the rest
 * live at reminders/. Un-completing moves the file back.
 */
export function setReminderStatus(
  orgRoot: string,
  ref: string,
  newStatus: ReminderStatus,
  opts: { snoozedUntil?: string } = {}
): ReminderStatusResult {
  if (!isReminderStatus(newStatus)) throw new RegulaError('USAGE', `Invalid reminder status: ${newStatus}`);
  const filePath = findReminder(orgRoot, ref);
  const doc = readDoc(filePath);
  const from = String(doc.frontmatter.status ?? '');

  // Conflict check BEFORE any write (see setTaskStatus) — never leave status flipped but unmoved.
  const targetPath = join(orgRoot, reminderFolder(newStatus), basename(filePath));
  const moving = resolvePath(targetPath) !== resolvePath(filePath);
  if (moving && existsSync(targetPath)) {
    throw new RegulaError('CONFLICT', `Move target already exists: ${relPath(orgRoot, targetPath)}`);
  }

  doc.frontmatter.status = newStatus;
  if (newStatus === 'completed' || newStatus === 'dismissed') {
    doc.frontmatter.completed = today();
  } else if (from === 'completed' || from === 'dismissed') {
    doc.frontmatter.completed = null;
  }
  // Snooze sets the wake time; any OTHER transition (reactivate to pending/ongoing, complete,
  // dismiss) clears it — a stale snoozed-until must not linger once the reminder is no longer snoozed.
  doc.frontmatter['snoozed-until'] = newStatus === 'snoozed' ? opts.snoozedUntil ?? null : null;

  writeDoc(filePath, doc.frontmatter, doc.content);

  let movedTo = filePath;
  if (moving) {
    mkdirSync(join(orgRoot, reminderFolder(newStatus)), { recursive: true });
    renameSync(filePath, targetPath);
    movedTo = targetPath;
  }

  return {
    from,
    to: newStatus,
    oldPath: relPath(orgRoot, filePath),
    newPath: relPath(orgRoot, movedTo),
    moved: movedTo !== filePath,
  };
}

export const completeReminder = (orgRoot: string, ref: string) =>
  setReminderStatus(orgRoot, ref, 'completed');
export const dismissReminder = (orgRoot: string, ref: string) =>
  setReminderStatus(orgRoot, ref, 'dismissed');
export const snoozeReminder = (orgRoot: string, ref: string, until: string) =>
  setReminderStatus(orgRoot, ref, 'snoozed', { snoozedUntil: until });

export interface UpdateReminderInput {
  remindAt?: string;
  repeat?: RepeatType | null;
  repeatUntil?: string | null;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
}

/** Update reminder fields in place (no status-driven move). */
export function updateReminder(
  orgRoot: string,
  ref: string,
  changes: UpdateReminderInput
): { path: string } {
  const filePath = findReminder(orgRoot, ref);
  const doc = readDoc(filePath);
  const fm = doc.frontmatter;

  if (changes.remindAt) fm['remind-at'] = changes.remindAt;
  if (changes.repeat !== undefined) {
    fm.repeat = changes.repeat;
    if (changes.repeat && fm.status === 'pending') fm.status = 'ongoing';
  }
  if (changes.repeatUntil !== undefined) fm['repeat-until'] = changes.repeatUntil;
  if (changes.tags) fm.tags = changes.tags;
  if (changes.addTags) fm.tags = [...new Set([...(fm.tags ?? []), ...changes.addTags])];
  if (changes.removeTags) fm.tags = (fm.tags ?? []).filter((t) => !changes.removeTags!.includes(t));

  writeDoc(filePath, fm, doc.content);
  return { path: relPath(orgRoot, filePath) };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface ReminderDetail {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  content: string;
}

/** Read one reminder (by slug or path). */
export function getReminder(orgRoot: string, ref: string): ReminderDetail {
  const filePath = findReminder(orgRoot, ref);
  const doc = readDoc(filePath);
  return {
    path: relPath(orgRoot, filePath),
    title: extractTitle(doc.content, filePath),
    frontmatter: doc.frontmatter,
    content: doc.content,
  };
}

export interface ReminderListItem {
  path: string;
  title: string;
  status?: string;
  remindAt?: string;
  snoozedUntil?: string | null;
  repeat?: string | null;
  tags: string[];
}

/** List reminders across reminders/ + reminders/completed/ (optionally one status). */
export function listReminders(
  orgRoot: string,
  opts: { status?: ReminderStatus } = {}
): ReminderListItem[] {
  const items: ReminderListItem[] = [];
  for (const folder of REMINDER_FOLDERS) {
    const dir = join(orgRoot, folder);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const abs = join(dir, entry.name);
      const doc = tryReadDoc(abs); // skip a malformed file rather than break the whole listing
      if (!doc || doc.frontmatter.type !== 'reminder') continue;
      if (opts.status && doc.frontmatter.status !== opts.status) continue;
      items.push({
        path: relPath(orgRoot, abs),
        title: extractTitle(doc.content, abs),
        status: doc.frontmatter.status,
        remindAt: doc.frontmatter['remind-at'] as string | undefined,
        snoozedUntil: (doc.frontmatter['snoozed-until'] as string | null | undefined) ?? null,
        repeat: (doc.frontmatter.repeat as string | null | undefined) ?? null,
        tags: doc.frontmatter.tags ?? [],
      });
    }
  }
  return items;
}
