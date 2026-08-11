/** HTTP client to the iris daemon — the read/index/graph/search authority.
 *  Also owns the verified-identity `stop` verb (pidfile + GET /api/daemon/status). */

import { resolve } from 'node:path';
import {
  clearPidFile,
  irisRuntimeDir,
  isPidAlive,
  readPidFile,
} from '../../daemon/src/pidfile.ts';

export class DaemonError extends Error {
  constructor(
    public readonly code: 'DAEMON_UNAVAILABLE' | 'DAEMON_ERROR' | 'DAEMON_TIMEOUT',
    message: string
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

/** Must match routes/daemon-status.ts `info.service`. */
export const IRIS_DAEMON_SERVICE = 'iris-bun-daemon';

/** Daemon base URL: `$IRIS_URL`, else `http://127.0.0.1:$IRIS_PORT` (default 3853 —
 *  amore house Bun daemon). */
export function daemonBaseUrl(): string {
  if (process.env.IRIS_URL) return process.env.IRIS_URL;
  const port = process.env.IRIS_PORT ?? '3853';
  return `http://127.0.0.1:${port}`;
}

function timeoutMs(): number {
  return Number(process.env.IRIS_TIMEOUT_MS ?? 15_000);
}

/** Map a fetch rejection to the right DaemonError (timeout vs unreachable). */
function mapFetchError(e: unknown, base: string, path: string): DaemonError {
  if (e instanceof Error && e.name === 'TimeoutError') {
    return new DaemonError('DAEMON_TIMEOUT', `Iris daemon did not respond within ${timeoutMs()}ms for ${path}`);
  }
  return new DaemonError(
    'DAEMON_UNAVAILABLE',
    `Iris daemon unreachable at ${base} — \`iris daemon\` (or bare \`iris\` / \`iris dash\`) starts it`
  );
}

/** GET a daemon path and parse JSON. Throws DaemonError (mapped to exit codes by the caller).
 *  Bounded: a hung daemon must not hang the CLI (default 15s; `$IRIS_TIMEOUT_MS` overrides). */
export async function daemonGet(path: string): Promise<unknown> {
  const base = daemonBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs()) });
  } catch (e) {
    throw mapFetchError(e, base, path);
  }
  if (!res.ok) {
    throw new DaemonError('DAEMON_ERROR', `Daemon responded ${res.status} ${res.statusText} for ${path}`);
  }
  return (await res.json()) as unknown;
}

/** POST JSON to a daemon path and parse the JSON response. Same timeout/error mapping as
 *  daemonGet — the write half of the Bun-daemon client (mutating daemon routes when present). A body
 *  is always sent (even `{}`) so the route's `req.json()` never rejects on an empty stream. */
export async function daemonPost(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const base = daemonBaseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (e) {
    throw mapFetchError(e, base, path);
  }
  if (!res.ok) {
    throw new DaemonError('DAEMON_ERROR', `Daemon responded ${res.status} ${res.statusText} for ${path}`);
  }
  return (await res.json()) as unknown;
}

/** Normalize org roots for equality (absolute, slash-folded; case-fold on Windows). */
export function normalizeOrgRoot(root: string): string {
  let p = resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') p = p.toLowerCase();
  return p;
}

export interface StopDaemonOk {
  ok: true;
  note: string;
  pid?: number;
  signaled?: boolean;
}

export interface StopDaemonFail {
  ok: false;
  error: string;
  pid?: number;
}

export interface StopDaemonOptions {
  /** Override pidfile runtime dir (tests / IRIS_HOME scratch). */
  runtimeDir?: string;
  /** Injected status fetch (default: GET /api/daemon/status). */
  fetchStatus?: () => Promise<unknown>;
  /** Injected signal (default: process.kill(pid, 'SIGTERM')). */
  signal?: (pid: number) => void;
  /** Injected liveness (default: isPidAlive). */
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Stop the iris daemon with verified identity.
 *
 * 1. Read pidfile; missing → ok (not running).
 * 2. Dead pid → clear pidfile, ok with stale note.
 * 3. Live pid → GET /api/daemon/status; require info.pid, info.org_root, and
 *    info.service all match before signalling. Foreign org_root refuses (nonzero).
 * 4. Signal, poll until exit, clear pidfile.
 */
export async function stopDaemon(
  orgRoot: string,
  opts: StopDaemonOptions = {},
): Promise<StopDaemonOk | StopDaemonFail> {
  const runtimeDir = opts.runtimeDir ?? irisRuntimeDir();
  const alive = opts.isAlive ?? isPidAlive;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 100;
  const waitBudget = opts.timeoutMs ?? 10_000;

  const pid = readPidFile(runtimeDir);
  if (pid === null) {
    return { ok: true, note: 'no pidfile; daemon not running' };
  }

  if (!alive(pid)) {
    clearPidFile(runtimeDir);
    return { ok: true, note: 'stale pid cleared; daemon was not running', pid };
  }

  let statusBody: unknown;
  try {
    statusBody = opts.fetchStatus
      ? await opts.fetchStatus()
      : await daemonGet('/api/daemon/status');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `cannot verify daemon identity for pid ${pid} (status unreachable): ${msg}`,
      pid,
    };
  }

  const info =
    typeof statusBody === 'object' && statusBody !== null
      ? (statusBody as { info?: Record<string, unknown> }).info
      : undefined;
  if (!info || typeof info !== 'object') {
    return { ok: false, error: 'daemon status missing info; refusing to signal', pid };
  }

  const service = info.service;
  if (service !== IRIS_DAEMON_SERVICE) {
    return {
      ok: false,
      error: `daemon service is ${JSON.stringify(service)}, expected ${JSON.stringify(IRIS_DAEMON_SERVICE)}; refusing to signal`,
      pid,
    };
  }

  const statusPid = Number(info.pid);
  if (!Number.isFinite(statusPid) || statusPid !== pid) {
    return {
      ok: false,
      error: `status pid ${String(info.pid)} does not match pidfile pid ${pid}; refusing to signal`,
      pid,
    };
  }

  const statusRoot = typeof info.org_root === 'string' ? info.org_root : '';
  const cliRoot = normalizeOrgRoot(orgRoot);
  const daemonRoot = normalizeOrgRoot(statusRoot);
  if (!statusRoot || daemonRoot !== cliRoot) {
    return {
      ok: false,
      error: `daemon org_root differs: daemon=${statusRoot || '(empty)'} cli=${orgRoot}; refusing to signal`,
      pid,
    };
  }

  const signal =
    opts.signal ??
    ((p: number) => {
      process.kill(p, 'SIGTERM');
    });

  try {
    signal(pid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `failed to signal pid ${pid}: ${msg}`, pid };
  }

  const deadline = Date.now() + waitBudget;
  while (alive(pid) && Date.now() < deadline) {
    await sleep(pollMs);
  }

  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* best-effort escalate */
    }
    await sleep(Math.min(pollMs * 2, 500));
  }

  if (alive(pid)) {
    return { ok: false, error: `pid ${pid} still alive after stop`, pid };
  }

  clearPidFile(runtimeDir);
  return { ok: true, note: 'daemon stopped', pid, signaled: true };
}

// Re-export pidfile helpers used by tests / callers that already import from daemon.ts
export {
  clearPidFile,
  irisRuntimeDir,
  isPidAlive,
  pidFilePath,
  readPidFile,
  writePidFile,
} from '../../daemon/src/pidfile.ts';
