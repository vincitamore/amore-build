import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SpeculumErrorKind =
  | 'not-installed' // binary could not be found (ENOENT)
  | 'spawn-failed' // spawned but could not start (e.g. EACCES)
  | 'timeout' // exceeded timeoutMs (default 30_000)
  | 'nonzero' // exited non-zero; capture stderr tail
  | 'parse-failed'; // exit 0 but stdout is not valid JSON

export type SpeculumResult<T> =
  | { ok: true; json: T; stdout: string; ms: number }
  | {
      ok: false;
      error: {
        kind: SpeculumErrorKind;
        message: string;
        stderrTail?: string;
        stdoutTail?: string;
        ms?: number;
      };
    };

const DEFAULT_TIMEOUT_MS = 30_000;
const TAIL_CHARS = 800;
const MAX_BUFFER = 10 * 1024 * 1024;

/** In-flight promises keyed by JSON.stringify([verb, args]). */
const inflight = new Map<string, Promise<SpeculumResult<unknown>>>();

/**
 * Resolve the binary name/path to spawn.
 * Order: env `SPECULUM_BIN` (call-time), else the literal `speculum` (PATH-resolved by spawn).
 */
export function resolveSpeculumBin(): string {
  const override = process.env.SPECULUM_BIN;
  if (override != null && override.length > 0) return override;
  return 'speculum';
}

function tail(s: string | undefined | null, n = TAIL_CHARS): string | undefined {
  if (s == null || s.length === 0) return undefined;
  return s.length <= n ? s : s.slice(-n);
}

function inflightKey(verb: string, args: string[]): string {
  return JSON.stringify([verb, args]);
}

/**
 * Run a speculum CLI verb and parse JSON stdout.
 * Adds no implicit flags — callers pass `--json` themselves.
 * Concurrent identical (verb, args) share one in-flight promise.
 */
export async function runSpeculum<T>(
  verb: string,
  args: string[] = [],
  opts?: { timeoutMs?: number },
): Promise<SpeculumResult<T>> {
  const key = inflightKey(verb, args);
  const existing = inflight.get(key);
  if (existing) return existing as Promise<SpeculumResult<T>>;

  const promise = runSpeculumOnce<T>(verb, args, opts).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise as Promise<SpeculumResult<unknown>>);
  return promise;
}

async function runSpeculumOnce<T>(
  verb: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<SpeculumResult<T>> {
  const bin = resolveSpeculumBin();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const argv = [verb, ...args];

  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
      // never shell: true — injection-safe; PATH lookup for bare names
    });
    const ms = Date.now() - started;
    const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
    const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
    try {
      const json = JSON.parse(out) as T;
      return { ok: true, json, stdout: out, ms };
    } catch {
      return {
        ok: false,
        error: {
          kind: 'parse-failed',
          message: 'speculum exited 0 but stdout is not valid JSON',
          stdoutTail: tail(out),
          stderrTail: tail(errOut),
          ms,
        },
      };
    }
  } catch (e) {
    const ms = Date.now() - started;
    return mapExecError<T>(e, bin, verb, ms, timeoutMs);
  }
}

type ExecErr = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stdout?: string;
  stderr?: string;
  cmd?: string;
};

function mapExecError<T>(
  e: unknown,
  bin: string,
  verb: string,
  ms: number,
  timeoutMs: number,
): SpeculumResult<T> {
  const err = e as ExecErr;
  const code = err.code;
  const stdout = typeof err.stdout === 'string' ? err.stdout : undefined;
  const stderr = typeof err.stderr === 'string' ? err.stderr : undefined;
  const stderrTail = tail(stderr);
  const stdoutTail = tail(stdout);

  // Missing binary (execFile PATH lookup or absolute path absent).
  if (code === 'ENOENT') {
    return {
      ok: false,
      error: {
        kind: 'not-installed',
        message: `speculum binary not found (${bin})`,
        ms,
      },
    };
  }

  // Timeout: Node/Bun kill the child when `timeout` elapses (killed + signal).
  if (
    err.killed === true ||
    code === 'ETIMEDOUT' ||
    (typeof err.message === 'string' && /\bETIMEDOUT\b|timed out/i.test(err.message))
  ) {
    return {
      ok: false,
      error: {
        kind: 'timeout',
        message: `speculum ${verb} exceeded ${timeoutMs}ms`,
        stderrTail,
        stdoutTail,
        ms,
      },
    };
  }

  // Spawn-time OS errors (permission, not executable, etc.) — string errno, not exit status.
  if (typeof code === 'string') {
    return {
      ok: false,
      error: {
        kind: 'spawn-failed',
        message: `failed to spawn ${bin}: ${code}${err.message ? ` (${err.message})` : ''}`,
        stderrTail,
        stdoutTail,
        ms,
      },
    };
  }

  // Non-zero exit: promisify(execFile) rejects with numeric code.
  if (typeof code === 'number' && code !== 0) {
    return {
      ok: false,
      error: {
        kind: 'nonzero',
        message: `speculum ${verb} exited ${code}`,
        stderrTail,
        stdoutTail,
        ms,
      },
    };
  }

  // status field (some runtimes) or unknown failure.
  const status = err.status;
  if (typeof status === 'number' && status !== 0) {
    return {
      ok: false,
      error: {
        kind: 'nonzero',
        message: `speculum ${verb} exited ${status}`,
        stderrTail,
        stdoutTail,
        ms,
      },
    };
  }

  return {
    ok: false,
    error: {
      kind: 'spawn-failed',
      message: err.message || `failed to run ${bin} ${verb}`,
      stderrTail,
      stdoutTail,
      ms,
    },
  };
}
