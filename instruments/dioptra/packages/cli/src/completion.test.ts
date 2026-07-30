import { test, expect } from 'bun:test';
import { resolveCompletions, completionScript } from './completion';

test('completes top-level groups + meta', () => {
  const c = resolveCompletions([], '');
  expect(c).toContain('task');
  expect(c).toContain('knowledge');
  expect(c).toContain('lint');
  expect(c).toContain('graph');
  expect(c).toContain('completion');
});

test('prefix-filters groups', () => {
  expect(resolveCompletions([], 'ta')).toEqual(['task']);
});

test('completes subcommands for a group', () => {
  const c = resolveCompletions(['task'], '');
  expect(c).toContain('list');
  expect(c).toContain('complete');
  expect(c).toContain('create');
});

test('subcommand prefix filter (co → complete, not create)', () => {
  expect(resolveCompletions(['task'], 'co')).toEqual(['complete']);
});

test('completes flags when the current word starts with --', () => {
  const c = resolveCompletions(['inbox', 'list'], '--');
  expect(c).toContain('--all'); // inbox list carries the boolean flag `all`
  expect(c).toContain('--json');
});

test('top-level completions no longer offer dash (glass is bare dioptra / dioptra dash; org verbs complete here)', () => {
  const c = resolveCompletions([], '');
  expect(c).not.toContain('dash');
  expect(c).toContain('commands');
  expect(c).toContain('help');
  expect(c).toContain('completion');
});

test('bash completion script targets the dioptra program name', () => {
  const s = completionScript('bash');
  expect(s).toContain('complete -F _dioptra_complete dioptra');
  expect(s).toContain('dioptra __complete');
  expect(s).not.toContain('regula');
  expect(s).not.toContain('vitrum');
});

test('powershell completion script targets the dioptra program name', () => {
  const s = completionScript('powershell');
  expect(s).toContain('-CommandName dioptra');
  expect(s).toContain('& dioptra __complete');
  expect(s).not.toContain('regula');
  expect(s).not.toContain('vitrum');
});
