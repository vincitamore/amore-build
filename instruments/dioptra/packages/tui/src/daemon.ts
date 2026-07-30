import { spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, openSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve as resolvePath } from 'path';

export class DaemonError extends Error {
  constructor(
    public readonly code: 'DOWN' | 'NO_BINARY' | 'TIMEOUT',
    message: string
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

/**
 * Daemon base URL: `$DIOPTRA_URL`, else `http://127.0.0.1:$DIOPTRA_PORT`
 * (default **3850** — the Bun daemon, primary since 2026-07-02; parity replay
 * 22/22, operator-verified via the dash). The frozen legacy Rust daemon stays
 * on 3847 (GUI/PWA/parity-recording) — reach it with `DIOPTRA_PORT=3847`.
 * NOTE: never default to 3848 — that is the legacy daemon's HTTPS listener
 * (`{port+1}`), which answers TCP but speaks TLS.
 */
export function daemonUrl(port?: number): string {
  if (process.env.DIOPTRA_URL) return process.env.DIOPTRA_URL;
  return `http://127.0.0.1:${port ?? Number(process.env.DIOPTRA_PORT ?? 3852)}`;
}

/**
 * Is a *Vitrum* daemon answering at `url`? A plain `<500` response is NOT enough: a port squatter
 * (or the SPA's own HTML on `/`) would read as "up" and clients would then run silently against the
 * wrong process — the stale-/wrong-daemon trap that once cost a full diagnostic loop (see /vitrum
 * §2, and the fine-tooth review's `isDaemonUp` P2). So probe `GET /api/daemon/status` — served
 * by the Bun daemon as its identity handshake (`info.service: vitrum-bun-daemon`, truthful
 * no-PTY fields), and formerly by the legacy Tauri-tier daemons (archived 2026-07-03 at
 * archive/instruments/vitrum-legacy/) — and
 * require the exact JSON shape only that handler emits (originally legacy
 * pty_daemon_client::handle_status):
 * `{ port: number, attached_at_startup: boolean, live: boolean, binary_path, info }`. That route
 * returns application/json where a squatter's `/` returns HTML, so wrong-shape / non-JSON / parse
 * failure / any error → treated as NOT up.
 */
export async function isDaemonUp(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const statusUrl = `${url.replace(/\/+$/, '')}/api/daemon/status`;
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    if (!isVitrumDaemonStatus(body)) return false;
    // House-identity check (2026-07-22): a shape-valid daemon serving a DIFFERENT
    // org root than this client resolved is the cross-house wire-crossing class
    // (foreign-root incident) — fail loudly rather than silently reading a
    // sibling house's tree. Older daemons omit info.org_root; those pass.
    const info = (body as Record<string, unknown>).info as Record<string, unknown> | undefined;
    const served = typeof info?.org_root === 'string' ? resolvePath(info.org_root) : undefined;
    if (served !== undefined) {
      let ours: string | undefined;
      try {
        ours = resolvePath(resolveOrgRoot());
      } catch {
        ours = undefined;
      }
      if (ours !== undefined && served !== ours) {
        throw new Error(
          `daemon on ${url} serves org root ${served}, but this client resolved ${ours} — ` +
            `a sibling house's daemon is squatting the port. Kill it and relaunch from its own tree.`,
        );
      }
    }
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.includes('squatting the port')) throw e;
    return false;
  }
}

/** True only for the response shape `GET /api/daemon/status` on a real Vitrum daemon produces. */
function isVitrumDaemonStatus(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const o = body as Record<string, unknown>;
  return (
    typeof o.attached_at_startup === 'boolean' &&
    typeof o.live === 'boolean' &&
    typeof o.port === 'number' &&
    'binary_path' in o &&
    'info' in o
  );
}

/**
 * Org root: `$DIOPTRA_ORG_ROOT`, else walk up for `(AGENTS.md|AGENT.md|CLAUDE.md)` beside `tasks/`.
 * THROWS when neither resolves rather than silently falling back to cwd — mirrors the
 * CLI's refusal (a cwd fallback would scaffold `tasks/` into whatever directory the dash
 * happened to launch from). index.tsx guards this at startup so the refusal surfaces as
 * a clean message + exit before the renderer takes the terminal. AGENTS.md covers selene.
 */
export function resolveOrgRoot(start: string = process.cwd()): string {
  if (process.env.DIOPTRA_ORG_ROOT) return process.env.DIOPTRA_ORG_ROOT;
  let dir = start;
  for (;;) {
    const hasOrient =
      existsSync(join(dir, 'AGENTS.md')) ||
      existsSync(join(dir, 'AGENT.md')) ||
      existsSync(join(dir, 'CLAUDE.md'));
    if (hasOrient && existsSync(join(dir, 'tasks'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('Org root not found — run inside the org tree or set DIOPTRA_ORG_ROOT (refusing the cwd fallback)');
    }
    dir = parent;
  }
}

/**
 * Resolve the daemon spawn command. Default: the **Bun daemon**
 * (`packages/daemon/src/index.ts`, run under the same bun executable hosting
 * this TUI — `process.execPath`). `$DIOPTRA_DAEMON_BIN` remains the explicit
 * escape hatch: when set (and existing) it is spawned directly as a
 * standalone binary with the same `<orgRoot> --port N` argv — that is how to
 * make the dash supervise the legacy `vitrum-daemon.exe` again.
 */
export function resolveDaemonCommand(): { cmd: string; baseArgs: string[] } | null {
  if (process.env.DIOPTRA_DAEMON_BIN && existsSync(process.env.DIOPTRA_DAEMON_BIN)) {
    return { cmd: process.env.DIOPTRA_DAEMON_BIN, baseArgs: [] };
  }
  // this module lives at instruments/dioptra/packages/tui/src/daemon.ts → ../../daemon
  const entry = join(import.meta.dir, '..', '..', 'daemon', 'src', 'index.ts');
  if (existsSync(entry)) return { cmd: process.execPath, baseArgs: [entry] };
  return null;
}

function waitUntilUp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await isDaemonUp(url)) return resolve();
      if (Date.now() >= deadline) {
        return reject(new DaemonError('TIMEOUT', `Vitrum daemon did not become ready at ${url} within ${timeoutMs}ms`));
      }
      setTimeout(tick, 1000);
    };
    void tick();
  });
}

export interface EnsureDaemonOptions {
  port?: number;
  orgRoot?: string;
  autoSpawn?: boolean; // default true
  timeoutMs?: number; // readiness wait when we spawn
}

/**
 * Ensure a Vitrum daemon is reachable, spawning + supervising our own if none is up. Reuses
 * a daemon already on the port (e.g. the Tauri app), so this is a no-op when the GUI is open;
 * launches a detached headless `vitrum-daemon` otherwise. Returns the URL + whether we spawned.
 */
export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<{ url: string; spawned: boolean }> {
  const url = daemonUrl(opts.port);
  if (await isDaemonUp(url)) return { url, spawned: false };
  if (opts.autoSpawn === false) {
    throw new DaemonError('DOWN', `No Vitrum daemon at ${url} (autoSpawn disabled)`);
  }
  const command = resolveDaemonCommand();
  if (!command) {
    throw new DaemonError('NO_BINARY', 'no daemon to spawn — packages/daemon/src/index.ts not found and $DIOPTRA_DAEMON_BIN unset');
  }
  const orgRoot = opts.orgRoot ?? resolveOrgRoot();
  const port = opts.port ?? Number(process.env.DIOPTRA_PORT ?? 3852);
  // Capture the spawned daemon's stderr so a spawn failure (bad binary, port already bound, panic on
  // boot) is diagnosable instead of vanishing into `'ignore'`. A stamped header opens each spawn so
  // multiple runs stay legible in the append log. If the capture file can't be opened, fall back to
  // ignoring stderr rather than failing the spawn.
  const errPath = daemonSpawnErrPath();
  let errStdio: number | 'ignore' = 'ignore';
  try {
    appendFileSync(errPath, `\n=== ensureDaemon spawn ${new Date().toISOString()} cmd=${command.cmd} ${command.baseArgs.join(' ')} port=${port} ===\n`);
    errStdio = openSync(errPath, 'a');
  } catch {
    // capture unavailable — keep 'ignore' so the daemon still spawns
  }
  const child = spawn(command.cmd, [...command.baseArgs, orgRoot, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', 'ignore', errStdio],
  });
  child.unref(); // persistent shared service — survives this client exiting
  await waitUntilUp(url, opts.timeoutMs ?? 90_000);
  return { url, spawned: true };
}

/** Path for the spawned daemon's captured stderr: `~/.dioptra/daemon-spawn.err` (dir ensured). */
function daemonSpawnErrPath(): string {
  const dir = join(homedir(), '.dioptra');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // dir may already exist / be uncreatable — the openSync in the caller surfaces a real failure
  }
  return join(dir, 'daemon-spawn.err');
}
