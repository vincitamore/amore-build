import { type RegulaErrorCode } from '@arcus/regula';

/** Ratified exit codes (the house contract, shared with network-cli/oraculum). */
export const EXIT = {
  OK: 0, // clean
  ACTIONABLE: 1, // ran clean, found an actionable condition (not-found, clash, lint errors)
  INFRA: 2, // infrastructure failure (daemon unreachable)
  USAGE: 64, // bad invocation
  UNAVAILABLE: 69, // an external service is down
  INTERNAL: 70, // tool bug
  TIMEOUT: 124, // wait/timeout
} as const;

export function exitForRegulaCode(code: RegulaErrorCode): number {
  switch (code) {
    case 'USAGE':
      return EXIT.USAGE;
    case 'NOT_FOUND':
    case 'EXISTS':
    case 'CONFLICT':
    case 'INVALID':
      return EXIT.ACTIONABLE;
    default:
      return EXIT.INTERNAL; // defensive: an unknown code
  }
}

// ─── Envelopes (ok-first) ────────────────────────────────────────────────────

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

// ─── Arg parsing ─────────────────────────────────────────────────────────────

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse `--flag value` AND `--flag=value`; boolean flags (and a flag followed by
 * another `--flag`, or at end) become `true`. Negative numbers parse as values.
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

/**
 * Flags present in the parse but not in the command's registry (value flags + boolean flags +
 * the global json/quiet). Policy at the callsite: WARN on read verbs, REFUSE (exit 64) on
 * write verbs — a silently-dropped flag on a write doesn't express intent.
 */
/** Global boolean flags accepted on every verb (not per-command registry entries). */
export const GLOBAL_BOOLEAN_FLAGS = ['json', 'quiet', 'allow-foreign-root'] as const;

export function unknownFlags(
  parsed: Record<string, string | boolean>,
  spec: { flags: Record<string, string>; booleanFlags: string[] },
): string[] {
  const known = new Set([
    ...Object.keys(spec.flags),
    ...spec.booleanFlags,
    ...GLOBAL_BOOLEAN_FLAGS,
  ]);
  return Object.keys(parsed).filter((f) => !known.has(f));
}

export function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}
export function csv(flags: Record<string, string | boolean>, name: string): string[] | undefined {
  const v = str(flags, name);
  return v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);
}
export function bool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
