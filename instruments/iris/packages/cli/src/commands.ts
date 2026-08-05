import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import * as regula from '@amore/regula';
import { type ParsedArgs, csv, str } from './contract';
import { EXIT } from './contract';
import { daemonGet } from './daemon';
import * as athanor from './athanor';
import * as edges from './edges';
import * as lucerna from './lucerna';
import * as qmd from './qmd';

export interface RunContext {
  orgRoot: string;
  args: ParsedArgs;
}

export interface CommandSpec {
  name: string;
  summary: string;
  isWrite: boolean;
  booleanFlags: string[];
  /**
   * Value-flag registry: flag name → one-line description. The single source for the
   * unknown-flag policy (warn on reads, REFUSE on writes — a silently-dropped flag on a
   * write doesn't express intent), per-command help, shell completion, and the manifest.
   */
  flags: Record<string, string>;
  run: (ctx: RunContext) => unknown | Promise<unknown>;
  /** Optional exit-code override based on the payload (e.g. lint errors → ACTIONABLE). */
  exit?: (payload: Record<string, unknown>) => number;
  /**
   * Optional compact human-text formatter. When present AND `--json` was NOT passed,
   * the CLI prints this instead of the ok-first JSON envelope — for orientation verbs
   * (e.g. `status`) meant to be glanced at, mirroring scripts/hooks/session-start-orient.py's
   * compact style. Commands without this always emit the JSON envelope (unchanged default).
   */
  human?: (payload: Record<string, unknown>) => string;
}

function requireRef(args: ParsedArgs, cmd: string): string {
  const ref = args.positional[0];
  if (!ref) throw new regula.RegulaError('USAGE', `${cmd} requires a reference (slug or path)`);
  return ref;
}

/** Map inbox promote → full task shape (goal + body + tags; never thin CLI stubs). */
function promoteToTaskInput(
  title: string,
  body: string,
  tags: string[],
): regula.CreateTaskInput {
  const trimmed = body.trim();
  const firstLine =
    trimmed.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ??
    `Promoted from inbox: ${title}`;
  const goal =
    firstLine.length >= regula.TASK_GOAL_MIN_CHARS
      ? firstLine.slice(0, 200)
      : `Promoted from inbox — expand acceptance for: ${title}`.slice(0, 200);
  let taskBody = trimmed;
  if (taskBody.length < regula.TASK_BODY_MIN_CHARS) {
    taskBody = [
      '## Context',
      '',
      trimmed || '_Promoted with empty source body._',
      '',
      '## Acceptance',
      '',
      '- [ ] Expand this task with concrete acceptance criteria',
      '- [ ] Close or re-scope after triage',
      '',
    ].join('\n');
  }
  return {
    title,
    description: goal,
    body: taskBody,
    tags: tags.length ? tags : ['promoted'],
  };
}

/** Strip a leading `# H1` line (and any blank lines before it — regula's readDoc leaves a
 *  leading newline after the frontmatter block) so the regula create verb's own `# ${title}`
 *  isn't doubled in the promoted doc. */
function stripLeadingH1(content: string): string {
  return content.replace(/^\s*#\s+.+(\r?\n)+/, '');
}

interface PromoteInput {
  to: 'task' | 'knowledge';
  title?: string;
  tags?: string[];
  folder?: string;
}

/**
 * inbox promote — the examen inbox_process successor (the census's sharpest gap:
 * nothing in the CLI/regula promotes inbox → task/knowledge).
 *
 * Composes EXISTING regula verbs (never reimplements): resolve the item → create the
 * target via createTask/createKnowledge → close the source per the house lifecycle
 * (lifecycle'd types resolve with a wikilink to the new doc; captures/emails/tickets
 * archive). Atomic in the create-then-close sense: a create failure closes nothing;
 * a close failure after a successful create is surfaced LOUDLY with the created path
 * — never a silent half-state.
 */
function promoteInbox(orgRoot: string, ref: string, input: PromoteInput): Record<string, unknown> {
  // 1. Resolve the inbox item (same ref-resolution the other inbox verbs use — an
  //    org-relative path; getInbox throws NOT_FOUND / a non-inbox USAGE error).
  const item = regula.getInbox(orgRoot, ref);
  const title = input.title ?? item.title;
  const body = stripLeadingH1(item.content);
  const tags = input.tags ?? item.frontmatter.tags ?? [];

  // 2. Create the target doc via the existing regula write verbs.
  const created: { path: string } =
    input.to === 'task'
      ? regula.createTask(orgRoot, promoteToTaskInput(title, body, tags))
      : regula.createKnowledge(orgRoot, { title, content: body, folder: input.folder, tags });

  // 3. Close the source in the same breath (the house resolution rule).
  const lifecycled = (regula.LIFECYCLED_INBOX_TYPES as readonly string[]).includes(item.type);
  const wikiTarget = created.path.replace(/\.md$/, '');
  let closed: { oldPath: string; newPath: string; via: 'resolve' | 'archive' };
  try {
    if (lifecycled) {
      const r = regula.resolveInbox(orgRoot, ref, { resolution: `Promoted to [[${wikiTarget}]]` });
      closed = { oldPath: r.oldPath, newPath: r.newPath, via: 'resolve' };
    } else {
      const r = regula.archiveInbox(orgRoot, ref);
      closed = { oldPath: r.oldPath, newPath: r.newPath, via: 'archive' };
    }
  } catch (e) {
    // Created but couldn't close — report loudly WITH the created path (no silent half-state).
    const msg = e instanceof Error ? e.message : String(e);
    throw new regula.RegulaError(
      'CONFLICT',
      `Promoted doc CREATED at ${created.path}, but closing the inbox source '${ref}' FAILED: ${msg}. ` +
        `The new doc is intact; close the source manually (iris inbox ${lifecycled ? 'resolve' : 'archive'} ${ref}).`,
    );
  }

  return { from: ref, to: input.to, created: created.path, closed };
}

/** Compact multi-line orientation text — the `status` verb's --json-less default output. */
function statusHuman(p: regula.StatusSummary): string {
  const t = p.tasks;
  const lines: string[] = [
    `Tasks: ${t.active} active · ${t.blocked} blocked · ${t.review} review · ${t.backlog} backlog · ${t.incubating} incubating · ${t.paused} paused · ${t.complete} complete`,
  ];

  const ib = p.inbox;
  if (ib.total > 0) {
    const parts = [
      ib.captures ? `${ib.captures} captures` : null,
      ib.ideas ? `${ib.ideas} ideas` : null,
      ib.decisions ? `${ib.decisions} decisions` : null,
      ib.investigations ? `${ib.investigations} investigations` : null,
    ].filter((x): x is string => x !== null);
    lines.push(`Inbox: ${ib.total} open (${parts.join(', ')})`);
  } else {
    lines.push('Inbox: clear');
  }

  const rem = p.reminders;
  if (rem.active > 0) {
    const parts = [`${rem.active} active`];
    if (rem.overdue) parts.push(`${rem.overdue} overdue`);
    if (rem.dueWithin7d) parts.push(`${rem.dueWithin7d} within 7d`);
    lines.push(`Reminders: ${parts.join(' · ')}`);
  } else {
    lines.push('Reminders: none active');
  }

  const f = p.forge;
  lines.push(
    f.pendingDreams || f.pendingProposals
      ? `Forge: ${f.pendingProposals} proposals · ${f.pendingDreams} dreams pending review`
      : 'Forge: queue clear',
  );

  return lines.join('\n');
}

export const COMMANDS: CommandSpec[] = [
  // ── status ──
  {
    name: 'status',
    summary: 'Orientation counts — tasks/inbox/reminders/forge (daemon-independent). Compact text by default; --json for the structured envelope.',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot }) => regula.getStatusSummary(orgRoot) as unknown as Record<string, unknown>,
    human: (p) => statusHuman(p as unknown as regula.StatusSummary),
  },

  // ── tasks ──
  {
    name: 'task create',
    summary:
      'Create a task: --title + --tags + --description (goal) required. Body optional (scaffold if omitted — expand with native tools). One-shot: --body / --body-file / --body-file - (stdin).',
    isWrite: true,
    booleanFlags: [],
    flags: {
      title: 'task title (or first positional) — required',
      description: 'one-line goal under the H1 (≥16 chars) — required',
      body: 'optional full markdown body (≥40 chars if set). Prefer omit + native edit for long prose',
      'body-file':
        'optional body from path, or "-" to read stdin (avoids shell-escape hell for long bodies)',
      tags: 'comma-separated tags (≥1) — required',
      priority: 'optional priority (high|medium|low)',
      'blocked-by': 'comma-separated blockers',
      status: `initial status (${regula.TASK_STATUSES.join('|')}; default active)`,
    },
    run: ({ orgRoot, args }) => {
      const title = str(args.flags, 'title') ?? args.positional[0];
      if (!title) {
        throw new regula.RegulaError(
          'USAGE',
          'task create requires --title (or positional), --tags, and --description (goal). Body optional.',
        );
      }
      let body = str(args.flags, 'body');
      const bodyFile = str(args.flags, 'body-file');
      if (bodyFile) {
        if (bodyFile === '-') {
          body = readFileSync(0, 'utf-8'); // fd 0 = stdin
        } else {
          const abs = isAbsolute(bodyFile) ? bodyFile : join(orgRoot, bodyFile);
          if (!existsSync(abs)) {
            throw new regula.RegulaError('USAGE', `task create --body-file not found: ${bodyFile}`);
          }
          body = readFileSync(abs, 'utf-8');
        }
      }
      const priorityRaw = str(args.flags, 'priority');
      return regula.createTask(orgRoot, {
        title,
        description: str(args.flags, 'description'),
        body,
        tags: csv(args.flags, 'tags'),
        priority: priorityRaw as regula.TaskPriority | undefined,
        blockedBy: csv(args.flags, 'blocked-by'),
        status: str(args.flags, 'status') as regula.TaskStatus | undefined,
      });
    },
  },
  {
    name: 'task complete',
    summary: 'Mark a task complete (moves to tasks/completed/)',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.completeTask(orgRoot, requireRef(args, 'task complete')),
  },
  {
    name: 'task pause',
    summary: 'Pause a task (moves to tasks/paused/, writes paused/paused-reason/trigger-to-unpause frontmatter, appends reason)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      reason: 'why paused (frontmatter paused-reason; also appended to the body)',
      trigger: 'named falsifiable trigger-to-unpause (frontmatter)',
    },
    run: ({ orgRoot, args }) =>
      regula.pauseTask(orgRoot, requireRef(args, 'task pause'), str(args.flags, 'reason'), str(args.flags, 'trigger')),
  },
  {
    name: 'task block',
    summary: 'Block a task (status: blocked; taxonomy-validated blocked-on + free-text blocked-by)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      on: `blocker classifier (${regula.BLOCKED_ON_REASONS.join('|')})`,
      by: 'free-text description of who/what is blocking',
    },
    run: ({ orgRoot, args }) => {
      const ref = requireRef(args, 'task block');
      const on = str(args.flags, 'on');
      const by = str(args.flags, 'by');
      if (!on) {
        throw new regula.RegulaError('USAGE', `task block requires --on <${regula.BLOCKED_ON_REASONS.join('|')}>`);
      }
      if (!by) throw new regula.RegulaError('USAGE', 'task block requires --by <free text>');
      return regula.blockTask(orgRoot, ref, on as regula.BlockedOnReason, by);
    },
  },
  {
    name: 'task status',
    summary: 'Set a task status (atomic status + folder reconcile)',
    isWrite: true,
    booleanFlags: [],
    flags: { to: `new status (${regula.TASK_STATUSES.join('|')})` },
    run: ({ orgRoot, args }) => {
      const ref = requireRef(args, 'task status');
      const status = str(args.flags, 'to') ?? args.positional[1];
      if (!status) throw new regula.RegulaError('USAGE', 'task status requires --to <status>');
      return regula.setTaskStatus(orgRoot, ref, status as regula.TaskStatus);
    },
  },
  {
    name: 'task update',
    summary: 'Update task tags / blocked-by in place',
    isWrite: true,
    booleanFlags: [],
    flags: {
      tags: 'replace tags (comma-separated)',
      'add-tags': 'add tags',
      'remove-tags': 'remove tags',
      'blocked-by': 'replace blocked-by list',
      'add-blocked-by': 'add blockers',
      'remove-blocked-by': 'remove blockers',
    },
    run: ({ orgRoot, args }) =>
      regula.updateTaskMeta(orgRoot, requireRef(args, 'task update'), {
        tags: csv(args.flags, 'tags'),
        addTags: csv(args.flags, 'add-tags'),
        removeTags: csv(args.flags, 'remove-tags'),
        blockedBy: csv(args.flags, 'blocked-by'),
        addBlockedBy: csv(args.flags, 'add-blocked-by'),
        removeBlockedBy: csv(args.flags, 'remove-blocked-by'),
      }),
  },

  // ── knowledge ──
  {
    name: 'knowledge create',
    summary: 'Create a knowledge article under knowledge/[folder]/',
    isWrite: true,
    booleanFlags: [],
    flags: {
      title: 'article title (or first positional)',
      content: 'article body',
      folder: 'knowledge subfolder (e.g. architecture/patterns)',
      tags: 'comma-separated tags',
    },
    run: ({ orgRoot, args }) => {
      const title = str(args.flags, 'title') ?? args.positional[0];
      const content = str(args.flags, 'content') ?? '';
      if (!title) throw new regula.RegulaError('USAGE', 'knowledge create requires a title');
      return regula.createKnowledge(orgRoot, {
        title,
        content,
        folder: str(args.flags, 'folder'),
        tags: csv(args.flags, 'tags'),
      });
    },
  },
  {
    name: 'knowledge update',
    summary: 'Update a knowledge article (by path); restamps updated',
    isWrite: true,
    booleanFlags: [],
    flags: {
      content: 'replace the body',
      append: 'append to the body',
      tags: 'replace tags',
      'add-tags': 'add tags',
      'remove-tags': 'remove tags',
    },
    run: ({ orgRoot, args }) =>
      regula.updateKnowledge(orgRoot, requireRef(args, 'knowledge update'), {
        content: str(args.flags, 'content'),
        append: str(args.flags, 'append'),
        tags: csv(args.flags, 'tags'),
        addTags: csv(args.flags, 'add-tags'),
        removeTags: csv(args.flags, 'remove-tags'),
      }),
  },

  // ── inbox ──
  {
    name: 'inbox capture',
    summary: 'Quick-capture into inbox/captures/',
    isWrite: true,
    booleanFlags: [],
    flags: {
      content: 'capture body (or first positional)',
      title: 'optional title (slugged into the filename)',
      source: 'source field (default capture)',
      tags: 'comma-separated tags',
    },
    run: ({ orgRoot, args }) => {
      const content = str(args.flags, 'content') ?? args.positional[0];
      if (!content) throw new regula.RegulaError('USAGE', 'inbox capture requires content');
      return regula.captureInbox(orgRoot, {
        content,
        title: str(args.flags, 'title'),
        source: str(args.flags, 'source'),
        tags: csv(args.flags, 'tags'),
      });
    },
  },
  {
    name: 'inbox list',
    summary: 'List the open inbox queue (excludes resolved/ unless --all)',
    isWrite: false,
    booleanFlags: ['all'],
    flags: { type: `inbox subtype (${regula.INBOX_TYPES.join('|')})` },
    run: ({ orgRoot, args }) => {
      const items = regula.listInbox(orgRoot, {
        includeResolved: args.flags.all === true,
        type: str(args.flags, 'type') as regula.InboxType | undefined,
      });
      return { count: items.length, items };
    },
  },
  {
    name: 'inbox resolve',
    summary: 'Resolve a lifecycled inbox item (moves to inbox/<type>/resolved/)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      status: 'terminal status (resolved|dropped|superseded; default resolved)',
      resolution: 'one-line resolution (carry a wikilink to where it landed)',
      date: 'resolution date YYYY-MM-DD (the date the resolving work shipped; default today)',
    },
    run: ({ orgRoot, args }) =>
      regula.resolveInbox(orgRoot, requireRef(args, 'inbox resolve'), {
        status: str(args.flags, 'status') as 'resolved' | 'dropped' | 'superseded' | undefined,
        resolution: str(args.flags, 'resolution'),
        resolvedDate: str(args.flags, 'date'),
      }),
  },
  {
    name: 'inbox move',
    summary: 'Triage: move an inbox item to another inbox subtype folder',
    isWrite: true,
    booleanFlags: [],
    flags: { to: `target inbox type (${regula.INBOX_TYPES.join('|')}) — or the second positional` },
    run: ({ orgRoot, args }) => {
      const ref = requireRef(args, 'inbox move');
      const targetType = str(args.flags, 'to') ?? args.positional[1];
      if (!targetType) {
        throw new regula.RegulaError('USAGE', 'inbox move requires a target type (second positional or --to)');
      }
      return regula.moveInbox(orgRoot, ref, targetType as regula.InboxType);
    },
  },
  {
    name: 'inbox archive',
    summary: 'Archive an inbox item out of the queue to archive/inbox/<type>/',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.archiveInbox(orgRoot, requireRef(args, 'inbox archive')),
  },
  {
    name: 'inbox get',
    summary: 'Read an inbox item (by org-relative path)',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.getInbox(orgRoot, requireRef(args, 'inbox get')),
  },
  {
    name: 'inbox promote',
    summary: 'Promote an inbox item to a task or knowledge article, then close the source (resolve if lifecycled, else archive)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      to: 'target type: task | knowledge (or the second positional)',
      title: 'override title (default: the item title)',
      tags: 'comma-separated tags (default: the item tags)',
      folder: 'knowledge subfolder (only with --to knowledge)',
    },
    run: ({ orgRoot, args }) => {
      const ref = requireRef(args, 'inbox promote');
      const to = str(args.flags, 'to') ?? args.positional[1];
      if (to !== 'task' && to !== 'knowledge') {
        throw new regula.RegulaError('USAGE', 'inbox promote requires --to task|knowledge (second positional or --to)');
      }
      return promoteInbox(orgRoot, ref, {
        to,
        title: str(args.flags, 'title'),
        tags: csv(args.flags, 'tags'),
        folder: str(args.flags, 'folder'),
      });
    },
  },

  // ── reminders ──
  {
    name: 'reminder create',
    summary: 'Create a reminder (pending, or ongoing if --repeat)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      title: 'reminder title (or first positional)',
      at: 'remind-at (YYYY-MM-DDTHH:mm local)',
      description: 'body text',
      repeat: 'daily|weekly|monthly|custom',
      until: 'repeat-until date',
      tags: 'comma-separated tags',
    },
    run: ({ orgRoot, args }) => {
      const title = str(args.flags, 'title') ?? args.positional[0];
      const remindAt = str(args.flags, 'at');
      if (!title) throw new regula.RegulaError('USAGE', 'reminder create requires a title');
      if (!remindAt) throw new regula.RegulaError('USAGE', 'reminder create requires --at <when>');
      const repeat = str(args.flags, 'repeat');
      if (repeat && !['daily', 'weekly', 'monthly', 'custom'].includes(repeat)) {
        throw new regula.RegulaError('USAGE', `Invalid --repeat '${repeat}' (daily|weekly|monthly|custom)`);
      }
      return regula.createReminder(orgRoot, {
        title,
        remindAt,
        description: str(args.flags, 'description'),
        repeat: repeat as regula.RepeatType | undefined,
        repeatUntil: str(args.flags, 'until'),
        tags: csv(args.flags, 'tags'),
      });
    },
  },
  {
    name: 'reminder complete',
    summary: 'Complete a reminder (moves to reminders/completed/)',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.completeReminder(orgRoot, requireRef(args, 'reminder complete')),
  },
  {
    name: 'reminder dismiss',
    summary: 'Dismiss a reminder (moves to reminders/completed/)',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.dismissReminder(orgRoot, requireRef(args, 'reminder dismiss')),
  },
  {
    name: 'reminder snooze',
    summary: 'Snooze a reminder until a time (stays in reminders/)',
    isWrite: true,
    booleanFlags: [],
    flags: { until: 'snooze-until (YYYY-MM-DDTHH:mm local; or second positional)' },
    run: ({ orgRoot, args }) => {
      const until = str(args.flags, 'until') ?? args.positional[1];
      if (!until) throw new regula.RegulaError('USAGE', 'reminder snooze requires --until <when>');
      return regula.snoozeReminder(orgRoot, requireRef(args, 'reminder snooze'), until);
    },
  },
  {
    name: 'reminder update',
    summary: 'Update reminder fields in place (no status-driven move)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      at: 'remind-at (YYYY-MM-DDTHH:mm local)',
      repeat: 'daily|weekly|monthly|custom',
      until: 'repeat-until date',
      tags: 'replace tags (comma-separated)',
      'add-tags': 'add tags',
      'remove-tags': 'remove tags',
    },
    run: ({ orgRoot, args }) => {
      const ref = requireRef(args, 'reminder update');
      const repeat = str(args.flags, 'repeat');
      if (repeat && !['daily', 'weekly', 'monthly', 'custom'].includes(repeat)) {
        throw new regula.RegulaError('USAGE', `Invalid --repeat '${repeat}' (daily|weekly|monthly|custom)`);
      }
      return regula.updateReminder(orgRoot, ref, {
        remindAt: str(args.flags, 'at'),
        repeat: repeat as regula.RepeatType | undefined,
        repeatUntil: str(args.flags, 'until'),
        tags: csv(args.flags, 'tags'),
        addTags: csv(args.flags, 'add-tags'),
        removeTags: csv(args.flags, 'remove-tags'),
      });
    },
  },

  // ── lint ──
  {
    name: 'lint',
    summary: 'Lint the org tree (status↔folder placement, schema). Errors fail.',
    isWrite: false,
    booleanFlags: [],
    flags: { folder: 'restrict to one org-relative folder (e.g. tasks)' },
    run: ({ orgRoot, args }) => regula.lint(orgRoot, { folder: str(args.flags, 'folder') }),
    exit: (p) => (p.valid ? EXIT.OK : EXIT.ACTIONABLE),
  },

  // ── reads (regula scans; daemon-independent) ──
  {
    name: 'task list',
    summary: 'List tasks (optionally --status)',
    isWrite: false,
    booleanFlags: [],
    flags: { status: 'filter by task status' },
    run: ({ orgRoot, args }) => {
      const tasks = regula.listTasks(orgRoot, {
        status: str(args.flags, 'status') as regula.TaskStatus | undefined,
      });
      return { count: tasks.length, tasks };
    },
  },
  {
    name: 'task get',
    summary: 'Read a task (frontmatter + body)',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.getTask(orgRoot, requireRef(args, 'task get')),
  },
  {
    name: 'knowledge list',
    summary: 'List knowledge articles (optionally --folder)',
    isWrite: false,
    booleanFlags: [],
    flags: { folder: 'restrict to a knowledge subfolder' },
    run: ({ orgRoot, args }) => {
      const knowledge = regula.listKnowledge(orgRoot, { folder: str(args.flags, 'folder') });
      return { count: knowledge.length, knowledge };
    },
  },
  {
    name: 'knowledge get',
    summary: 'Read a knowledge article (by path)',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.getKnowledge(orgRoot, requireRef(args, 'knowledge get')),
  },
  {
    name: 'reminder list',
    summary: 'List reminders (optionally --status)',
    isWrite: false,
    booleanFlags: [],
    flags: { status: 'filter by reminder status' },
    run: ({ orgRoot, args }) => {
      const reminders = regula.listReminders(orgRoot, {
        status: str(args.flags, 'status') as regula.ReminderStatus | undefined,
      });
      return { count: reminders.length, reminders };
    },
  },
  {
    name: 'reminder get',
    summary: 'Read a reminder (by slug or path)',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => regula.getReminder(orgRoot, requireRef(args, 'reminder get')),
  },

  // ── daemon reads (index / graph / search over HTTP) ──
  {
    name: 'graph',
    summary: 'Knowledge graph data from the daemon (nodes/links/clusters)',
    isWrite: false,
    booleanFlags: [],
    flags: { scope: 'seed path for a neighborhood scope', depth: 'neighborhood depth' },
    run: async ({ args }) => {
      const params = new URLSearchParams();
      const scope = str(args.flags, 'scope');
      if (scope) params.set('scope', scope);
      const depth = str(args.flags, 'depth');
      if (depth) params.set('depth', depth);
      const qs = params.toString();
      return daemonGet(`/api/graph${qs ? `?${qs}` : ''}`);
    },
  },
  {
    name: 'search',
    summary:
      'Search the house: --mode index (fuzzy, default), lex (BM25), vec (vectors), query (hybrid)',
    isWrite: false,
    booleanFlags: [],
    flags: {
      query: 'search query (or first positional)',
      mode: 'index|lex|vec|query (default index; non-index modes need iris qmd setup)',
      type: 'restrict to a doc type (client-side filter on index mode; ignored by qmd ranking)',
      n: 'result count (passed as limit for qmd modes; client-side slice for index)',
    },
    run: async ({ args }) => {
      const q = str(args.flags, 'query') ?? args.positional[0];
      if (!q) throw new regula.RegulaError('USAGE', 'search requires a query (positional or --query)');
      const mode = (str(args.flags, 'mode') ?? 'index').toLowerCase();
      if (!['index', 'lex', 'vec', 'query'].includes(mode)) {
        throw new regula.RegulaError(
          'USAGE',
          `Invalid --mode '${mode}' (expected index|lex|vec|query)`,
        );
      }
      const nStr = str(args.flags, 'n');
      let n: number | undefined;
      if (nStr !== undefined) {
        n = Number(nStr);
        if (!Number.isFinite(n) || n <= 0) {
          throw new regula.RegulaError('USAGE', `Invalid --n '${nStr}' (expected a positive integer)`);
        }
      }

      const params = new URLSearchParams();
      params.set('q', q);
      if (mode !== 'index') params.set('mode', mode);
      if (n !== undefined) params.set('limit', String(n));
      const raw = (await daemonGet(`/api/search?${params}`)) as {
        query: string;
        count: number;
        total: number;
        items: Array<Record<string, unknown>>;
        available?: boolean;
        reason?: string;
        backend?: string;
        mode?: string;
      };
      const type = str(args.flags, 'type');
      let items = type ? raw.items.filter((it) => it.type === type) : raw.items;
      if (mode === 'index' && n !== undefined) items = items.slice(0, n);
      return {
        query: raw.query,
        mode,
        count: items.length,
        total: raw.total,
        items,
        ...(raw.available === false
          ? { available: false, reason: raw.reason }
          : raw.backend
            ? { available: true, backend: raw.backend }
            : {}),
      };
    },
  },
  {
    name: 'links',
    summary: 'Resolved outbound links + backlinks for a document (daemon index)',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: async ({ args }) => {
      const ref = requireRef(args, 'links');
      const data = (await daemonGet(`/api/files/${encodeURIComponent(ref)}`)) as {
        resolvedOutbound?: unknown[];
        resolvedBacklinks?: unknown[];
      };
      return {
        path: ref,
        outbound: data.resolvedOutbound ?? [],
        backlinks: data.resolvedBacklinks ?? [],
      };
    },
  },

  // ── athanor (pipeline engine — subprocess dispatch + forge/ fs reads) ──
  {
    name: 'athanor list',
    summary: 'List recent athanor pipeline manifests (forge/sessions/), newest first',
    isWrite: false,
    booleanFlags: [],
    flags: { limit: 'max pipelines (default 10)' },
    run: ({ orgRoot, args }) => {
      const limitStr = str(args.flags, 'limit');
      let limit: number | undefined;
      if (limitStr !== undefined) {
        limit = Number(limitStr);
        if (!Number.isInteger(limit) || limit <= 0) throw new regula.RegulaError('USAGE', `Invalid --limit '${limitStr}' (expected a positive integer)`);
      }
      return athanor.listPipelines(orgRoot, limit) as unknown as Record<string, unknown>;
    },
  },
  {
    name: 'athanor recipes',
    summary: 'List athanor recipes — enumerated from the REAL registry (never a hardcoded list, which drifts)',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot }) => athanor.parseRecipeRegistry(orgRoot) as unknown as Record<string, unknown>,
  },
  {
    name: 'athanor status',
    summary: 'Reconstruct a pipeline status from its manifest on disk (+ crash log)',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => athanor.pipelineStatus(orgRoot, requireRef(args, 'athanor status')),
  },
  {
    name: 'athanor results',
    summary: "Read a completed pipeline's layer handles (--full also loads full outputs)",
    isWrite: false,
    booleanFlags: ['full'],
    flags: { layer: 'layer number (default: the last)' },
    run: ({ orgRoot, args }) => {
      const layerStr = str(args.flags, 'layer');
      let layer: number | undefined;
      if (layerStr !== undefined) {
        layer = Number(layerStr);
        if (!Number.isInteger(layer) || layer < 0) throw new regula.RegulaError('USAGE', `Invalid --layer '${layerStr}' (expected a non-negative integer)`);
      }
      return athanor.pipelineResults(orgRoot, requireRef(args, 'athanor results'), {
        layer,
        full: args.flags.full === true,
      });
    },
  },
  {
    name: 'athanor run',
    summary: 'Dispatch an athanor pipeline (detached subprocess). --preview shows what would run without dispatching',
    isWrite: true,
    booleanFlags: ['clean', 'preview'],
    flags: {
      recipe: 'recipe name (see `athanor recipes`)',
      goal: 'one-line pipeline goal',
      sources: 'comma-separated source files (org-relative)',
      concerns: 'layer→concerns JSON, e.g. \'{"1":["angle-a","angle-b"]}\' (assay/deep-review/copia need layer 1)',
      'concerns-file': 'path to an existing concerns JSON file (org-relative or absolute)',
      name: 'pipeline name (default: slug of the goal)',
    },
    run: ({ orgRoot, args }) => {
      const concernsRaw = str(args.flags, 'concerns');
      let concerns: Record<string, string[]> | undefined;
      if (concernsRaw !== undefined) {
        try {
          const parsed: unknown = JSON.parse(concernsRaw);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected a JSON object of layer→string[]');
          concerns = parsed as Record<string, string[]>;
        } catch (e) {
          throw new regula.RegulaError('USAGE', `Invalid --concerns JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const plan = athanor.buildRunPlan(orgRoot, {
        recipe: str(args.flags, 'recipe') ?? '',
        goal: str(args.flags, 'goal') ?? '',
        sources: csv(args.flags, 'sources') ?? [],
        concerns,
        concernsFile: str(args.flags, 'concerns-file'),
        name: str(args.flags, 'name'),
        clean: args.flags.clean === true,
      });
      return args.flags.preview === true ? athanor.previewRun(plan) : athanor.dispatchRun(plan);
    },
  },

  // ── lucerna (agency control — thin clients over /api/lucerna/*) ──
  {
    name: 'lucerna status',
    summary: 'Lucerna health + state (via the iris daemon). Reports Offline truthfully when Lucerna is not installed',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: () => lucerna.lucernaStatus(),
  },
  {
    name: 'lucerna log',
    summary: "Tail Lucerna's activity log (via the iris daemon); --filter substring-matches",
    isWrite: false,
    booleanFlags: [],
    flags: { n: 'lines (default 50)', filter: 'only lines containing this substring' },
    run: async ({ args }) => {
      const nStr = str(args.flags, 'n');
      let n = 50;
      if (nStr !== undefined) {
        n = Number(nStr);
        if (!Number.isInteger(n) || n <= 0) throw new regula.RegulaError('USAGE', `Invalid --n '${nStr}' (expected a positive integer)`);
      }
      return lucerna.lucernaLog(n, str(args.flags, 'filter'));
    },
  },
  {
    name: 'lucerna halt',
    summary: 'Write the Lucerna halt sentinel (graceful stop; Lucerna deletes the file on consume)',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: () => lucerna.lucernaHalt(),
    exit: lucerna.lucernaWriteExit,
  },
  {
    name: 'lucerna wake',
    summary: 'Write the Lucerna wake sentinel',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: () => lucerna.lucernaWake(),
    exit: lucerna.lucernaWriteExit,
  },
  {
    name: 'lucerna sleep',
    summary: 'Write the Lucerna sleep sentinel',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: () => lucerna.lucernaSleep(),
    exit: lucerna.lucernaWriteExit,
  },
  {
    name: 'lucerna start',
    summary:
      'Start the Lucerna daemon as a detached child in the house (resolves IRIS_LUCERNA_BIN, PATH, then instruments/lucerna)',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: () => lucerna.lucernaStart(),
    exit: lucerna.lucernaWriteExit,
  },
  {
    name: 'lucerna stop',
    summary:
      'Stop Lucerna: write halt sentinel, wait bounded; escalate to pid kill only if still alive and pid is lucerna',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: () => lucerna.lucernaStop(),
    exit: lucerna.lucernaWriteExit,
  },
  {
    name: 'lucerna enable',
    summary:
      'Set durable enablement: iris lucerna enable dreams on|off | auto-commit-live on|off (defaults both off)',
    isWrite: true,
    booleanFlags: [],
    flags: {},
    run: ({ args }) => {
      const flag = args.positional[0];
      const value = args.positional[1];
      if (!flag || !value) {
        throw new regula.RegulaError(
          'USAGE',
          'lucerna enable requires <dreams|auto-commit-live> <on|off>',
        );
      }
      try {
        return lucerna.lucernaEnable(flag, value);
      } catch (e) {
        throw new regula.RegulaError('USAGE', e instanceof Error ? e.message : String(e));
      }
    },
    exit: lucerna.lucernaWriteExit,
  },
  {
    name: 'lucerna notifications',
    summary: 'Newest Lucerna house notifications (notifications.jsonl); empty when the file is absent',
    isWrite: false,
    booleanFlags: [],
    flags: { n: 'entries (default 20)' },
    run: async ({ args }) => {
      const nStr = str(args.flags, 'n');
      let n = 20;
      if (nStr !== undefined) {
        n = Number(nStr);
        if (!Number.isInteger(n) || n <= 0) {
          throw new regula.RegulaError('USAGE', `Invalid --n '${nStr}' (expected a positive integer)`);
        }
      }
      return lucerna.lucernaNotifications(n);
    },
  },
  {
    name: 'lucerna dreams',
    summary:
      'List or review Lucerna dream artifacts (session manifests + light reports). Subcommands: [list] | show <id> | review <id>. Status flip only — never executes content',
    isWrite: false, // list/show are reads; review is handled via write when subcommand is review
    booleanFlags: ['pending'],
    flags: { pending: 'only pending items' },
    run: async ({ args }) => {
      const sub = args.positional[0];
      if (!sub || sub === 'list') {
        return lucerna.lucernaDreamsList(args.flags.pending === true);
      }
      if (sub === 'show') {
        const id = args.positional[1];
        if (!id) {
          throw new regula.RegulaError('USAGE', 'lucerna dreams show requires <id>');
        }
        return lucerna.lucernaDreamShow(id);
      }
      if (sub === 'review') {
        const id = args.positional[1];
        if (!id) {
          throw new regula.RegulaError('USAGE', 'lucerna dreams review requires <id>');
        }
        // Status field flip only (pending → reviewed / light pending → acted).
        return lucerna.lucernaDreamReview(id);
      }
      throw new regula.RegulaError(
        'USAGE',
        "lucerna dreams expects [list] | show <id> | review <id> (got '" + sub + "')",
      );
    },
    exit: (p) => {
      // review returns ok; list/show do not use ok:false for empty
      if (typeof p.ok === 'boolean') return lucerna.lucernaWriteExit(p);
      if (p.found === false) return EXIT.ACTIONABLE;
      return EXIT.OK;
    },
  },
  {
    name: 'lucerna proposals',
    summary:
      'List or resolve Lucerna proposals. Subcommands: [list] | show <id> | apply <id> | close <id>. Flips status only — applying proposal CONTENT is the resident/operator job',
    isWrite: false,
    booleanFlags: ['pending'],
    flags: { pending: 'only pending items' },
    run: async ({ args }) => {
      const sub = args.positional[0];
      if (!sub || sub === 'list') {
        return lucerna.lucernaProposalsList(args.flags.pending === true);
      }
      if (sub === 'show') {
        const id = args.positional[1];
        if (!id) {
          throw new regula.RegulaError('USAGE', 'lucerna proposals show requires <id>');
        }
        return lucerna.lucernaProposalShow(id);
      }
      if (sub === 'apply') {
        const id = args.positional[1];
        if (!id) {
          throw new regula.RegulaError('USAGE', 'lucerna proposals apply requires <id>');
        }
        // Status flip only. Content is never auto-applied.
        const result = await lucerna.lucernaProposalApply(id);
        return {
          ...result,
          note: 'status flipped to applied only — applying proposal CONTENT is the resident/operator job',
        };
      }
      if (sub === 'close') {
        const id = args.positional[1];
        if (!id) {
          throw new regula.RegulaError('USAGE', 'lucerna proposals close requires <id>');
        }
        const result = await lucerna.lucernaProposalClose(id);
        return {
          ...result,
          note: 'status flipped to closed only — proposal content was not executed',
        };
      }
      throw new regula.RegulaError(
        'USAGE',
        "lucerna proposals expects [list] | show <id> | apply <id> | close <id> (got '" + sub + "')",
      );
    },
    exit: (p) => {
      if (typeof p.ok === 'boolean') return lucerna.lucernaWriteExit(p);
      if (p.found === false) return EXIT.ACTIONABLE;
      return EXIT.OK;
    },
  },

  // ── edges (vinculum — structural typed edges into graph/edges.jsonl) ──
  {
    name: 'edges derive',
    summary:
      'Derive structural typed edges from house frontmatter + self-labels; write graph/edges.jsonl (idempotent reconcile)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      house: 'house root override (default: resolved org root)',
    },
    run: ({ orgRoot, args }) => edges.runEdgesDerive(orgRoot, args),
  },
  {
    name: 'edges list',
    summary: 'List served edges from graph/edges.jsonl (table by default; --json for structured)',
    isWrite: false,
    booleanFlags: [],
    flags: {
      type: 'filter by edge type (e.g. depends-on)',
      source: 'filter by source node id',
      target: 'filter by target node id',
      'asserted-by': 'filter by provenance.asserted_by (e.g. structural-v0)',
      tier: 'filter by derivation tier on provenance (structural|0|2)',
      mechanism: 'filter by mechanism (structural|judged)',
      confidence: 'filter by confidence tier (asserted|inferred|candidate)',
      model: 'filter by provenance.model id',
      recent: 'keep only the N most recent edges by provenance.ts',
      since: 'ISO timestamp lower bound on provenance.ts',
      house: 'house root override',
    },
    run: ({ orgRoot, args }) => edges.runEdgesList(orgRoot, args),
    human: edges.edgesListHuman,
  },
  {
    name: 'edges show',
    summary: 'Show one edge by stable id with full provenance',
    isWrite: false,
    booleanFlags: [],
    flags: {
      house: 'house root override',
    },
    run: ({ orgRoot, args }) => edges.runEdgesShow(orgRoot, args),
    human: edges.edgesShowHuman,
  },
  {
    name: 'edges remove',
    summary: 'Remove one edge by stable id; durable across re-derive via graph/suppressions.jsonl',
    isWrite: true,
    booleanFlags: [],
    flags: {
      house: 'house root override',
    },
    run: ({ orgRoot, args }) => edges.runEdgesRemove(orgRoot, args),
  },
  {
    name: 'edges edit',
    summary: 'Edit note/label on an edge by stable id; preserved across re-derive via graph/overrides.jsonl',
    isWrite: true,
    booleanFlags: ['clear-note', 'clear-label'],
    flags: {
      note: 'set annotation note (user-adjustable)',
      label: 'set short display label (user-adjustable)',
      house: 'house root override',
    },
    run: ({ orgRoot, args }) => edges.runEdgesEdit(orgRoot, args),
  },
  {
    name: 'edges validate',
    summary: 'Validate every line in graph/edges.jsonl against the edge schema',
    isWrite: false,
    booleanFlags: [],
    flags: {
      house: 'house root override',
    },
    run: ({ orgRoot, args }) => edges.runEdgesValidate(orgRoot, args),
  },
  {
    name: 'edges stats',
    summary: 'Edge store counts by type / tier / provenance',
    isWrite: false,
    booleanFlags: [],
    flags: {
      house: 'house root override',
    },
    run: ({ orgRoot, args }) => edges.runEdgesStats(orgRoot, args),
  },
  {
    name: 'edges update',
    summary:
      'Agentic graph refresh: --tier 0 structural re-derive (default), --tier 1 candidate inventory, --tier 2 gen→judge→live ingest (requires amore)',
    isWrite: true,
    booleanFlags: [],
    flags: {
      tier: 'derivation tier 0|1|2 (default 0; only 2 calls a model)',
      house: 'house root override',
    },
    run: ({ orgRoot, args }) => edges.runEdgesUpdateCmd(orgRoot, args),
    human: edges.edgesUpdateHuman,
    exit: edges.edgesUpdateExit,
  },

  // ── qmd (managed local semantic search companion) ──
  {
    name: 'qmd setup',
    summary:
      'Install pinned qmd, bootstrap house collections, first index; download hybrid models unless --no-models',
    isWrite: true,
    booleanFlags: ['no-models', 'use-global'],
    flags: {},
    run: ({ orgRoot, args }) => qmd.runQmdSetup(orgRoot, args),
    human: qmd.qmdSetupHuman,
    exit: qmd.qmdExit,
  },
  {
    name: 'qmd status',
    summary: 'Runtime pin, model presence, index doc/vector/pending counts, refresh state',
    isWrite: false,
    booleanFlags: [],
    flags: {},
    run: ({ orgRoot, args }) => qmd.runQmdStatus(orgRoot, args),
    human: qmd.qmdStatusHuman,
    exit: qmd.qmdExit,
  },
  {
    name: 'qmd update',
    summary: 'Incremental re-walk of house collections; --embed processes pending vectors when models exist',
    isWrite: true,
    booleanFlags: ['embed'],
    flags: {},
    run: ({ orgRoot, args }) => qmd.runQmdUpdate(orgRoot, args),
    exit: qmd.qmdExit,
  },
];

export interface ResolvedCommand {
  spec: CommandSpec;
  rest: string[];
}

/** Resolve a (possibly two-word) command from argv, returning the matched spec + remaining args. */
export function resolveCommand(argv: string[]): ResolvedCommand | { error: string } {
  if (argv.length === 0) return { error: 'no command given' };
  const twoWord = argv.length >= 2 && !argv[1].startsWith('--') ? `${argv[0]} ${argv[1]}` : null;
  let spec = twoWord ? COMMANDS.find((c) => c.name === twoWord) : undefined;
  if (spec) return { spec, rest: argv.slice(2) };
  spec = COMMANDS.find((c) => c.name === argv[0]);
  if (spec) return { spec, rest: argv.slice(1) };
  return { error: `Unknown command: ${argv.slice(0, 2).join(' ')}` };
}

/** The capability manifest (drives `iris commands --json` / `iris regula commands --json`). */
export function manifest(): Record<string, unknown> {
  return {
    commands: COMMANDS.map((c) => ({
      name: c.name,
      summary: c.summary,
      isWrite: c.isWrite,
      booleanFlags: c.booleanFlags,
      flags: c.flags,
      hasHumanOutput: c.human !== undefined,
    })),
  };
}
