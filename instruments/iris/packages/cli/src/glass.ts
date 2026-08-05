#!/usr/bin/env bun
/**
 * House span entry (OpenTUI dashboard). Invoked by the global `iris` bin
 * (bare `iris` or `iris dash`). Not a separate global bin — iris installs
 * exactly one binary on PATH.
 *
 *   iris              → open the dashboard
 *   iris dash         → same
 *   iris --help | -h  → house help (iris.ts)
 */
import { launchDash, resolveTuiEntry } from './dash-launch';

const NOTE =
  'iris opens the dashboard (the span). Org verbs (status, task, knowledge, inbox, ' +
  'reminder, lint, search, links, graph, athanor, lucerna, …) live under `iris <verb>`.';

const argv = process.argv.slice(2);

if (argv.length === 0) {
  await launchDash([]); // never returns
}

if (argv[0] === 'dash') {
  await launchDash(argv.slice(1)); // compat alias — passes through any trailing args
}

if (argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(NOTE + '\n');
  process.exit(0);
}

// Hidden: print the TUI entry the bare invocation WOULD spawn (no launch) — lets a
// smoke assert the spawn target resolves without taking over the terminal.
if (argv[0] === '--print-entry') {
  process.stdout.write((await resolveTuiEntry()) + '\n');
  process.exit(0);
}

// Anything else: the note on stderr, USAGE exit.
process.stderr.write(NOTE + '\n');
process.exit(64);
