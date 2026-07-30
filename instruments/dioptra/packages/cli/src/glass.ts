#!/usr/bin/env bun
/**
 * House sight entry (OpenTUI dashboard). Invoked by the global `dioptra` bin
 * (bare `dioptra` or `dioptra dash`). Not a separate global bin — dioptra does
 * not install bare `vitrum` on PATH.
 *
 *   dioptra              → open the dashboard
 *   dioptra dash         → same
 *   dioptra --help | -h  → house help (dioptra.ts)
 */
import { launchDash, resolveTuiEntry } from './dash-launch';

const NOTE =
  'dioptra opens the dashboard (the sight). Org verbs (status, task, knowledge, inbox, ' +
  'reminder, lint, search, links, graph, athanor, …) live under `dioptra <verb>`.';

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
