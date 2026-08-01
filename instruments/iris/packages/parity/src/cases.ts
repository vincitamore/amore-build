// ─────────────────────────────────────────────────────────────────────────────
// Case matrix — representative requests per core endpoint, derived from REAL
// client usage (packages/client/src/lib/api.ts + packages/tui/src/**), not
// invented. Each case is pure data: a concrete request the recorder fires and
// the replayer re-fires. 2-5 cases per endpoint that has meaningful variation;
// 1 for the parameterless reads.
//
// Concrete paths reference stable, canonical org docs (context/voice.md — 62
// backlinks; knowledge/README.md) and a stable committed asset. The goldens
// they produce are ephemeral (see README § "Why goldens are ephemeral"); the
// case LIST is the tracked spec.
// ─────────────────────────────────────────────────────────────────────────────

import type { HttpMethod } from './inventory';

export interface Case {
  /** Unique id within its endpoint; also the golden filename (`<id>.json`). */
  id: string;
  /** The endpoint template this case exercises (must match an Endpoint.path). */
  endpoint: string;
  method: HttpMethod;
  /** Concrete request path incl. query string (path params substituted). */
  path: string;
  /** For a later mutating phase — unused by the read harness. */
  body?: unknown;
  desc: string;
}

export const CASES: Case[] = [
  // health
  { id: 'plain', endpoint: '/api/health', method: 'GET', path: '/api/health', desc: 'liveness probe' },

  // status
  { id: 'plain', endpoint: '/api/status', method: 'GET', path: '/api/status', desc: 'index + tag + recent stats' },

  // launch-presets
  { id: 'plain', endpoint: '/api/launch-presets', method: 'GET', path: '/api/launch-presets', desc: 'terminal preset templates' },

  // files — list, with each filter the handler honors
  { id: 'all', endpoint: '/api/files', method: 'GET', path: '/api/files', desc: 'full index listing' },
  { id: 'type-knowledge', endpoint: '/api/files', method: 'GET', path: '/api/files?type=knowledge', desc: 'type filter' },
  { id: 'type-task', endpoint: '/api/files', method: 'GET', path: '/api/files?type=task', desc: 'type filter (tasks)' },
  { id: 'prefix-knowledge-arch', endpoint: '/api/files', method: 'GET', path: '/api/files?prefix=knowledge/architecture/', desc: 'prefix filter' },
  { id: 'exclude-forge', endpoint: '/api/files', method: 'GET', path: '/api/files?exclude_prefix=forge/', desc: 'exclude-prefix filter' },

  // files — get one (backlink resolution). voice.md carries 62 backlinks.
  { id: 'voice-with-backlinks', endpoint: '/api/files/{*path}', method: 'GET', path: '/api/files/context/voice.md', desc: 'single doc with rich backlinks (62)' },
  { id: 'knowledge-readme', endpoint: '/api/files/{*path}', method: 'GET', path: '/api/files/knowledge/README.md', desc: 'single doc, cross-linked index' },
  { id: 'not-found', endpoint: '/api/files/{*path}', method: 'GET', path: '/api/files/context/__parity_nonexistent__.md', desc: '404 path (unindexed doc)' },

  // assets — non-JSON body (raw file bytes + mime). Small stable committed svg.
  { id: 'vercel-svg', endpoint: '/api/assets/{*path}', method: 'GET', path: '/api/assets/projects/demo-command/frontend/public/vercel.svg', desc: 'raw svg — non-JSON path' },

  // search — realistic queries + an intentionally-empty result.
  //
  // QUERY SELECTION CRITERION (2026-07-02): a query is case-eligible only when
  // its rank-50 cutoff does NOT split a score-tie cluster. The legacy scorer
  // (SkimMatcherV2 compose) produces large exact-score ties; take(50) slices a
  // straddling tie by HashMap order — per-process random, so the top-50 SET
  // itself is non-deterministic for such queries (measured: q=sovereignty had
  // 62 docs tied exactly at the cutoff score; q=example 56). Those queries can
  // never replay clean against a rewrite — not a parity gap. `daemon` and
  // `network` verified tie-safe (set-equal legacy vs rework) 2026-07-02 via
  // packages/daemon/scripts/search-probe.ts. If a search case fails replay and
  // the probe shows every symmetric-difference doc scoring exactly at the
  // cutoff, re-pick the query — do not chase the scorer.
  { id: 'q-daemon', endpoint: '/api/search', method: 'GET', path: '/api/search?q=daemon', desc: 'common technical term (tie-safe at cutoff)' },
  { id: 'q-network', endpoint: '/api/search', method: 'GET', path: '/api/search?q=network', desc: 'common domain term (tie-safe at cutoff)' },
  { id: 'q-empty', endpoint: '/api/search', method: 'GET', path: '/api/search?q=zzq_no_such_term_xyz', desc: 'empty result set' },

  // graph — the three edge modes the clients actually request + a scope
  { id: 'plain-wiki', endpoint: '/api/graph', method: 'GET', path: '/api/graph', desc: 'default (wiki edges, workspace scope)' },
  { id: 'edges-semantic', endpoint: '/api/graph', method: 'GET', path: '/api/graph?edges=semantic', desc: 'typed graph/edges.jsonl overlay only' },
  { id: 'edges-both', endpoint: '/api/graph', method: 'GET', path: '/api/graph?edges=both', desc: 'wiki + typed (upgrade rule)' },
  { id: 'scope-folder-arch', endpoint: '/api/graph', method: 'GET', path: '/api/graph?scope=folder:knowledge/architecture', desc: 'folder-scoped neighborhood' },

  // projects
  { id: 'all', endpoint: '/api/projects', method: 'GET', path: '/api/projects', desc: 'project list + readme/claude flags' },
  { id: 'deployment-cli', endpoint: '/api/projects/{name}/tree', method: 'GET', path: '/api/projects/deployment-cli/tree', desc: 'project file tree' },
  { id: 'deployment-cli-readme', endpoint: '/api/projects/{name}/file/{*path}', method: 'GET', path: '/api/projects/deployment-cli/file/README.md', desc: 'a project file by path' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Ratified-divergence ignore paths, keyed by endpoint template. A body path
// listed here is not compared (its divergence is understood and accepted). Keep
// this list minimal and justified — every entry is a documented non-determinism,
// not a place to hide a real regression.
//
// Path grammar: dot-separated (`server.uptime`), array indices are numeric
// segments (`items.0.score`), `*` matches any single segment (`items.*.score`).
// The synthetic `__status` / `__contentType` / `__bodyKind` pseudo-paths are
// ignorable the same way, but should almost never need to be.
//
// Empirically verified (record twice, 300ms apart): only /api/status and
// /api/health vary across the corpus moment — every other core endpoint is
// byte-stable. See README § "The record → replay-same-moment rule".
// ─────────────────────────────────────────────────────────────────────────────

export const IGNORE: Record<string, string[]> = {
  '/api/health': ['timestamp'], // chrono::Utc::now() — advances every call
  // server.uptime / server.lastIndexed: elapsed secs + Utc::now().
  // recent (added 2026-07-02, exhibited on the first cross-implementation
  // replay): top-5 docs by `updated` — but `updated` is date-granular and any
  // active day updates far more than 5 docs, so the boundary tier is sliced by
  // HashMap order (per-process random, like the search cutoff ties). The
  // membership itself is legacy-nondeterministic across restarts —
  // canonicalization cannot absorb a membership lottery, so the array is
  // ignored. The `documents`/`tags` sections remain fully compared.
  '/api/status': ['server.uptime', 'server.lastIndexed', 'recent'],
};

export function ignoreFor(endpoint: string): string[] {
  return IGNORE[endpoint] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ratified order-canonicalization (2026-07-02, Bun-daemon milestone — see
// canon.ts header + README). Legacy element order for these arrays is Rust
// HashMap per-process hash-order: stable in-run, reseeded across restarts —
// non-contractual and unreproducible by a rewrite. Both golden AND target are
// sorted by these key specs before diffing; element CONTENT is still fully
// compared. /api/search note: score-descending rank is real contract but is
// not recoverable from the body (no score field), so the search gate is
// set-equality of the top-50 — rank fidelity is exercised separately
// (packages/daemon/scripts/search-probe.ts).
// Everything NOT listed here stays order-significant, notably:
// status.tags.top / status.recent (count/date-sorted truncations — add here
// ONLY if a replay exhibits a tie-boundary divergence), projects (name-sorted),
// trees (dirs-first name-sorted), launch-presets (fixed).
// ─────────────────────────────────────────────────────────────────────────────

import type { CanonSort } from './canon';

export const CANON: Record<string, CanonSort[]> = {
  '/api/files': [{ path: 'items', by: ['path'] }],
  '/api/search': [{ path: 'items', by: ['path'] }],
  '/api/graph': [
    { path: 'nodes', by: ['id'] },
    { path: 'links', by: ['source', 'target', 'relation', 'edgeKind'] },
  ],
};

export function canonFor(endpoint: string): CanonSort[] {
  return CANON[endpoint] ?? [];
}

export function casesForEndpoint(endpoint: string): Case[] {
  return CASES.filter((c) => c.endpoint === endpoint);
}
