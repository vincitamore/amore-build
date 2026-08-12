import { test, expect } from 'bun:test';
import { COMMANDS, resolveCommand, type CommandSpec } from './commands';
import {
  lucernaWriteExit,
  parseBudgetSetArgs,
  projectLucernaBudgets,
  projectLucernaChoresList,
  projectLucernaChoresShow,
} from './lucerna';

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

test('edges verbs resolve and classify write/read correctly', () => {
  expect(resolveOk(['edges', 'derive']).name).toBe('edges derive');
  expect(resolveOk(['edges', 'list']).name).toBe('edges list');
  expect(resolveOk(['edges', 'show', 'abc123']).name).toBe('edges show');
  expect(resolveOk(['edges', 'remove', 'abc123']).name).toBe('edges remove');
  expect(resolveOk(['edges', 'edit', 'abc123', '--note', 'x']).name).toBe('edges edit');
  expect(resolveOk(['edges', 'validate']).name).toBe('edges validate');
  expect(resolveOk(['edges', 'stats']).name).toBe('edges stats');
  expect(resolveOk(['edges', 'update']).name).toBe('edges update');
  expect(resolveOk(['edges', 'update', '--tier', '2']).name).toBe('edges update');
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  expect(byName['edges derive'].isWrite).toBe(true);
  expect(byName['edges remove'].isWrite).toBe(true);
  expect(byName['edges edit'].isWrite).toBe(true);
  expect(byName['edges update'].isWrite).toBe(true);
  expect(byName['edges list'].isWrite).toBe(false);
  expect(byName['edges show'].isWrite).toBe(false);
  expect(byName['edges validate'].isWrite).toBe(false);
  expect(byName['edges stats'].isWrite).toBe(false);
  expect(typeof byName['edges list'].human).toBe('function');
  expect(typeof byName['edges show'].human).toBe('function');
  expect(typeof byName['edges update'].human).toBe('function');
  expect(byName['edges list'].flags.tier).toBeDefined();
  expect(byName['edges list'].flags.mechanism).toBeDefined();
  expect(byName['edges list'].flags.recent).toBeDefined();
  expect(byName['edges update'].flags.tier).toContain('0|1|2');
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

test('stop resolves as a read (daemon lifecycle) verb', () => {
  const spec = resolveOk(['stop']);
  expect(spec.name).toBe('stop');
  expect(spec.isWrite).toBe(false);
});

test('lucerna verbs resolve to the right spec', () => {
  expect(resolveOk(['lucerna', 'status']).name).toBe('lucerna status');
  expect(resolveOk(['lucerna', 'log']).name).toBe('lucerna log');
  expect(resolveOk(['lucerna', 'halt']).name).toBe('lucerna halt');
  expect(resolveOk(['lucerna', 'wake']).name).toBe('lucerna wake');
  expect(resolveOk(['lucerna', 'sleep']).name).toBe('lucerna sleep');
  expect(resolveOk(['lucerna', 'start']).name).toBe('lucerna start');
  expect(resolveOk(['lucerna', 'stop']).name).toBe('lucerna stop');
  expect(resolveOk(['lucerna', 'enable', 'dreams', 'on']).name).toBe('lucerna enable');
  expect(resolveOk(['lucerna', 'notifications']).name).toBe('lucerna notifications');
  expect(resolveOk(['lucerna', 'dreams']).name).toBe('lucerna dreams');
  expect(resolveOk(['lucerna', 'dreams', 'show', 'x']).name).toBe('lucerna dreams');
  expect(resolveOk(['lucerna', 'dreams', 'list']).name).toBe('lucerna dreams');
  expect(resolveOk(['lucerna', 'dreams', 'review', 'x']).name).toBe('lucerna dreams review');
  expect(resolveOk(['lucerna', 'proposals']).name).toBe('lucerna proposals');
  expect(resolveOk(['lucerna', 'proposals', 'show', 'x']).name).toBe('lucerna proposals');
  expect(resolveOk(['lucerna', 'proposals', 'list']).name).toBe('lucerna proposals');
  expect(resolveOk(['lucerna', 'proposals', 'apply', 'x']).name).toBe('lucerna proposals apply');
  expect(resolveOk(['lucerna', 'proposals', 'close', 'x']).name).toBe('lucerna proposals close');
});

test('non-registered three-word sequence falls through to the two-word spec', () => {
  expect(resolveOk(['lucerna', 'dreams', 'show', 'x']).name).toBe('lucerna dreams');
  expect(resolveOk(['lucerna', 'proposals', 'show', 'x']).name).toBe('lucerna proposals');
});

test('lucerna write/read classification', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  expect(byName['lucerna status'].isWrite).toBe(false);
  expect(byName['lucerna log'].isWrite).toBe(false);
  expect(byName['lucerna notifications'].isWrite).toBe(false);
  expect(byName['lucerna dreams'].isWrite).toBe(false);
  expect(byName['lucerna proposals'].isWrite).toBe(false);
  expect(byName['lucerna dreams review'].isWrite).toBe(true);
  expect(byName['lucerna proposals apply'].isWrite).toBe(true);
  expect(byName['lucerna proposals close'].isWrite).toBe(true);
  expect(byName['lucerna halt'].isWrite).toBe(true);
  expect(byName['lucerna wake'].isWrite).toBe(true);
  expect(byName['lucerna sleep'].isWrite).toBe(true);
  expect(byName['lucerna start'].isWrite).toBe(true);
  expect(byName['lucerna stop'].isWrite).toBe(true);
  expect(byName['lucerna enable'].isWrite).toBe(true);
});

test('lucerna log rejects invalid --n before any daemon call', () => {
  const spec = COMMANDS.find((c) => c.name === 'lucerna log')!;
  expect(
    spec.run({ orgRoot: '/nonexistent', args: { positional: [], flags: { n: '0' } } }),
  ).rejects.toThrow(/--n/);
  expect(
    spec.run({ orgRoot: '/nonexistent', args: { positional: [], flags: { n: 'x' } } }),
  ).rejects.toThrow(/--n/);
});

test('lucerna enable requires flag and on|off', () => {
  const spec = COMMANDS.find((c) => c.name === 'lucerna enable')!;
  expect(() =>
    spec.run({ orgRoot: '/nonexistent', args: { positional: [], flags: {} } }),
  ).toThrow(/enable/);
  expect(() =>
    spec.run({ orgRoot: '/nonexistent', args: { positional: ['dreams'], flags: {} } }),
  ).toThrow(/enable/);
});

test('lucerna dreams / proposals subcommand usage before daemon call', () => {
  const dreams = COMMANDS.find((c) => c.name === 'lucerna dreams')!;
  expect(
    dreams.run({ orgRoot: '/nonexistent', args: { positional: ['show'], flags: {} } }),
  ).rejects.toThrow(/show requires/);
  expect(
    dreams.run({ orgRoot: '/nonexistent', args: { positional: ['review'], flags: {} } }),
  ).rejects.toThrow(/lucerna dreams review/);
  expect(
    dreams.run({ orgRoot: '/nonexistent', args: { positional: ['bogus'], flags: {} } }),
  ).rejects.toThrow(/expects/);

  const review = COMMANDS.find((c) => c.name === 'lucerna dreams review')!;
  expect(
    review.run({ orgRoot: '/nonexistent', args: { positional: [], flags: {} } }),
  ).rejects.toThrow(/review requires/);

  const apply = COMMANDS.find((c) => c.name === 'lucerna proposals apply')!;
  expect(
    apply.run({ orgRoot: '/nonexistent', args: { positional: [], flags: {} } }),
  ).rejects.toThrow(/apply requires/);

  const close = COMMANDS.find((c) => c.name === 'lucerna proposals close')!;
  expect(
    close.run({ orgRoot: '/nonexistent', args: { positional: [], flags: {} } }),
  ).rejects.toThrow(/close requires/);
});

test('lucernaWriteExit maps ok:false to ACTIONABLE', () => {
  expect(lucernaWriteExit({ ok: true })).toBe(0);
  expect(lucernaWriteExit({ ok: false })).toBe(1);
});

test('lucerna budgets/chores resolve to their own read specs', () => {
  expect(resolveOk(['lucerna', 'budgets']).name).toBe('lucerna budgets');
  expect(resolveOk(['lucerna', 'budgets', 'show']).name).toBe('lucerna budgets show');
  expect(resolveOk(['lucerna', 'chores']).name).toBe('lucerna chores');
  expect(resolveOk(['lucerna', 'chores', 'list']).name).toBe('lucerna chores list');
  expect(resolveOk(['lucerna', 'chores', 'show', 'scan']).name).toBe('lucerna chores show');
  expect(resolveOk(['lucerna', 'budgets', 'set', 'tokens', '1']).name).toBe('lucerna budgets set');
  expect(resolveOk(['lucerna', 'chores', 'enable', 'scan']).name).toBe('lucerna chores enable');
  expect(resolveOk(['lucerna', 'chores', 'disable', 'scan']).name).toBe('lucerna chores disable');
  expect(resolveOk(['lucerna', 'chores', 'interval', 'scan', '24']).name).toBe(
    'lucerna chores interval',
  );
  expect(resolveOk(['lucerna', 'dreams', 'review', 'x']).name).toBe('lucerna dreams review');
});

test('lucerna write verbs are three-word, isWrite true, flags populated', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  for (const name of [
    'lucerna budgets set',
    'lucerna chores enable',
    'lucerna chores disable',
    'lucerna chores interval',
  ]) {
    expect(byName[name].isWrite).toBe(true);
    expect(byName[name].flags).toEqual({});
    expect(byName[name].exit).toBe(lucernaWriteExit);
  }
});

test('parseBudgetSetArgs maps aliases and refuses 1e9 / negatives', () => {
  expect(parseBudgetSetArgs('tokens', '400000')).toEqual({
    knob: 'dailyTokenCeiling',
    n: 400000,
  });
  expect(parseBudgetSetArgs('actions', '0')).toEqual({ knob: 'dailyActionCap', n: 0 });
  expect(parseBudgetSetArgs('cooldown', '2')).toEqual({ knob: 'cycleCooldownMinutes', n: 120 });
  expect(parseBudgetSetArgs('reserve', '80000')).toEqual({
    knob: 'dreamsReserveTokens',
    n: 80000,
  });
  expect(() => parseBudgetSetArgs('tokens', '1e9')).toThrow(/non-negative integer/);
  expect(() => parseBudgetSetArgs('actions', '-1')).toThrow(/non-negative integer/);
});

test('lucerna budgets/chores reads are isWrite false', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  expect(byName['lucerna budgets'].isWrite).toBe(false);
  expect(byName['lucerna budgets show'].isWrite).toBe(false);
  expect(byName['lucerna chores'].isWrite).toBe(false);
  expect(byName['lucerna chores list'].isWrite).toBe(false);
  expect(byName['lucerna chores show'].isWrite).toBe(false);
  expect(byName['lucerna dreams review'].isWrite).toBe(true);
});

test('lucerna chores list registers --disabled in the flag table', () => {
  const list = COMMANDS.find((c) => c.name === 'lucerna chores list')!;
  expect(list.booleanFlags).toContain('disabled');
  expect(list.flags.disabled).toBeDefined();
  const twoWord = COMMANDS.find((c) => c.name === 'lucerna chores')!;
  expect(twoWord.booleanFlags).toContain('disabled');
  expect(twoWord.flags.disabled).toBeDefined();
});

test('lucerna budgets set / chores enable|disable|interval USAGE before daemon call', () => {
  const budgets = COMMANDS.find((c) => c.name === 'lucerna budgets')!;
  expect(
    budgets.run({ orgRoot: '/nonexistent', args: { positional: ['set'], flags: {} } }),
  ).rejects.toThrow(/lucerna budgets set/);

  const chores = COMMANDS.find((c) => c.name === 'lucerna chores')!;
  expect(
    chores.run({ orgRoot: '/nonexistent', args: { positional: ['enable'], flags: {} } }),
  ).rejects.toThrow(/lucerna chores enable/);
  expect(
    chores.run({ orgRoot: '/nonexistent', args: { positional: ['disable'], flags: {} } }),
  ).rejects.toThrow(/lucerna chores disable/);
  expect(
    chores.run({ orgRoot: '/nonexistent', args: { positional: ['interval'], flags: {} } }),
  ).rejects.toThrow(/lucerna chores interval/);

  const show = COMMANDS.find((c) => c.name === 'lucerna chores show')!;
  expect(
    show.run({ orgRoot: '/nonexistent', args: { positional: [], flags: {} } }),
  ).rejects.toThrow(/show requires/);
});

test('lucerna budgets/chores project a missing house without throwing', () => {
  const missing = { available: false, reason: 'not-installed' };
  expect(projectLucernaBudgets(missing)).toEqual({
    available: false,
    budgets: null,
    capability: null,
    reason: 'not-installed',
  });
  expect(projectLucernaChoresList(missing)).toEqual({
    available: false,
    count: 0,
    entries: [],
    reason: 'not-installed',
  });
  expect(projectLucernaChoresShow(missing, 'scan')).toEqual({
    available: false,
    found: false,
  });
});

test('lucerna budgets projects capability from status.budgets', () => {
  const capability = { state: 'ready', reasonCode: 'ok', reason: 'ok' };
  const budgets = { state: 'ready', capability, roster: { entries: [] } };
  expect(projectLucernaBudgets({ available: true, budgets })).toEqual({
    available: true,
    budgets,
    capability,
  });
});

test('lucerna chores list/show project roster.entries', () => {
  const entries = [
    { key: 'scan', class: 'maintenance', tier: 'light', enabled: true, lastRun: null },
    { key: 'web', class: 'research', tier: 'expensive', enabled: false, lastRun: '2026-01-01' },
  ];
  const status = { available: true, budgets: { roster: { entries } } };
  expect(projectLucernaChoresList(status)).toEqual({ available: true, count: 2, entries });
  expect(projectLucernaChoresList(status, true)).toEqual({
    available: true,
    count: 1,
    entries: [entries[1]],
  });
  expect(projectLucernaChoresShow(status, 'scan')).toEqual({
    available: true,
    found: true,
    ...entries[0],
  });
  expect(projectLucernaChoresShow(status, 'missing')).toEqual({
    available: true,
    found: false,
  });
});

test('lucerna chores show exits 0 when not-installed and 1 when key is missing', () => {
  const spec = COMMANDS.find((c) => c.name === 'lucerna chores show')!;
  expect(spec.exit!({ available: false, found: false })).toBe(0);
  expect(spec.exit!({ available: true, found: false })).toBe(1);
  expect(spec.exit!({ available: true, found: true })).toBe(0);
});

test('lucerna write specs exit 1 on ok:false (not-installed)', () => {
  const set = COMMANDS.find((c) => c.name === 'lucerna budgets set')!;
  expect(set.exit!({ ok: false, reason: 'not-installed' })).toBe(1);
  expect(set.exit!({ ok: true })).toBe(0);
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

test('human formatters are opt-in on orientation/review verbs only', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  expect(byName['status'].human).toBeDefined();
  expect(byName['edges list'].human).toBeDefined();
  expect(byName['edges show'].human).toBeDefined();
  expect(byName['edges update'].human).toBeDefined();
  const humanOk = new Set([
    'status',
    'edges list',
    'edges show',
    'edges update',
    'qmd setup',
    'qmd status',
  ]);
  for (const c of COMMANDS) {
    if (humanOk.has(c.name)) continue;
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
