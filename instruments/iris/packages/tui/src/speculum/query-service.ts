/**
 * In-process readonly read path over the speculum derived index.
 * Never migrates, never writes — CLI alone owns user_version and ingest.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Schema versions this reader understands (column set it actually queries). */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [4];

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
  sessions: number;
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

export type SearchHit = {
  eventId: number;
  sessionId: string;
  kind: string;
  /** Short FTS snippet (or text fallback). */
  snippet: string;
};

export type SearchOpts = {
  limit?: number;
  sessionId?: string;
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
  sessionList(limit?: number, offset?: number): SessionListRow[];
  turns(sessionId: string): TurnRow[];
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

class SqliteQueryService implements QueryService {
  readonly path: string;
  private db: Database | null;
  private readonly maxAttempts: number;
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => void;
  private forceBusyRemaining: number;
  private _busy = false;

  constructor(path: string, opts: OpenQueryServiceOpts) {
    this.path = path;
    this.maxAttempts = opts.maxAttempts ?? BUSY_MAX_ATTEMPTS;
    this.delayMs = opts.delayMs ?? BUSY_DELAY_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.forceBusyRemaining = opts.forceBusyAttempts ?? 0;
    this.db = openReadonly(path);
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
      events: 0,
      usageRows: 0,
      lastIngestedAt: null,
      stale: false,
    };
    return this.read(() => {
      const db = this.requireDb();
      const sessions =
        db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0;
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
      return { sessions, events, usageRows, lastIngestedAt, stale };
    }, empty);
  }

  sessionList(limit = 50, offset = 0): SessionListRow[] {
    const lim = Math.max(0, Math.trunc(limit));
    const off = Math.max(0, Math.trunc(offset));
    return this.read(() => {
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
          },
          [number, number]
        >(
          `SELECT
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
             (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count
           FROM sessions s
           ORDER BY s.started_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(lim, off);
      return rows.map((r) => ({
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
      }));
    }, []);
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
      if (sessionId) {
        const rows = db
          .query<
            {
              eventId: number;
              sessionId: string;
              kind: string;
              snippet: string | null;
              text: string | null;
            },
            [string, string, number]
          >(
            `SELECT
               e.id AS eventId,
               e.session_id AS sessionId,
               e.kind AS kind,
               snippet(events_fts, 0, '', '', '…', 12) AS snippet,
               e.text AS text
             FROM events_fts
             JOIN events e ON e.id = events_fts.rowid
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
            kind: string;
            snippet: string | null;
            text: string | null;
          },
          [string, number]
        >(
          `SELECT
             e.id AS eventId,
             e.session_id AS sessionId,
             e.kind AS kind,
             snippet(events_fts, 0, '', '', '…', 12) AS snippet,
             e.text AS text
           FROM events_fts
           JOIN events e ON e.id = events_fts.rowid
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

function mapSearchHit(r: {
  eventId: number;
  sessionId: string;
  kind: string;
  snippet: string | null;
  text: string | null;
}): SearchHit {
  const snip = (r.snippet ?? '').trim();
  const text = (r.text ?? '').trim();
  return {
    eventId: r.eventId,
    sessionId: r.sessionId,
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
