/**
 * Degree centrality over a query-time projected edge list.
 *
 * Deliberately degree only (in / out / total). PageRank, eigenvector, and
 * betweenness stay deferred until exhibited demand.
 */

import type { GraphEdge, GraphNode, ProjectedGraph } from "./project";

export interface NodeDegree {
  nodeId: string;
  in: number;
  out: number;
  total: number;
}

export interface DegreeResult {
  /** One entry per node present in the graph (including isolates). */
  degrees: NodeDegree[];
  maxDegree: number;
  totalNodes: number;
  totalEdges: number;
}

/**
 * Compute directed degree counts over an edge list.
 * Nodes with no incident edges still appear when a node list is supplied.
 */
export function degreeCentrality(
  graph: ProjectedGraph | { nodes?: GraphNode[]; edges: GraphEdge[] },
): DegreeResult {
  const counts = new Map<string, { in: number; out: number }>();

  const ensure = (id: string) => {
    if (!counts.has(id)) counts.set(id, { in: 0, out: 0 });
  };

  if (graph.nodes) {
    for (const n of graph.nodes) ensure(n.id);
  }

  for (const e of graph.edges) {
    ensure(e.from);
    ensure(e.to);
    counts.get(e.from)!.out += 1;
    counts.get(e.to)!.in += 1;
  }

  const degrees: NodeDegree[] = [];
  let maxDegree = 0;
  for (const [nodeId, c] of counts) {
    const total = c.in + c.out;
    if (total > maxDegree) maxDegree = total;
    degrees.push({ nodeId, in: c.in, out: c.out, total });
  }

  // Stable order: higher total first, then nodeId.
  degrees.sort((a, b) => b.total - a.total || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));

  return {
    degrees,
    maxDegree,
    totalNodes: degrees.length,
    totalEdges: graph.edges.length,
  };
}
