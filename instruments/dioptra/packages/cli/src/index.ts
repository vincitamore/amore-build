#!/usr/bin/env bun
import { RegulaError } from '@selene/regula';
import { resolveOrgRoot } from './org-root';
import { COMMANDS, manifest, resolveCommand } from './commands';
import { EXIT, exitForRegulaCode, fail, ok, parseArgs, unknownFlags } from './contract';
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
    usage: 'dioptra <command> [args] [--flags]',
    commands: COMMANDS.map((c) => `${c.name}${c.isWrite ? '' : ' (read)'} — ${c.summary}`),
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
const args = parseArgs(rest, [...spec.booleanFlags, 'json', 'quiet']);
const quiet = args.flags.quiet === true;

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
    'Org root not found — run inside the org tree or set DIOPTRA_ORG_ROOT (refusing the cwd fallback)',
    spec.name,
    quiet,
  );
  process.exit(EXIT.USAGE);
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
