// The house CLI contract, reimplemented for parity (◇ doctrine: no shared package —
// each tool reimplements the contract from the primitives). ok-first --json envelope ·
// ratified exit codes · --flag value AND --flag=value · unknown flags warn on reads.
//
// Mirrors instruments/vinculum/src/cli/contract.ts, retargeted at the parity verbs.

export const EXIT = {
  OK: 0, // clean — every recorded case matched
  ACTIONABLE: 1, // ran clean, found an actionable condition (a case diverged)
  INFRA: 2, // infrastructure failure (golden dir/manifest missing, unreadable)
  USAGE: 64, // bad invocation
  UNAVAILABLE: 69, // an external service is down (the base/target daemon)
  INTERNAL: 70, // tool bug
  TIMEOUT: 124, // a request timed out
} as const;

export interface OkEnvelope {
  ok: true;
  [k: string]: unknown;
}
export interface FailEnvelope {
  ok: false;
  error: { code: string; message: string };
  command: string;
}

export function ok(payload: Record<string, unknown>): OkEnvelope {
  return { ok: true, ...payload };
}
export function fail(code: string, message: string, command: string): FailEnvelope {
  return { ok: false, error: { code, message }, command };
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse `--flag value` AND `--flag=value`; boolean flags (and a flag followed by
 * another `--flag`, or at end) become `true`.
 */
export function parseArgs(args: string[], booleanFlags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = args[i + 1];
      if (!booleanFlags.includes(name) && next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** Flags present in the parse but not in the command's registry (+ global json/quiet). */
export function unknownFlags(
  parsed: Record<string, string | boolean>,
  spec: { flags: Record<string, string>; booleanFlags: Record<string, string> },
): string[] {
  const known = new Set([...Object.keys(spec.flags), ...Object.keys(spec.booleanFlags), 'json', 'quiet']);
  return Object.keys(parsed).filter((f) => !known.has(f));
}

export function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}
export function num(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
export function bool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
