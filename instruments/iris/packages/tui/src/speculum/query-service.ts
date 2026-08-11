/**
 * In-process readonly read path over the speculum derived index.
 * Never migrates, never writes — CLI alone owns user_version and ingest.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Schema versions this reader understands (column set it actually queries). */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [4, 5, 6];

/** Staleness threshold aligned with `speculum status` (hours since newest session). */
export const STALE_THRESHOLD_HOURS = 24;

/** Default busy-retry budget (WAL writer during ingest --full). */
export const BUSY_MAX_ATTEMPTS = 3;
/** Fixed delay between busy retries (ms); small + deterministic for tests. */
export const BUSY_DELAY_MS = 5;

/** Env keys mirrored from the instrument path resolver (no package import). */
export type PathEnv = {
  SPECULUM_DB?: string;
  SPECULUM_HOME?: string;
  AMORE_HOME?: string;
};

export type QueryStatus = {
  /** Total session directories in the derived index (primary + subagent). */
  sessions: number;
  /**
   * Session rows that are not agent='subagent'.
   * Ingest only writes 'primary' | 'subagent'; anything else (nullish/unknown)
   * is counted here so the split never produces NaN/undefined.
   */
  primarySessions: number;
  /** Session rows where agent = 'subagent' (parent_session set at ingest). */
  subagentSessions: number;
  /** Cheap GROUP BY agent → count map (raw agent strings). */
  byAgent: Record<string, number>;
  events: number;
  usageRows: number;
  lastIngestedAt: string | null;
  stale: boolean;
};

export type SessionListRow = {
  id: string;
  projectPath: string;
  agent: string;
  parentSession: string | null;
  modelId: string | null;
  startedAt: string;
  endedAt: string;
  turnCount: number;
  userMsgCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  /** Events belonging to this session (COUNT from events). */
  eventCount: number;
  /**
   * Session title from summary.json session_summary (schema v5).
   * Empty string on v4 indexes or when summary had no title.
   */
  title: string;
  /**
   * v6 facets from sessions columns. Empty string when the column is absent
   * (v4/v5 indexes) or the row has no value.
   */
  cwdClass: string;
  agentName: string;
  subagentType: string;
  description: string;
  titleSource: string;
};

/** Sort modes for filtered session listing (default recent = started_at DESC). */
export type SessionSort = 'recent' | 'turns' | 'errors';

/**
 * Filter / page / sort options for sessionList and sessionCount.
 * All filters are AND-composed. Filters that need columns missing from the
 * opened index are ignored (never throw).
 */
export type SessionListOpts = {
  /** Exact match on sessions.cwd_class. */
  cwdClass?: 'operator' | 'experiment' | 'harness' | 'unknown' | string;
  /** Exact match on sessions.agent. */
  agent?: 'primary' | 'subagent' | string;
  /** Case-insensitive substring on project_path. */
  project?: string;
  /** Inclusive lower bound on started_at (ISO string). */
  since?: string;
  /** Inclusive upper bound on started_at (ISO string). */
  until?: string;
  /** Case-insensitive substring on resolved title. */
  title?: string;
  /** Sort order; default recent (started_at DESC). */
  sort?: SessionSort;
  /** Page size; default 50. */
  limit?: number;
  /** Page start; default 0. */
  offset?: number;
};

export type TurnRow = {
  /** events.id — jump grain for Microscope. */
  eventId: number;
  kind: string;
  ts: string;
  text: string | null;
  toolName: string | null;
  toolError: number | null;
};

/**
 * Full untruncated turn payload for detail panes.
 * All text-like fields normalize SQL null to '' (documented here).
 * Never includes events.raw.
 */
export type TurnDetail = {
  eventId: number;
  sessionId: string;
  kind: string;
  ts: string;
  /** events.text; null → ''. */
  text: string;
  /** events.tool_name; null → ''. */
  toolName: string;
  /** events.tool_input; null → ''. */
  toolInput: string;
  /** events.tool_output; null → ''. */
  toolOutput: string;
  /**
   * events.tool_error rendered as string (integer columns become "0"/"1");
   * SQL null → ''.
   */
  toolError: string;
};

/** Per-session derived annotation row (v6 session_annotations). */
export type SessionAnnotation = {
  phaseClass: string;
  errorDensity: number;
  /** Parsed probe_hits JSON-text; bad JSON → {}. */
  probeHits: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationSec: number;
  method: string;
};

export type SearchHit = {
  eventId: number;
  sessionId: string;
  /** Session title when available (v5); empty on v4 / absent. */
  title: string;
  kind: string;
  /** Short FTS snippet (or text fallback). */
  snippet: string;
};

export type SearchOpts = {
  limit?: number;
  sessionId?: string;
};

/**
 * Evidence edge between two sessions (map-record only — never affinity/similarity).
 * - parentage: subagent session → its parent_session (both in the requested set)
 * - event: session-pair aggregation of event_links (both endpoints in the set)
 * - resumed_from / shared_artifact: session_links rows (v6; both endpoints in set)
 */
export type SessionMapLink = {
  source: string;
  target: string;
  kind: 'parentage' | 'event' | 'resumed_from' | 'shared_artifact';
  count: number;
};

export type OpenQueryServiceOpts = {
  /** Explicit db path; wins over env resolution. */
  path?: string;
  /** Env bag for resolveIndexPath (defaults to process.env). */
  env?: PathEnv;
  /** Busy-retry attempts (default BUSY_MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** Delay between retries in ms (default BUSY_DELAY_MS). */
  delayMs?: number;
  /**
   * Sleep implementation (default busy-wait). Tests inject a no-op or counter.
   */
  sleep?: (ms: number) => void;
  /**
   * Test seam: force the next N read attempts to throw a SQLITE_BUSY-like error
   * before delegating to the real query. Production leaves this unset.
   */
  forceBusyAttempts?: number;
};

export interface QueryService {
  /** Absolute path of the opened index. */
  readonly path: string;
  getVersion(): number;
  schemaOK(): boolean;
  /** True after a read exhausted busy retries without success. */
  busy(): boolean;
  status(): QueryStatus;
  /**
   * Legacy form: sessionList(limit?, offset?) — unchanged call shape for map/microscope.
   * Opts form: sessionList(opts) with filters, sort, limit, offset.
   */
  sessionList(limit?: number, offset?: number): SessionListRow[];
  sessionList(opts: SessionListOpts): SessionListRow[];
  /** Count of sessions matching the same filters as sessionList (ignores limit/offset/sort). */
  sessionCount(opts?: SessionListOpts): number;
  /**
   * Evidence edges among a co-visible session-id set: parentage + event_links aggregation.
   * Edges whose endpoints are outside the set are dropped. Empty input → [].
   * Does not include session_links (see sessionLinks).
   */
  links(sessionIds: readonly string[]): SessionMapLink[];
  /**
   * links() plus v6 session_links rows (resumed_from / shared_artifact), same
   * co-visible filter. When session_links is absent, equals links().
   */
  sessionLinks(sessionIds: readonly string[]): SessionMapLink[];
  turns(sessionId: string): TurnRow[];
  /**
   * Full untruncated event columns for a single turn. Null when the event id is
   * missing. Never returns raw.
   */
  turnDetail(eventId: number): TurnDetail | null;
  /**
   * session_annotations rows for the given ids. Empty input or missing table → {}.
   * probe_hits JSON-text is parsed defensively (bad JSON → {}).
   */
  annotations(sessionIds: readonly string[]): Record<string, SessionAnnotation>;
  search(query: string, opts?: SearchOpts): SearchHit[];
  close(): void;
  /** Close + reopen readonly (picks up rows written by the CLI since last open). */
  reopen(): void;
}

/**
 * Resolve the derived-index path.
 * Order: SPECULUM_DB → SPECULUM_HOME/speculum.sqlite →
 * AMORE_HOME/instruments/speculum/speculum.sqlite → ~/.amore/...
 */
export function resolveIndexPath(env: PathEnv = process.env as PathEnv): string {
  const db = env.SPECULUM_DB?.trim();
  if (db) return db;
  const home = env.SPECULUM_HOME?.trim();
  if (home) return join(home, 'speculum.sqlite');
  const amore = env.AMORE_HOME?.trim() || join(homedir(), '.amore');
  return join(amore, 'instruments', 'speculum', 'speculum.sqlite');
}

/** True when an error looks like SQLITE_BUSY / locked. */
export function isSqliteBusy(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { code?: string | number; message?: string; name?: string };
  if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') return true;
  if (typeof e.code === 'number' && (e.code === 5 || e.code === 6)) return true;
  const msg = typeof e.message === 'string' ? e.message : String(err);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|locked/i.test(msg);
}

function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  // Deterministic busy-wait (no async surface on the query-service).
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

/**
 * Run `fn` with bounded busy retry. Returns `{ ok, value }` or `{ ok:false, busy:true }`.
 * Exported so retry policy is unit-testable without a live lock.
 */
export function withBusyRetry<T>(
  fn: () => T,
  opts: {
    maxAttempts: number;
    delayMs: number;
    sleep?: (ms: number) => void;
  },
): { ok: true; value: T } | { ok: false; busy: true; error: unknown } {
  const sleep = opts.sleep ?? defaultSleep;
  const max = Math.max(1, opts.maxAttempts);
  let lastErr: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusy(err)) throw err;
      if (attempt < max - 1) sleep(opts.delayMs);
    }
  }
  return { ok: false, busy: true, error: lastErr };
}

/** Strip FTS operators; quote tokens for a safe MATCH expression. */
export function prepareFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/["'*:(){}[\]^~!@#\\/<>?=+|&]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}

/** Column names present on sessions for the opened index. */
function sessionsColumnSet(db: Database): Set<string> {
  try {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(sessions)`).all();
    return new Set(cols.map((c) => c.name));
  } catch {
    return new Set();
  }
}

/** True when a named table exists (event_links / session_* may be absent on stripped fixtures). */
function tableExists(db: Database, name: string): boolean {
  try {
    const row = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(name);
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Normalize a filter/options bag from either legacy (limit, offset) or opts form. */
function normalizeSessionListArgs(
  limitOrOpts?: number | SessionListOpts,
  offset?: number,
): SessionListOpts {
  if (limitOrOpts != null && typeof limitOrOpts === 'object') {
    return limitOrOpts;
  }
  const opts: SessionListOpts = {};
  if (typeof limitOrOpts === 'number') opts.limit = limitOrOpts;
  if (typeof offset === 'number') opts.offset = offset;
  return opts;
}

/**
 * Shared WHERE builder for sessionList / sessionCount.
 * Filters requiring absent columns are dropped (never throw). Parameters only.
 */
function buildSessionListWhere(
  opts: SessionListOpts,
  cols: Set<string>,
): { whereSql: string; params: (string | number)[] } {
  const wheres: string[] = [];
  const params: (string | number)[] = [];

  if (opts.cwdClass && cols.has('cwd_class')) {
    wheres.push('s.cwd_class = ?');
    params.push(opts.cwdClass);
  }
  if (opts.agent) {
    wheres.push('s.agent = ?');
    params.push(opts.agent);
  }
  if (opts.project) {
    wheres.push("s.project_path LIKE '%' || ? || '%' COLLATE NOCASE");
    params.push(opts.project);
  }
  if (opts.since !== undefined && opts.since !== '') {
    wheres.push('s.started_at >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined && opts.until !== '') {
    wheres.push('s.started_at <= ?');
    params.push(opts.until);
  }
  if (opts.title && cols.has('title')) {
    wheres.push("s.title LIKE '%' || ? || '%' COLLATE NOCASE");
    params.push(opts.title);
  }

  const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
  return { whereSql, params };
}

function sessionOrderBy(sort: SessionSort | undefined): string {
  switch (sort) {
    case 'turns':
      return 'ORDER BY s.turn_count DESC, s.started_at DESC, s.id ASC';
    case 'errors':
      return 'ORDER BY s.tool_error_count DESC, s.started_at DESC, s.id ASC';
    case 'recent':
    default:
      return 'ORDER BY s.started_at DESC, s.id ASC';
  }
}

/** Defensive probe_hits JSON parse; bad JSON or non-object → {}. */
function parseProbeHits(raw: string | null | undefined): Record<string, number> {
  if (raw == null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
        out[k] = Number(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function nullToEmpty(v: string | number | null | undefined): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

class SqliteQueryService implements QueryService {
  readonly path: string;
  private db: Database | null;
  private readonly maxAttempts: number;
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => void;
  private forceBusyRemaining: number;
  private _busy = false;
  /** Cached sessions column set; null until first introspect. */
  private _sessionCols: Set<string> | null = null;

  constructor(path: string, opts: OpenQueryServiceOpts) {
    this.path = path;
    this.maxAttempts = opts.maxAttempts ?? BUSY_MAX_ATTEMPTS;
    this.delayMs = opts.delayMs ?? BUSY_DELAY_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.forceBusyRemaining = opts.forceBusyAttempts ?? 0;
    this.db = openReadonly(path);
  }

  private sessionColumns(): Set<string> {
    if (this._sessionCols != null) return this._sessionCols;
    const db = this.db;
    if (!db) {
      this._sessionCols = new Set();
      return this._sessionCols;
    }
    this._sessionCols = sessionsColumnSet(db);
    return this._sessionCols;
  }

  private hasTitleColumn(): boolean {
    return this.sessionColumns().has('title');
  }

  getVersion(): number {
    return this.read(() => {
      const row = this.requireDb()
        .query<{ user_version: number }, []>('PRAGMA user_version')
        .get();
      return row?.user_version ?? 0;
    }, 0);
  }

  schemaOK(): boolean {
    const v = this.getVersion();
    return (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(v);
  }

  busy(): boolean {
    return this._busy;
  }

  status(): QueryStatus {
    const empty: QueryStatus = {
      sessions: 0,
      primarySessions: 0,
      subagentSessions: 0,
      byAgent: {},
      events: 0,
      usageRows: 0,
      lastIngestedAt: null,
      stale: false,
    };
    return this.read(() => {
      const db = this.requireDb();
      const sessions =
        db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0;
      // Literal 'subagent' only — matches ingest resolveAgent (AgentRole).
      // All other agent values (incl. 'primary', unknown, empty) count as primary.
      const subagentSessions =
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM sessions WHERE agent = 'subagent'",
          )
          .get()?.n ?? 0;
      const primarySessions = Math.max(0, sessions - subagentSessions);
      const byAgentRows = db
        .query<{ agent: string; n: number }, []>(
          'SELECT agent, COUNT(*) AS n FROM sessions GROUP BY agent',
        )
        .all();
      const byAgent: Record<string, number> = {};
      for (const row of byAgentRows) {
        byAgent[row.agent] = row.n;
      }
      const events =
        db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0;
      const usageRows =
        db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage').get()?.n ?? 0;
      const lastIngestedAt =
        db
          .query<{ latest: string | null }, []>(
            'SELECT MAX(last_ingested) AS latest FROM ingest_state',
          )
          .get()?.latest ?? null;
      const newest =
        db
          .query<{ newest: string | null }, []>(
            'SELECT MAX(started_at) AS newest FROM sessions',
          )
          .get()?.newest ?? null;
      let stale = false;
      if (newest) {
        const hours = (Date.now() - new Date(newest).getTime()) / (3600 * 1000);
        stale = hours > STALE_THRESHOLD_HOURS;
      }
      return {
        sessions,
        primarySessions,
        subagentSessions,
        byAgent,
        events,
        usageRows,
        lastIngestedAt,
        stale,
      };
    }, empty);
  }

  sessionList(limitOrOpts?: number | SessionListOpts, offset?: number): SessionListRow[] {
    const opts = normalizeSessionListArgs(limitOrOpts, offset);
    const lim = Math.max(0, Math.trunc(opts.limit ?? 50));
    const off = Math.max(0, Math.trunc(opts.offset ?? 0));
    return this.read(() => {
      const cols = this.sessionColumns();
      const titleSelect = cols.has('title') ? 's.title AS title' : "'' AS title";
      const facet = (col: string, alias: string) =>
        cols.has(col) ? `s.${col} AS ${alias}` : `'' AS ${alias}`;
      const { whereSql, params } = buildSessionListWhere(opts, cols);
      const sql = `SELECT
             s.id,
             s.project_path,
             s.agent,
             s.parent_session,
             s.model_id,
             s.started_at,
             s.ended_at,
             s.turn_count,
             s.user_msg_count,
             s.tool_call_count,
             s.tool_error_count,
             (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count,
             ${titleSelect},
             ${facet('cwd_class', 'cwd_class')},
             ${facet('agent_name', 'agent_name')},
             ${facet('subagent_type', 'subagent_type')},
             ${facet('description', 'description')},
             ${facet('title_source', 'title_source')}
           FROM sessions s
           ${whereSql}
           ${sessionOrderBy(opts.sort)}
           LIMIT ? OFFSET ?`;
      const rows = this.requireDb()
        .query<
          {
            id: string;
            project_path: string;
            agent: string;
            parent_session: string | null;
            model_id: string | null;
            started_at: string;
            ended_at: string;
            turn_count: number;
            user_msg_count: number;
            tool_call_count: number;
            tool_error_count: number;
            event_count: number;
            title: string;
            cwd_class: string;
            agent_name: string;
            subagent_type: string;
            description: string;
            title_source: string;
          },
          (string | number)[]
        >(sql)
        .all(...params, lim, off);
      return rows.map(mapSessionListRow);
    }, []);
  }

  sessionCount(opts: SessionListOpts = {}): number {
    return this.read(() => {
      const cols = this.sessionColumns();
      const { whereSql, params } = buildSessionListWhere(opts, cols);
      const row = this.requireDb()
        .query<{ n: number }, (string | number)[]>(
          `SELECT COUNT(*) AS n FROM sessions s ${whereSql}`,
        )
        .get(...params);
      return row?.n ?? 0;
    }, 0);
  }

  links(sessionIds: readonly string[]): SessionMapLink[] {
    const ids = [...new Set(sessionIds.map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    return this.read(() => this.collectLinks(ids, false), []);
  }

  sessionLinks(sessionIds: readonly string[]): SessionMapLink[] {
    const ids = [...new Set(sessionIds.map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    return this.read(() => this.collectLinks(ids, true), []);
  }

  /** Parentage + event_links (+ optional session_links). Shared by links/sessionLinks. */
  private collectLinks(ids: string[], includeSessionLinks: boolean): SessionMapLink[] {
    const db = this.requireDb();
    const out: SessionMapLink[] = [];
    const idSet = new Set(ids);
    const placeholders = ids.map(() => '?').join(', ');
    // Parentage: child (subagent) → parent, only when both endpoints are co-visible.
    const parentRows = db
      .query<{ id: string; parent_session: string | null }, string[]>(
        `SELECT id, parent_session FROM sessions
         WHERE parent_session IS NOT NULL
           AND parent_session != ''
           AND id IN (${placeholders})`,
      )
      .all(...ids);
    for (const r of parentRows) {
      const parent = (r.parent_session ?? '').trim();
      if (!parent || !idSet.has(parent) || parent === r.id) continue;
      out.push({ source: r.id, target: parent, kind: 'parentage', count: 1 });
    }

    // event_links → session pairs via events (table may be absent on stripped fixtures).
    if (tableExists(db, 'event_links')) {
      const eventRows = db
        .query<{ source: string; target: string; n: number }, string[]>(
          `SELECT
             es.session_id AS source,
             et.session_id AS target,
             COUNT(*) AS n
           FROM event_links el
           JOIN events es ON es.id = el.source_event_id
           JOIN events et ON et.id = el.target_event_id
           WHERE es.session_id IN (${placeholders})
             AND et.session_id IN (${placeholders})
             AND es.session_id != et.session_id
           GROUP BY es.session_id, et.session_id`,
        )
        .all(...ids, ...ids);
      for (const r of eventRows) {
        if (!idSet.has(r.source) || !idSet.has(r.target)) continue;
        out.push({
          source: r.source,
          target: r.target,
          kind: 'event',
          count: Math.max(1, Number(r.n) || 1),
        });
      }
    }

    if (includeSessionLinks && tableExists(db, 'session_links')) {
      const slRows = db
        .query<
          { source_session: string; target_session: string; kind: string },
          string[]
        >(
          `SELECT source_session, target_session, kind
           FROM session_links
           WHERE source_session IN (${placeholders})
             AND target_session IN (${placeholders})
             AND source_session != target_session`,
        )
        .all(...ids, ...ids);
      for (const r of slRows) {
        if (!idSet.has(r.source_session) || !idSet.has(r.target_session)) continue;
        // Only map known session_links kinds into the public union.
        if (r.kind !== 'resumed_from' && r.kind !== 'shared_artifact') continue;
        out.push({
          source: r.source_session,
          target: r.target_session,
          kind: r.kind,
          count: 1,
        });
      }
    }
    return out;
  }

  turnDetail(eventId: number): TurnDetail | null {
    const id = Math.trunc(eventId);
    if (!Number.isFinite(id) || id <= 0) return null;
    return this.read(() => {
      const row = this.requireDb()
        .query<
          {
            id: number;
            session_id: string;
            kind: string;
            ts: string;
            text: string | null;
            tool_name: string | null;
            tool_input: string | null;
            tool_output: string | null;
            tool_error: number | null;
          },
          [number]
        >(
          // Never SELECT raw — privacy and size invariant for detail panes.
          `SELECT id, session_id, kind, ts, text, tool_name, tool_input, tool_output, tool_error
           FROM events
           WHERE id = ?`,
        )
        .get(id);
      if (!row) return null;
      return {
        eventId: row.id,
        sessionId: row.session_id,
        kind: row.kind,
        ts: row.ts,
        text: nullToEmpty(row.text),
        toolName: nullToEmpty(row.tool_name),
        toolInput: nullToEmpty(row.tool_input),
        toolOutput: nullToEmpty(row.tool_output),
        toolError: nullToEmpty(row.tool_error),
      };
    }, null);
  }

  annotations(sessionIds: readonly string[]): Record<string, SessionAnnotation> {
    const ids = [...new Set(sessionIds.map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) return {};
    return this.read(() => {
      const db = this.requireDb();
      if (!tableExists(db, 'session_annotations')) return {};
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db
        .query<
          {
            session_id: string;
            phase_class: string;
            error_density: number;
            probe_hits: string;
            input_tokens: number;
            output_tokens: number;
            total_tokens: number;
            duration_sec: number;
            method: string;
          },
          string[]
        >(
          `SELECT session_id, phase_class, error_density, probe_hits,
                  input_tokens, output_tokens, total_tokens, duration_sec, method
           FROM session_annotations
           WHERE session_id IN (${placeholders})`,
        )
        .all(...ids);
      const out: Record<string, SessionAnnotation> = {};
      for (const r of rows) {
        out[r.session_id] = {
          phaseClass: r.phase_class ?? '',
          errorDensity: Number(r.error_density) || 0,
          probeHits: parseProbeHits(r.probe_hits),
          inputTokens: Number(r.input_tokens) || 0,
          outputTokens: Number(r.output_tokens) || 0,
          totalTokens: Number(r.total_tokens) || 0,
          durationSec: Number(r.duration_sec) || 0,
          method: r.method ?? '',
        };
      }
      return out;
    }, {});
  }

  turns(sessionId: string): TurnRow[] {
    return this.read(() => {
      const rows = this.requireDb()
        .query<
          {
            id: number;
            kind: string;
            ts: string;
            text: string | null;
            tool_name: string | null;
            tool_error: number | null;
          },
          [string]
        >(
          `SELECT id, kind, ts, text, tool_name, tool_error
           FROM events
           WHERE session_id = ?
           ORDER BY ts ASC, id ASC`,
        )
        .all(sessionId);
      return rows.map((r) => ({
        eventId: r.id,
        kind: r.kind,
        ts: r.ts,
        text: r.text,
        toolName: r.tool_name,
        toolError: r.tool_error,
      }));
    }, []);
  }

  search(query: string, opts: SearchOpts = {}): SearchHit[] {
    const match = prepareFtsQuery(query);
    if (!match) return [];
    const limit = Math.max(1, Math.trunc(opts.limit ?? 20));
    const sessionId = opts.sessionId;

    return this.read(() => {
      const db = this.requireDb();
      const titleExpr = this.hasTitleColumn()
        ? "COALESCE(s.title, '') AS title"
        : "'' AS title";
      const joinSessions = this.hasTitleColumn()
        ? 'LEFT JOIN sessions s ON s.id = e.session_id'
        : '';
      if (sessionId) {
        const rows = db
          .query<
            {
              eventId: number;
              sessionId: string;
              title: string;
              kind: string;
              snippet: string | null;
              text: string | null;
            },
            [string, string, number]
          >(
            `SELECT
               e.id AS eventId,
               e.session_id AS sessionId,
               ${titleExpr},
               e.kind AS kind,
               snippet(events_fts, 0, '', '', '…', 12) AS snippet,
               e.text AS text
             FROM events_fts
             JOIN events e ON e.id = events_fts.rowid
             ${joinSessions}
             WHERE events_fts MATCH ?
               AND e.session_id = ?
             ORDER BY bm25(events_fts)
             LIMIT ?`,
          )
          .all(match, sessionId, limit);
        return rows.map(mapSearchHit);
      }
      const rows = db
        .query<
          {
            eventId: number;
            sessionId: string;
            title: string;
            kind: string;
            snippet: string | null;
            text: string | null;
          },
          [string, number]
        >(
          `SELECT
             e.id AS eventId,
             e.session_id AS sessionId,
             ${titleExpr},
             e.kind AS kind,
             snippet(events_fts, 0, '', '', '…', 12) AS snippet,
             e.text AS text
           FROM events_fts
           JOIN events e ON e.id = events_fts.rowid
           ${joinSessions}
           WHERE events_fts MATCH ?
           ORDER BY bm25(events_fts)
           LIMIT ?`,
        )
        .all(match, limit);
      return rows.map(mapSearchHit);
    }, []);
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // already closed
      }
      this.db = null;
    }
    this._busy = false;
  }

  reopen(): void {
    this.close();
    this.db = openReadonly(this.path);
    this._busy = false;
    this._sessionCols = null;
  }

  /** @internal test seam — force upcoming read attempts to appear busy. */
  forceBusy(n: number): void {
    this.forceBusyRemaining = Math.max(0, Math.trunc(n));
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('query-service is closed; call reopen() or openQueryService()');
    }
    return this.db;
  }

  private read<T>(fn: () => T, fallback: T): T {
    const result = withBusyRetry(
      () => {
        if (this.forceBusyRemaining > 0) {
          this.forceBusyRemaining -= 1;
          const err = new Error('database is locked');
          (err as { code?: string }).code = 'SQLITE_BUSY';
          throw err;
        }
        return fn();
      },
      {
        maxAttempts: this.maxAttempts,
        delayMs: this.delayMs,
        sleep: this.sleep,
      },
    );
    if (result.ok) {
      this._busy = false;
      return result.value;
    }
    this._busy = true;
    return fallback;
  }
}

function mapSessionListRow(r: {
  id: string;
  project_path: string;
  agent: string;
  parent_session: string | null;
  model_id: string | null;
  started_at: string;
  ended_at: string;
  turn_count: number;
  user_msg_count: number;
  tool_call_count: number;
  tool_error_count: number;
  event_count: number;
  title: string;
  cwd_class: string;
  agent_name: string;
  subagent_type: string;
  description: string;
  title_source: string;
}): SessionListRow {
  return {
    id: r.id,
    projectPath: r.project_path,
    agent: r.agent,
    parentSession: r.parent_session,
    modelId: r.model_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    turnCount: r.turn_count,
    userMsgCount: r.user_msg_count,
    toolCallCount: r.tool_call_count,
    toolErrorCount: r.tool_error_count,
    eventCount: r.event_count,
    title: r.title ?? '',
    cwdClass: r.cwd_class ?? '',
    agentName: r.agent_name ?? '',
    subagentType: r.subagent_type ?? '',
    description: r.description ?? '',
    titleSource: r.title_source ?? '',
  };
}

function mapSearchHit(r: {
  eventId: number;
  sessionId: string;
  title?: string;
  kind: string;
  snippet: string | null;
  text: string | null;
}): SearchHit {
  const snip = (r.snippet ?? '').trim();
  const text = (r.text ?? '').trim();
  return {
    eventId: r.eventId,
    sessionId: r.sessionId,
    title: (r.title ?? '').trim(),
    kind: r.kind,
    snippet: snip || text.slice(0, 120),
  };
}

function openReadonly(path: string): Database {
  if (path !== ':memory:' && !existsSync(path)) {
    throw new Error(`speculum index not found at ${path}`);
  }
  // Readonly open: write attempts must fail. No migrate, no PRAGMA user_version stamp.
  return new Database(path, { readonly: true, create: false });
}

/**
 * Open a readonly query-service over the derived index.
 * @param pathOrOpts explicit path string, or options (path / env / retry).
 */
export function openQueryService(
  pathOrOpts?: string | OpenQueryServiceOpts,
): QueryService {
  const opts: OpenQueryServiceOpts =
    typeof pathOrOpts === 'string' ? { path: pathOrOpts } : (pathOrOpts ?? {});
  const path = opts.path?.trim() || resolveIndexPath(opts.env ?? (process.env as PathEnv));
  return new SqliteQueryService(path, opts);
}
