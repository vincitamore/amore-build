import { basename, join } from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { readDoc } from './doc';
import { relPath } from './util';
import {
  LIFECYCLED_INBOX_TYPES,
  REMINDER_STATUSES,
  TASK_STATUSES,
  isInboxTerminalStatus,
  reminderFolder,
  taskFolder,
  type Frontmatter,
  type ReminderStatus,
  type TaskStatus,
} from './schema';

export type LintSeverity = 'error' | 'warning';

export interface LintIssue {
  path: string;
  field: string;
  issue: string;
  severity: LintSeverity;
}

export interface LintResult {
  filesScanned: number;
  errorCount: number;
  warningCount: number;
  valid: boolean;
  issues: LintIssue[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** context/current-state.md's word-count warning threshold (§ current-state-staleness). Tunable. */
export const CURRENT_STATE_MAX_WORDS = 6000;

/** context/current-state.md's dated-section staleness threshold, in days (§ current-state-staleness). Tunable. */
export const CURRENT_STATE_STALE_DAYS = 21;

/** active-task-staleness threshold, in days (§ active-task-staleness). Tunable. */
export const ACTIVE_TASK_STALE_DAYS = 21;

/**
 * context/project-map.md's fs-mtime staleness threshold, in days (§ project-map-staleness).
 * Mirrors CURRENT_STATE_STALE_DAYS. A healthy map churns at least monthly. Tunable.
 */
export const PROJECT_MAP_STALE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const CURRENT_STATE_PATH = 'context/current-state.md';
const DATED_SECTION_RE = /^## Recent structural changes \((\d{4}-\d{2}-\d{2})\)/gm;

const PROJECT_MAP_PATH = 'context/project-map.md';
/** Top-level dirs whose project-map.md coverage is checked (both enumerated; each message names the real parent). */
const PROJECT_MAP_ROOTS = ['projects', 'instruments'] as const;

/**
 * current-state.md is the dynamic counterpart to AGENTS.md — standing reality, not an
 * archive. Unlike the four schema'd types above, this check targets one specific file
 * by path and reads its body (word count, dated section headings), so it can't live in
 * `lintDoc`'s frontmatter-only, type-dispatched checks. Warn (never error — neither
 * condition blocks correct operation) when the body has grown past a size a session can
 * orient from cheaply, or when dated sections have aged out of "recent". Remedy in both
 * cases: migrate the offending sections verbatim to `context/previous-state.md`
 * (append-only archive) — current-state.md states standing reality only.
 */
export function lintCurrentState(content: string, path: string, now: Date = new Date()): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (field: string, issue: string) => issues.push({ path, field, issue, severity: 'warning' });

  const trimmed = content.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  if (wordCount > CURRENT_STATE_MAX_WORDS) {
    push(
      'length',
      `Body is ${wordCount} words (over ${CURRENT_STATE_MAX_WORDS}) — migrate old sections verbatim to context/previous-state.md; current-state.md states standing reality only.`,
    );
  }

  const staleCutoff = new Date(now);
  staleCutoff.setDate(staleCutoff.getDate() - CURRENT_STATE_STALE_DAYS);
  const staleDates: string[] = [];
  for (const m of content.matchAll(DATED_SECTION_RE)) {
    const sectionDate = new Date(`${m[1]}T00:00:00`);
    if (!Number.isNaN(sectionDate.getTime()) && sectionDate < staleCutoff) staleDates.push(m[1]);
  }
  if (staleDates.length > 0) {
    push(
      'staleness',
      `${staleDates.length} dated section(s) older than ${CURRENT_STATE_STALE_DAYS} days: ${staleDates.join(', ')} — migrate verbatim to context/previous-state.md.`,
    );
  }

  return issues;
}

/**
 * Lint one document's frontmatter against the schema.
 *
 * `dirRel` is the document's directory, org-root-relative (e.g. `tasks/paused`). It
 * powers the PLACEMENT check — verifying status matches folder. examen's lint never
 * checked placement and never linted reminders at all, so it couldn't even detect the
 * status↔folder drift that its own `task_update` produced. Both are climbs here.
 */
export function lintDoc(fm: Frontmatter, path: string, dirRel: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (field: string, issue: string, severity: LintSeverity = 'error') =>
    issues.push({ path, field, issue, severity });

  if (!fm.type) push('type', 'Missing required field');
  if (!fm.created) push('created', 'Missing required field');
  else if (typeof fm.created === 'string' && !DATE_RE.test(fm.created)) {
    push('created', 'Invalid date format (expected YYYY-MM-DD)');
  }
  if (fm.tags && !Array.isArray(fm.tags)) push('tags', 'tags should be an array');

  if (fm.type === 'task') {
    if (!fm.status) push('status', 'Missing required field for tasks');
    else if (!(TASK_STATUSES as readonly string[]).includes(fm.status)) {
      push('status', `Invalid task status: ${fm.status}`, 'warning');
    } else {
      const expected = taskFolder(fm.status as TaskStatus);
      if (dirRel !== expected) {
        push('status', `placed in '${dirRel}' but status '${fm.status}' belongs in '${expected}'`);
      }
    }
    if (fm['blocked-by'] && !Array.isArray(fm['blocked-by'])) {
      push('blocked-by', 'blocked-by should be an array');
    }
    if (fm.status === 'complete' && !fm.completed) {
      push('completed', "status 'complete' but no completed date", 'warning');
    }
    // paused-missing-trigger: a paused task without a named falsifiable trigger-to-unpause
    // can only be unpaused by someone re-deriving why it stopped — the trigger is what makes
    // "is it stuck or just defocused?" answerable without archaeology.
    if (fm.status === 'paused' && !fm['trigger-to-unpause']) {
      push(
        'trigger-to-unpause',
        "status 'paused' but no trigger-to-unpause — name the falsifiable unpause condition",
        'warning',
      );
    }
  } else if (fm.type === 'knowledge') {
    if (!fm.updated) push('updated', 'Missing updated field (tracks last edit)', 'warning');
    if (!fm.tags || (Array.isArray(fm.tags) && fm.tags.length === 0)) {
      push('tags', 'Knowledge article has no tags', 'warning');
    }
  } else if (fm.type === 'inbox') {
    if (!fm.source) push('source', 'Missing source field', 'warning');
    // Placement for the lifecycle'd types: a terminal status lives in inbox/<type>/resolved/,
    // an open item at inbox/<type>/. This is the drift a half-completed resolve leaves behind.
    const m = dirRel.match(/^inbox\/([^/]+)(\/resolved)?$/);
    if (m && (LIFECYCLED_INBOX_TYPES as readonly string[]).includes(m[1])) {
      const inResolved = Boolean(m[2]);
      const terminal = typeof fm.status === 'string' && isInboxTerminalStatus(fm.status);
      if (terminal && !inResolved) {
        push('status', `terminal status '${String(fm.status)}' belongs in 'inbox/${m[1]}/resolved'`);
      } else if (!terminal && inResolved) {
        push('status', `placed in 'inbox/${m[1]}/resolved' but status '${String(fm.status ?? 'open')}' is not terminal`);
      }
    }
  } else if (fm.type === 'reminder') {
    if (!fm.status) push('status', 'Missing required field for reminders');
    else if (!(REMINDER_STATUSES as readonly string[]).includes(fm.status)) {
      push('status', `Invalid reminder status: ${fm.status}`, 'warning');
    } else {
      const expected = reminderFolder(fm.status as ReminderStatus);
      if (dirRel !== expected) {
        push('status', `placed in '${dirRel}' but status '${fm.status}' belongs in '${expected}'`);
      }
    }
    if (!fm['remind-at']) push('remind-at', 'Missing remind-at', 'warning');
  }

  return issues;
}

/** Recursively collect .md files under `dir`, each tagged with its org-relative directory. */
function walkMd(orgRoot: string, dir: string): { abs: string; dirRel: string }[] {
  const out: { abs: string; dirRel: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(orgRoot, abs));
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ abs, dirRel: relPath(orgRoot, dir) });
    }
  }
  return out;
}

/** The canonical status folders a task may live in (active/blocked share the `tasks` root). */
const TASK_STATUS_FOLDERS = new Set<string>(TASK_STATUSES.map(taskFolder));

/**
 * same-stem-across-status-folders — a cross-file check (not per-doc, so it cannot live in
 * `lintDoc`). A status/completion move renames a task file into a status subfolder under
 * its SAME stem. If that stem already exists in another status folder, the move clobbers;
 * and a stem already present in two status folders means a prior move copied instead of
 * moving, leaving two live docs whose `status:` fields contradict. Neither is ever
 * legitimate, so this is always an error. Only files directly under a canonical task
 * status folder are considered, so unrelated nesting can't produce a false positive.
 */
export function lintTaskStemCollisions(orgRoot: string): LintIssue[] {
  const base = join(orgRoot, 'tasks');
  if (!existsSync(base)) return [];

  const byStem = new Map<string, string[]>();
  for (const { abs, dirRel } of walkMd(orgRoot, base)) {
    if (!TASK_STATUS_FOLDERS.has(dirRel)) continue;
    const stem = basename(abs, '.md');
    const list = byStem.get(stem) ?? [];
    list.push(relPath(orgRoot, abs));
    byStem.set(stem, list);
  }

  const issues: LintIssue[] = [];
  for (const [stem, paths] of byStem) {
    const folders = new Set(paths.map((p) => p.slice(0, p.lastIndexOf('/'))));
    if (folders.size < 2) continue;
    const sorted = [...paths].sort();
    issues.push({
      path: sorted[0],
      field: 'stem',
      issue:
        `stem '${stem}' present in ${folders.size} status folders — a status/completion move onto ` +
        `an existing stem clobbers, and a stem in two folders is a copy-not-move with contradictory ` +
        `status; consolidate to one: ${sorted.join(', ')}`,
      severity: 'error',
    });
  }
  return issues;
}

/**
 * active-task-staleness — a filesystem-mtime check (not per-frontmatter, so it cannot live
 * in `lintDoc`, which sees only parsed frontmatter). Flags active tasks untouched past a
 * threshold with no blocker recorded: `status: active`, whose last file write (fs mtime,
 * not git) exceeds ACTIVE_TASK_STALE_DAYS, AND whose `blocked-by` is empty/absent AND whose
 * `blocked-on` is unset. A recorded blocker already explains the dormancy, so a blocked task
 * is never stale in this sense. Warn (never error) — a dormant-but-live task blocks no
 * correct operation; the remedy is a judgment call (reconfirm active, set a blocker, or
 * advance the task). `now` is injectable for deterministic tests.
 */
export function lintActiveTaskStaleness(orgRoot: string, now: Date = new Date()): LintIssue[] {
  const base = join(orgRoot, 'tasks');
  if (!existsSync(base)) return [];

  const cutoffMs = now.getTime() - ACTIVE_TASK_STALE_DAYS * MS_PER_DAY;
  const issues: LintIssue[] = [];

  for (const { abs } of walkMd(orgRoot, base)) {
    let fm: Frontmatter;
    let mtimeMs: number;
    try {
      fm = readDoc(abs).frontmatter;
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      continue; // unreadable/unparseable files are reported by the main lint walk
    }

    if (fm.type !== 'task' || fm.status !== 'active') continue;

    const blockedBy = fm['blocked-by'];
    const hasBlockedBy = Array.isArray(blockedBy) ? blockedBy.length > 0 : Boolean(blockedBy);
    const hasBlockedOn = Boolean(fm['blocked-on']);
    if (hasBlockedBy || hasBlockedOn) continue;

    if (mtimeMs < cutoffMs) {
      const days = Math.floor((now.getTime() - mtimeMs) / MS_PER_DAY);
      issues.push({
        path: relPath(orgRoot, abs),
        field: 'staleness',
        issue:
          `active task untouched for ${days} days (over ${ACTIVE_TASK_STALE_DAYS}) with no blocker ` +
          `(blocked-by/blocked-on) — reconfirm it's active, record a blocker, or advance it`,
        severity: 'warning',
      });
    }
  }

  return issues;
}

/**
 * Does `name` appear anywhere in the (already-lowercased) map body? Case-insensitive substring is
 * the base test: a name mentioned anywhere — a topology row OR the map's "Deliberately unmapped"
 * note — counts as covered, so that note IS the ignore mechanism and no ignore list is hardcoded
 * here. For 1–2 char names a raw substring is degenerate (it would spuriously match inside unrelated
 * words and silently pass a genuinely unmapped dir), so those require a word-boundary hit instead.
 */
function mapMentions(mapLower: string, name: string): boolean {
  const n = name.toLowerCase();
  if (n.length <= 2) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(mapLower);
  }
  return mapLower.includes(n);
}

/**
 * project-map-coverage — a presence check of the on-disk project/instrument dirs against their
 * mention in context/project-map.md (not per-frontmatter, so it cannot live in `lintDoc`). The map
 * rotted for months precisely because nothing mechanical guarded it — contrast lintCurrentState
 * above, which current-state.md earned after its own rot. A top-level dir under projects/ or
 * instruments/ whose name appears NOWHERE in the map body is drift: either the map is missing a
 * project, or the project should be named in the map's "Deliberately unmapped" note. Warn (never
 * error) — an unmentioned dir blocks no correct operation; the remedy is a judgment call. There is
 * deliberately no ignore list in this rule: to silence a dir, name it in the "Deliberately unmapped"
 * note, which satisfies the same substring test a topology row would. If the map file itself is
 * absent, that's a single error and the rule returns — the guard cannot run without the map. (The
 * aggregate `lint()` only invokes this when the map exists, mirroring the current-state block, so
 * the absent-map error is a defensive property for direct callers, not a full-tree signal.)
 */
export function lintProjectMapCoverage(orgRoot: string): LintIssue[] {
  const mapAbs = join(orgRoot, PROJECT_MAP_PATH);
  if (!existsSync(mapAbs)) {
    return [
      {
        path: PROJECT_MAP_PATH,
        field: 'file',
        issue: `${PROJECT_MAP_PATH} is absent — the project-map coverage guard cannot run`,
        severity: 'error',
      },
    ];
  }

  let mapLower: string;
  try {
    mapLower = readFileSync(mapAbs, 'utf8').toLowerCase();
  } catch {
    return [{ path: PROJECT_MAP_PATH, field: 'file', issue: 'Unreadable / unparseable', severity: 'error' }];
  }

  const issues: LintIssue[] = [];
  for (const root of PROJECT_MAP_ROOTS) {
    const base = join(orgRoot, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!mapMentions(mapLower, entry.name)) {
        issues.push({
          path: `${root}/${entry.name}`,
          field: 'coverage',
          issue:
            `${root}/${entry.name} has no mention in ${PROJECT_MAP_PATH} — add it to the topology ` +
            `or to the map's "Deliberately unmapped" note`,
          severity: 'warning',
        });
      }
    }
  }
  return issues;
}

/**
 * project-map-staleness — a filesystem-mtime check on context/project-map.md (not per-frontmatter,
 * so it cannot live in `lintDoc`). Mirrors lintCurrentState's staleness arm but keyed on fs mtime
 * rather than dated section headings, since the map carries no such headings. A healthy map churns
 * at least monthly (projects move in/out, instruments land); an mtime older than PROJECT_MAP_STALE_DAYS
 * means the topology has gone untouched long enough that drift is likely even where
 * lintProjectMapCoverage can't see it (a renamed-in-place project, a stale description). Warn (never
 * error). Remedy: re-verify the map against the tree per the audit protocol. Strictly-older
 * semantics (a map exactly at the threshold is not yet stale). `now` is injectable for tests.
 */
export function lintProjectMapStaleness(orgRoot: string, now: Date = new Date()): LintIssue[] {
  const mapAbs = join(orgRoot, PROJECT_MAP_PATH);
  if (!existsSync(mapAbs)) return []; // absence is lintProjectMapCoverage's error to raise, not this rule's

  let mtimeMs: number;
  try {
    mtimeMs = statSync(mapAbs).mtimeMs;
  } catch {
    return [];
  }

  const cutoffMs = now.getTime() - PROJECT_MAP_STALE_DAYS * MS_PER_DAY;
  if (mtimeMs >= cutoffMs) return [];

  const days = Math.floor((now.getTime() - mtimeMs) / MS_PER_DAY);
  return [
    {
      path: PROJECT_MAP_PATH,
      field: 'staleness',
      issue:
        `${PROJECT_MAP_PATH} fs mtime is ${days} days old (over ${PROJECT_MAP_STALE_DAYS}) — a healthy map ` +
        `churns at least monthly; re-verify it against the tree per forge/output/project-map-audit/_protocol.md`,
      severity: 'warning',
    },
  ];
}

export interface LintOptions {
  /** Restrict to one org-relative folder (e.g. 'tasks'); default lints tasks/knowledge/inbox/reminders. */
  folder?: string;
}

/** Lint the org tree (or one folder). Errors fail; warnings don't. */
export function lint(orgRoot: string, opts: LintOptions = {}): LintResult {
  const issues: LintIssue[] = [];
  let filesScanned = 0;
  const roots = opts.folder ? [opts.folder] : ['tasks', 'knowledge', 'inbox', 'reminders'];

  for (const r of roots) {
    const base = join(orgRoot, r);
    if (!existsSync(base)) continue;
    for (const { abs, dirRel } of walkMd(orgRoot, base)) {
      filesScanned++;
      try {
        const doc = readDoc(abs);
        issues.push(...lintDoc(doc.frontmatter, relPath(orgRoot, abs), dirRel));
      } catch {
        issues.push({ path: relPath(orgRoot, abs), field: 'file', issue: 'Unreadable / unparseable', severity: 'error' });
      }
    }
  }

  // same-stem-across-status-folders: a cross-file check over tasks/ (re-walks already-scanned
  // files, so it adds no filesScanned). Runs on a full-tree lint or a tasks-scoped one.
  if (!opts.folder || opts.folder === 'tasks') {
    issues.push(...lintTaskStemCollisions(orgRoot));
    // active-task-staleness: re-walks tasks/ for mtime (adds no filesScanned). Same scoping
    // as the stem-collision check — full-tree lint or a tasks-scoped one.
    issues.push(...lintActiveTaskStaleness(orgRoot));
  }

  // current-state-staleness: a single targeted file, not a folder walk — runs only on a
  // full-tree lint (no --folder), so it never fires alongside an unrelated folder-scoped
  // run and never double-scans the file if 'context' were ever passed as --folder (which
  // would already walk it generically via the roots loop above).
  if (!opts.folder) {
    const currentStateAbs = join(orgRoot, CURRENT_STATE_PATH);
    if (existsSync(currentStateAbs)) {
      filesScanned++;
      try {
        const doc = readDoc(currentStateAbs);
        issues.push(...lintCurrentState(doc.content, relPath(orgRoot, currentStateAbs)));
      } catch {
        issues.push({ path: CURRENT_STATE_PATH, field: 'file', issue: 'Unreadable / unparseable', severity: 'error' });
      }
    }

    // project-map coverage + staleness: single-targeted files under context/, the same class as
    // current-state above — full-tree only (never fires under an unrelated --folder run). Both rules
    // read context/project-map.md; guard on its existence exactly as the current-state block does, so
    // a temp/partial tree with no map produces no project-map issues here (the absent-map error is a
    // defensive property of lintProjectMapCoverage for direct callers, not a full-tree signal). Count
    // the map once as a scanned file when present (both rules read the one file).
    const projectMapAbs = join(orgRoot, PROJECT_MAP_PATH);
    if (existsSync(projectMapAbs)) {
      filesScanned++;
      issues.push(...lintProjectMapCoverage(orgRoot));
      issues.push(...lintProjectMapStaleness(orgRoot));
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return {
    filesScanned,
    errorCount,
    warningCount: issues.length - errorCount,
    valid: errorCount === 0,
    issues,
  };
}
