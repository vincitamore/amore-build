import type { GraphData } from '../render/graph';
import type { SemanticLink } from '../render/overlay';

// A spread of statuses per type so the status / radial / attention channels have something to
// show in the offline demo (the live daemon supplies real statuses).
const STATUS_BY_TYPE: Record<string, (string | undefined)[]> = {
  task: ['active', 'blocked', 'review', 'backlog', 'paused', 'complete'],
  inbox: ['open', 'open', 'resolved'],
  reminder: ['pending', 'ongoing', 'completed'],
  forge: ['running', 'complete'],
  knowledge: [undefined],
};

/** A synthetic clustered graph for demos/smokes when the live daemon isn't up. */
export function syntheticGraph(clusters = 4, per = 12): GraphData {
  const types = ['task', 'knowledge', 'inbox', 'forge', 'reminder'];
  const nodes: GraphData['nodes'] = [];
  const links: GraphData['links'] = [];
  let id = 0;
  for (let c = 0; c < clusters; c++) {
    const base = id;
    for (let i = 0; i < per; i++) {
      const type = types[(c + i) % types.length];
      const states = STATUS_BY_TYPE[type] ?? [undefined];
      nodes.push({
        id: `n${id}`,
        label: `node ${id}`,
        type,
        status: states[(c + i) % states.length],
        group: `cluster-${c}`,
      });
      id++;
    }
    for (let i = 0; i < per; i++) links.push({ source: `n${base + i}`, target: `n${base + ((i + 1) % per)}` });
    for (let i = 0; i < 3; i++) links.push({ source: `n${base + i}`, target: `n${base + ((i + 5) % per)}` });
  }
  for (let c = 0; c < clusters; c++) links.push({ source: `n${c * per}`, target: `n${((c + 1) % clusters) * per}` });
  return { nodes, links };
}

/**
 * A handful of synthetic typed edges spanning all 6 families with a mix of tiers, so the typed-edge
 * overlay demos + headless-smokes offline (the live daemon serves the real `graph/edges.jsonl`). Ids
 * are taken from the passed graph's own nodes so the endpoints always exist; empty for a tiny graph.
 */
export function syntheticSemanticLinks(graph: GraphData): SemanticLink[] {
  const ids = graph.nodes.map((n) => n.id);
  if (ids.length < 12) return [];
  const e = (i: number, j: number, relation: string, tier: string): SemanticLink => ({
    source: ids[i],
    target: ids[j],
    relation,
    tier,
    edgeKind: 'semantic',
  });
  return [
    e(0, 5, 'dual-of', 'asserted'), // lattice-structural
    e(1, 6, 'exemplifies', 'inferred'), // lattice-structural
    e(2, 9, 'generalizes', 'asserted'), // abstraction-ladder
    e(3, 7, 'refines', 'inferred'), // abstraction-ladder
    e(4, 8, 'supersedes', 'asserted'), // lifecycle-lift
    e(0, 10, 'motivates', 'inferred'), // lifecycle-lift
    e(5, 11, 'depends-on', 'asserted'), // task-graph
    e(6, 2, 'analogous-to', 'asserted'), // analogy-tension
    e(7, 3, 'contradicts', 'asserted'), // analogy-tension
    e(8, 1, 'builds-on', 'inferred'), // knowledge-functional
    e(9, 4, 'addressed-by', 'asserted'), // knowledge-functional
  ];
}
