import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import matter from 'gray-matter';
import {
  lint,
  lintCurrentState,
  lintActiveTaskStaleness,
  lintProjectMapCoverage,
  lintProjectMapStaleness,
  extractWikilinks,
  CURRENT_STATE_MAX_WORDS,
  CURRENT_STATE_STALE_DAYS,
  ACTIVE_TASK_STALE_DAYS,
  PROJECT_MAP_STALE_DAYS,
} from './lint';
import { createTask } from './task';
import { createKnowledge } from './knowledge';
import { createReminder } from './reminder';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, fm: Record<string, unknown>, body = 'X') {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, matter.stringify(`# ${body}\n`, fm));
}

test('docs created by regula lint clean', () => {
  createTask(root, {  title: 'Clean Task', allowThin: true });
  createKnowledge(root, { title: 'Clean KB', content: 'x', tags: ['a'] });
  createReminder(root, { title: 'Clean Rem', remindAt: '2026-07-01T09:00' });
  const r = lint(root);
  expect(r.errorCount).toBe(0);
  expect(r.valid).toBe(true);
});

test('detects a status↔folder placement mismatch (the climb examen could not)', () => {
  seed('tasks/drifted.md', { type: 'task', status: 'paused', created: '2026-06-20' });
  const r = lint(root);
  const placement = r.issues.find((i) => i.field === 'status' && i.issue.includes('belongs in'));
  expect(placement).toBeDefined();
  expect(placement!.severity).toBe('error');
  expect(r.valid).toBe(false);
});

test('a correctly-placed paused task lints clean', () => {
  seed('tasks/paused/ok.md', { type: 'task', status: 'paused', created: '2026-06-20' });
  expect(lint(root).errorCount).toBe(0);
});

test('flags missing created (error) and a bad date', () => {
  seed('tasks/no-date.md', { type: 'task', status: 'active' });
  seed('tasks/bad-date.md', { type: 'task', status: 'active', created: 'June 2026' });
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'created' && i.issue.includes('Missing'))).toBe(true);
  expect(r.issues.some((i) => i.field === 'created' && i.issue.includes('Invalid date'))).toBe(true);
});

test('inbox placement: terminal-outside-resolved and open-inside-resolved are both errors', () => {
  seed('inbox/ideas/stuck.md', { type: 'inbox', created: '2026-06-20', status: 'resolved', source: 'capture' });
  seed('inbox/ideas/resolved/ghost.md', { type: 'inbox', created: '2026-06-20', status: 'open', source: 'capture' });
  seed('inbox/ideas/fine.md', { type: 'inbox', created: '2026-06-20', status: 'open', source: 'capture' });
  seed('inbox/ideas/resolved/done.md', { type: 'inbox', created: '2026-06-20', status: 'dropped', source: 'capture' });
  const r = lint(root);
  const errs = r.issues.filter((i) => i.field === 'status' && i.severity === 'error');
  expect(errs.length).toBe(2);
  expect(errs.some((i) => i.issue.includes("belongs in 'inbox/ideas/resolved'"))).toBe(true);
  expect(errs.some((i) => i.issue.includes('is not terminal'))).toBe(true);
});

test('a complete task without a completed date warns', () => {
  seed('tasks/completed/done.md', { type: 'task', status: 'complete', created: '2026-06-20' });
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'completed' && i.severity === 'warning')).toBe(true);
  expect(r.errorCount).toBe(0);
});

test('knowledge with no tags warns; reminder with bad status warns (the reminder climb)', () => {
  seed('knowledge/untagged.md', { type: 'knowledge', created: '2026-06-20', updated: '2026-06-20', title: 'U' });
  seed('reminders/weird.md', { type: 'reminder', status: 'bogus', created: '2026-06-20', 'remind-at': 'x' });
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'tags' && i.severity === 'warning')).toBe(true);
  expect(r.issues.some((i) => i.field === 'status' && i.issue.includes('Invalid reminder status'))).toBe(true);
  expect(r.errorCount).toBe(0);
});

// ── paused-missing-trigger ──

test('a paused task without trigger-to-unpause warns (never errors)', () => {
  seed('tasks/paused/adrift.md', { type: 'task', status: 'paused', created: '2026-06-20', paused: '2026-06-25' });
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'trigger-to-unpause');
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('warning');
  expect(issue!.issue).toContain('no trigger-to-unpause');
  expect(r.errorCount).toBe(0);
  expect(r.valid).toBe(true);
});

test('a paused task WITH trigger-to-unpause lints clean', () => {
  seed('tasks/paused/anchored.md', {
    type: 'task',
    status: 'paused',
    created: '2026-06-20',
    paused: '2026-06-25',
    'paused-reason': 'waiting on hardware',
    'trigger-to-unpause': 'replacement unit arrives',
  });
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'trigger-to-unpause')).toBe(false);
  expect(r.errorCount).toBe(0);
});

test('a non-paused task never fires paused-missing-trigger', () => {
  seed('tasks/rolling.md', { type: 'task', status: 'active', created: '2026-06-20' });
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'trigger-to-unpause')).toBe(false);
});

// ── same-stem-across-status-folders ──

test('flags a same-stem task duplicated across two status folders (error)', () => {
  seed('tasks/deploy-sh-rescaffold-mechanism.md', { type: 'task', status: 'active', created: '2026-06-20' });
  seed('tasks/completed/deploy-sh-rescaffold-mechanism.md', {
    type: 'task',
    status: 'complete',
    created: '2026-06-20',
    completed: '2026-06-25',
  });
  const r = lint(root);
  const stem = r.issues.find((i) => i.field === 'stem');
  expect(stem).toBeDefined();
  expect(stem!.severity).toBe('error');
  expect(stem!.issue).toContain('deploy-sh-rescaffold-mechanism');
  expect(stem!.issue).toContain('tasks/deploy-sh-rescaffold-mechanism.md');
  expect(stem!.issue).toContain('tasks/completed/deploy-sh-rescaffold-mechanism.md');
  expect(r.valid).toBe(false);
});

test('same stem in a single status folder does not collide', () => {
  seed('tasks/backlog/solo.md', { type: 'task', status: 'backlog', created: '2026-06-20' });
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'stem')).toBe(false);
  expect(r.errorCount).toBe(0);
});

test('distinct stems across folders do not collide', () => {
  seed('tasks/one.md', { type: 'task', status: 'active', created: '2026-06-20' });
  seed('tasks/completed/two.md', { type: 'task', status: 'complete', created: '2026-06-20', completed: '2026-06-25' });
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'stem')).toBe(false);
});

test('a stem spread across three status folders is one issue naming all three', () => {
  seed('tasks/spread.md', { type: 'task', status: 'active', created: '2026-06-20' });
  seed('tasks/paused/spread.md', { type: 'task', status: 'paused', created: '2026-06-20' });
  seed('tasks/backlog/spread.md', { type: 'task', status: 'backlog', created: '2026-06-20' });
  const r = lint(root);
  const stemIssues = r.issues.filter((i) => i.field === 'stem');
  expect(stemIssues.length).toBe(1);
  expect(stemIssues[0].issue).toContain('3 status folders');
  expect(stemIssues[0].issue).toContain('tasks/backlog/spread.md');
  expect(stemIssues[0].issue).toContain('tasks/paused/spread.md');
  expect(stemIssues[0].issue).toContain('tasks/spread.md');
});

test('a tasks-scoped run still runs the stem-collision check', () => {
  seed('tasks/dup.md', { type: 'task', status: 'active', created: '2026-06-20' });
  seed('tasks/completed/dup.md', { type: 'task', status: 'complete', created: '2026-06-20', completed: '2026-06-25' });
  const r = lint(root, { folder: 'tasks' });
  expect(r.issues.some((i) => i.field === 'stem')).toBe(true);
});

// ── current-state-staleness ──

test('lintCurrentState: short, fresh body is clean', () => {
  const now = new Date('2026-07-01T00:00:00');
  const content = '# Current State\n\n## Recent structural changes (2026-06-25)\n\nAll good.\n';
  expect(lintCurrentState(content, 'context/current-state.md', now)).toEqual([]);
});

test('lintCurrentState: body over the word threshold warns, never errors', () => {
  const now = new Date('2026-07-01T00:00:00');
  const content = 'word '.repeat(CURRENT_STATE_MAX_WORDS + 1);
  const issues = lintCurrentState(content, 'context/current-state.md', now);
  const lengthIssue = issues.find((i) => i.field === 'length');
  expect(lengthIssue).toBeDefined();
  expect(lengthIssue!.severity).toBe('warning');
  expect(lengthIssue!.issue).toContain(String(CURRENT_STATE_MAX_WORDS + 1));
  expect(lengthIssue!.issue).toContain('context/previous-state.md');
});

test('lintCurrentState: body at exactly the threshold does not warn', () => {
  const now = new Date('2026-07-01T00:00:00');
  const content = 'word '.repeat(CURRENT_STATE_MAX_WORDS);
  const issues = lintCurrentState(content, 'context/current-state.md', now);
  expect(issues.some((i) => i.field === 'length')).toBe(false);
});

test('lintCurrentState: a dated section older than the threshold warns with the offending date, never errors', () => {
  const now = new Date('2026-07-01T00:00:00');
  const content =
    '## Recent structural changes (2026-06-01)\n\nOld stuff.\n\n' +
    '## Recent structural changes (2026-06-25)\n\nRecent stuff.\n';
  const issues = lintCurrentState(content, 'context/current-state.md', now);
  const staleIssue = issues.find((i) => i.field === 'staleness');
  expect(staleIssue).toBeDefined();
  expect(staleIssue!.severity).toBe('warning');
  expect(staleIssue!.issue).toContain('2026-06-01');
  expect(staleIssue!.issue).not.toContain('2026-06-25');
});

test('lintCurrentState: a section exactly at the threshold is not yet stale (strictly-older semantics)', () => {
  const now = new Date('2026-07-01T00:00:00');
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - CURRENT_STATE_STALE_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const content = `## Recent structural changes (${cutoffDate})\n\nRight at the edge.\n`;
  const issues = lintCurrentState(content, 'context/current-state.md', now);
  expect(issues.some((i) => i.field === 'staleness')).toBe(false);
});

test('lintCurrentState: multiple stale sections are all named', () => {
  const now = new Date('2026-07-01T00:00:00');
  const content =
    '## Recent structural changes (2026-05-01)\n\nA.\n\n' +
    '## Recent structural changes (2026-05-15)\n\nB.\n\n' +
    '## Recent structural changes (2026-06-28)\n\nC (fresh).\n';
  const issues = lintCurrentState(content, 'context/current-state.md', now);
  const staleIssue = issues.find((i) => i.field === 'staleness')!;
  expect(staleIssue.issue).toContain('2026-05-01');
  expect(staleIssue.issue).toContain('2026-05-15');
  expect(staleIssue.issue).not.toContain('2026-06-28');
  expect(staleIssue.issue).toContain('2 dated section');
});

test('lint(): fires on a real context/current-state.md, warns (never errors), and stays valid', () => {
  const staleFm = { type: 'context', created: '2026-02-05', updated: '2026-07-01', tags: ['meta', 'state'] };
  const staleBody =
    '# Current State\n\n' +
    '## Recent structural changes (2026-01-01)\n\n' +
    'word '.repeat(CURRENT_STATE_MAX_WORDS + 1) +
    '\n';
  seed('context/current-state.md', staleFm, staleBody);
  const r = lint(root);
  const csIssues = r.issues.filter((i) => i.path === 'context/current-state.md');
  expect(csIssues.length).toBe(2); // length + staleness
  expect(csIssues.every((i) => i.severity === 'warning')).toBe(true);
  expect(r.errorCount).toBe(0);
  expect(r.valid).toBe(true);
});

test('lint(): a clean, small current-state.md does not warn', () => {
  // Dynamic date: a hard-coded date here is a time-bomb against CURRENT_STATE_STALE_DAYS.
  const today = new Date().toISOString().slice(0, 10);
  const body = `# Current State\n\n## Recent structural changes (${today})\n\nAll caught up.\n`;
  seed('context/current-state.md', { type: 'context', created: '2026-02-05', tags: ['meta'] }, body);
  const r = lint(root);
  expect(r.issues.filter((i) => i.path === 'context/current-state.md').length).toBe(0);
});

test('lint(): a folder-scoped run does not touch current-state.md', () => {
  const staleFm = { type: 'context', created: '2026-02-05', tags: ['meta'] };
  const staleBody =
    '# Current State\n\n## Recent structural changes (2026-01-01)\n\n' + 'word '.repeat(CURRENT_STATE_MAX_WORDS + 1);
  seed('context/current-state.md', staleFm, staleBody);
  seed('tasks/ok.md', { type: 'task', status: 'active', created: '2026-06-20' });
  const r = lint(root, { folder: 'tasks' });
  expect(r.issues.some((i) => i.path === 'context/current-state.md')).toBe(false);
});

// ── active-task-staleness ──

const NOW = new Date('2026-07-01T00:00:00');

/** Backdate a fixture's mtime to `days` before NOW (deterministic; avoids wall-clock flake). */
function ageFile(rel: string, days: number) {
  const p = join(root, rel);
  const when = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  utimesSync(p, when, when);
}

test('a stale, unblocked active task is flagged (warning, never error)', () => {
  seed('tasks/dormant.md', { type: 'task', status: 'active', created: '2026-01-01' });
  ageFile('tasks/dormant.md', ACTIVE_TASK_STALE_DAYS + 100);
  const issues = lintActiveTaskStaleness(root, NOW);
  const issue = issues.find((i) => i.path === 'tasks/dormant.md');
  expect(issue).toBeDefined();
  expect(issue!.field).toBe('staleness');
  expect(issue!.severity).toBe('warning');
  expect(issue!.issue).toContain('no blocker');
});

test('a recently-touched active task is not flagged', () => {
  seed('tasks/fresh.md', { type: 'task', status: 'active', created: '2026-06-20' });
  ageFile('tasks/fresh.md', 5);
  expect(lintActiveTaskStaleness(root, NOW).length).toBe(0);
});

test('a stale active task WITH blocked-by is not flagged', () => {
  seed('tasks/blocked-by-set.md', {
    type: 'task',
    status: 'active',
    created: '2026-01-01',
    'blocked-by': ['waiting on vendor RMA'],
  });
  ageFile('tasks/blocked-by-set.md', ACTIVE_TASK_STALE_DAYS + 100);
  expect(lintActiveTaskStaleness(root, NOW).length).toBe(0);
});

test('a stale active task WITH blocked-on is not flagged (empty blocked-by)', () => {
  seed('tasks/blocked-on-set.md', {
    type: 'task',
    status: 'active',
    created: '2026-01-01',
    'blocked-by': [],
    'blocked-on': 'hardware',
  });
  ageFile('tasks/blocked-on-set.md', ACTIVE_TASK_STALE_DAYS + 100);
  expect(lintActiveTaskStaleness(root, NOW).length).toBe(0);
});

test('a stale but non-active task is ignored', () => {
  seed('tasks/paused/old.md', { type: 'task', status: 'paused', created: '2026-01-01' });
  seed('tasks/backlog/old.md', { type: 'task', status: 'backlog', created: '2026-01-01' });
  ageFile('tasks/paused/old.md', ACTIVE_TASK_STALE_DAYS + 100);
  ageFile('tasks/backlog/old.md', ACTIVE_TASK_STALE_DAYS + 100);
  expect(lintActiveTaskStaleness(root, NOW).length).toBe(0);
});

test('a task aged exactly to the threshold is not yet stale (strictly-over semantics)', () => {
  seed('tasks/edge.md', { type: 'task', status: 'active', created: '2026-01-01' });
  ageFile('tasks/edge.md', ACTIVE_TASK_STALE_DAYS);
  expect(lintActiveTaskStaleness(root, NOW).length).toBe(0);
});

test('lint(): surfaces active-task-staleness as a warning, stays valid', () => {
  seed('tasks/dormant.md', { type: 'task', status: 'active', created: '2026-01-01' });
  ageFile('tasks/dormant.md', ACTIVE_TASK_STALE_DAYS + 100);
  const r = lint(root); // real now — fixture is aged >100d past threshold, well outside any margin
  const issue = r.issues.find((i) => i.path === 'tasks/dormant.md' && i.field === 'staleness');
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('warning');
  expect(r.errorCount).toBe(0);
  expect(r.valid).toBe(true);
});

test('lint(): a tasks-scoped run still runs active-task-staleness', () => {
  seed('tasks/dormant.md', { type: 'task', status: 'active', created: '2026-01-01' });
  ageFile('tasks/dormant.md', ACTIVE_TASK_STALE_DAYS + 100);
  const r = lint(root, { folder: 'tasks' });
  expect(r.issues.some((i) => i.path === 'tasks/dormant.md' && i.field === 'staleness')).toBe(true);
});

// ── project-map-coverage ──

/** Write context/project-map.md with the given raw body — coverage reads the whole raw file. */
function seedMap(body: string) {
  const p = join(root, 'context', 'project-map.md');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

test('project-map-coverage: an on-disk project dir absent from the map warns (never errors)', () => {
  mkdirSync(join(root, 'projects', 'orphan-widget'), { recursive: true });
  seedMap('# Project Map\n\nSome other projects live here.\n');
  const issues = lintProjectMapCoverage(root);
  const issue = issues.find((i) => i.path === 'projects/orphan-widget');
  expect(issue).toBeDefined();
  expect(issue!.field).toBe('coverage');
  expect(issue!.severity).toBe('warning');
  expect(issue!.issue).toContain('no mention');
  expect(issue!.issue).toContain('Deliberately unmapped');
  expect(issues.every((i) => i.severity === 'warning')).toBe(true);
});

test('project-map-coverage: a dir named in the map body does not warn', () => {
  mkdirSync(join(root, 'projects', 'mapped-thing'), { recursive: true });
  seedMap('# Project Map\n\n- `mapped-thing/` — the thing that is mapped.\n');
  expect(lintProjectMapCoverage(root)).toEqual([]);
});

test('project-map-coverage: a dir named ONLY in the "Deliberately unmapped" note does not warn', () => {
  mkdirSync(join(root, 'projects', 'legacy-junk'), { recursive: true });
  seedMap('# Project Map\n\nDeliberately unmapped: legacy-junk (ephemeral, not worth a topology row).\n');
  expect(lintProjectMapCoverage(root)).toEqual([]);
});

test('project-map-coverage: enumerates instruments/ as well as projects/', () => {
  mkdirSync(join(root, 'instruments', 'shadow-tool'), { recursive: true });
  seedMap('# Project Map\n\nNothing about the instruments here.\n');
  const issue = lintProjectMapCoverage(root).find((i) => i.path === 'instruments/shadow-tool');
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('warning');
});

test('project-map-coverage: an absent map is a single error', () => {
  const issues = lintProjectMapCoverage(root); // no context/project-map.md seeded
  expect(issues.length).toBe(1);
  expect(issues[0].severity).toBe('error');
  expect(issues[0].path).toBe('context/project-map.md');
});

test('project-map-coverage: 1–2 char dir names use a word boundary, not a degenerate substring', () => {
  mkdirSync(join(root, 'projects', 'ab'), { recursive: true }); // "ab" only inside "about" → still unmapped
  mkdirSync(join(root, 'projects', 'cd'), { recursive: true }); // standalone "cd" → mapped
  seedMap('# Project Map\n\nAll about the run cd here workflow.\n');
  const paths = lintProjectMapCoverage(root).map((i) => i.path);
  expect(paths).toContain('projects/ab');
  expect(paths).not.toContain('projects/cd');
});

// ── project-map-staleness ──

const MAP_NOW = new Date('2026-07-01T00:00:00');

/** Backdate context/project-map.md's mtime to `days` before MAP_NOW (deterministic, no wall-clock flake). */
function ageMap(days: number) {
  const p = join(root, 'context', 'project-map.md');
  const when = new Date(MAP_NOW.getTime() - days * 24 * 60 * 60 * 1000);
  utimesSync(p, when, when);
}

test('project-map-staleness: a fresh map is clean', () => {
  seedMap('# Project Map\n');
  ageMap(5);
  expect(lintProjectMapStaleness(root, MAP_NOW)).toEqual([]);
});

test('project-map-staleness: a map older than the threshold warns (never errors)', () => {
  seedMap('# Project Map\n');
  ageMap(PROJECT_MAP_STALE_DAYS + 10);
  const issues = lintProjectMapStaleness(root, MAP_NOW);
  expect(issues.length).toBe(1);
  expect(issues[0].field).toBe('staleness');
  expect(issues[0].severity).toBe('warning');
  expect(issues[0].issue).toContain(String(PROJECT_MAP_STALE_DAYS));
  expect(issues[0].issue).toContain('forge/output/project-map-audit/_protocol.md');
});

test('project-map-staleness: a map exactly at the threshold is not yet stale (strictly-older semantics)', () => {
  seedMap('# Project Map\n');
  ageMap(PROJECT_MAP_STALE_DAYS);
  expect(lintProjectMapStaleness(root, MAP_NOW)).toEqual([]);
});

test('project-map-staleness: an absent map yields no staleness issue (coverage owns the absent error)', () => {
  expect(lintProjectMapStaleness(root, MAP_NOW)).toEqual([]);
});

// ── project-map rules wired into lint() ──

test('lint(): surfaces project-map coverage as a warning and stays valid', () => {
  seedMap('# Project Map\n\nnothing about the tree here\n');
  mkdirSync(join(root, 'projects', 'unlisted-proj'), { recursive: true });
  const r = lint(root); // real now; freshly-written map → no staleness warn
  const issue = r.issues.find((i) => i.path === 'projects/unlisted-proj' && i.field === 'coverage');
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('warning');
  expect(r.errorCount).toBe(0);
  expect(r.valid).toBe(true);
});

test('lint(): a folder-scoped run does not touch project-map', () => {
  seedMap('# Project Map\n');
  mkdirSync(join(root, 'projects', 'unlisted-proj'), { recursive: true });
  seed('tasks/ok.md', { type: 'task', status: 'active', created: '2026-06-20' });
  const r = lint(root, { folder: 'tasks' });
  expect(r.issues.some((i) => i.field === 'coverage' || i.path === 'context/project-map.md')).toBe(false);
});

// ── wikilinks (ported from the house lint) ──

/** Seed a root AGENTS.md so [[AGENTS]] resolves (walkAllMd sees it as a referent). */
function seedAgents() {
  writeFileSync(join(root, 'AGENTS.md'), '# Agents\n');
}

test('wikilinks: a scope-dir doc with no wikilink warns, never errors (create scaffolds are linkless until expanded)', () => {
  seed('tasks/nolink.md', { type: 'task', status: 'active', created: '2026-06-20' });
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'wikilink' && i.issue.includes('no [[wikilink]]'));
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('warning');
  expect(r.errorCount).toBe(0);
  expect(r.valid).toBe(true);
});

test('wikilinks: a broken link in a scope dir is an error naming the missing file', () => {
  seed('tasks/broken.md', { type: 'task', status: 'active', created: '2026-06-20' }, 'See [[no/such/file]] for detail.\n');
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'wikilink' && i.issue.includes('no/such/file.md'));
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('error');
  expect(issue!.line).toBe(1);
  expect(r.valid).toBe(false);
});

test('wikilinks: a wrong-case target that resolves only case-insensitively is broken', () => {
  seedAgents();
  seed('tasks/case.md', { type: 'task', status: 'active', created: '2026-06-20' }, 'Link [[agents]] wrong case.\n');
  const r = lint(root);
  const issue = r.issues.find((i) => i.path === 'tasks/case.md' && i.field === 'wikilink');
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('error');
});

test('wikilinks: code fences and inline code are not prose (and a real link resolves)', () => {
  seedAgents();
  seed(
    'tasks/fenced.md',
    { type: 'task', status: 'active', created: '2026-06-20' },
    'Real [[AGENTS]].\n```\n[[not-a-link]]\n```\nInline `[[also-not]]`.\n',
  );
  const r = lint(root);
  expect(r.issues.filter((i) => i.path === 'tasks/fenced.md' && i.field === 'wikilink')).toEqual([]);
});

test('wikilinks: extraction strips code, keeps line numbers, drops anchors and aliases', () => {
  const text = [
    'Real link: [[AGENTS]] and [[knowledge/audit-surface-design|alias]].',
    'Inline code `[[wikilink]]` must not count.',
    '```',
    '[[not-a-link]]',
    '```',
    'Heading ref: [[context/current-state#Section]].',
  ].join('\n');
  const links = extractWikilinks(text);
  expect(links.map((l) => l.target)).toEqual(['AGENTS', 'knowledge/audit-surface-design', 'context/current-state']);
  expect(links[2]!.line).toBe(6); // fence-blanked lines keep numbering
});

test('wikilinks: the Markdown-table-cell `\\|` form is an alias delimiter, not part of the target', () => {
  const links = extractWikilinks('| [[context/current-state\\|current-state.md]] | Standing reality | Every arrival |');
  expect(links.map((l) => l.target)).toEqual(['context/current-state']);
});

test('wikilinks: a broken link in context/ warns (never errors) and previous-state.md is in scope', () => {
  seedAgents();
  seed('context/current-state.md', { type: 'context', created: '2026-02-05', tags: ['meta'] }, '# State\n\nBroken [[no/such/file]] here.\n');
  seed('context/previous-state.md', { type: 'context', created: '2026-02-05', tags: ['meta'] }, '# Old\n\nAlso broken [[no/such/file2]].\n');
  const r = lint(root);
  const cs = r.issues.filter((i) => i.path === 'context/current-state.md' && i.field === 'wikilink');
  const ps = r.issues.filter((i) => i.path === 'context/previous-state.md' && i.field === 'wikilink');
  expect(cs.length).toBe(1);
  expect(cs[0]!.severity).toBe('warning');
  expect(ps.length).toBe(1); // previous-state in scope per operator decision
  expect(ps[0]!.severity).toBe('warning');
  expect(r.errorCount).toBe(0);
  expect(r.valid).toBe(true);
});

test('wikilinks: a folder-scoped run does not run the context/ wikilink check', () => {
  seedAgents();
  seed('context/current-state.md', { type: 'context', created: '2026-02-05', tags: ['meta'] }, '# State\n\nBroken [[no/such/file]] here.\n');
  seed('tasks/ok.md', { type: 'task', status: 'active', created: '2026-06-20' }, '[[AGENTS]] fine.\n');
  const r = lint(root, { folder: 'tasks' });
  expect(r.issues.some((i) => i.path.startsWith('context/'))).toBe(false);
});

// ── type↔folder + inbox admission ──

test('a knowledge-typed doc in tasks/ is a type↔folder error', () => {
  seedAgents();
  seed('tasks/notask.md', { type: 'knowledge', created: '2026-06-20', updated: '2026-06-20', tags: ['x'] }, '[[AGENTS]]\n');
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'type' && i.issue.includes('requires'));
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('error');
  expect(r.valid).toBe(false);
});

test('a README.md index file is exempt from the type↔folder rule', () => {
  seedAgents();
  seed('tasks/README.md', { type: 'index', created: '2026-06-20' }, '[[AGENTS]]\n');
  const r = lint(root);
  expect(r.issues.some((i) => i.path === 'tasks/README.md' && i.field === 'type')).toBe(false);
});

test('an unknown inbox folder is an error', () => {
  seedAgents();
  seed('inbox/mystery/x.md', { type: 'inbox', created: '2026-06-20', source: 'capture', status: 'open' }, '[[AGENTS]]\n');
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'file' && i.issue.includes('unknown inbox folder'));
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('error');
});

// ── value domains + formats (warning class) ──

test('source outside the domain warns, never errors', () => {
  seedAgents();
  seed('inbox/ideas/badsrc.md', { type: 'inbox', created: '2026-06-20', source: 'bogus', status: 'open' }, '[[AGENTS]]\n');
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'source' && i.issue.includes('outside domain'));
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('warning');
  expect(r.errorCount).toBe(0);
});

test('repeat outside the domain warns, never errors', () => {
  seedAgents();
  seed('reminders/badrepeat.md', { type: 'reminder', created: '2026-06-20', status: 'pending', 'remind-at': '2026-07-01T09:00', repeat: 'fortnightly' }, '[[AGENTS]]\n');
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'repeat' && i.issue.includes('outside domain'))).toBe(true);
  expect(r.errorCount).toBe(0);
});

test('a bad date format on a schema date key warns; null is legal', () => {
  seedAgents();
  seed('tasks/completed/bad-date.md', { type: 'task', status: 'complete', created: '2026-06-20', completed: 'June 2026' }, '[[AGENTS]]\n');
  seed('tasks/null-date.md', { type: 'task', status: 'active', created: '2026-06-20', completed: null, tags: ['x'] }, '[[AGENTS]]\n');
  const r = lint(root);
  const bad = r.issues.find((i) => i.path === 'tasks/completed/bad-date.md' && i.field === 'completed');
  expect(bad).toBeDefined();
  expect(bad!.severity).toBe('warning');
  expect(r.issues.some((i) => i.path === 'tasks/null-date.md' && i.field === 'completed')).toBe(false);
  expect(r.errorCount).toBe(0);
});

test('a time-bearing remind-at passes the datetime format check (normalized ISO form)', () => {
  seedAgents();
  seed('reminders/timed.md', { type: 'reminder', created: '2026-06-20', status: 'pending', 'remind-at': '2026-07-01T09:00', tags: ['r'] }, '[[AGENTS]]\n');
  const r = lint(root);
  expect(r.issues.some((i) => i.path === 'reminders/timed.md' && i.field === 'remind-at')).toBe(false);
});

// ── lifecycle additions ──

test('a terminal inbox item without resolved/resolution warns, never errors', () => {
  seedAgents();
  seed('inbox/ideas/resolved/nofields.md', { type: 'inbox', created: '2026-06-20', source: 'session', status: 'resolved' }, '[[AGENTS]]\n');
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'resolved' && i.issue.includes('no resolved date'))).toBe(true);
  expect(r.issues.some((i) => i.field === 'resolution' && i.issue.includes('no resolution line'))).toBe(true);
  expect(r.errorCount).toBe(0);
});

test('a terminal inbox item WITH resolved/resolution is clean on those fields', () => {
  seedAgents();
  seed('inbox/ideas/resolved/fine.md', { type: 'inbox', created: '2026-06-20', source: 'session', status: 'resolved', resolved: '2026-06-25', resolution: 'Landed in [[tasks/x]].' }, '[[AGENTS]]\n');
  const r = lint(root);
  expect(r.issues.some((i) => i.path === 'inbox/ideas/resolved/fine.md' && (i.field === 'resolved' || i.field === 'resolution'))).toBe(false);
});

test('a snoozed reminder without snoozed-until warns, never errors', () => {
  seedAgents();
  seed('reminders/snoozed.md', { type: 'reminder', created: '2026-06-20', status: 'snoozed', 'remind-at': '2026-07-01T09:00' }, '[[AGENTS]]\n');
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'snoozed-until');
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('warning');
  expect(r.errorCount).toBe(0);
});

// ── lattice + orientation-rules drift ──

test('lattice-drift skips with a note when LATTICE_CANONICAL is unset', () => {
  delete process.env.LATTICE_CANONICAL;
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'lattice-drift')).toBe(false);
  expect(r.notes.some((n) => n.includes('lattice-drift: skipped'))).toBe(true);
});

test('lattice-drift errors when the local copy differs from the canonical', () => {
  mkdirSync(join(root, 'context'), { recursive: true });
  writeFileSync(join(root, 'context', 'principle-lattice.md'), '# Local lattice\n');
  const canonical = join(root, 'canonical-lattice.md');
  writeFileSync(canonical, '# Canonical lattice\n');
  process.env.LATTICE_CANONICAL = canonical;
  try {
    const r = lint(root);
    const issue = r.issues.find((i) => i.field === 'lattice-drift');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(r.valid).toBe(false);
  } finally {
    delete process.env.LATTICE_CANONICAL;
  }
});

test('lattice-drift compares BODIES only — house-local headers and line endings are not drift', () => {
  mkdirSync(join(root, 'context'), { recursive: true });
  writeFileSync(join(root, 'context', 'principle-lattice.md'), '<!-- house-local loading note -->\n## Lattice\n\nBody.\n');
  const canonical = join(root, 'canonical-lattice.md');
  writeFileSync(canonical, '<!-- provenance header -->\r\n## Lattice\r\n\r\nBody.\r\n');
  process.env.LATTICE_CANONICAL = canonical;
  try {
    const r = lint(root);
    expect(r.issues.some((i) => i.field === 'lattice-drift')).toBe(false);
  } finally {
    delete process.env.LATTICE_CANONICAL;
  }
});

test('lattice-drift errors when the BODY genuinely drifts under identical headers', () => {
  mkdirSync(join(root, 'context'), { recursive: true });
  writeFileSync(join(root, 'context', 'principle-lattice.md'), '<!-- h -->\n## Lattice\n\nLocal body.\n');
  const canonical = join(root, 'canonical-lattice.md');
  writeFileSync(canonical, '<!-- h -->\n## Lattice\n\nCanonical body.\n');
  process.env.LATTICE_CANONICAL = canonical;
  try {
    const r = lint(root);
    const issue = r.issues.find((i) => i.field === 'lattice-drift');
    expect(issue).toBeDefined();
    expect(issue!.issue).toContain('lattice body differs');
  } finally {
    delete process.env.LATTICE_CANONICAL;
  }
});

test('orientation-rules-drift skips with a note when the org root has no rules dir', () => {
  const r = lint(root);
  expect(r.issues.some((i) => i.field === 'orientation-rules-drift')).toBe(false);
  expect(r.notes.some((n) => n.includes('orientation-rules-drift: skipped'))).toBe(true);
});

test('orientation-rules-drift errors when the org sync script --check fails', () => {
  mkdirSync(join(root, '.arcus'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'sync_orientation_rules.py'), 'import sys\nsys.exit(1)\n');
  const r = lint(root);
  const issue = r.issues.find((i) => i.field === 'orientation-rules-drift');
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe('error');
  expect(issue!.issue).toContain('exited 1');
});
