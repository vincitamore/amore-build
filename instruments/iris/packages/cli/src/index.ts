#!/usr/bin/env bun
import { ensureMutationTrust, RegulaError } from '@amore/regula';
import { resolveOrgRoot } from './org-root';
import { COMMANDS, manifest, resolveCommand } from './commands';
import {
  EXIT,
  exitForRegulaCode,
  fail,
  GLOBAL_BOOLEAN_FLAGS,
  ok,
  parseArgs,
  unknownFlags,
} from './contract';
import { DaemonError } from './daemon';
import { completionScript, resolveCompletions } from './completion';

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** One-line stderr summary on errors (the contract's second stream); --quiet suppresses. */
function emitFail(code: string, message: string, command: string, quiet: boolean): void {
  emit(fail(code, message, command));
  if (!quiet) process.stderr.write(`${code}: ${message}\n`);
}

function helpText(): Record<string, unknown> {
  return {
    usage: 'iris <command> [args] [--flags]',
    commands: COMMANDS.map((c) => `${c.name}${c.isWrite ? '' : ' (read)'} — ${c.summary}`),
    notes: [
      'Reads (status, list, search, graph, …) work on any resolved org root.',
      'Mutations require a house root (AGENTS.md|AGENT.md|CLAUDE.md + tasks/) or opt-in:',
      '  --allow-foreign-root | IRIS_ALLOW_FOREIGN_ROOT=1 | ~/.iris/allowed-roots.json',
    ],
  };
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
  emit(ok({ command: 'help', ...helpText() }));
  process.exit(EXIT.OK);
}

if (argv[0] === 'commands') {
  emit(ok({ command: 'commands', ...manifest() }));
  process.exit(EXIT.OK);
}

// `completion` and `__complete` emit RAW text (a script / candidate list), not JSON.
if (argv[0] === 'completion') {
  process.stdout.write(completionScript(argv[1] === 'powershell' ? 'powershell' : 'bash'));
  process.exit(EXIT.OK);
}
if (argv[0] === '__complete') {
  const rest = argv.slice(1);
  const current = rest.length ? rest[rest.length - 1] : '';
  const prior = rest.slice(0, -1);
  process.stdout.write(resolveCompletions(prior, current).join('\n') + '\n');
  process.exit(EXIT.OK);
}

const resolved = resolveCommand(argv);
if ('error' in resolved) {
  emit(fail('USAGE', resolved.error, argv.slice(0, 2).join(' ')));
  process.exit(EXIT.USAGE);
}

const { spec, rest } = resolved;
const args = parseArgs(rest, [...spec.booleanFlags, ...GLOBAL_BOOLEAN_FLAGS]);
const quiet = args.flags.quiet === true;
const allowForeignRoot = args.flags['allow-foreign-root'] === true;

// Unknown-flag policy: REFUSE on write verbs (a silently-dropped flag on a write doesn't
// express intent), WARN on reads.
const unknown = unknownFlags(args.flags, spec);
if (unknown.length > 0) {
  const list = unknown.map((f) => `--${f}`).join(' ');
  if (spec.isWrite) {
    emitFail('USAGE', `Unknown flag(s) for ${spec.name}: ${list}`, spec.name, quiet);
    process.exit(EXIT.USAGE);
  } else if (!quiet) {
    process.stderr.write(`warning: unknown flag(s) ignored: ${list}\n`);
  }
}

const orgRoot = resolveOrgRoot();
if (!orgRoot) {
  emitFail(
    'USAGE',
    'Org root not found — run inside the org tree or set IRIS_ORG_ROOT (refusing the cwd fallback)',
    spec.name,
    quiet,
  );
  process.exit(EXIT.USAGE);
}

// Tiered trust: READ verbs skip the guard. MUTATION verbs go through the single seam
// (regula root-trust) — house markers, --allow-foreign-root, env, or allow-list.
if (spec.isWrite) {
  try {
    await ensureMutationTrust(orgRoot, {
      allowForeignRoot,
      // Prompt only on a real TTY; non-interactive fails closed with the flag/env remedy.
      interactive: Boolean(process.stdin.isTTY),
    });
  } catch (e) {
    if (e instanceof RegulaError) {
      emitFail(e.code, e.message, spec.name, quiet);
      process.exit(exitForRegulaCode(e.code));
    }
    throw e;
  }
}

try {
  const payload = (await spec.run({ orgRoot, args })) as Record<string, unknown>;
  // Orientation verbs (currently just `status`) carry a compact human formatter and print
  // that by default; --json opts into the ok-first envelope every other verb always uses.
  if (spec.human && args.flags.json !== true) {
    process.stdout.write(spec.human(payload) + '\n');
  } else {
    emit(ok({ command: spec.name, ...payload }));
  }
  process.exit(spec.exit ? spec.exit(payload) : EXIT.OK);
} catch (e) {
  if (e instanceof RegulaError) {
    emitFail(e.code, e.message, spec.name, quiet);
    process.exit(exitForRegulaCode(e.code));
  }
  if (e instanceof DaemonError) {
    emitFail(e.code, e.message, spec.name, quiet);
    process.exit(
      e.code === 'DAEMON_UNAVAILABLE' ? EXIT.UNAVAILABLE : e.code === 'DAEMON_TIMEOUT' ? EXIT.TIMEOUT : EXIT.INFRA,
    );
  }
  emitFail('INTERNAL', e instanceof Error ? e.message : String(e), spec.name, quiet);
  process.exit(EXIT.INTERNAL);
}
