// ─────────────────────────────────────────────────────────────────────────────
// Endpoint inventory — DISCOVERED, not invented.
//
// Sources of truth (read, never guessed; legacy tier archived 2026-07-03 —
// paths repointed to the archive, content unchanged):
//   1. The legacy Axum router build in
//      archive/instruments/vitrum-legacy/src-tauri/src/server/mod.rs  (the main
//      `app` router + the nested sub-routers: federation / registry / profile /
//      terminal / daemon).
//   2. The federation sub-router in
//      archive/instruments/vitrum-legacy/src-tauri/src/server/federation.rs.
//   3. The real clients' `/api/` call sites — which fixes the `consumers` field
//      and the `core` vs `inventory` split:
//        - client (React/Tauri GUI + PWA, archived):
//          archive/instruments/vitrum-legacy/client/src/lib/api.ts
//        - tui  (OpenTUI dashboard):        packages/tui/src/**
//        - cli  (agent org surface):        packages/cli/src/commands.ts
//
// Tiers:
//   core      — a GET/read with ≥1 real client consumer. RECORDED by default.
//   inventory — registered but no client consumer found. Not recorded (nothing
//               drives it, so there is no observed contract to freeze).
//   mutating  — a write (POST/PUT/PATCH/DELETE) on org data. NOT recorded here:
//               side-effects need fixtures, not goldens (a later harness phase).
//   excluded  — federation / auth / pty / proxy / websocket / debug surface,
//               out of scope for the read-parity harness. Carries a one-word
//               `reason`. federation ports last; pty is dead; proxies pass
//               through to another daemon (oraculum residual).
// ─────────────────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WS';
export type Consumer = 'client' | 'tui' | 'cli' | 'pwa';
export type Tier = 'core' | 'inventory' | 'mutating' | 'excluded';
export type ExcludeReason =
  | 'federation'
  | 'auth'
  | 'pty'
  | 'proxy'
  | 'websocket'
  | 'debug';

export interface Endpoint {
  method: HttpMethod;
  /** Axum route template as registered (path params in `{name}` / `{*path}` form). */
  path: string;
  /** Path-template parameters, in order. */
  pathParams: string[];
  /** Query params the server actually honors (from the handler's Query<…> struct). */
  queryParams: string[];
  /** Which clients call it (empty ⇒ registered-but-unconsumed). */
  consumers: Consumer[];
  tier: Tier;
  /** One-word reason, for tier `excluded` / `mutating`. */
  reason?: ExcludeReason | 'write';
  note?: string;
}

export const ENDPOINTS: Endpoint[] = [
  // ── CORE — recorded read surface ──────────────────────────────────────────
  { method: 'GET', path: '/api/health', pathParams: [], queryParams: [], consumers: ['client', 'pwa'], tier: 'core' },
  { method: 'GET', path: '/api/status', pathParams: [], queryParams: [], consumers: ['client', 'tui', 'pwa'], tier: 'core', note: 'server.uptime + server.lastIndexed are wall-clock, see cases.ts IGNORE' },
  { method: 'GET', path: '/api/launch-presets', pathParams: [], queryParams: [], consumers: ['client'], tier: 'core', note: 'resolves preset cwd against org_root; stable' },
  { method: 'GET', path: '/api/files', pathParams: [], queryParams: ['type', 'prefix', 'exclude_prefix'], consumers: ['client', 'tui', 'cli'], tier: 'core', note: 'client also sends tag/folder — the handler ignores them (only type/prefix/exclude_prefix in ListFilesQuery)' },
  { method: 'GET', path: '/api/files/{*path}', pathParams: ['path'], queryParams: [], consumers: ['client', 'tui'], tier: 'core', note: 'single doc + resolved backlinks/outbound; 404 when not indexed' },
  { method: 'GET', path: '/api/assets/{*path}', pathParams: ['path'], queryParams: [], consumers: ['client', 'pwa'], tier: 'core', note: 'raw file bytes + mime; NON-JSON body' },
  { method: 'GET', path: '/api/search', pathParams: [], queryParams: ['q'], consumers: ['client', 'tui', 'cli'], tier: 'core', note: 'client/tui send type/tag/limit — the handler ignores them (SearchQuery is {q} only)' },
  { method: 'GET', path: '/api/graph', pathParams: [], queryParams: ['scope', 'depth', 'group_by', 'include_tags', 'edges'], consumers: ['client', 'tui', 'cli'], tier: 'core', note: 'edges=wiki|semantic|both; scope=workspace|folder:<p>|seed:<id>|tag:<n>' },
  { method: 'GET', path: '/api/projects', pathParams: [], queryParams: [], consumers: ['client', 'tui'], tier: 'core' },
  { method: 'GET', path: '/api/projects/{name}/tree', pathParams: ['name'], queryParams: [], consumers: ['client'], tier: 'core' },
  { method: 'GET', path: '/api/projects/{name}/file/{*path}', pathParams: ['name', 'path'], queryParams: [], consumers: ['client'], tier: 'core' },

  // ── MUTATING — org-data writes; recorded by a later, fixture-based phase ───
  { method: 'POST', path: '/api/files', pathParams: [], queryParams: [], consumers: ['client', 'cli'], tier: 'mutating', reason: 'write', note: 'create file' },
  { method: 'PUT', path: '/api/files/{*path}', pathParams: ['path'], queryParams: [], consumers: ['client', 'cli'], tier: 'mutating', reason: 'write', note: 'replace frontmatter+content' },
  { method: 'PATCH', path: '/api/files/{*path}', pathParams: ['path'], queryParams: [], consumers: ['client', 'cli'], tier: 'mutating', reason: 'write', note: 'patch frontmatter fields' },
  { method: 'DELETE', path: '/api/files/{*path}', pathParams: ['path'], queryParams: [], consumers: ['client'], tier: 'mutating', reason: 'write' },
  { method: 'POST', path: '/api/files/move', pathParams: [], queryParams: [], consumers: ['client', 'cli'], tier: 'mutating', reason: 'write' },
  { method: 'POST', path: '/api/inbox/resolve', pathParams: [], queryParams: [], consumers: ['client', 'cli'], tier: 'mutating', reason: 'write', note: 'atomic flip+stamp+move to inbox/<type>/resolved/' },
  { method: 'PUT', path: '/api/projects/{name}/file/{*path}', pathParams: ['name', 'path'], queryParams: [], consumers: ['client'], tier: 'mutating', reason: 'write' },

  // ── EXCLUDED: proxy — pass-through to another daemon ───────────────────────
  { method: 'GET', path: '/api/oraculum/health', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'proxy' },
  { method: 'POST', path: '/api/oraculum/chat', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'proxy' },
  { method: 'POST', path: '/api/oraculum/expand', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'proxy' },
  // Lucerna agency state-file proxy (live Bun routes only; no goldens for POSTs)
  { method: 'GET', path: '/api/lucerna/health', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'lucerna runtime health.json' },
  { method: 'GET', path: '/api/lucerna/status', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'lucerna state + enablement' },
  { method: 'GET', path: '/api/lucerna/log', pathParams: [], queryParams: ['n'], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy' },
  { method: 'GET', path: '/api/lucerna/notifications', pathParams: [], queryParams: ['n'], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'house notifications.jsonl' },
  { method: 'GET', path: '/api/lucerna/pulse', pathParams: [], queryParams: [], consumers: ['tui'], tier: 'excluded', reason: 'proxy', note: 'dashboard compact pulse row' },
  { method: 'POST', path: '/api/lucerna/halt', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy' },
  { method: 'POST', path: '/api/lucerna/wake', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy' },
  { method: 'POST', path: '/api/lucerna/sleep', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy' },
  { method: 'POST', path: '/api/lucerna/start', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'detached spawn + health poll' },
  { method: 'POST', path: '/api/lucerna/stop', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'halt then optional pid kill' },
  { method: 'POST', path: '/api/lucerna/enable', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'atomic lucerna.enable.json write' },
  { method: 'GET', path: '/api/lucerna/dreams', pathParams: [], queryParams: ['pending'], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'session manifests + light dream reports' },
  { method: 'GET', path: '/api/lucerna/dream', pathParams: [], queryParams: ['id', 'path'], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'single dream show' },
  { method: 'POST', path: '/api/lucerna/dreams/review', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'flip review-status pending→reviewed' },
  { method: 'GET', path: '/api/lucerna/proposals', pathParams: [], queryParams: ['pending'], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'forge/proposals list' },
  { method: 'GET', path: '/api/lucerna/proposal', pathParams: [], queryParams: ['id', 'path'], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'single proposal show' },
  { method: 'POST', path: '/api/lucerna/proposals/apply', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'status pending→applied only' },
  { method: 'POST', path: '/api/lucerna/proposals/close', pathParams: [], queryParams: [], consumers: ['tui', 'cli'], tier: 'excluded', reason: 'proxy', note: 'status pending→closed only' },

  // ── EXCLUDED: auth — identity / signing ────────────────────────────────────
  { method: 'GET', path: '/api/identity', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'auth' },
  { method: 'POST', path: '/api/identity/create', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'auth' },
  { method: 'POST', path: '/api/identity/unlock', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'auth' },
  { method: 'POST', path: '/api/sign', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'auth' },
  { method: 'POST', path: '/api/sign-with-anchor', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'auth' },
  { method: 'POST', path: '/api/verify', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'auth' },

  // ── EXCLUDED: federation — local-only surface adjacent to the peer network ─
  { method: 'POST', path: '/api/peers/add', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/peers', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/chat/send', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/chat/history', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/sharing', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'PUT', path: '/api/sharing', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/invitation/create', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },

  // ── EXCLUDED: federation — the /api/federation nest (peer-facing) ──────────
  { method: 'GET', path: '/api/federation/hello', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/auth', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/search', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/files', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/files/{*path}', pathParams: ['path'], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/cross-search', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/cross-files', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/cross-file/{*path}', pathParams: ['path'], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/git-repos', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/git-repos-remote', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/git-ls-refs', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/git-fetch', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/adopt', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/send', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/receive', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/shared', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/shared/diff', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/shared/resolve', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/shared/respond', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/notify-adopted', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/adopters', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/profile', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/manifest', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/federation/sync/push', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/packages', pathParams: [], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/packages/{name}/files', pathParams: ['name'], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/packages/{name}/file/{*path}', pathParams: ['name', 'path'], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/federation/credentials/{package}', pathParams: ['package'], queryParams: [], consumers: [], tier: 'excluded', reason: 'federation' },

  // ── EXCLUDED: federation — the /api/registry nest (network bootstrap) ──────
  { method: 'GET', path: '/api/registry/status', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/registry/register', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/registry/directory', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/registry/search', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/registry/peer-profile/{did}', pathParams: ['did'], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/registry/peer-avatar/{did}', pathParams: ['did'], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/registry/peer-banner/{did}', pathParams: ['did'], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/registry/unlist', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/registry/directory-url', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'PUT', path: '/api/registry/directory-url', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },

  // ── EXCLUDED: federation — the /api/profile nest (published identity) ──────
  { method: 'GET', path: '/api/profile', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'PUT', path: '/api/profile', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/profile/publish', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/profile/avatar', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/profile/avatar', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'DELETE', path: '/api/profile/avatar', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'GET', path: '/api/profile/banner', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'POST', path: '/api/profile/banner', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },
  { method: 'DELETE', path: '/api/profile/banner', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'federation' },

  // ── EXCLUDED: pty — terminal sessions + PTY-daemon management (dead) ───────
  { method: 'WS', path: '/ws/terminal', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'WS', path: '/ws/terminal-v2', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'GET', path: '/api/terminal/sessions', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'POST', path: '/api/terminal/sessions', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'DELETE', path: '/api/terminal/sessions/{id}', pathParams: ['id'], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'PATCH', path: '/api/terminal/sessions/{id}', pathParams: ['id'], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'GET', path: '/api/terminal-v2/sessions', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'POST', path: '/api/terminal-v2/sessions', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'DELETE', path: '/api/terminal-v2/sessions/{id}', pathParams: ['id'], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'PATCH', path: '/api/terminal-v2/sessions/{id}', pathParams: ['id'], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'GET', path: '/api/daemon/status', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'POST', path: '/api/daemon/start', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'POST', path: '/api/daemon/stop', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },
  { method: 'POST', path: '/api/daemon/restart', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'pty' },

  // ── EXCLUDED: websocket / debug ────────────────────────────────────────────
  { method: 'WS', path: '/ws', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'websocket' },
  { method: 'POST', path: '/api/debug-log', pathParams: [], queryParams: [], consumers: ['client'], tier: 'excluded', reason: 'debug' },
];

export function endpointsByTier(tier: Tier): Endpoint[] {
  return ENDPOINTS.filter((e) => e.tier === tier);
}

export function coreEndpoints(): Endpoint[] {
  return endpointsByTier('core');
}

export function tierCounts(): Record<Tier, number> {
  const counts: Record<Tier, number> = { core: 0, inventory: 0, mutating: 0, excluded: 0 };
  for (const e of ENDPOINTS) counts[e.tier]++;
  return counts;
}

/** Reason breakdown for the excluded tier (documentation / report aid). */
export function excludeReasonCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of endpointsByTier('excluded')) {
    const r = e.reason ?? 'unknown';
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

/**
 * Filesystem-safe slug for an endpoint template, used as the golden subdirectory.
 * `/api/files/{*path}` → `api-files-path`; `/api/graph` → `api-graph`.
 */
export function endpointSlug(template: string): string {
  return template
    .replace(/^\//, '')
    .replace(/[{}*]/g, '')
    .replace(/\//g, '-');
}
