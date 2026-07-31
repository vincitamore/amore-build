import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import {
  createTask,
  completeTask,
  pauseTask,
  setTaskStatus,
  updateTaskMeta,
  findTask,
  blockTask,
  assembleTaskContent,
  assertFullTaskCreate,
  TASK_BODY_MIN_CHARS,
  TASK_GOAL_MIN_CHARS,
} from './task';
import { RegulaError } from './errors';
import { today } from './util';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fmOf(rel: string): Record<string, unknown> {
  return matter(readFileSync(join(root, rel), 'utf-8')).data;
}

test('createTask writes an active task at the tasks/ root', () => {
  const r = createTask(root, {  title: 'My New Task', tags: ['x'], allowThin: true });
  expect(r.path).toBe('tasks/my-new-task.md');
  expect(r.status).toBe('active');
  expect(existsSync(join(root, 'tasks/my-new-task.md'))).toBe(true);
  const fm = fmOf('tasks/my-new-task.md');
  expect(fm.type).toBe('task');
  expect(fm.status).toBe('active');
  expect(fm.created).toBe(today());
  expect(fm.completed).toBe(null);
  expect(fm.tags).toEqual(['x']);
});

test('createTask full shape requires tags + goal; body scaffolds if omitted (anti-stub)', () => {
  expect(() => createTask(root, { title: 'Thin' })).toThrow(RegulaError);
  expect(() =>
    createTask(root, {
      title: 'Almost',
      tags: ['a'],
      description: 'short',
    }),
  ).toThrow(/goal|description|anti-stub|title \+ tags/i);
  expect(() =>
    createTask(root, {
      title: 'Almost',
      tags: ['a'],
      description: 'A goal long enough to pass the floor!!',
      body: 'too short',
    }),
  ).toThrow(/too short|BODY_MIN/i);

  const goal = 'Ship the Grok headless auto-commit path under the house tree.';
  const scaffolded = createTask(root, {
    title: 'Scaffold Shape Task',
    tags: ['house'],
    description: goal,
  });
  expect(scaffolded.bodyScaffolded).toBe(true);
  const scRaw = readFileSync(join(root, scaffolded.path), 'utf-8');
  expect(scRaw).toContain('regula:body-scaffold');
  expect(scRaw).toContain('## Acceptance');

  const body = [
    '## Acceptance',
    '',
    '- [ ] Probe green',
    '- [ ] Adapter wired',
    '',
    '## Context',
    '',
    'The instrument needs real LLM drivers, not watchers alone.',
    '',
  ].join('\n');
  expect(goal.length).toBeGreaterThanOrEqual(TASK_GOAL_MIN_CHARS);
  expect(body.length).toBeGreaterThanOrEqual(TASK_BODY_MIN_CHARS);

  const r = createTask(root, {
    title: 'Full Shape Task',
    tags: ['alpha', 'beta'],
    description: goal,
    body,
    priority: 'high',
  });
  expect(r.path).toBe('tasks/full-shape-task.md');
  expect(r.bodyScaffolded).toBeFalsy();
  const raw = readFileSync(join(root, r.path), 'utf-8');
  expect(raw).toContain('# Full Shape Task');
  expect(raw).toContain(goal);
  expect(raw).toContain('## Acceptance');
  expect(raw).not.toContain('regula:body-scaffold');
  expect(fmOf(r.path).priority).toBe('high');
  expect(fmOf(r.path).tags).toEqual(['alpha', 'beta']);
});

test('assembleTaskContent puts goal under H1 then body', () => {
  const md = assembleTaskContent('T', 'One-line goal text here.', '## Acceptance\n\n- [ ] x\n');
  expect(md).toContain('# T\n');
  expect(md).toContain('One-line goal text here.');
  expect(md).toContain('## Acceptance');
});

test('assertFullTaskCreate lists missing flags', () => {
  try {
    assertFullTaskCreate({ title: 'X' });
    throw new Error('expected throw');
  } catch (e) {
    expect(e).toBeInstanceOf(RegulaError);
    expect((e as RegulaError).message).toContain('--tags');
    expect((e as RegulaError).message).toContain('--description');
    expect((e as RegulaError).message).not.toMatch(/--body or --body-file \(markdown/);
  }
});

test('createTask refuses a duplicate slug', () => {
  createTask(root, {  title: 'Dup', allowThin: true });
  expect(() => createTask(root, {  title: 'Dup', allowThin: true })).toThrow();
});

test('completeTask moves the file to tasks/completed/ and stamps the date', () => {
  createTask(root, {  title: 'Finish Me', allowThin: true });
  const r = completeTask(root, 'finish-me');
  expect(r.from).toBe('active');
  expect(r.to).toBe('complete');
  expect(r.moved).toBe(true);
  expect(r.newPath).toBe('tasks/completed/finish-me.md');
  expect(existsSync(join(root, 'tasks/finish-me.md'))).toBe(false);
  expect(existsSync(join(root, 'tasks/completed/finish-me.md'))).toBe(true);
  const fm = fmOf('tasks/completed/finish-me.md');
  expect(fm.status).toBe('complete');
  expect(fm.completed).toBe(today());
});

test('setTaskStatus reconciles the folder on ANY status change (the examen fix)', () => {
  createTask(root, {  title: 'Move Me', allowThin: true });
  const r = setTaskStatus(root, 'move-me', 'backlog');
  expect(r.newPath).toBe('tasks/backlog/move-me.md');
  expect(existsSync(join(root, 'tasks/backlog/move-me.md'))).toBe(true);
  expect(existsSync(join(root, 'tasks/move-me.md'))).toBe(false);
  // and it is still findable by slug from its new home
  expect(findTask(root, 'move-me')).toBe(join(root, 'tasks/backlog/move-me.md'));
});

test('pauseTask moves to tasks/paused/ and appends the reason', () => {
  createTask(root, {  title: 'Pause Me', allowThin: true });
  const r = pauseTask(root, 'pause-me', 'waiting on operator');
  expect(r.to).toBe('paused');
  expect(r.newPath).toBe('tasks/paused/pause-me.md');
  const body = readFileSync(join(root, 'tasks/paused/pause-me.md'), 'utf-8');
  expect(body).toContain('## Paused');
  expect(body).toContain('waiting on operator');
});

test('pauseTask writes the full pause frontmatter (paused, paused-reason, trigger-to-unpause)', () => {
  createTask(root, {  title: 'Pause Fully', allowThin: true });
  pauseTask(root, 'pause-fully', 'waiting on corpus run', 'benchmark run completes');
  const fm = fmOf('tasks/paused/pause-fully.md');
  expect(fm.status).toBe('paused');
  expect(fm.paused).toBe(today());
  expect(fm['paused-reason']).toBe('waiting on corpus run');
  expect(fm['trigger-to-unpause']).toBe('benchmark run completes');
  // the body append still rides along
  const body = readFileSync(join(root, 'tasks/paused/pause-fully.md'), 'utf-8');
  expect(body).toContain('## Paused');
});

test('pauseTask with no reason/trigger stamps paused only, omitting the optional fields', () => {
  createTask(root, {  title: 'Bare Pause', allowThin: true });
  pauseTask(root, 'bare-pause');
  const fm = fmOf('tasks/paused/bare-pause.md');
  expect(fm.paused).toBe(today());
  expect('paused-reason' in fm).toBe(false);
  expect('trigger-to-unpause' in fm).toBe(false);
  const body = readFileSync(join(root, 'tasks/paused/bare-pause.md'), 'utf-8');
  expect(body).not.toContain('## Paused');
});

test('leaving the paused state clears the pause frontmatter (mirrors completed-date coherence)', () => {
  createTask(root, {  title: 'Resume Me', allowThin: true });
  pauseTask(root, 'resume-me', 'stalled', 'operator returns');
  setTaskStatus(root, 'resume-me', 'active');
  const fm = fmOf('tasks/resume-me.md');
  expect(fm.status).toBe('active');
  expect('paused' in fm).toBe(false);
  expect('paused-reason' in fm).toBe(false);
  expect('trigger-to-unpause' in fm).toBe(false);
});

test('re-activating a complete task clears the completed date and moves it back', () => {
  createTask(root, {  title: 'Reopen', allowThin: true });
  completeTask(root, 'reopen');
  const r = setTaskStatus(root, 'reopen', 'active');
  expect(r.from).toBe('complete');
  expect(r.newPath).toBe('tasks/reopen.md');
  const fm = fmOf('tasks/reopen.md');
  expect(fm.status).toBe('active');
  expect(fm.completed).toBe(null);
});

test('updateTaskMeta edits tags in place without moving the file', () => {
  createTask(root, {  title: 'Tag Me', tags: ['a'], allowThin: true });
  updateTaskMeta(root, 'tag-me', { addTags: ['b'], removeTags: ['a'] });
  const fm = fmOf('tasks/tag-me.md');
  expect(fm.tags).toEqual(['b']);
  expect(existsSync(join(root, 'tasks/tag-me.md'))).toBe(true);
});

test('findTask throws NOT_FOUND for an unknown slug', () => {
  expect(() => findTask(root, 'does-not-exist')).toThrow();
});

test('blockTask sets status blocked, taxonomy-validated blocked-on, free-text blocked-by, and reconciles the folder', () => {
  createTask(root, {  title: 'Needs A Decision', allowThin: true });
  const r = blockTask(root, 'needs-a-decision', 'decision', 'waiting on operator to pick an approach');
  expect(r.from).toBe('active');
  expect(r.to).toBe('blocked');
  expect(r.blockedOn).toBe('decision');
  expect(r.blockedBy).toEqual(['waiting on operator to pick an approach']);
  expect(r.newPath).toBe('tasks/needs-a-decision.md'); // blocked shares the tasks/ root with active
  const fm = fmOf('tasks/needs-a-decision.md');
  expect(fm.status).toBe('blocked');
  expect(fm['blocked-on']).toBe('decision');
  expect(fm['blocked-by']).toEqual(['waiting on operator to pick an approach']);
});

test('blockTask reconciles the folder from a non-root status back to the tasks/ root', () => {
  createTask(root, {  title: 'Reblock Me', allowThin: true });
  pauseTask(root, 'reblock-me', 'waiting');
  const r = blockTask(root, 'reblock-me', 'external', 'vendor ticket open');
  expect(r.newPath).toBe('tasks/reblock-me.md');
  expect(existsSync(join(root, 'tasks/paused/reblock-me.md'))).toBe(false);
  expect(existsSync(join(root, 'tasks/reblock-me.md'))).toBe(true);
});

test('blockTask rejects a value outside the five-value taxonomy, leaving the task untouched', () => {
  createTask(root, {  title: 'Bad Taxonomy', allowThin: true });
  expect(() => blockTask(root, 'bad-taxonomy', 'operator' as never, 'reason')).toThrow();
  const fm = fmOf('tasks/bad-taxonomy.md');
  expect(fm.status).toBe('active'); // rejected before any write
});

test('blockTask requires a non-empty --by', () => {
  createTask(root, {  title: 'No Reason', allowThin: true });
  expect(() => blockTask(root, 'no-reason', 'peer', '')).toThrow();
  expect(() => blockTask(root, 'no-reason', 'peer', '   ')).toThrow();
});

test('setTaskStatus CONFLICT leaves the source file untouched (check precedes any write)', () => {
  createTask(root, {  title: 'Clash', allowThin: true });
  mkdirSync(join(root, 'tasks/backlog'), { recursive: true });
  writeFileSync(
    join(root, 'tasks/backlog/clash.md'),
    matter.stringify('# Other\n', { type: 'task', status: 'backlog', created: '2026-01-01' }),
  );
  expect(() => setTaskStatus(root, 'clash', 'backlog')).toThrow('Move target already exists');
  const fm = fmOf('tasks/clash.md');
  expect(fm.status).toBe('active'); // NOT flipped — a failed move must not leave status↔folder drift
});
