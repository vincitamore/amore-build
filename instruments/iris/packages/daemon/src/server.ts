// ─────────────────────────────────────────────────────────────────────────────
// server.ts — Bun.serve manual router over DaemonDeps (dependency injection: the
// router is testable against a fake OrgIndex + fake sibling modules). Mirrors the
// legacy Axum route table (mod.rs) for the 11 core read endpoints.
//
// Routing model:
//   - exact-path routes matched first (/api/health, /api/status, …, /api/files,
//     /api/search, /api/graph, /api/projects);
//   - then wildcard-capture routes (/api/files/{*path}, /api/assets/{*path},
//     /api/projects/{name}/tree, /api/projects/{name}/file/{*path}). Captures are
//     percent-decoded the way axum decodes path params.
//   - unknown routes and non-GET methods → 404 (empty body).
//
// EVERY response (success or error) carries the global CORS headers — enforced by
// the http.ts helpers each handler returns through. Unknown query params are
// ignored everywhere (we only read the params each handler honors).
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonDeps } from './contract.ts';
import { createQmdModule, startQmdRefreshWatch } from './proxies/qmd.ts';
import { emptyStatus } from './routes/http.ts';
import { health } from './routes/health.ts';
import { status } from './routes/status.ts';
import { launchPresets } from './routes/launch-presets.ts';
import { getFile, listFiles } from './routes/files.ts';
import { getAsset } from './routes/assets.ts';
import { searchRoute } from './routes/search.ts';
import { graphRoute } from './routes/graph.ts';
import { listProjects, projectFile, projectTree } from './routes/projects.ts';
import { daemonStatus } from './routes/daemon-status.ts';
import { lucernaRoute } from './routes/lucerna.ts';

const FILES_PREFIX = '/api/files/';
const ASSETS_PREFIX = '/api/assets/';
const PROJECT_TREE_RE = /^\/api\/projects\/([^/]+)\/tree$/;
const PROJECT_FILE_RE = /^\/api\/projects\/([^/]+)\/file\/(.+)$/;

/** Percent-decode an axum path capture; fall back to the raw text on malformed
 *  escapes (axum would 400, but that is not in the read-parity surface). */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function handle(deps: DaemonDeps, req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const params = url.searchParams;

  // Lucerna state-surface routes handle their own methods (GET reads + POST
  // governance) — dispatched before the GET-only guard below.
  if (pathname.startsWith('/api/lucerna/')) return lucernaRoute(deps.config, req);

  if (req.method !== 'GET') return emptyStatus(404);

  switch (pathname) {
    case '/api/health':
      return health();
    case '/api/status':
      return status(deps);
    case '/api/daemon/status':
      // Daemon-identity handshake for clients' isDaemonUp (not parity-gated —
      // see routes/daemon-status.ts). Registered like legacy's daemon_mgmt nest.
      return daemonStatus(deps.config);
    case '/api/launch-presets':
      return launchPresets(deps.config);
    case '/api/files':
      return listFiles(deps, {
        type: params.get('type') ?? undefined,
        prefix: params.get('prefix') ?? undefined,
        exclude_prefix: params.get('exclude_prefix') ?? undefined,
      });
    case '/api/search':
      return searchRoute(deps, params.get('q'), params.get('mode'), params.get('limit'));
    case '/api/graph':
      return graphRoute(deps, params);
    case '/api/projects':
      return listProjects(deps);
  }

  if (pathname.startsWith(FILES_PREFIX)) {
    return getFile(deps, decode(pathname.slice(FILES_PREFIX.length)));
  }
  if (pathname.startsWith(ASSETS_PREFIX)) {
    return getAsset(deps, decode(pathname.slice(ASSETS_PREFIX.length)));
  }

  const treeM = PROJECT_TREE_RE.exec(pathname);
  if (treeM) return projectTree(deps, decode(treeM[1]));

  const fileM = PROJECT_FILE_RE.exec(pathname);
  if (fileM) return projectFile(deps, decode(fileM[1]), decode(fileM[2]));

  return emptyStatus(404);
}

/** The fetch handler over injected deps — the unit under test in route tests.
 *  Bun.serve accepts `Response | Promise<Response>`. */
export function buildFetch(deps: DaemonDeps): (req: Request) => Response | Promise<Response> {
  return (req) => handle(deps, req);
}

export interface StartedServer {
  server: ReturnType<typeof Bun.serve>;
  /** Stop the HTTP server and any qmd refresh watch. */
  stop(): void;
}

/** Ensure deps carry a qmd module; start automatic freshness when not injected. */
export function wireQmd(deps: DaemonDeps, opts?: { noRefresh?: boolean }): DaemonDeps {
  if (deps.qmd) return deps;
  if (opts?.noRefresh || process.env.IRIS_QMD_NO_REFRESH === '1') {
    return { ...deps, qmd: createQmdModule() };
  }
  const refresh = startQmdRefreshWatch(deps.config.orgRoot);
  return { ...deps, qmd: createQmdModule({}, refresh) };
}

/** Start Bun.serve on config.port with the wired deps. Returns the Bun server.
 *
 *  Loopback-only by design: iris is a local-first instrument and its index is
 *  the org tree — Bun's default hostname is 0.0.0.0 (all interfaces), which
 *  would expose it to the LAN. Pinned, not configurable.
 *
 *  When `deps.qmd` is absent, a default managed-qmd module is attached and a
 *  debounced freshness watch is started (disabled with IRIS_QMD_NO_REFRESH=1). */
export function startServer(deps: DaemonDeps): ReturnType<typeof Bun.serve> {
  const wired = wireQmd(deps);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: wired.config.port,
    fetch: buildFetch(wired),
  });
}
