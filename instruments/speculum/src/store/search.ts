/**
 * Sparse full-text search over the derived events index (FTS5).
 *
 * Sessions remain source of truth; events_fts is a standalone FTS5 virtual
 * table (rowid = events.id) re-derived on ingest and dropped on forget /
 * ingest --full. No embeddings, no network.
 *
 * Hybrid mode is honest sparse-recency fusion via RRF (k=60): BM25 rank list
 * fused with a recency-ordered list — not dense/sparse marketing hybrid.
 */

import type { Db } from "./db";

/** Default RRF constant (classic TREC / Cormack et al.). */
export const RRF_K = 60;

export type SearchBackendKind = "fts" | "recency" | "hybrid";

export interface SearchHit {
  eventId: number;
  sessionId: string;
  projectPath: string;
  ts: string;
  kind: string;
  /** Higher is better. For pure FTS this is inverted bm25; for hybrid, RRF sum. */
  score: number;
  snippet: string;
  backend: SearchBackendKind;
  toolName?: string | null;
}

export interface SearchOpts {
  /** Max hits to return (default 20). */
  limit?: number;
  /** Inclusive lower bound on event ts (ISO or YYYY-MM-DD expanded by caller). */
  since?: string | null;
  /** Inclusive upper bound on event ts. */
  until?: string | null;
  /** Substring filter on project_path. */
  project?: string | null;
  /** Exact session id filter. */
  sessionId?: string | null;
  /**
   * When true, return pure FTS BM25 order (no recency fusion).
   * Default false → RRF of FTS + recency.
   */
  ftsOnly?: boolean;
  /** RRF k (default 60). */
  rrfK?: number;
  /**
   * Candidate pool per source before fusion (default max(limit*5, 50)).
   * Caps how many recency-only (off-topic) rows can enter the fusion set.
   */
  candidateLimit?: number;
}

export interface SearchBackend {
  search(query: string, opts?: SearchOpts): SearchHit[];
}

export interface FtsEventFields {
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
}

/** Sanitize operator input into an FTS5 MATCH expression (token AND). */
export function prepareFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/["'*:(){}[\]^~!@#\\/<>?=+|&]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  // Quote each token so punctuation-stripped words match as terms.
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

function filterClauses(opts: SearchOpts): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (opts.since) {
    parts.push("e.ts >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    parts.push("e.ts <= ?");
    params.push(opts.until);
  }
  if (opts.project) {
    parts.push("e.project_path LIKE '%' || ? || '%'");
    params.push(opts.project);
  }
  if (opts.sessionId) {
    parts.push("e.session_id = ?");
    params.push(opts.sessionId);
  }
  return {
    sql: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
    params,
  };
}

interface RankedRow {
  eventId: number;
  sessionId: string;
  projectPath: string;
  ts: string;
  kind: string;
  toolName: string | null;
  snippet: string;
  /** Raw ranking key from the source (bm25 lower-better, or ts for recency). */
  rawScore: number;
}

function rrfScore(rank: number, k: number): number {
  return 1 / (k + rank);
}

/**
 * Reciprocal rank fusion over ordered id lists.
 * rank is 1-based. Documented as sparse-recency fusion — not embeddings.
 */
export function reciprocalRankFusion(
  lists: number[][],
  k: number = RRF_K,
): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, idx) => {
      const rank = idx + 1;
      scores.set(id, (scores.get(id) ?? 0) + rrfScore(rank, k));
    });
  }
  return scores;
}

function ftsSearch(db: Db, matchQuery: string, opts: SearchOpts, pool: number): RankedRow[] {
  const { sql: extra, params: filterParams } = filterClauses(opts);
  // snippet() requires the 6-arg form on bun:sqlite; ORDER BY bm25 (lower = better).
  const sql = `
    SELECT
      e.id AS eventId,
      e.session_id AS sessionId,
      e.project_path AS projectPath,
      e.ts AS ts,
      e.kind AS kind,
      e.tool_name AS toolName,
      bm25(events_fts) AS rawScore,
      COALESCE(
        NULLIF(snippet(events_fts, 0, '[', ']', '...', 12), ''),
        NULLIF(snippet(events_fts, 1, '[', ']', '...', 8), ''),
        NULLIF(snippet(events_fts, 2, '[', ']', '...', 10), ''),
        NULLIF(snippet(events_fts, 3, '[', ']', '...', 10), ''),
        COALESCE(e.text, e.tool_name, '')
      ) AS snippet
    FROM events_fts
    JOIN events e ON e.id = events_fts.rowid
    WHERE events_fts MATCH ?${extra}
    ORDER BY bm25(events_fts)
    LIMIT ?
  `;
  try {
    return db
      .query<RankedRow, (string | number)[]>(sql)
      .all(matchQuery, ...filterParams, pool);
  } catch {
    // Malformed MATCH after sanitization — treat as no hits.
    return [];
  }
}

function recencySearch(db: Db, opts: SearchOpts, pool: number): RankedRow[] {
  const { sql: extra, params: filterParams } = filterClauses(opts);
  const sql = `
    SELECT
      e.id AS eventId,
      e.session_id AS sessionId,
      e.project_path AS projectPath,
      e.ts AS ts,
      e.kind AS kind,
      e.tool_name AS toolName,
      0 AS rawScore,
      COALESCE(
        CASE WHEN e.text IS NOT NULL AND length(e.text) > 80
          THEN substr(e.text, 1, 80) || '...'
          ELSE e.text
        END,
        e.tool_name,
        ''
      ) AS snippet
    FROM events e
    WHERE 1=1${extra}
    ORDER BY e.ts DESC, e.id DESC
    LIMIT ?
  `;
  return db.query<RankedRow, (string | number)[]>(sql).all(...filterParams, pool);
}

/**
 * Search events. Default path: RRF fuse of FTS BM25 list + recency list.
 * Pass `ftsOnly: true` for pure sparse BM25 ranking.
 */
export function searchEvents(db: Db, query: string, opts: SearchOpts = {}): SearchHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 500));
  const pool = Math.max(opts.candidateLimit ?? Math.max(limit * 5, 50), limit);
  const k = opts.rrfK ?? RRF_K;
  const matchQuery = prepareFtsQuery(query);

  if (!matchQuery) {
    // Empty query after sanitize: recency-only listing (still local, no FTS).
    return recencySearch(db, opts, limit).map((r) => ({
      eventId: r.eventId,
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      ts: r.ts,
      kind: r.kind,
      score: 0,
      snippet: r.snippet ?? "",
      backend: "recency" as const,
      toolName: r.toolName,
    }));
  }

  const ftsRows = ftsSearch(db, matchQuery, opts, pool);

  if (opts.ftsOnly) {
    // Invert bm25 (lower better) into a non-negative score for display.
    return ftsRows.slice(0, limit).map((r) => ({
      eventId: r.eventId,
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      ts: r.ts,
      kind: r.kind,
      score: -r.rawScore,
      snippet: r.snippet ?? "",
      backend: "fts" as const,
      toolName: r.toolName,
    }));
  }

  const recencyRows = recencySearch(db, opts, pool);
  const ftsIds = ftsRows.map((r) => r.eventId);
  const recencyIds = recencyRows.map((r) => r.eventId);
  const fused = reciprocalRankFusion([ftsIds, recencyIds], k);

  const byId = new Map<number, RankedRow>();
  for (const r of recencyRows) byId.set(r.eventId, r);
  // FTS rows win for snippet (highlighted).
  for (const r of ftsRows) byId.set(r.eventId, r);

  const ranked: SearchHit[] = [];
  for (const [eventId, score] of fused.entries()) {
    const row = byId.get(eventId);
    if (!row) continue;
    const fromFts = ftsIds.includes(eventId);
    const fromRecency = recencyIds.includes(eventId);
    const backend: SearchBackendKind =
      fromFts && fromRecency ? "hybrid" : fromFts ? "fts" : "recency";
    ranked.push({
      eventId: row.eventId,
      sessionId: row.sessionId,
      projectPath: row.projectPath,
      ts: row.ts,
      kind: row.kind,
      score,
      snippet: row.snippet ?? "",
      backend,
      toolName: row.toolName,
    });
  }
  ranked.sort(
    (a, b) => b.score - a.score || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0),
  );

  return ranked.slice(0, limit);
}

/** Pure SearchBackend facade over the local FTS index. */
export function createSearchBackend(db: Db): SearchBackend {
  return {
    search(query: string, opts?: SearchOpts): SearchHit[] {
      return searchEvents(db, query, opts);
    },
  };
}

// ── FTS maintenance (ingest / forget / rebuild) ────────────────────────────

export function upsertEventFts(db: Db, eventId: number, fields: FtsEventFields): void {
  // Standalone FTS: rowid mirrors events.id. Delete-then-insert for re-ingest safety.
  db.prepare("DELETE FROM events_fts WHERE rowid = ?").run(eventId);
  db.prepare(
    `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    fields.text,
    fields.tool_name,
    fields.tool_input,
    fields.tool_output,
  );
}

export function deleteEventFts(db: Db, eventId: number): void {
  db.prepare("DELETE FROM events_fts WHERE rowid = ?").run(eventId);
}

/** Drop all FTS rows for events belonging to a session (call before DELETE events). */
export function deleteSessionFromFts(db: Db, sessionId: string): void {
  db.prepare(
    `DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE session_id = ?)`,
  ).run(sessionId);
}

/** Clear the entire FTS index. */
export function clearEventsFts(db: Db): void {
  db.run("DELETE FROM events_fts");
}

/** Rebuild FTS from current events rows (migration / full reindex). */
export function rebuildEventsFts(db: Db): void {
  clearEventsFts(db);
  db.run(`
    INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
    SELECT id, text, tool_name, tool_input, tool_output FROM events
  `);
}
