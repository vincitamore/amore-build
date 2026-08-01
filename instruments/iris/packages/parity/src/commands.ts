// The single spec table — help + the `commands --json` capability manifest derive
// from here (never hand-maintained twice). Mirrors the vinculum/cli spec shape.

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  /** Write verbs REFUSE unknown flags (exit 64); read verbs warn on stderr. */
  write: boolean;
  flags: Record<string, string>;
  booleanFlags: Record<string, string>;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'commands',
    summary: 'Capability manifest (this table)',
    usage: 'parity commands [--json]',
    write: false,
    flags: {},
    booleanFlags: {},
  },
  {
    name: 'inventory',
    summary: 'The discovered endpoint inventory + tier counts (core/inventory/mutating/excluded)',
    usage: 'parity inventory [--tier core|inventory|mutating|excluded] [--json]',
    write: false,
    flags: { tier: 'filter to one tier' },
    booleanFlags: {},
  },
  {
    name: 'cases',
    summary: 'The case matrix (one row per recorded request)',
    usage: 'parity cases [--json]',
    write: false,
    flags: {},
    booleanFlags: {},
  },
  {
    name: 'record',
    summary: 'Record every core case against a base daemon into golden/ (the spec snapshot)',
    usage: 'parity record [--base http://127.0.0.1:3853] [--out golden/] [--json]',
    write: true, // writes goldens to disk (not the daemon — read-only against it)
    flags: {
      base: 'daemon base URL to record from (default http://127.0.0.1:3853)',
      out: 'golden output directory (default golden/ under cwd)',
    },
    booleanFlags: {},
  },
  {
    name: 'replay',
    summary: 'Re-fire recorded cases against a target daemon and diff bodies vs golden',
    usage: 'parity replay --target <url> [--golden golden/] [--max-diffs N] [--json]',
    write: false,
    flags: {
      target: 'daemon base URL to diff against the goldens (required)',
      golden: 'golden directory to replay from (default golden/ under cwd)',
      'max-diffs': 'max diff paths to print per failing case (default 8)',
    },
    booleanFlags: {},
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function manifest(): { commands: Array<Record<string, unknown>> } {
  return {
    commands: COMMANDS.map((c) => ({
      name: c.name,
      summary: c.summary,
      usage: c.usage,
      write: c.write,
      flags: Object.entries(c.flags).map(([name, description]) => ({ name, description })),
      booleanFlags: Object.entries(c.booleanFlags).map(([name, description]) => ({ name, description })),
    })),
  };
}

export function helpText(): string {
  const lines = ['parity — golden-master parity harness for the daemon rework', ''];
  for (const c of COMMANDS) {
    lines.push(`  ${c.usage}`);
    lines.push(`      ${c.summary}`);
  }
  lines.push('');
  lines.push('Global flags: --json (ok-first envelope to stdout) · --quiet (suppress stderr)');
  return lines.join('\n');
}
