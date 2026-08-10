/**
 * Query-time graph projection over the derived event index.
 *
 * Builds a plain node list + edge list (JSON-serializable) from events.
 * No durable edge tables — recompute on each call from sqlite rows.
 */

import type { Db } from "../store/db";
import {
  type EventQueryOpts,
  type EventRow,
  eventsAtOrBefore,
} from "../store/queries";

/** Node id form: "e:{eventId}" so edges stay string-stable and JSON-friendly. */
export function nodeIdForEvent(eventId: number): string {
  return `e:${eventId}`;
}

export interface GraphNode {
  id: string;
  eventId: number;
  kind: string;
  toolName: string | null;
  sessionId: string;
  projectPath: string;
  ts: string;
  toolCallId: string | null;
}

export type GraphEdgeType = "succession" | "tool_link";

export interface GraphEdge {
  from: string;
  to: string;
  type: GraphEdgeType;
  /** Present on tool_link edges. */
  toolCallId?: string;
}

export interface ProjectedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ProjectGraphOpts extends EventQueryOpts {
  /**
   * Inclusive upper bound on event ts (state-at-T style).
   * When set, only events with ts <= at are projected.
   */
  at?: Date | string;
  /**
   * Edge kinds to emit. Default: both temporal succession and tool_use→result.
   */
  edgeTypes?: GraphEdgeType[];
}

function eventToNode(ev: EventRow): GraphNode {
  return {
    id: nodeIdForEvent(ev.id),
    eventId: ev.id,
    kind: ev.kind,
    toolName: ev.toolName,
    sessionId: ev.sessionId,
    projectPath: ev.projectPath,
    ts: ev.ts,
    toolCallId: ev.toolCallId,
  };
}

function loadEvents(db: Db, opts: ProjectGraphOpts): EventRow[] {
  if (opts.at !== undefined) {
    const { at, edgeTypes: _e, ...rest } = opts;
    return Array.from(eventsAtOrBefore(db, at, rest));
  }

  // Full window: reuse eventsAtOrBefore with a far-future ceiling so filters stay shared.
  const { edgeTypes: _e, at: _a, ...rest } = opts;
  return Array.from(eventsAtOrBefore(db, "9999-12-31T23:59:59.999Z", rest));
}

/**
 * Project a session/project window's events into a query-time edge list.
 *
 * Nodes = typed events (id, kind, tool name, session, ts).
 * Edges:
 *   - succession: consecutive events within a session (ordered by ts, id)
 *   - tool_link: tool_use → matching tool_result via tool_call_id
 */
export function projectGraph(db: Db, opts: ProjectGraphOpts = {}): ProjectedGraph {
  const want = new Set<GraphEdgeType>(
    opts.edgeTypes ?? (["succession", "tool_link"] as GraphEdgeType[]),
  );
  const events = loadEvents(db, opts);

  const nodes: GraphNode[] = events.map(eventToNode);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];

  // Group by session for succession + tool pairing.
  const bySession = new Map<string, EventRow[]>();
  for (const ev of events) {
    let list = bySession.get(ev.sessionId);
    if (!list) {
      list = [];
      bySession.set(ev.sessionId, list);
    }
    list.push(ev);
  }

  for (const [, sessionEvents] of bySession) {
    // Already ordered by session_id, ts, id from the query; re-sort for safety.
    sessionEvents.sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return a.id - b.id;
    });

    if (want.has("succession")) {
      for (let i = 1; i < sessionEvents.length; i++) {
        const prev = sessionEvents[i - 1]!;
        const cur = sessionEvents[i]!;
        edges.push({
          from: nodeIdForEvent(prev.id),
          to: nodeIdForEvent(cur.id),
          type: "succession",
        });
      }
    }

    if (want.has("tool_link")) {
      // First tool_use and latest tool_result per tool_call_id within the window.
      const uses = new Map<string, EventRow>();
      const results = new Map<string, EventRow>();
      for (const ev of sessionEvents) {
        if (!ev.toolCallId) continue;
        if (ev.kind === "tool_use" && !uses.has(ev.toolCallId)) {
          uses.set(ev.toolCallId, ev);
        }
        if (ev.kind === "tool_result") {
          results.set(ev.toolCallId, ev);
        }
      }
      for (const [callId, use] of uses) {
        const res = results.get(callId);
        if (!res) continue;
        const from = nodeIdForEvent(use.id);
        const to = nodeIdForEvent(res.id);
        if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
        edges.push({
          from,
          to,
          type: "tool_link",
          toolCallId: callId,
        });
      }
    }
  }

  return { nodes, edges };
}
