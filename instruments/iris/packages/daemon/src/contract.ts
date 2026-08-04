// ─────────────────────────────────────────────────────────────────────────────
// @amore/daemon — the shared contract.
//
// The ONE file every module imports. Types + module-boundary signatures only —
// no implementation. Builders implement their owned module against these
// interfaces; the seams here are frozen (change requires the integrator).
//
// Authority chain:
//   spec/legacy-shapes.md  — the legacy wire contract (empirically grounded)
//   spec/regula-api.md     — what @amore/regula provides vs what we build
//   README.md              — parity discipline + the ratified v2 shape changes
//
// Legacy sources (READ-ONLY ground truth when the spec is ambiguous; archived
// 2026-07-03 under archive/instruments/vitrum-legacy/):
//   .../src-tauri/src/server/index.rs      — walk/exclusions, resolver ladder, search
//   .../src-tauri/src/server/document.rs   — parse: title/excerpt/links/type
//   .../src-tauri/src/server/routes.rs     — handlers, graph build
//   .../src-tauri/src/server/projects.rs   — projects list/tree/file
// ─────────────────────────────────────────────────────────────────────────────

// ── Documents ────────────────────────────────────────────────────────────────

/**
 * An indexed org document. Mirrors legacy `OrgDocument` (document.rs).
 * `path` is org-relative with forward slashes — the canonical id everywhere.
 * `content` is NEVER stored in the index (legacy parity: index copies carry
 * content=None; get_file reads the body from disk per-request).
 */
export interface IndexedDoc {
  path: string;
  /** Legacy title rule (document.rs) — NOT regula's extractTitle. */
  title: string;
  /** Wire key `type` — infer_type(frontmatter.type, top path segment). */
  docType: string;
  status: string | null;
  created: string | null; // frontmatter `created`, fallback `started` (forge)
  updated: string | null;
  tags: string[];
  /** Raw wikilink targets, document order, NOT deduped, `|label` stripped,
   *  `#anchor` KEPT (legacy regex: \[\[([^\]|]+)(?:\|[^\]]+)?\]\]). */
  links: string[];
  /** Org-relative paths of docs whose resolved outbound links bind here.
   *  Computed by the index build (resolver ladder), replicated from index.rs. */
  backlinks: string[];
  /** First prose line, whitespace-collapsed, ~120 chars. Absent when no prose. */
  excerpt?: string;
  // Forge extras — present only when the frontmatter carries them:
  pipeline?: string;
  recipe?: string;
  role?: string;
  layer?: number;
  goal?: string;
  triggeredBy?: string;
  reviewStatus?: string;
  dreamAction?: string;
  signature?: unknown;
}

/**
 * Wire serialization of an IndexedDoc (files-list / search items / get_file).
 * Presence rules (parity-gated — spec §0.4):
 *   - `created`, `status`, `updated`: ALWAYS present, null when absent.
 *   - forge extras + `excerpt` (+ `content` when withContent): omit-when-absent.
 *   - `backlinks`, `links`, `tags`: always present (possibly []).
 * Key order is NOT parity-gated (differ is key-set based); emit alphabetical
 * for byte-closeness to legacy Regime B anyway.
 */
export interface WireDoc {
  backlinks: string[];
  content?: string;
  created: string | null;
  dreamAction?: string;
  excerpt?: string;
  goal?: string;
  layer?: number;
  links: string[];
  path: string;
  pipeline?: string;
  recipe?: string;
  resolvedBacklinks?: ResolvedBacklink[];
  resolvedOutbound?: ResolvedOutbound[];
  reviewStatus?: string;
  role?: string;
  signature?: unknown;
  status: string | null;
  tags: string[];
  title: string;
  triggeredBy?: string;
  type: string;
  updated: string | null;
}

export interface ResolvedBacklink {
  path: string;
  title: string;
  type: string;
}

/** Resolved entry: {resolvedPath,target,title,type}; unresolved: {target} only. */
export interface ResolvedOutbound {
  resolvedPath?: string;
  target: string;
  title?: string | null;
  type?: string | null;
}

// ── The index ────────────────────────────────────────────────────────────────

export type LinkResolution =
  | { kind: 'resolved'; path: string }
  | { kind: 'skip' } // scheme-qualified, or doc-relative escaping org root
  | { kind: 'missing' };

/**
 * The in-memory org index. Built once at startup by a full walk (legacy
 * should_exclude semantics — see core/walk.ts). NO file watcher this
 * milestone (trigger to add one: first client repoints to this daemon).
 */
export interface OrgIndex {
  /** org-relative path → doc. Iteration order = insertion = walk order;
   *  serving code MUST NOT depend on it (sort where order is contractual). */
  docs: Map<string, IndexedDoc>;
  /** lowercased org-relative path → real path (resolver steps 1/2). */
  pathMap: Map<string, string>;
  /** lowercased stem → real paths (resolver step 4; ambiguity = abstain). */
  stemMap: Map<string, string[]>;
  /** lowercased project dir name → its README.md/CLAUDE.md doc path (step 4b). */
  projectMap: Map<string, string>;
  /** Resolve target `t` written in doc `sourcePath` via the 6-step legacy
   *  ladder (spec §5). Pure w.r.t. the built maps. */
  resolve(target: string, sourcePath: string): LinkResolution;
}

export interface IndexBuildStats {
  files: number;
  parsed: number;
  parseFailures: number;
  ms: number;
}

// ── Watcher (C-tail: first-client-repoint trigger fired 2026-07-02) ─────────

/** A debounced batch of admitted filesystem deltas (org-relative, forward-slash
 *  `.md` paths that pass `shouldExclude`). */
export interface ChangeSet {
  /** Created or modified — will be (re)parsed; a parse failure drops the doc. */
  updated: string[];
  /** Deleted — removed from the index. */
  removed: string[];
}

export interface ApplyStats {
  updated: number;
  removed: number;
  parseFailures: number;
  ms: number;
}

/** core/ barrel (src/core/index.ts) must export exactly: */
export interface CoreModule {
  buildIndex(orgRoot: string): { index: OrgIndex; stats: IndexBuildStats };
  /** Legacy walk filter replica (index.rs should_exclude), incl. the ratified
   *  `.claude/worktrees/**` exclusion (subsumed by the dot-prefix rule —
   *  pinned by an explicit test). */
  shouldExclude(relPath: string, isDir: boolean): boolean;
  /** WireDoc from an IndexedDoc; content/resolved* included only for get_file. */
  serializeDoc(doc: IndexedDoc, opts?: { content?: string; resolvedBacklinks?: ResolvedBacklink[]; resolvedOutbound?: ResolvedOutbound[] }): WireDoc;
  /** Body with frontmatter block stripped (legacy extract_body). */
  extractBody(raw: string): string;
  /**
   * Apply a ChangeSet to the live index. Post-condition (pinned by test): the
   * index observably deep-equals a cold `buildIndex` of the same tree state —
   * docs, all three lookup maps, backlinks, and `resolve` behavior alike.
   * Mechanism is the implementer's (in-place refill vs property rebind), but
   * note `resolve` is a closure over the maps built at cold-build time — the
   * updated maps must be what it reads afterward. Runs synchronously on the
   * event loop: no request handler ever observes a half-applied batch.
   */
  applyChanges(index: OrgIndex, orgRoot: string, changes: ChangeSet): ApplyStats;
  /**
   * Watch `orgRoot` (fs.watch recursive) and keep `index` current. EVERY event
   * is admitted through the SAME `shouldExclude` as the walk — the one-
   * admission-filter rule (the legacy watcher's `is_excluded` was a stale fork
   * of `should_exclude`; that class is contract-banned here). Events that
   * cannot be classified to admitted `.md` file deltas (null filename,
   * dir-scoped renames affecting tracked docs, oversized batches) trigger a
   * full reconcile — a walk-diff expressed as a ChangeSet through
   * `applyChanges`, so there is exactly ONE index-update path. Debounce:
   * $IRIS_WATCH_DEBOUNCE_MS quiet (default 300), bounded max-wait.
   */
  startWatcher(index: OrgIndex, orgRoot: string): { stop(): void };
}

// ── Graph ────────────────────────────────────────────────────────────────────

/** Node classes. `file` is v2-only (ratified 2026-07-02). */
export type NodeKind = 'doc' | 'placeholder' | 'cluster' | 'file';

/**
 * Wire node (spec §8.3). Optional fields OMIT when absent (never null).
 * v2 additions: kind 'file'; `subtype`; forge type split 'pipeline'|'dream'.
 */
export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  type: string;
  status?: string;
  linkCount: number;
  folder: string;
  tags: string[];
  pipeline?: string;
  group: string;
  memberCount?: number;
  updated?: string;
  /** v2 only. task → status value; inbox → type subfolder. Never in legacy shape. */
  subtype?: string;
}

/** Wire link (spec §8.4). Optionals omit when absent. */
export interface GraphLink {
  source: string;
  target: string;
  weight?: number;
  relation?: string;
  tier?: string;
  edgeKind?: string;
}

export interface ResolvedScopeWire {
  kind: string;
  value?: string;
  depth?: number;
  groupBy: string;
  nodeCount: number;
  linkCount: number;
}

export interface ClusterSummary {
  id: string;
  label: string;
  groupKey: string;
  memberCount: number;
  representatives: string[];
}

export interface GraphResponse {
  nodes: GraphNode[];
  links: GraphLink[];
  scope: ResolvedScopeWire;
  clusters: ClusterSummary[];
}

export interface GraphParams {
  scope?: string; // workspace | folder:<p> | seed:<id> | tag:<n> (default workspace)
  depth?: number; // seed BFS only, default 1
  groupBy?: string; // type (default) | folder | project | tag
  edges?: string; // wiki (default; ANY unknown value → wiki) | semantic | both
  /**
   * RATIFIED SHAPE SWITCH: absent/'legacy' → legacy-exact (the parity gate);
   * 'v2' → kind:file nodes + forge pipeline|dream type split + subtype field.
   * v2 is the daemon's forward shape; legacy default holds until clients repoint.
   */
  shape?: string;
}

/** A typed edge from graph/edges.jsonl (extra fields ignored, malformed lines skipped). */
export interface TypedEdge {
  source: string;
  target: string;
  type: string;
  confidence?: string; // 'candidate' edges are NEVER servable
  refines_wikilink?: boolean;
}

/** graph/ barrel (src/graph/index.ts) must export exactly: */
export interface GraphModule {
  buildGraph(index: OrgIndex, params: GraphParams, orgRoot: string): GraphResponse;
  /** Read <orgRoot>/graph/edges.jsonl; absent → []. Only called when edges!=wiki. */
  loadTypedEdges(orgRoot: string): TypedEdge[];
}

/** projects/ barrel (src/projects/index.ts) must export exactly: */
export interface ProjectsModule {
  listProjects(orgRoot: string): { name: string; hasReadme: boolean; hasClaude: boolean }[];
  /** null → 404; 'forbidden' → 403 (spec §10 exclusions, dirs-first byte-sort,
   *  binary-ext skip, empty-dir prune, org-root-as-project top-level excludes). */
  getTree(orgRoot: string, name: string): TreeEntry[] | null | 'forbidden';
  getProjectFile(orgRoot: string, name: string, path: string): ProjectFileWire | null | 'forbidden';
}

export interface TreeEntry {
  name: string;
  path: string; // project-relative, forward slashes
  isDir: boolean;
  size?: number;
  language?: string;
  children?: TreeEntry[];
}

export interface ProjectFileWire {
  path: string; // echoes request param verbatim
  content: string; // FULL raw file, frontmatter intact
  language: string | null; // null (present!) when unknown — unlike TreeEntry
  size: number;
}

// ── Search ───────────────────────────────────────────────────────────────────

/** search/ barrel (src/search/index.ts) must export exactly: */
export interface SearchModule {
  /**
   * Bit-faithful port of fuzzy_matcher::SkimMatcherV2::fuzzy_match (the
   * vendored crate source under ~/.cargo/registry — the exact version the
   * legacy daemon links). null = no match. Scores must match Rust exactly:
   * the top-50 SET is parity-gated.
   */
  fuzzyMatch(text: string, pattern: string): number | null;
  /**
   * Legacy compose (index.rs::search): query lowercased once;
   * total = title*3 + path + maxTag*2; keep total>0; sort score desc
   * (stable); take(50). Returns docs in final order.
   */
  search(index: OrgIndex, query: string): IndexedDoc[];
}

// ── Server ───────────────────────────────────────────────────────────────────

export interface DaemonConfig {
  orgRoot: string;
  port: number; // default 3848
  startedAt: number; // epoch ms, for status.server.uptime
}

/**
 * Route handlers receive the built index + config (dependency injection — the
 * routes module is testable against a fake OrgIndex). Response invariants
 * (spec §0): no envelope; compact JSON; global CORS headers
 * (access-control-allow-origin:* + vary triple); errors are bare status +
 * empty body EXCEPT missing `q` → 400 text/plain axum message; assets add
 * cache-control: private, max-age=300 and the mime map; unknown query params
 * ignored everywhere.
 */
export interface DaemonDeps {
  config: DaemonConfig;
  index: OrgIndex;
  core: Pick<CoreModule, 'serializeDoc' | 'extractBody'>;
  graph: GraphModule;
  projects: ProjectsModule;
  search: SearchModule;
}

/** RFC3339 UTC, 9 fractional digits, '+00:00' offset (parity-ignored value,
 *  but shape/type must hold): 2026-07-02T17:25:26.955000000+00:00 */
export type Rfc3339Nanos = string;
