/**
 * `speculum graph` — thin CLI shell over query-time graph projection .
 * Local only; no network, no model. Neighbors / path / degree / state-at-T.
 */

import { openDb, type Db } from "../store/db";
import {
  projectGraph,
  nodeIdForEvent,
  degreeCentrality,
  type ProjectedGraph,
  type GraphNode,
  type GraphEdge,
} from "../graph";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseEventId(raw: string | undefined): number | null {
  if (!raw) return null;
  // Accept "e:12" or bare "12"
  const s = raw.startsWith("e:") ? raw.slice(2) : raw;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

export function graphHelpText(): string {
  return `speculum graph <subcommand> [options]

Query-time graph over the local derived index (no durable edge store).
Projection = succession + tool_link edges from events.

Subcommands:
  summary              Node/edge counts + top degree (default)
  neighbors <eventId>  Adjacent nodes via projection edges
  path <from> <to>     Shortest BFS path (event ids or e:N)
  degree               Degree centrality ranking
  state-at <iso>       Prefix graph at timestamp (alias: --at)

Options:
  --session ID         Filter to one session
  --project P          Exact project path filter
  --at ISO             Inclusive upper bound on event ts
  --limit N            Cap table rows (default 20)
  --json               Machine-readable output

Heuristic note: succession edges are temporal adjacency, not causation.
`;
}

interface GraphCliOpts {
  sessionId?: string;
  projectPath?: string;
  at?: string;
  limit: number;
  json: boolean;
}

function parseOpts(args: string[]): GraphCliOpts {
  const limitRaw = opt(args, "--limit");
  const limit = limitRaw ? Math.max(1, Number(limitRaw) || 20) : 20;
  return {
    sessionId: opt(args, "--session"),
    projectPath: opt(args, "--project"),
    at: opt(args, "--at"),
    limit,
    json: hasFlag(args, "--json"),
  };
}

function projectOpts(cli: GraphCliOpts) {
  return {
    sessionIds: cli.sessionId ? [cli.sessionId] : undefined,
    projectPath: cli.projectPath,
    at: cli.at,
  };
}

function bareArgs(args: string[]): string[] {
  const skipVal = new Set(["--session", "--project", "--at", "--limit"]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json" || a === "--help" || a === "-h") continue;
    if (skipVal.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

export function buildGraph(db: Db, cli: GraphCliOpts): ProjectedGraph {
  return projectGraph(db, projectOpts(cli));
}

function neighborsOf(g: ProjectedGraph, eventId: number): {
  node: GraphNode | undefined;
  inbound: GraphEdge[];
  outbound: GraphEdge[];
} {
  const id = nodeIdForEvent(eventId);
  const node = g.nodes.find((n) => n.id === id);
  return {
    node,
    inbound: g.edges.filter((e) => e.to === id),
    outbound: g.edges.filter((e) => e.from === id),
  };
}

/** BFS shortest path on undirected view of projection edges. */
export function shortestPath(
  g: ProjectedGraph,
  fromEventId: number,
  toEventId: number,
): string[] | null {
  const start = nodeIdForEvent(fromEventId);
  const goal = nodeIdForEvent(toEventId);
  if (start === goal) return [start];

  const adj = new Map<string, string[]>();
  const ensure = (id: string) => {
    if (!adj.has(id)) adj.set(id, []);
  };
  for (const n of g.nodes) ensure(n.id);
  for (const e of g.edges) {
    ensure(e.from);
    ensure(e.to);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  if (!adj.has(start) || !adj.has(goal)) return null;

  const prev = new Map<string, string | null>();
  prev.set(start, null);
  const q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi]!;
    if (cur === goal) break;
    for (const nb of adj.get(cur) ?? []) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      q.push(nb);
    }
  }
  if (!prev.has(goal)) return null;
  const path: string[] = [];
  let walk: string | null = goal;
  while (walk) {
    path.push(walk);
    walk = prev.get(walk) ?? null;
  }
  path.reverse();
  return path;
}

export async function graphCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
    console.log(graphHelpText());
    return;
  }

  const bare = bareArgs(args);
  let sub = bare[0] ?? "summary";
  let rest = bare.slice(1);

  // Allow: graph --at ISO (summary at T) without explicit subcommand
  const cli = parseOpts(args);
  if (sub.startsWith("e:") || /^\d+$/.test(sub)) {
    // Convenience: graph <eventId> → neighbors
    rest = [sub, ...rest];
    sub = "neighbors";
  }

  // state-at may appear as: graph state-at <iso> or graph --at <iso>
  if (sub === "state-at" && rest[0] && !cli.at) {
    cli.at = rest[0];
    rest = rest.slice(1);
  }

  const db = openDb();
  try {
    const g = buildGraph(db, cli);

    if (sub === "summary" || sub === "state-at") {
      const deg = degreeCentrality(g);
      const payload = {
        nodes: g.nodes.length,
        edges: g.edges.length,
        edgeTypes: countBy(g.edges.map((e) => e.type)),
        maxDegree: deg.maxDegree,
        topDegree: deg.degrees.slice(0, cli.limit).map((d) => ({
          nodeId: d.nodeId,
          in: d.in,
          out: d.out,
          total: d.total,
        })),
        at: cli.at ?? null,
        sessionId: cli.sessionId ?? null,
        note: "query-time projection; succession ≠ causation",
      };
      if (cli.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log("");
      console.log("speculum graph summary");
      console.log("─".repeat(72));
      console.log(`  nodes: ${payload.nodes}  edges: ${payload.edges}`);
      console.log(
        `  edge types: ${Object.entries(payload.edgeTypes)
          .map(([k, v]) => `${k}=${v}`)
          .join("  ") || "(none)"}`,
      );
      if (cli.at) console.log(`  at: ${cli.at}`);
      if (cli.sessionId) console.log(`  session: ${cli.sessionId}`);
      console.log(`  max degree: ${payload.maxDegree}`);
      console.log("  top degree:");
      for (const d of payload.topDegree) {
        console.log(`    ${d.nodeId}  in=${d.in} out=${d.out} total=${d.total}`);
      }
      console.log("");
      console.log("  note: succession edges are temporal adjacency, not causation.");
      console.log("");
      return;
    }

    if (sub === "neighbors") {
      const eventId = parseEventId(rest[0]);
      if (eventId === null) {
        console.error("usage: speculum graph neighbors <eventId>");
        process.exit(1);
      }
      const nb = neighborsOf(g, eventId);
      const payload = {
        eventId,
        node: nb.node ?? null,
        inbound: nb.inbound,
        outbound: nb.outbound,
      };
      if (cli.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log("");
      console.log(`speculum graph neighbors e:${eventId}`);
      console.log("─".repeat(72));
      if (!nb.node) {
        console.log("  (event not in projected window)");
        console.log("");
        return;
      }
      console.log(
        `  node: ${nb.node.id}  kind=${nb.node.kind}  tool=${nb.node.toolName ?? "—"}  ${nb.node.ts}`,
      );
      console.log(`  outbound (${nb.outbound.length}):`);
      for (const e of nb.outbound.slice(0, cli.limit)) {
        console.log(`    → ${e.to}  [${e.type}]`);
      }
      console.log(`  inbound (${nb.inbound.length}):`);
      for (const e of nb.inbound.slice(0, cli.limit)) {
        console.log(`    ← ${e.from}  [${e.type}]`);
      }
      console.log("");
      return;
    }

    if (sub === "path") {
      const fromId = parseEventId(rest[0]);
      const toId = parseEventId(rest[1]);
      if (fromId === null || toId === null) {
        console.error("usage: speculum graph path <fromEventId> <toEventId>");
        process.exit(1);
      }
      const path = shortestPath(g, fromId, toId);
      const payload = {
        from: fromId,
        to: toId,
        path,
        length: path ? path.length - 1 : null,
      };
      if (cli.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log("");
      console.log(`speculum graph path e:${fromId} → e:${toId}`);
      console.log("─".repeat(72));
      if (!path) {
        console.log("  (no path in projected window)");
      } else {
        console.log(`  hops: ${path.length - 1}`);
        console.log(`  ${path.join(" → ")}`);
      }
      console.log("");
      return;
    }

    if (sub === "degree") {
      const deg = degreeCentrality(g);
      const payload = {
        totalNodes: deg.totalNodes,
        totalEdges: deg.totalEdges,
        maxDegree: deg.maxDegree,
        degrees: deg.degrees.slice(0, cli.limit),
      };
      if (cli.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log("");
      console.log("speculum graph degree");
      console.log("─".repeat(72));
      console.log(
        `  nodes: ${deg.totalNodes}  edges: ${deg.totalEdges}  max: ${deg.maxDegree}`,
      );
      for (const d of payload.degrees) {
        console.log(`  ${d.nodeId}  in=${d.in} out=${d.out} total=${d.total}`);
      }
      console.log("");
      return;
    }

    console.error(`unknown graph subcommand: ${sub}`);
    console.log(graphHelpText());
    process.exit(1);
  } finally {
    db.close();
  }
}

function countBy(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}
