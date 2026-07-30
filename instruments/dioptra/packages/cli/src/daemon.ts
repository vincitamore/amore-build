/** HTTP client to the dioptra daemon — the read/index/graph/search authority. */

export class DaemonError extends Error {
  constructor(
    public readonly code: 'DAEMON_UNAVAILABLE' | 'DAEMON_ERROR' | 'DAEMON_TIMEOUT',
    message: string
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

/** Daemon base URL: `$DIOPTRA_URL`, else `http://127.0.0.1:$DIOPTRA_PORT` (default 3852 —
 *  selene house Bun daemon). */
export function daemonBaseUrl(): string {
  if (process.env.DIOPTRA_URL) return process.env.DIOPTRA_URL;
  const port = process.env.DIOPTRA_PORT ?? '3852';
  return `http://127.0.0.1:${port}`;
}

function timeoutMs(): number {
  return Number(process.env.DIOPTRA_TIMEOUT_MS ?? 15_000);
}

/** Map a fetch rejection to the right DaemonError (timeout vs unreachable). */
function mapFetchError(e: unknown, base: string, path: string): DaemonError {
  if (e instanceof Error && e.name === 'TimeoutError') {
    return new DaemonError('DAEMON_TIMEOUT', `Dioptra daemon did not respond within ${timeoutMs()}ms for ${path}`);
  }
  return new DaemonError(
    'DAEMON_UNAVAILABLE',
    `Dioptra daemon unreachable at ${base} — \`dioptra daemon\` (or bare \`dioptra\` / \`dioptra dash\`) starts it`
  );
}

/** GET a daemon path and parse JSON. Throws DaemonError (mapped to exit codes by the caller).
 *  Bounded: a hung daemon must not hang the CLI (default 15s; `$DIOPTRA_TIMEOUT_MS` overrides). */
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
