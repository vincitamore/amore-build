/**
 * Derived event_links + decisions rebuild (single ordered post-pass).
 *
 * Invariant: these tables are re-derived on every ingest; never hand-maintained.
 * Shape: one full-table scan of events → pure builders → wipe + bulk insert.
 */

import type { Db } from "../store/db";
import { buildEventLinks, type DerivedLink, type LinkEvent } from "./links";
import {
  extractDecisions,
  type DerivedDecision,
  type ExtractEvent,
} from "./extract";

export {
  buildEventLinks,
  extractArtifactIds,
  type DerivedLink,
  type LinkEvent,
  type LinkKind,
} from "./links";

export {
  extractDecisions,
  decisionId,
  type DerivedDecision,
  type DecisionCategory,
  type ExtractEvent,
} from "./extract";

export interface RebuildStats {
  links: number;
  decisions: number;
  eventsScanned: number;
}

type EventSqlRow = {
  id: number;
  session_id: string;
  project_path: string;
  ts: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_error: number | null;
  tool_call_id: string | null;
};

/**
 * Load all events once, ordered for deterministic pairing, then rebuild both
 * derived tables. Called from the ingest post-pass (and tests).
 */
export function rebuildEventLinksAndDecisions(db: Db): RebuildStats {
  const rows = db
    .query<EventSqlRow, []>(
      `SELECT id, session_id, project_path, ts, kind, text,
              tool_name, tool_input, tool_output, tool_error, tool_call_id
       FROM events
       ORDER BY session_id, ts, id`,
    )
    .all();

  const extractEvents: ExtractEvent[] = rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    projectPath: r.project_path,
    ts: r.ts,
    kind: r.kind,
    text: r.text,
    toolName: r.tool_name,
    toolInput: r.tool_input,
    toolOutput: r.tool_output,
    toolCallId: r.tool_call_id,
    toolError: r.tool_error,
  }));

  // LinkEvent is a structural subset of ExtractEvent.
  const linkEvents: LinkEvent[] = extractEvents;
  const links = buildEventLinks(linkEvents);
  const decisions = extractDecisions(extractEvents);

  persistLinksAndDecisions(db, links, decisions);

  return {
    links: links.length,
    decisions: decisions.length,
    eventsScanned: rows.length,
  };
}

/** Wipe + bulk insert. Kept separate for tests that inject synthetic links. */
export function persistLinksAndDecisions(
  db: Db,
  links: readonly DerivedLink[],
  decisions: readonly DerivedDecision[],
): void {
  db.run("DELETE FROM event_links");
  db.run("DELETE FROM decisions");

  const linkStmt = db.prepare(
    `INSERT INTO event_links
       (source_event_id, target_event_id, kind, method, confidence, heuristic)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const l of links) {
    linkStmt.run(
      l.sourceEventId,
      l.targetEventId,
      l.kind,
      l.method,
      l.confidence,
      l.heuristic,
    );
  }

  const decStmt = db.prepare(
    `INSERT INTO decisions
       (id, session_id, project_path, ts, category, scenario, reasoning,
        outcome, confidence, decision_maker, source_event_id, method, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of decisions) {
    decStmt.run(
      d.id,
      d.sessionId,
      d.projectPath,
      d.ts,
      d.category,
      d.scenario,
      d.reasoning,
      d.outcome,
      d.confidence,
      d.decisionMaker,
      d.sourceEventId,
      d.method,
      d.metadata,
    );
  }
}

// ---------------------------------------------------------------------------
// Chain / impact walks over durable event_links (for decisions CLI)
// ---------------------------------------------------------------------------

export interface EventLinkRow {
  id: number;
  sourceEventId: number;
  targetEventId: number;
  kind: string;
  method: string;
  confidence: number;
  heuristic: boolean;
}

export interface ChainNode {
  eventId: number;
  depth: number;
  viaKind: string | null;
  viaMethod: string | null;
}

/** Upstream walk (incoming edges) from a seed event id. */
export function chainUpstream(
  db: Db,
  seedEventId: number,
  maxDepth = 8,
): ChainNode[] {
  return walkLinks(db, seedEventId, "up", maxDepth);
}

/** Downstream walk (outgoing edges) from a seed event id. */
export function chainDownstream(
  db: Db,
  seedEventId: number,
  maxDepth = 8,
): ChainNode[] {
  return walkLinks(db, seedEventId, "down", maxDepth);
}

function walkLinks(
  db: Db,
  seedEventId: number,
  direction: "up" | "down",
  maxDepth: number,
): ChainNode[] {
  const out: ChainNode[] = [{ eventId: seedEventId, depth: 0, viaKind: null, viaMethod: null }];
  const visited = new Set<number>([seedEventId]);
  let frontier = [seedEventId];

  const stmt =
    direction === "up"
      ? db.prepare<
          {
            source_event_id: number;
            target_event_id: number;
            kind: string;
            method: string;
          },
          [number]
        >(
          `SELECT source_event_id, target_event_id, kind, method
           FROM event_links WHERE target_event_id = ?`,
        )
      : db.prepare<
          {
            source_event_id: number;
            target_event_id: number;
            kind: string;
            method: string;
          },
          [number]
        >(
          `SELECT source_event_id, target_event_id, kind, method
           FROM event_links WHERE source_event_id = ?`,
        );

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      const rows = stmt.all(id);
      for (const r of rows) {
        const neighbor = direction === "up" ? r.source_event_id : r.target_event_id;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
        out.push({
          eventId: neighbor,
          depth,
          viaKind: r.kind,
          viaMethod: r.method,
        });
      }
    }
    frontier = next;
  }

  return out;
}

export function listEventLinks(
  db: Db,
  opts: { eventId?: number; kind?: string; limit?: number } = {},
): EventLinkRow[] {
  const wheres: string[] = [];
  const params: (string | number)[] = [];
  if (opts.eventId !== undefined) {
    wheres.push("(source_event_id = ? OR target_event_id = ?)");
    params.push(opts.eventId, opts.eventId);
  }
  if (opts.kind) {
    wheres.push("kind = ?");
    params.push(opts.kind);
  }
  const limit = opts.limit ?? 500;
  const sql = `
    SELECT id, source_event_id, target_event_id, kind, method, confidence, heuristic
    FROM event_links
    ${wheres.length ? `WHERE ${wheres.join(" AND ")}` : ""}
    ORDER BY id
    LIMIT ${Math.trunc(limit)}
  `;
  return db
    .query<
      {
        id: number;
        source_event_id: number;
        target_event_id: number;
        kind: string;
        method: string;
        confidence: number;
        heuristic: number;
      },
      (string | number)[]
    >(sql)
    .all(...params)
    .map((r) => ({
      id: r.id,
      sourceEventId: r.source_event_id,
      targetEventId: r.target_event_id,
      kind: r.kind,
      method: r.method,
      confidence: r.confidence,
      heuristic: r.heuristic === 1,
    }));
}

export interface DecisionRow {
  id: string;
  sessionId: string;
  projectPath: string;
  ts: string;
  category: string;
  scenario: string | null;
  reasoning: string | null;
  outcome: string | null;
  confidence: number | null;
  decisionMaker: string | null;
  sourceEventId: number | null;
  method: string;
  metadata: string | null;
}

export function listDecisions(
  db: Db,
  opts: {
    sessionId?: string;
    category?: string;
    since?: string;
    until?: string;
    project?: string;
    limit?: number;
  } = {},
): DecisionRow[] {
  const wheres: string[] = [];
  const params: (string | number)[] = [];
  if (opts.sessionId) {
    wheres.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.category) {
    wheres.push("category = ?");
    params.push(opts.category);
  }
  if (opts.since) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    wheres.push("ts <= ?");
    params.push(opts.until);
  }
  if (opts.project) {
    wheres.push("project_path LIKE ?");
    params.push(`%${opts.project}%`);
  }
  const limit = opts.limit ?? 100;
  const sql = `
    SELECT id, session_id, project_path, ts, category, scenario, reasoning,
           outcome, confidence, decision_maker, source_event_id, method, metadata
    FROM decisions
    ${wheres.length ? `WHERE ${wheres.join(" AND ")}` : ""}
    ORDER BY ts DESC, id
    LIMIT ${Math.trunc(limit)}
  `;
  return db
    .query<
      {
        id: string;
        session_id: string;
        project_path: string;
        ts: string;
        category: string;
        scenario: string | null;
        reasoning: string | null;
        outcome: string | null;
        confidence: number | null;
        decision_maker: string | null;
        source_event_id: number | null;
        method: string;
        metadata: string | null;
      },
      (string | number)[]
    >(sql)
    .all(...params)
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      projectPath: r.project_path,
      ts: r.ts,
      category: r.category,
      scenario: r.scenario,
      reasoning: r.reasoning,
      outcome: r.outcome,
      confidence: r.confidence,
      decisionMaker: r.decision_maker,
      sourceEventId: r.source_event_id,
      method: r.method,
      metadata: r.metadata,
    }));
}

export function getDecision(db: Db, id: string): DecisionRow | null {
  const r = db
    .query<
      {
        id: string;
        session_id: string;
        project_path: string;
        ts: string;
        category: string;
        scenario: string | null;
        reasoning: string | null;
        outcome: string | null;
        confidence: number | null;
        decision_maker: string | null;
        source_event_id: number | null;
        method: string;
        metadata: string | null;
      },
      [string]
    >(
      `SELECT id, session_id, project_path, ts, category, scenario, reasoning,
              outcome, confidence, decision_maker, source_event_id, method, metadata
       FROM decisions WHERE id = ?`,
    )
    .get(id);
  if (!r) return null;
  return {
    id: r.id,
    sessionId: r.session_id,
    projectPath: r.project_path,
    ts: r.ts,
    category: r.category,
    scenario: r.scenario,
    reasoning: r.reasoning,
    outcome: r.outcome,
    confidence: r.confidence,
    decisionMaker: r.decision_maker,
    sourceEventId: r.source_event_id,
    method: r.method,
    metadata: r.metadata,
  };
}

/** Decision category counts (IC-23 optional summary). */
export function decisionSummary(
  db: Db,
): { total: number; byCategory: Record<string, number>; byMethod: Record<string, number> } {
  const total =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM decisions").get()?.n ?? 0;
  const byCategory: Record<string, number> = {};
  for (const r of db
    .query<{ category: string; n: number }, []>(
      "SELECT category, COUNT(*) AS n FROM decisions GROUP BY category ORDER BY n DESC",
    )
    .all()) {
    byCategory[r.category] = r.n;
  }
  const byMethod: Record<string, number> = {};
  for (const r of db
    .query<{ method: string; n: number }, []>(
      "SELECT method, COUNT(*) AS n FROM decisions GROUP BY method ORDER BY n DESC",
    )
    .all()) {
    byMethod[r.method] = r.n;
  }
  return { total, byCategory, byMethod };
}
