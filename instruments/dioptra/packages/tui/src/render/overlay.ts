// Typed-edge overlay — the render-only channel that draws the vinculum semantic-edge layer
// (`graph/edges.jsonl`, served at `/api/graph?edges=semantic`) on top of the wiki edge web.
//
// This module is PURE (colors + filtering only, no positions, no OpenTUI): the 15 relation types
// map to 6 families (see graph/README.md), each family gets one fixed hue that reads over the dark
// theme, and `computeOverlay` filters the semantic links down to the ones that should draw (both
// endpoints currently visible AND the family not toggled off) plus the per-family counts the legend
// and status line read. `renderView` (graph.ts) consumes the result; positions live there.

import { dim, hsl, type RGB } from './color';

/** The 6 edge families, in the fixed order the legend renders them (graph/README.md). */
export type EdgeFamily =
  | 'lattice-structural'
  | 'abstraction-ladder'
  | 'lifecycle-lift'
  | 'task-graph'
  | 'analogy-tension'
  | 'knowledge-functional';

export const EDGE_FAMILIES: EdgeFamily[] = [
  'lattice-structural',
  'abstraction-ladder',
  'lifecycle-lift',
  'task-graph',
  'analogy-tension',
  'knowledge-functional',
];

/** A typed semantic link off `/api/graph?edges=semantic` (only the fields the overlay uses). */
export interface SemanticLink {
  source: string;
  target: string;
  relation: string; // the typed relation, e.g. `analogous-to`, `refines`
  tier?: string; // `asserted` | `inferred` (served tiers); anything non-asserted dims
  edgeKind: 'semantic'; // the defensive discriminator — the client keeps only these
}

// The 15 relation types → their family (graph/README.md's "15 types / 6 families" table).
const RELATION_FAMILY: Record<string, EdgeFamily> = {
  // lattice-structural
  'dual-of': 'lattice-structural',
  'contests-at-border': 'lattice-structural',
  'transmission-pair': 'lattice-structural',
  exemplifies: 'lattice-structural',
  'vice-of': 'lattice-structural',
  // abstraction-ladder
  generalizes: 'abstraction-ladder',
  refines: 'abstraction-ladder',
  // lifecycle-lift
  supersedes: 'lifecycle-lift',
  'resolved-by': 'lifecycle-lift',
  motivates: 'lifecycle-lift',
  // task-graph
  'depends-on': 'task-graph',
  // analogy & tension
  'analogous-to': 'analogy-tension',
  contradicts: 'analogy-tension',
  // knowledge-functional
  'builds-on': 'knowledge-functional',
  'addressed-by': 'knowledge-functional',
};

/** The family a relation belongs to, or null for an unknown relation (dropped from the overlay). */
export function familyOf(relation: string): EdgeFamily | null {
  return RELATION_FAMILY[relation] ?? null;
}

// Six well-separated hues (min gap ~40°), saturated + light enough to read as thin braille edges
// over the near-black graph ground ({16,18,24}). Fixed per family — the overlay's third visual
// channel is family, so hue is spent entirely on it (nodes carry cluster hue on a different layer).
const FAMILY_HUE: Record<EdgeFamily, number> = {
  'lattice-structural': 265, // violet
  'abstraction-ladder': 205, // azure
  'lifecycle-lift': 145, // green
  'task-graph': 48, // amber
  'analogy-tension': 8, // red-orange
  'knowledge-functional': 320, // magenta
};

/** A family's full-brightness hue — the legend swatch color and an asserted edge's color. */
export function familyColor(family: EdgeFamily): RGB {
  return hsl(FAMILY_HUE[family], 0.72, 0.62);
}

/** An edge's drawn color: full family hue for `asserted`, dimmed to ~60% for `inferred`/other. */
export function familyEdgeColor(family: EdgeFamily, tier?: string): RGB {
  const base = familyColor(family);
  return tier === 'asserted' ? base : dim(base, 0.4);
}

/** One typed edge to draw: endpoint ids + its family + its tier-resolved color. */
export interface OverlayEdge {
  source: string;
  target: string;
  family: EdgeFamily;
  color: RGB;
}

/** Per-relation stat under a family: the relation name + its node-visible tally + toggle state.
 *  Present-only (a relation appears once it exists in the data), so the expanded family legend can
 *  drill into the individual relations and toggle each. */
export interface RelationStat {
  relation: string;
  count: number; // typed edges of this relation with BOTH endpoints visible (stable across toggles)
  hidden: boolean; // relation toggled off (render-time set) → dimmed in the legend, not drawn
}

/** Per-family legend stat: swatch color + how many of its edges are node-visible + toggle state. */
export interface FamilyStat {
  family: EdgeFamily;
  color: RGB; // the family's asserted (full) color — the legend swatch
  count: number; // typed edges of this family with BOTH endpoints visible (before family-hide)
  hidden: boolean; // family toggled off (render-time set) → dimmed in the legend, not drawn
  relations: RelationStat[]; // per-relation rows for the expanded family legend, count desc, present-only
}

export interface OverlayResult {
  edges: OverlayEdge[]; // edges to draw: node-visible AND family-visible
  families: FamilyStat[]; // per-family rows for the legend, in EDGE_FAMILIES order, present-only
  visibleCount: number; // edges.length — the status line's `typed N`
}

/** Shared empty set for the optional `hiddenRelations` arg (avoids per-call allocation + keeps the
 *  3-arg call sites byte-identical to before). */
const EMPTY_RELATIONS: Set<string> = new Set();

/**
 * Filter the semantic links down to what should draw and tally the per-family + per-relation counts.
 * Pure: takes an `isVisible(id)` predicate (the caller passes `screen.has`, the same node-visibility
 * gate the wiki edges use, so hiddenTypes is respected at render time with no reflow), the render-time
 * `hiddenFamilies` set, and optionally the `hiddenRelations` set. An edge is dropped when its family
 * OR its relation is hidden. A family (and a relation under it) appears if it has any edge in the data
 * (so it can be toggled back on even when currently all-hidden); every `count` is the node-visible
 * tally regardless of the toggles, so the number stays put as you toggle — matching the type legend.
 */
export function computeOverlay(
  links: SemanticLink[],
  isVisible: (id: string) => boolean,
  hiddenFamilies: Set<EdgeFamily>,
  hiddenRelations: Set<string> = EMPTY_RELATIONS
): OverlayResult {
  const present = new Set<EdgeFamily>();
  const nodeVisibleByFamily = new Map<EdgeFamily, number>();
  const nodeVisibleByRelation = new Map<string, number>();
  const relationsByFamily = new Map<EdgeFamily, Set<string>>();
  const edges: OverlayEdge[] = [];
  for (const l of links) {
    const family = familyOf(l.relation);
    if (!family) continue; // unknown relation — not a family, dropped
    present.add(family);
    let rels = relationsByFamily.get(family);
    if (!rels) relationsByFamily.set(family, (rels = new Set()));
    rels.add(l.relation); // present-in-data (toggleable even when currently all-hidden)
    const bothVisible = isVisible(l.source) && isVisible(l.target);
    if (!bothVisible) continue;
    nodeVisibleByFamily.set(family, (nodeVisibleByFamily.get(family) ?? 0) + 1);
    nodeVisibleByRelation.set(l.relation, (nodeVisibleByRelation.get(l.relation) ?? 0) + 1);
    if (hiddenFamilies.has(family)) continue; // family toggled off — counted, not drawn
    if (hiddenRelations.has(l.relation)) continue; // relation toggled off — counted, not drawn
    edges.push({ source: l.source, target: l.target, family, color: familyEdgeColor(family, l.tier) });
  }
  const families: FamilyStat[] = EDGE_FAMILIES.filter((f) => present.has(f)).map((f) => {
    const relations: RelationStat[] = [...(relationsByFamily.get(f) ?? [])]
      .map((relation) => ({ relation, count: nodeVisibleByRelation.get(relation) ?? 0, hidden: hiddenRelations.has(relation) }))
      .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation));
    return {
      family: f,
      color: familyColor(f),
      count: nodeVisibleByFamily.get(f) ?? 0,
      hidden: hiddenFamilies.has(f),
      relations,
    };
  });
  return { edges, families, visibleCount: edges.length };
}
