import { test, expect } from 'bun:test';
import { COMMANDS, resolveCommand, type CommandSpec } from './commands';

function resolveOk(argv: string[]): CommandSpec {
  const r = resolveCommand(argv);
  if ('error' in r) throw new Error(r.error);
  return r.spec;
}

test('resolveCommand resolves every A1-parity verb to the right spec', () => {
  expect(resolveOk(['status']).name).toBe('status');
  expect(resolveOk(['inbox', 'move', 'x', 'ideas']).name).toBe('inbox move');
  expect(resolveOk(['inbox', 'archive', 'x']).name).toBe('inbox archive');
  expect(resolveOk(['inbox', 'get', 'x']).name).toBe('inbox get');
  expect(resolveOk(['reminder', 'update', 'x']).name).toBe('reminder update');
  expect(resolveOk(['reminder', 'get', 'x']).name).toBe('reminder get');
  expect(resolveOk(['links', 'x.md']).name).toBe('links');
  expect(resolveOk(['search', 'query']).name).toBe('search');
  expect(resolveOk(['task', 'block', 'x']).name).toBe('task block');
});

test('write/read classification is correct for the new verbs (governs the unknown-flag refuse-vs-warn policy)', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  expect(byName['status'].isWrite).toBe(false);
  expect(byName['inbox move'].isWrite).toBe(true);
  expect(byName['inbox archive'].isWrite).toBe(true);
  expect(byName['inbox get'].isWrite).toBe(false);
  expect(byName['reminder update'].isWrite).toBe(true);
  expect(byName['reminder get'].isWrite).toBe(false);
  expect(byName['links'].isWrite).toBe(false);
  expect(byName['search'].isWrite).toBe(false);
  expect(byName['task block'].isWrite).toBe(true);
});

test('tranche-2 verbs resolve to the right spec', () => {
  expect(resolveOk(['athanor', 'list']).name).toBe('athanor list');
  expect(resolveOk(['athanor', 'recipes']).name).toBe('athanor recipes');
  expect(resolveOk(['athanor', 'run', '--recipe', 'x']).name).toBe('athanor run');
  expect(resolveOk(['athanor', 'status', 'p']).name).toBe('athanor status');
  expect(resolveOk(['athanor', 'results', 'p']).name).toBe('athanor results');
  expect(resolveOk(['inbox', 'promote', 'x', 'task']).name).toBe('inbox promote');
});

test('tranche-2 write/read classification (athanor run is write; athanor reads are reads)', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  expect(byName['athanor list'].isWrite).toBe(false);
  expect(byName['athanor recipes'].isWrite).toBe(false);
  expect(byName['athanor status'].isWrite).toBe(false);
  expect(byName['athanor results'].isWrite).toBe(false);
  expect(byName['athanor run'].isWrite).toBe(true);
  expect(byName['inbox promote'].isWrite).toBe(true);
});

test('inbox promote requires --to task|knowledge before touching regula', () => {
  const spec = COMMANDS.find((c) => c.name === 'inbox promote')!;
  expect(() => spec.run({ orgRoot: '/nonexistent', args: { positional: ['x'], flags: {} } })).toThrow(/--to/);
  expect(() =>
    spec.run({ orgRoot: '/nonexistent', args: { positional: ['x'], flags: { to: 'bogus' } } }),
  ).toThrow(/--to/);
});

test('athanor run --concerns invalid JSON → USAGE before planning', () => {
  const spec = COMMANDS.find((c) => c.name === 'athanor run')!;
  expect(() =>
    spec.run({ orgRoot: '/nonexistent', args: { positional: [], flags: { recipe: 'r', goal: 'g', sources: 'a.md', concerns: '{bad' } } }),
  ).toThrow(/Invalid --concerns/);
});

test('task block flag registry documents the blocked-on taxonomy and a free-text --by', () => {
  const spec = COMMANDS.find((c) => c.name === 'task block')!;
  expect(spec.flags.on).toContain('decision');
  expect(spec.flags.on).toContain('peer');
  expect(spec.flags.on).toContain('corpus');
  expect(spec.flags.on).toContain('hardware');
  expect(spec.flags.on).toContain('external');
  expect(spec.flags.by).toBeDefined();
});

test('task block requires both --on and --by before touching regula', () => {
  const spec = COMMANDS.find((c) => c.name === 'task block')!;
  expect(() => spec.run({ orgRoot: '/nonexistent', args: { positional: ['x'], flags: {} } })).toThrow(
    /--on/,
  );
  expect(() =>
    spec.run({ orgRoot: '/nonexistent', args: { positional: ['x'], flags: { on: 'decision' } } }),
  ).toThrow(/--by/);
});

test('search flag registry documents mode/type/n', () => {
  const spec = COMMANDS.find((c) => c.name === 'search')!;
  expect(Object.keys(spec.flags)).toEqual(expect.arrayContaining(['mode', 'type', 'n']));
});

test('search rejects an invalid --mode before any daemon call', () => {
  const spec = COMMANDS.find((c) => c.name === 'search')!;
  expect(
    spec.run({ orgRoot: '/nonexistent', args: { positional: ['q'], flags: { mode: 'bogus' } } }),
  ).rejects.toThrow(/mode/);
});

test('search rejects a non-positive --n before any daemon call', () => {
  const spec = COMMANDS.find((c) => c.name === 'search')!;
  expect(
    spec.run({ orgRoot: '/nonexistent', args: { positional: ['q'], flags: { n: '0' } } }),
  ).rejects.toThrow(/--n/);
});

test('inbox move requires a target type (second positional or --to) before touching regula', () => {
  const spec = COMMANDS.find((c) => c.name === 'inbox move')!;
  expect(() => spec.run({ orgRoot: '/nonexistent', args: { positional: ['x'], flags: {} } })).toThrow(
    /target type/,
  );
});

test('status carries a human formatter; every other command does not (JSON-always default preserved)', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  expect(byName['status'].human).toBeDefined();
  for (const c of COMMANDS) {
    if (c.name === 'status') continue;
    expect(c.human).toBeUndefined();
  }
});

test('status human formatter renders a compact multi-line summary (counts, no JSON braces)', () => {
  const spec = COMMANDS.find((c) => c.name === 'status')!;
  const text = spec.human!({
    tasks: { active: 1, blocked: 0, review: 0, backlog: 0, incubating: 0, paused: 0, complete: 2 },
    inbox: { captures: 0, ideas: 0, decisions: 0, investigations: 0, total: 0 },
    reminders: { active: 0, overdue: 0, dueWithin7d: 0 },
    forge: { pendingDreams: 0, pendingProposals: 0 },
  });
  expect(text).toContain('1 active');
  expect(text).toContain('Inbox: clear');
  expect(text).toContain('Forge: queue clear');
  expect(text).not.toContain('{');
});

test('every command in the manifest carries hasHumanOutput and it matches the spec', async () => {
  const { manifest } = await import('./commands');
  const m = manifest() as { commands: Array<{ name: string; hasHumanOutput: boolean }> };
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  for (const entry of m.commands) {
    expect(entry.hasHumanOutput).toBe(byName[entry.name].human !== undefined);
  }
});
