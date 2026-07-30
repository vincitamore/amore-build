import { test, expect } from 'bun:test';
import { parseArgs, ok, fail, exitForRegulaCode, csv, unknownFlags, EXIT } from './contract';
import { COMMANDS } from './commands';

test('parseArgs handles --flag value, --flag=value, booleans, and positionals', () => {
  const r = parseArgs(['create', '--title', 'My Task', '--tags=a,b', '--json'], ['json']);
  expect(r.positional).toEqual(['create']);
  expect(r.flags.title).toBe('My Task');
  expect(r.flags.tags).toBe('a,b');
  expect(r.flags.json).toBe(true);
});

test('parseArgs treats a negative number as a value, not a flag', () => {
  const r = parseArgs(['--count', '-5']);
  expect(r.flags.count).toBe('-5');
});

test('parseArgs: a flag at end or before another flag is boolean true', () => {
  const r = parseArgs(['--a', '--b', 'x']);
  expect(r.flags.a).toBe(true);
  expect(r.flags.b).toBe('x');
});

test('csv splits and trims, undefined when absent', () => {
  expect(csv({ tags: 'a, b ,c' }, 'tags')).toEqual(['a', 'b', 'c']);
  expect(csv({}, 'tags')).toBeUndefined();
});

test('ok-first envelope shape', () => {
  expect(ok({ path: 'x' })).toEqual({ ok: true, path: 'x' });
  const f = fail('USAGE', 'bad', 'task create');
  expect(f.ok).toBe(false);
  expect(f.error.code).toBe('USAGE');
  expect(f.command).toBe('task create');
});

test('RegulaError codes map to ratified exit codes', () => {
  expect(exitForRegulaCode('USAGE')).toBe(EXIT.USAGE);
  expect(exitForRegulaCode('NOT_FOUND')).toBe(EXIT.ACTIONABLE);
  expect(exitForRegulaCode('CONFLICT')).toBe(EXIT.ACTIONABLE);
});

test('unknownFlags flags what the registry does not know; json/quiet/booleans/values pass', () => {
  const spec = { flags: { title: 't', tags: 't' }, booleanFlags: ['all'] };
  expect(unknownFlags({ title: 'x', tags: 'a', all: true, json: true, quiet: true }, spec)).toEqual([]);
  expect(unknownFlags({ title: 'x', titel: 'typo', 'blocked-on': 'y' }, spec)).toEqual(['titel', 'blocked-on']);
});

test('every command spec carries a flag registry (the contract single-source)', () => {
  for (const c of COMMANDS) {
    expect(c.flags).toBeDefined();
    // registry keys must be flag names, not --prefixed
    for (const k of Object.keys(c.flags)) expect(k.startsWith('--')).toBe(false);
  }
});
