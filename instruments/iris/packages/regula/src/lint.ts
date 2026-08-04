import { basename, join, parse, resolve } from 'path';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { readDoc } from './doc';
import { relPath } from './util';
import {
  INBOX_TYPES,
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
  /** 1-based source line for body-level findings (wikilinks); absent for frontmatter findings. */
  line?: number;
}

export interface LintResult {
  filesScanned: number;
  errorCount: number;
  warningCount: number;
  valid: boolean;
  issues: LintIssue[];
  /** Skip-with-note entries for optional rules whose source is absent (never findings). */
  notes: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Date-only stamp (anchored full-match) for the schema date keys. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Datetime stamp — accepts both the file form (`2026-08-02T09:00`) and the normalized form
 * (`2026-08-02T09:00:00.000Z`, what normalizeYamlDates produces for a time-bearing value).
 */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Top-level scope dir -> required frontmatter `type` (README.md index files exempt). */
const SCOPE_TYPES: Record<string, string> = {
  tasks: 'task',
  inbox: 'inbox',
  knowledge: 'knowledge',
  reminders: 'reminder',
};

/** Enumerated scalar domains, checked whenever the key is present (AGENTS.md schema claims). */
const SOURCE_VALUES = ['capture', 'operator', 'session'] as const;
const REPEAT_VALUES = ['daily', 'weekly', 'monthly', 'custom'] as const;

/** Date-only frontmatter keys (YYYY-MM-DD). `created` has its own dedicated check. */
const DATE_KEYS = ['updated', 'completed', 'resolved', 'paused', 'repeat-until'] as const;
/** Datetime frontmatter keys (ISO date or datetime). */
const DATETIME_KEYS = ['remind-at', 'snoozed-until'] as const;

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

  // type↔folder: a doc's `type` must match its top-level scope folder (README.md index files exempt).
  const top = dirRel.split('/')[0]!;
  const base = path.split('/').pop()!;
  if (base !== 'README.md' && top in SCOPE_TYPES && fm.type !== SCOPE_TYPES[top]) {
    push('type', `type '${String(fm.type ?? null)}' but ${top}/ requires '${SCOPE_TYPES[top]}'`);
  }

  // inbox folder admission: only regula's inbox types are legal under inbox/ (any depth).
  const parts = dirRel.split('/');
  if (parts[0] === 'inbox' && parts.length >= 2 && !(INBOX_TYPES as readonly string[]).includes(parts[1]!)) {
    push('file', `unknown inbox folder '${dirRel}' — files live in ${(INBOX_TYPES as readonly string[]).join('|')}, optionally under resolved/`);
  }

  // enumerated scalar domains, checked whenever the key is present (warning — a bad value
  // blocks no correct operation; structural violations are placement/type, below)
  for (const [key, domain] of [
    ['source', SOURCE_VALUES],
    ['repeat', REPEAT_VALUES],
  ] as const) {
    const v = fm[key];
    if (v === undefined || v === null) continue;
    if (!(domain as readonly string[]).includes(String(v))) {
      push(key, `${key}: ${JSON.stringify(v)} outside domain [${(domain as readonly string[]).join(', ')}]`, 'warning');
    }
  }

  // date / datetime formats, checked whenever the key is present (null is legal; warning —
  // a malformed stamp blocks no correct operation)
  for (const key of DATE_KEYS) {
    const v = fm[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !DATE_ONLY_RE.test(v)) {
      push(key, `${key}: must be YYYY-MM-DD or null, got ${JSON.stringify(v)}`, 'warning');
    }
  }
  for (const key of DATETIME_KEYS) {
    const v = fm[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !DATETIME_RE.test(v)) {
      push(key, `${key}: must be an ISO date or datetime, got ${JSON.stringify(v)}`, 'warning');
    }
  }

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
    if (fm.status === 'paused' && !fm.paused) {
      push('paused', "status 'paused' but no paused date — stamp when it stopped", 'warning');
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
    // Terminal lifecycle fields: a resolved/dropped/superseded item must stamp the day the
    // resolving work shipped and a one-line resolution + wikilink (AGENTS.md inbox schema).
    if (typeof fm.status === 'string' && isInboxTerminalStatus(fm.status)) {
      if (!fm.resolved) {
        push('resolved', `status '${fm.status}' but no resolved date — stamp the day the resolving work shipped`, 'warning');
      }
      if (typeof fm.resolution !== 'string' || fm.resolution.trim() === '') {
        push('resolution', `status '${fm.status}' but no resolution line + wikilink`, 'warning');
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
    if (fm.status === 'snoozed' && (fm['snoozed-until'] === undefined || fm['snoozed-until'] === null)) {
      push('snoozed-until', "status 'snoozed' but no snoozed-until — name when it re-surfaces", 'warning');
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wikilinks — presence + repo-root-relative resolution (ported from the house
// hand-rolled lint; code-stripped so fences/inline code never count as prose).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank code regions (fenced blocks and `inline code`) so wikilink extraction never
 * counts a spec against itself. Line numbers are preserved by blanking, not deleting.
 */
export function stripCode(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      out.push('');
      fence = fence === null ? fenceMatch[1]![0]!.repeat(3) : null;
      continue;
    }
    if (fence !== null) {
      out.push('');
      continue;
    }
    out.push(line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length)));
  }
  return out;
}

export interface WikiLink {
  target: string;
  line: number;
}

/**
 * Split a wikilink body into its target. Both `|` and `\|` act as the alias delimiter — the
 * `\|` form is the Markdown-table-cell escape, so `[[target\|alias]]` inside a table row is
 * semantically `[[target|alias]]` and the backslash is stripped. The alias itself is display-only
 * and not part of resolution.
 */
function splitWikilinkTarget(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '|') continue;
    const backslash = i > 0 && raw[i - 1] === '\\';
    return raw.slice(0, i - (backslash ? 1 : 0)).trim();
  }
  return raw.trim();
}

/** Extract [[target]] / [[target|alias]] wikilinks, anchor-stripped, 1-based line numbers. */
export function extractWikilinks(text: string): WikiLink[] {
  const stripped = stripCode(text);
  const links: WikiLink[] = [];
  const re = /\[\[([^\[\]]+)\]\]/g;
  stripped.forEach((line, idx) => {
    for (const m of line.matchAll(re)) {
      const raw = m[1]!.trim();
      if (raw === '') continue;
      let target = splitWikilinkTarget(raw);
      const hash = target.indexOf('#');
      if (hash !== -1) target = target.slice(0, hash).trim();
      if (target !== '') links.push({ target, line: idx + 1 });
    }
  });
  return links;
}

/**
 * Component-wise case-EXACT existence check. Node's existsSync is only as exact as the
 * underlying filesystem (case-insensitive on Windows/macOS), so a link that would 404 on a
 * case-sensitive checkout can look resolvable here. Walking each component through readdir
 * gives the portable answer.
 */
export function existsCaseExact(absPath: string): boolean {
  const { root: vol } = parse(absPath);
  if (!vol) return false;
  let cur = vol;
  for (const part of absPath.slice(vol.length).split(/[\\/]+/).filter(Boolean)) {
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    cur = join(cur, part);
  }
  return true;
}

/** Org-root-wide .md index (posix rel paths, case-exact by construction) — the wikilink referent set. */
function walkAllMd(orgRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(relPath(orgRoot, full));
    }
  };
  walk(orgRoot);
  return out;
}

/**
 * Wikilink presence + resolution for one document.
 *
 * Scope dirs (tasks/knowledge/inbox/reminders): resolution at error severity (a broken link
 * in an org document is structural rot); presence at warning severity — a fresh regula-created
 * scaffold legitimately carries no link until native expansion, so hard-failing would block the
 * normal create flow (the anti-stub contract).
 *
 * context/ files: resolution at warning severity (operator decision — orientation files churn,
 * and a broken link there costs a failed lookup, never a corrupt operation) and no presence
 * rule (current-state/README/generated files are not org documents under the link convention).
 */
export function lintWikilinks(
  orgRoot: string,
  content: string,
  path: string,
  inContext: boolean,
  repoMd: Set<string>,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const links = extractWikilinks(content);
  if (!inContext && links.length === 0) {
    issues.push({
      path,
      field: 'wikilink',
      issue: 'no [[wikilink]] in prose (code fences/inline code excluded)',
      severity: 'warning',
    });
  }
  const seen = new Set<string>();
  for (const link of links) {
    if (seen.has(link.target)) continue;
    seen.add(link.target);
    // skill:// references (e.g. [[skill://tui]]) resolve through the harness's
    // skill loader, not the repo — they are never file paths, so skip them.
    if (link.target.startsWith('skill://')) continue;
    const rel = link.target.endsWith('.md') ? link.target : `${link.target}.md`;
    if (repoMd.has(rel)) continue;
    const severity: LintSeverity = inContext ? 'warning' : 'error';
    if (rel.startsWith('../')) {
      if (existsCaseExact(join(orgRoot, rel))) continue;
      issues.push({
        path,
        field: 'wikilink',
        issue: `[[${link.target}]] → no such file (${rel}) (cross-tree, case-exact)`,
        severity,
        line: link.line,
      });
      continue;
    }
    if (existsSync(join(orgRoot, rel))) {
      issues.push({
        path,
        field: 'wikilink',
        issue: `[[${link.target}]] resolves only case-insensitively — breaks on case-sensitive checkouts`,
        severity,
        line: link.line,
      });
    } else {
      issues.push({
        path,
        field: 'wikilink',
        issue: `[[${link.target}]] → no such file (${rel})`,
        severity,
        line: link.line,
      });
    }
  }
  return issues;
}

/**
 * context/ wikilink resolution — full-tree only (the same class as the current-state /
 * project-map blocks). Every context/ file resolves at warning severity; the append-only
 * archive (previous-state.md) is intentionally in scope per operator decision.
 */
export function lintContextWikilinks(orgRoot: string, repoMd: Set<string>): LintIssue[] {
  const base = join(orgRoot, 'context');
  if (!existsSync(base)) return [];
  const issues: LintIssue[] = [];
  for (const { abs } of walkMd(orgRoot, base)) {
    try {
      const doc = readDoc(abs);
      issues.push(...lintWikilinks(orgRoot, doc.content, relPath(orgRoot, abs), true, repoMd));
    } catch {
      // unparseable context/ files are not this rule's to report (context has no frontmatter schema)
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// House-coupling drift rules — lattice canonical + derived orientation rules.
// Both are full-tree-only and skip-with-note when their optional source is absent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lattice invariant is the BODY, not the file: house-local HTML-comment headers
 * legitimately differ (a loading note here, provenance there) and line endings churn
 * across editors. Strip a leading HTML-comment header and normalize CRLF→LF, then compare.
 */
function latticeBody(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n');
  const header = text.match(/^\s*<!--[\s\S]*?-->/);
  if (header) text = text.slice(header[0].length);
  return text;
}

/**
 * lattice-drift — the local context/principle-lattice.md BODY vs an external canonical
 * (LATTICE_CANONICAL env, e.g. a sibling house's canonical copy). The body is the invariant:
 * house-local headers and line endings are not drift (see latticeBody). Skip-with-note when
 * unset (the local copy is authority for single-house adopters); error on a missing local
 * copy or body drift when set. Ported from the house lint; regula-general by config — any
 * house can point LATTICE_CANONICAL at its canonical.
 */
export function lintLatticeDrift(orgRoot: string): { issues: LintIssue[]; notes: string[] } {
  const canonicalEnv = process.env.LATTICE_CANONICAL;
  const local = join(orgRoot, 'context', 'principle-lattice.md');
  if (!canonicalEnv) {
    return {
      issues: [],
      notes: ['lattice-drift: skipped (no LATTICE_CANONICAL set; local context/principle-lattice.md is authority)'],
    };
  }
  const canonical = resolve(canonicalEnv);
  if (!existsSync(canonical)) {
    return { issues: [], notes: [`lattice-drift: skipped (LATTICE_CANONICAL not found: ${canonical})`] };
  }
  if (!existsSync(local)) {
    return {
      issues: [
        {
          path: 'context/principle-lattice.md',
          field: 'lattice-drift',
          issue: `local lattice copy missing while LATTICE_CANONICAL exists at ${canonical}`,
          severity: 'error',
        },
      ],
      notes: [],
    };
  }
  if (latticeBody(readFileSync(canonical, 'utf8')) !== latticeBody(readFileSync(local, 'utf8'))) {
    return {
      issues: [
        {
          path: 'context/principle-lattice.md',
          field: 'lattice-drift',
          issue: `local lattice body differs from LATTICE_CANONICAL (${canonical}) — sync it (headers/line endings are not drift)`,
          severity: 'error',
        },
      ],
      notes: [],
    };
  }
  return { issues: [], notes: [] };
}

/**
 * orientation-rules-drift — the derived harness rules (.amore/rules/ or .grok/rules/) must
 * match their context/ sources; verified by the org's own scripts/sync_orientation_rules.py
 * --check. Skip-with-note when neither rules dir nor the script exists (a non-amore-shape
 * org root), or when python is unavailable. Ported from the house lint; regula-general by
 * discovery — whatever script the org root carries is what gets checked.
 */
export function lintOrientationRulesDrift(orgRoot: string): { issues: LintIssue[]; notes: string[] } {
  const hasAmore = existsSync(join(orgRoot, '.amore'));
  const hasGrok = existsSync(join(orgRoot, '.grok'));
  if (!hasAmore && !hasGrok) {
    return { issues: [], notes: ['orientation-rules-drift: skipped (.amore/ and .grok/ absent)'] };
  }
  const script = join(orgRoot, 'scripts', 'sync_orientation_rules.py');
  if (!existsSync(script)) {
    return { issues: [], notes: ['orientation-rules-drift: skipped (sync_orientation_rules.py not found)'] };
  }
  const extraArgs = hasAmore ? [] : ['--grok-compat'];
  try {
    const proc = spawnSync('python', [script, '--check', ...extraArgs], {
      cwd: orgRoot,
      encoding: 'utf8',
      env: { ...process.env, ORG_ROOT: orgRoot },
    });
    if (proc.status !== 0) {
      const tail = (proc.stdout || proc.stderr || '').trim().split('\n').slice(-3).join(' | ');
      return {
        issues: [
          {
            path: '.amore/rules',
            field: 'orientation-rules-drift',
            issue: `sync_orientation_rules.py --check exited ${proc.status}: ${tail}`,
            severity: 'error',
          },
        ],
        notes: [],
      };
    }
    return { issues: [], notes: [] };
  } catch {
    return { issues: [], notes: ['orientation-rules-drift: skipped (python not available)'] };
  }
}

export interface LintOptions {
  /** Restrict to one org-relative folder (e.g. 'tasks'); default lints tasks/knowledge/inbox/reminders. */
  folder?: string;
}

/** Lint the org tree (or one folder). Errors fail; warnings don't. */
export function lint(orgRoot: string, opts: LintOptions = {}): LintResult {
  const issues: LintIssue[] = [];
  const notes: string[] = [];
  let filesScanned = 0;
  const roots = opts.folder ? [opts.folder] : ['tasks', 'knowledge', 'inbox', 'reminders'];
  const repoMd = new Set(walkAllMd(orgRoot));

  for (const r of roots) {
    const base = join(orgRoot, r);
    if (!existsSync(base)) continue;
    for (const { abs, dirRel } of walkMd(orgRoot, base)) {
      filesScanned++;
      try {
        const doc = readDoc(abs);
        const path = relPath(orgRoot, abs);
        issues.push(...lintDoc(doc.frontmatter, path, dirRel));
        issues.push(...lintWikilinks(orgRoot, doc.content, path, false, repoMd));
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

    // context/ wikilink resolution + the house-coupling drift rules — full-tree only, the same
    // class as the current-state/project-map blocks above.
    issues.push(...lintContextWikilinks(orgRoot, repoMd));
    const lattice = lintLatticeDrift(orgRoot);
    issues.push(...lattice.issues);
    notes.push(...lattice.notes);
    const orient = lintOrientationRulesDrift(orgRoot);
    issues.push(...orient.issues);
    notes.push(...orient.notes);
  }

  issues.sort((a, b) => a.path.localeCompare(b.path) || a.field.localeCompare(b.field) || a.issue.localeCompare(b.issue));

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return {
    filesScanned,
    errorCount,
    warningCount: issues.length - errorCount,
    valid: errorCount === 0,
    issues,
    notes,
  };
}
