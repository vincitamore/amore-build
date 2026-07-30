import { basename, join, resolve as resolvePath } from 'path';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { readDoc, tryReadDoc, writeDoc } from './doc';
import { extractTitle, relPath, slugify, today } from './util';
import { RegulaError } from './errors';
import {
  BLOCKED_ON_REASONS,
  isBlockedOnReason,
  isTaskStatus,
  taskFolder,
  type BlockedOnReason,
  type Frontmatter,
  type TaskStatus,
} from './schema';

/** Every folder a task can live in, in scan order (active/blocked at the root). */
const TASK_FOLDERS = [
  'tasks',
  'tasks/review',
  'tasks/backlog',
  'tasks/incubating',
  'tasks/paused',
  'tasks/completed',
] as const;

/** One-line goal / purpose (not the full body). */
export const TASK_GOAL_MIN_CHARS = 16;
/**
 * If a caller supplies `--body` / body field, it must clear this floor (anti one-liner body).
 * Body may be **omitted** entirely — create then writes a scaffold and the agent expands via
 * native tools (preferred path; matches AGENT.md body-authoring hygiene).
 */
export const TASK_BODY_MIN_CHARS = 40;

export type TaskPriority = 'high' | 'medium' | 'low';

export interface CreateTaskInput {
  title: string;
  /**
   * One-line goal / purpose under the H1. Required for full creates (CLI default).
   * Not a substitute for a real body — but body may land after create via native edit.
   */
  description?: string;
  /**
   * Full markdown body after the goal lead (no leading H1). Optional at create:
   * omit to get a scaffold, then expand the file with native write tools.
   */
  body?: string;
  tags?: string[];
  priority?: TaskPriority;
  blockedBy?: string[];
  status?: TaskStatus;
  /**
   * Escape hatch for unit tests and other internal lifecycle fixtures that only need a
   * path+status shell. The CLI never sets this. Prefer full fields for real work.
   */
  allowThin?: boolean;
}

export interface TaskWriteResult {
  path: string;
  slug: string;
  status: TaskStatus;
  /** True when body was auto-scaffolded (caller should expand before treating as fully authored). */
  bodyScaffolded?: boolean;
}

const TASK_PRIORITIES: readonly TaskPriority[] = ['high', 'medium', 'low'];

/** Marker in scaffolded bodies — agents expand until this is gone. */
export const TASK_BODY_SCAFFOLD_MARKER = '<!-- regula:body-scaffold — expand before treating this task as fully authored -->';

export function isTaskPriority(s: string): s is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(s);
}

/**
 * Validate create fields (anti-stub without body-file hell).
 * Requires title + tags + goal. Body optional (scaffold if missing/short).
 * If body is supplied, it must meet TASK_BODY_MIN_CHARS.
 */
export function assertFullTaskCreate(input: CreateTaskInput): void {
  const missing: string[] = [];
  if (!input.title?.trim()) missing.push('--title (or positional title)');
  if (!input.tags?.length) missing.push('--tags (comma-separated, ≥1)');
  const goal = input.description?.trim() ?? '';
  if (goal.length < TASK_GOAL_MIN_CHARS) {
    missing.push(
      `--description (one-line goal, ≥${TASK_GOAL_MIN_CHARS} chars; not the full body)`,
    );
  }
  const body = input.body?.trim() ?? '';
  if (body.length > 0 && body.length < TASK_BODY_MIN_CHARS) {
    missing.push(
      `--body too short (≥${TASK_BODY_MIN_CHARS} chars, or omit body entirely for scaffold + native edit)`,
    );
  }
  if (input.priority !== undefined && !isTaskPriority(input.priority)) {
    throw new RegulaError(
      'USAGE',
      `Invalid --priority '${input.priority}' (want ${TASK_PRIORITIES.join('|')})`,
    );
  }
  if (missing.length) {
    throw new RegulaError(
      'USAGE',
      'task create requires title + tags + goal (anti-stub):\n  - ' +
        missing.join('\n  - ') +
        '\nPreferred agent path:\n' +
        '  dioptra task create --title "…" --tags a,b --description "One-line goal…"\n' +
        '  # then expand body with native Write/Edit on the returned path\n' +
        'One-shot body: --body "…" | --body-file path.md | --body-file - (stdin)',
    );
  }
}

/** Default body when create omits --body: structure without forcing shell-escape hell. */
export function scaffoldTaskBody(goal: string): string {
  return [
    TASK_BODY_SCAFFOLD_MARKER,
    '',
    '## Goal',
    '',
    goal.trim(),
    '',
    '## Acceptance',
    '',
    '- [ ] …',
    '',
    '## Context',
    '',
    '_Expand with native tools after create (house hygiene: regula owns lifecycle; body prose is native authoring)._',
    '',
    '## Related',
    '',
    '- …',
    '',
  ].join('\n');
}

/** Assemble markdown content: H1 + goal lead + body. */
export function assembleTaskContent(title: string, description?: string, body?: string): string {
  const goal = description?.trim() ?? '';
  const bodyText = body?.trim() ?? '';
  const parts = [`# ${title}`, ''];
  if (goal) {
    parts.push(goal, '');
  }
  if (bodyText) {
    // Avoid doubling if body already starts with the same goal line.
    if (goal && (bodyText === goal || bodyText.startsWith(goal + '\n'))) {
      parts.push(bodyText.slice(goal.length).replace(/^\n+/, ''));
    } else {
      parts.push(bodyText);
    }
    if (!parts[parts.length - 1].endsWith('\n')) parts.push('');
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Create a task, placed in the folder its status demands (active → tasks/ root). */
export function createTask(orgRoot: string, input: CreateTaskInput): TaskWriteResult {
  const status: TaskStatus = input.status ?? 'active';
  if (!isTaskStatus(status)) throw new RegulaError('USAGE', `Invalid task status: ${status}`);
  if (input.priority !== undefined && !isTaskPriority(input.priority)) {
    throw new RegulaError('USAGE', `Invalid priority: ${input.priority}`);
  }
  if (!input.allowThin) {
    assertFullTaskCreate(input);
  }
  const slug = slugify(input.title);
  if (!slug) throw new RegulaError('USAGE', 'Task title produced an empty slug');

  const dir = join(orgRoot, taskFolder(status));
  const filePath = join(dir, `${slug}.md`);
  if (existsSync(filePath)) {
    throw new RegulaError('EXISTS', `Task already exists: ${relPath(orgRoot, filePath)}`);
  }
  mkdirSync(dir, { recursive: true });

  const frontmatter: Frontmatter = {
    type: 'task',
    status,
    created: today(),
    completed: status === 'complete' ? today() : null,
    tags: input.tags ?? [],
    blocks: [] as string[],
    'blocked-by': input.blockedBy ?? [],
  };
  if (input.priority) frontmatter.priority = input.priority;

  let bodyScaffolded = false;
  let body = input.body?.trim() ?? '';
  if (!input.allowThin && body.length < TASK_BODY_MIN_CHARS) {
    body = scaffoldTaskBody(input.description?.trim() ?? input.title);
    bodyScaffolded = true;
  }

  // Thin fixtures: preserve old shape (title + optional description only).
  const content = input.allowThin
    ? `# ${input.title}\n\n${input.description ?? input.body ?? ''}\n`
    : assembleTaskContent(input.title, input.description, body);

  writeDoc(filePath, frontmatter, content);

  return { path: relPath(orgRoot, filePath), slug, status, bodyScaffolded };
}

/** Locate a task by org-relative path (…/foo.md) or bare slug, across all task folders. */
export function findTask(orgRoot: string, ref: string): string {
  if (ref.endsWith('.md') || ref.includes('/') || ref.includes('\\')) {
    const p = join(orgRoot, ref);
    if (existsSync(p)) return p;
  }
  const slug = ref.replace(/\.md$/, '');
  for (const dir of TASK_FOLDERS) {
    const p = join(orgRoot, dir, `${slug}.md`);
    if (existsSync(p)) return p;
  }
  throw new RegulaError('NOT_FOUND', `Task not found: ${ref}`);
}

export interface StatusChangeResult {
  from: string;
  to: TaskStatus;
  oldPath: string;
  newPath: string;
  moved: boolean;
}

/**
 * THE atomic core: set a task's status AND reconcile its folder in one operation.
 *
 * This is the deliberate improvement over examen, whose `task_update` set the status
 * field but left the file where it was — so a task could read `status: paused` while
 * sitting in `tasks/`. Here, any status change moves the file to `taskFolder(status)`,
 * and the completed-date is kept coherent (set on complete, cleared on re-open).
 */
export function setTaskStatus(
  orgRoot: string,
  ref: string,
  newStatus: TaskStatus,
  opts: { pauseReason?: string; pauseTrigger?: string; blockedOn?: BlockedOnReason; blockedBy?: string } = {}
): StatusChangeResult {
  if (!isTaskStatus(newStatus)) throw new RegulaError('USAGE', `Invalid task status: ${newStatus}`);

  const filePath = findTask(orgRoot, ref);
  const doc = readDoc(filePath);
  const from = String(doc.frontmatter.status ?? '');

  // Conflict check BEFORE any write: if the move is going to fail, fail with the file
  // untouched — a status flipped on disk but not moved is exactly the status↔folder
  // drift this verb exists to prevent.
  const targetPath = join(orgRoot, taskFolder(newStatus), basename(filePath));
  const moving = resolvePath(targetPath) !== resolvePath(filePath);
  if (moving && existsSync(targetPath)) {
    throw new RegulaError('CONFLICT', `Move target already exists: ${relPath(orgRoot, targetPath)}`);
  }

  doc.frontmatter.status = newStatus;
  if (newStatus === 'complete') doc.frontmatter.completed = today();
  else if (from === 'complete') doc.frontmatter.completed = null;

  let content = doc.content;
  // Pause frontmatter (task schema: paused / paused-reason / trigger-to-unpause) rides the
  // same single write+move as the status flip. `paused` is always stamped; reason/trigger
  // are written only when given. Leaving the paused state clears all three, mirroring the
  // completed-date coherence above — stale pause fields on a re-activated task are drift.
  if (newStatus === 'paused') {
    doc.frontmatter.paused = today();
    if (opts.pauseReason !== undefined) doc.frontmatter['paused-reason'] = opts.pauseReason;
    if (opts.pauseTrigger !== undefined) doc.frontmatter['trigger-to-unpause'] = opts.pauseTrigger;
    if (opts.pauseReason) {
      content = `${content.trimEnd()}\n\n## Paused\n\n*${today()}*: ${opts.pauseReason}\n`;
    }
  } else if (from === 'paused') {
    delete doc.frontmatter.paused;
    delete doc.frontmatter['paused-reason'];
    delete doc.frontmatter['trigger-to-unpause'];
  }
  // blockTask's fields ride the same single write+move — never a second pass that could
  // leave status flipped with blocked-on/-by unset if the process died in between.
  if (newStatus === 'blocked') {
    if (opts.blockedOn !== undefined) doc.frontmatter['blocked-on'] = opts.blockedOn;
    if (opts.blockedBy !== undefined) doc.frontmatter['blocked-by'] = [opts.blockedBy];
  }

  writeDoc(filePath, doc.frontmatter, content);

  let movedTo = filePath;
  if (moving) {
    mkdirSync(join(orgRoot, taskFolder(newStatus)), { recursive: true });
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

/** Mark a task complete: status `complete`, completed date stamped, moved to tasks/completed/. */
export function completeTask(orgRoot: string, ref: string): StatusChangeResult {
  return setTaskStatus(orgRoot, ref, 'complete');
}

/**
 * Pause a task: status `paused`, moved to tasks/paused/, pause frontmatter written
 * (`paused` stamped today; `paused-reason` / `trigger-to-unpause` when given), and the
 * optional reason also appended to the body as a dated `## Paused` section.
 */
export function pauseTask(orgRoot: string, ref: string, reason?: string, trigger?: string): StatusChangeResult {
  return setTaskStatus(orgRoot, ref, 'paused', { pauseReason: reason, pauseTrigger: trigger });
}

export interface BlockTaskResult extends StatusChangeResult {
  blockedOn: BlockedOnReason;
  blockedBy: string[];
}

/**
 * Block a task: status `blocked` (atomic status + folder reconcile via setTaskStatus),
 * `blocked-on` validated against the five-value taxonomy (CLAUDE.md § Frontmatter
 * schemas), `blocked-by` set to the given free-text reason. One write, one move — the
 * same atomicity setTaskStatus already gives pause/complete.
 */
export function blockTask(orgRoot: string, ref: string, on: BlockedOnReason, by: string): BlockTaskResult {
  if (!isBlockedOnReason(on)) {
    throw new RegulaError('USAGE', `Invalid blocked-on reason: ${on} (expected ${BLOCKED_ON_REASONS.join('|')})`);
  }
  if (!by || !by.trim()) {
    throw new RegulaError('USAGE', 'task block requires a non-empty --by <free text>');
  }
  const result = setTaskStatus(orgRoot, ref, 'blocked', { blockedOn: on, blockedBy: by });
  return { ...result, blockedOn: on, blockedBy: [by] };
}

export interface UpdateTaskMeta {
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  blockedBy?: string[];
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
}

/** Update tags / blocked-by in place (no status change, no move). */
export function updateTaskMeta(
  orgRoot: string,
  ref: string,
  changes: UpdateTaskMeta
): { path: string } {
  const filePath = findTask(orgRoot, ref);
  const doc = readDoc(filePath);
  const fm = doc.frontmatter;

  if (changes.tags) fm.tags = changes.tags;
  if (changes.addTags) fm.tags = [...new Set([...(fm.tags ?? []), ...changes.addTags])];
  if (changes.removeTags) {
    fm.tags = (fm.tags ?? []).filter((t) => !changes.removeTags!.includes(t));
  }

  if (changes.blockedBy) fm['blocked-by'] = changes.blockedBy;
  if (changes.addBlockedBy) {
    const cur = (fm['blocked-by'] as string[] | undefined) ?? [];
    fm['blocked-by'] = [...new Set([...cur, ...changes.addBlockedBy])];
  }
  if (changes.removeBlockedBy) {
    const cur = (fm['blocked-by'] as string[] | undefined) ?? [];
    fm['blocked-by'] = cur.filter((b) => !changes.removeBlockedBy!.includes(b));
  }

  writeDoc(filePath, fm, doc.content);
  return { path: relPath(orgRoot, filePath) };
}

// ─── Reads (daemon-independent scans) ────────────────────────────────────────

export interface TaskListItem {
  path: string;
  title: string;
  status?: string;
  tags: string[];
  created?: string;
  completed?: string | null;
  blockedBy: string[];
  /** Structured blocker classifier (decision | peer | corpus | hardware | external), if set. */
  blockedOn?: string;
}

/** List tasks across all folders (or just one status's folder), newest first. */
export function listTasks(orgRoot: string, opts: { status?: TaskStatus } = {}): TaskListItem[] {
  const folders: readonly string[] = opts.status ? [taskFolder(opts.status)] : TASK_FOLDERS;
  const items: TaskListItem[] = [];
  for (const folder of folders) {
    const dir = join(orgRoot, folder);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const abs = join(dir, entry.name);
      const doc = tryReadDoc(abs); // skip a malformed file rather than break the whole listing
      if (!doc || doc.frontmatter.type !== 'task') continue;
      // active and blocked share the tasks/ root, so a folder match isn't enough — also
      // filter on the status field when a status was requested.
      if (opts.status && doc.frontmatter.status !== opts.status) continue;
      items.push({
        path: relPath(orgRoot, abs),
        title: extractTitle(doc.content, abs),
        status: doc.frontmatter.status,
        tags: doc.frontmatter.tags ?? [],
        created: doc.frontmatter.created,
        completed: (doc.frontmatter.completed as string | null | undefined) ?? null,
        blockedBy: (doc.frontmatter['blocked-by'] as string[] | undefined) ?? [],
        blockedOn: (doc.frontmatter['blocked-on'] as string | undefined) ?? undefined,
      });
    }
  }
  return items.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
}

export interface TaskDetail {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  content: string;
}

/** Read one task (by slug or path), with frontmatter + body. */
export function getTask(orgRoot: string, ref: string): TaskDetail {
  const filePath = findTask(orgRoot, ref);
  const doc = readDoc(filePath);
  return {
    path: relPath(orgRoot, filePath),
    title: extractTitle(doc.content, filePath),
    frontmatter: doc.frontmatter,
    content: doc.content,
  };
}
