import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { BrailleCanvas } from './braille';
import { attentionShade, clusterColor, dim, EDGE_DIM, EDGE_FAINT, EDGE_OVERLAY_DIM, HIGHLIGHT, HOT_EDGE, type RGB } from './color';
import { attentionTier, attentionWeight } from './weight';
import { detectCommunities } from './community';
import { computeOverlay, type EdgeFamily, type FamilyStat, type OverlayEdge, type SemanticLink } from './overlay';
import { hiddenSubKey, subKeyOf } from './subkey';
import { fitViewport, worldToScreen, type Viewport, type WorldPoint } from './viewport';

// The daemon's /api/graph shape (the fields we use; extra fields ignored).
export interface GraphNode {
  id: string;
  label?: string;
  type?: string; // doc type → node glyph (task/knowledge/inbox/…)
  kind?: string; // "doc" | "cluster" | "placeholder"
  status?: string; // frontmatter status → attention tier (task/inbox/reminder/…)
  group?: string; // cluster key (preferred)
  folder?: string; // cluster key fallback
  linkCount?: number;
  updated?: string; // last-updated ISO timestamp (recency)
  tags?: string[];
}
export interface GraphLink {
  source: string;
  target: string;
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** The cluster a node belongs to: group → folder → type → unclustered. */
export function clusterKeyOf(n: GraphNode): string {
  return n.group ?? n.folder ?? n.type ?? '∅';
}

/** The status bucket a node belongs to: status → type → unclustered. Nodes without a status
 *  (knowledge, files) fall back to their type so they still form coherent buckets. */
export function statusKeyOf(n: GraphNode): string {
  return n.status ?? n.type ?? '∅';
}

/** The clustering/coloring key for a node under the active layout mode: `status` mode buckets by
 *  status, every other mode by the folder/type cluster key. Kept in one place so the layout, the
 *  node color, and the legend all agree on which axis is live. */
export function axisKeyOf(n: GraphNode, mode: LayoutMode): string {
  return mode === 'status' ? statusKeyOf(n) : clusterKeyOf(n);
}

// Distinct full-cell glyphs per doc type, so node type reads at a glance over the edge web.
// Every doc type the daemon emits gets its own silhouette (no shared '•' fallback for real types).
const NODE_GLYPH: Record<string, string> = {
  task: '◆',
  knowledge: '●',
  inbox: '◧',
  reminder: '◔',
  forge: '⬡',
  ticket: '▣',
  tag: '▲',
  project: '⬢',
  archive: '▽',
  placeholder: '◌', // unresolved wikilink target — dotted = "not yet real"
  other: '◇',
  // shape=v2 types (appended so existing KNOWN_TYPES indices — and typeColor — stay stable):
  pipeline: '⎔', // forge split: operator/forge-master pipelines (hexagon kin of legacy forge's ⬡)
  dream: '☽', // forge split: dream artifacts
  file: '▤', // v2 file node — an existing non-md wikilink target
};
export function nodeGlyph(type?: string): string {
  return (type && NODE_GLYPH[type]) || '•';
}

// Pipeline/dream manifests all title themselves `Pipeline: <slug>` (dream slugs additionally lead
// with a timestamp), so a head-slice truncation renders every one of them as the SAME string — the
// shared prefix survives, the distinguishing tail dies. Rewrite those machine-slug labels so the
// distinctive part leads, THEN truncate. Other labels pass through untouched.
const DREAM_SLUG = /^Pipeline:\s+dream-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-(.+)$/;
const PIPELINE_PREFIX = /^Pipeline:\s+/;
export function displayLabel(label: string, max = 18): string {
  const dream = DREAM_SLUG.exec(label);
  const s = dream ? `${dream[2]} ${dream[1]}` : label.replace(PIPELINE_PREFIX, '');
  return s.slice(0, max);
}

/** Every doc type that has a dedicated glyph, in a stable order (drives the type color + legend). */
export const KNOWN_TYPES = Object.keys(NODE_GLYPH);

/** A stable per-type color, independent of layout mode — the legend's glyph color, so the type key
 *  reads the same however the graph is clustered. Golden-angle hue on the type's fixed index. */
export function typeColor(type?: string): RGB {
  const i = type ? KNOWN_TYPES.indexOf(type) : -1;
  return clusterColor(i < 0 ? KNOWN_TYPES.length : i);
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  cluster: number;
}
type SimLink = SimulationLinkDatum<SimNode>;

export interface PositionedNode {
  id: string;
  x: number; // sub-pixel screen coords
  y: number;
}

export interface WorldNode {
  id: string;
  x: number; // world coords (layout space, pre-viewport)
  y: number;
  cluster: number;
}

// force     — raw force-directed (springs + charge), the classic hairball-prone map.
// cluster   — force with per-cluster grid anchors keyed on folder/type, so clusters separate.
// status    — cluster layout keyed on status instead, so all blocked / active / review pull together.
// community — cluster layout keyed on communities DETECTED from the link structure (label propagation).
// radial    — no force: attention-ranked phyllotaxis, hottest work at the center, dormant spiralling out.
export type LayoutMode = 'force' | 'cluster' | 'status' | 'community' | 'radial';

/** Modes that pull nodes toward per-axis grid anchors (vs raw force / radial placement). */
function isClustered(mode: LayoutMode): boolean {
  return mode === 'cluster' || mode === 'status' || mode === 'community';
}

/** Undirected degree per node id (source + target incidence). Feeds attention weight + node mass. */
function degreeMap(graph: GraphData): Map<string, number> {
  const deg = new Map<string, number>();
  const bump = (id: string) => deg.set(id, (deg.get(id) ?? 0) + 1);
  for (const l of graph.links) {
    bump(l.source);
    bump(l.target);
  }
  return deg;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Radial attention layout — place nodes by attention rank, not by force. Sort by attention weight
 * (status tier, degree as tiebreak) descending, then lay them on a phyllotaxis (sunflower) spiral
 * so the highest-attention work lands nearest the origin and dormant work spirals outward. The
 * cluster hue is preserved so a node's folder/type still reads; position encodes priority.
 * Deterministic and O(n log n) — no simulation, so it settles instantly.
 */
function radialLayout(graph: GraphData): WorldNode[] {
  const clusterKeys = [...new Set(graph.nodes.map(clusterKeyOf))];
  const deg = degreeMap(graph);
  const ranked = graph.nodes
    .map((n) => ({ n, w: attentionWeight(n, deg.get(n.id) ?? 0) }))
    .sort((a, b) => b.w - a.w);
  const spacing = 6;
  return ranked.map(({ n }, i) => {
    const r = spacing * Math.sqrt(i);
    const theta = i * GOLDEN_ANGLE;
    return {
      id: n.id,
      x: r * Math.cos(theta),
      y: r * Math.sin(theta),
      cluster: clusterKeys.indexOf(clusterKeyOf(n)),
    };
  });
}

/** Anchor positions on a ~square grid spanning [-r, r] (cluster mode pulls toward these). */
function gridAnchors(count: number, r: number): { x: number; y: number }[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const anchors: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    anchors.push({
      x: cols === 1 ? 0 : (cx / (cols - 1) - 0.5) * 2 * r,
      y: rows === 1 ? 0 : (cy / (rows - 1) - 0.5) * 2 * r,
    });
  }
  return anchors;
}

/**
 * Run the force layout once and return WORLD-space positions (no viewport applied).
 * `mode: 'cluster'` pulls nodes toward per-cluster grid anchors (forceX/forceY) so
 * clusters physically separate — a different layout than raw force, to curb hairballing.
 * Deterministic (d3 phyllotaxis init; no randomness in the forces).
 */
// Target ring radius per attention tier for the status-aware force bias (index = tier). Hot work
// (tier 3) is drawn toward the center, dormant work (tier 0) toward the rim — a gentle gradient
// that leaves the organic force structure intact (low strength) rather than posing nodes.
const RADIUS_BY_TIER = [108, 70, 38, 6];
export const DEFAULT_STATUS_FORCE = 0.06;

/** Build a stopped d3 force simulation for the graph in the given layout mode. `cluster`/`status`/
 *  `community` share the grid-anchored topology, differing only in the axis their cluster index
 *  comes from (folder-or-type / status / link-detected community); raw `force` adds a weak
 *  attention-radial bias (strength `statusForce`) so status reads as centrality in the primary map. */
function buildSimulation(
  graph: GraphData,
  mode: LayoutMode,
  statusForce = DEFAULT_STATUS_FORCE
): { sim: Simulation<SimNode, undefined>; nodes: SimNode[]; neutralCluster: number } {
  const clustered = isClustered(mode);
  // Cluster index per node: communities come from the link structure (not a node key), every other
  // clustered mode from `axisKeyOf`. This index drives both the grid anchor AND the node color.
  let clusterOf: (n: GraphNode) => number;
  let clusterCount: number;
  let neutralCluster = -1; // the misc-bucket cluster index (community mode only) → rendered gray
  if (mode === 'community') {
    // Merge communities smaller than ~0.6% of the graph into a shared "misc" bucket so the palette
    // stays readable (a full-workspace graph yields hundreds of tiny communities otherwise), scaled
    // to graph size so a small neighborhood scope isn't over-merged.
    const minSize = Math.max(4, Math.floor(graph.nodes.length / 175));
    const { labels: comm, misc } = detectCommunities(graph, { minSize });
    clusterCount = Math.max(1, new Set(comm.values()).size);
    clusterOf = (n) => comm.get(n.id) ?? 0;
    neutralCluster = misc;
  } else {
    const clusterKeys = [...new Set(graph.nodes.map((n) => axisKeyOf(n, mode)))];
    clusterCount = clusterKeys.length;
    clusterOf = (n) => clusterKeys.indexOf(axisKeyOf(n, mode));
  }
  const nodes: SimNode[] = graph.nodes.map((n) => ({ id: n.id, cluster: clusterOf(n) }));
  const links: SimLink[] = graph.links.map((l) => ({ source: l.source, target: l.target }));
  // Node mass by degree: hubs (many links) repel harder so they claim breathing room and the
  // periphery reads as periphery. Leaves keep the base charge.
  const deg = degreeMap(graph);
  const baseCharge = clustered ? -18 : -30;
  const sim = forceSimulation<SimNode>(nodes)
    .force('charge', forceManyBody<SimNode>().strength((d) => baseCharge * (1 + Math.min(deg.get(d.id) ?? 0, 16) / 16)))
    .force('link', forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(clustered ? 12 : 18))
    .force('collide', forceCollide(2))
    .stop();
  if (clustered) {
    const anchors = gridAnchors(clusterCount, 100);
    sim
      .force('x', forceX<SimNode>((d) => anchors[d.cluster].x).strength(0.35))
      .force('y', forceY<SimNode>((d) => anchors[d.cluster].y).strength(0.35));
  } else {
    sim.force('center', forceCenter(0, 0));
    // Status-aware bias: pull each node toward its attention tier's ring (hot → center). Strength 0
    // disables it (raw force); the config modal tunes it live.
    if (statusForce > 0) {
      const tierById = new Map(graph.nodes.map((n) => [n.id, attentionTier(n)]));
      sim.force(
        'attention',
        forceRadial<SimNode>((d) => RADIUS_BY_TIER[tierById.get(d.id) ?? 1], 0, 0).strength(statusForce)
      );
    }
  }
  return { sim, nodes, neutralCluster };
}

const worldFrom = (nodes: SimNode[]): WorldNode[] =>
  nodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0, cluster: n.cluster }));

/** A laid-out world plus the neutral (misc) cluster index, -1 when there is none. */
export interface LayoutResult {
  nodes: WorldNode[];
  neutralCluster: number;
}

/** Synchronous layout — run all iterations at once (small graphs / tests). */
export function layoutWorld(
  graph: GraphData,
  opts: { iterations?: number; mode?: LayoutMode; statusForce?: number } = {}
): LayoutResult {
  if (graph.nodes.length === 0) return { nodes: [], neutralCluster: -1 };
  const { iterations = 300, mode = 'force', statusForce } = opts;
  if (mode === 'radial') return { nodes: radialLayout(graph), neutralCluster: -1 }; // direct placement
  const { sim, nodes, neutralCluster } = buildSimulation(graph, mode, statusForce);
  for (let i = 0; i < iterations; i++) sim.tick();
  return { nodes: worldFrom(nodes), neutralCluster };
}

/** Async layout — tick in chunks, yielding to the event loop so a loading animation keeps playing. */
export async function layoutWorldAsync(
  graph: GraphData,
  opts: { iterations?: number; mode?: LayoutMode; statusForce?: number; chunk?: number; signal?: { aborted: boolean } } = {}
): Promise<LayoutResult> {
  if (graph.nodes.length === 0) return { nodes: [], neutralCluster: -1 };
  const { iterations = 300, mode = 'force', statusForce, chunk = 20, signal } = opts;
  if (mode === 'radial') return { nodes: radialLayout(graph), neutralCluster: -1 }; // instant
  const { sim, nodes, neutralCluster } = buildSimulation(graph, mode, statusForce);
  for (let i = 0; i < iterations; ) {
    const end = Math.min(iterations, i + chunk);
    for (; i < end; i++) sim.tick();
    if (signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  return { nodes: worldFrom(nodes), neutralCluster };
}

export interface LayoutOptions {
  width: number; // sub-pixels
  height: number;
  iterations?: number;
  padding?: number;
  mode?: LayoutMode;
  statusForce?: number;
}

/** Layout + fit-to-canvas → SCREEN positions (convenience over layoutWorld + fitViewport). */
export function layoutGraph(graph: GraphData, opts: LayoutOptions): { nodes: PositionedNode[] } {
  const { width, height, iterations, padding = 2, mode, statusForce } = opts;
  const { nodes: world } = layoutWorld(graph, { iterations, mode, statusForce });
  if (world.length === 0) return { nodes: [] };
  const vp = fitViewport(world, width, height, padding);
  return { nodes: world.map((n) => ({ id: n.id, ...worldToScreen(n, vp, width, height) })) };
}

// ─── Composite colored render: dim braille edge-web + colored type-glyph nodes on top ───

export interface Cell {
  char: string;
  fg: RGB;
  attr?: number; // optional OpenTUI text attribute bitmask (e.g. bold for degree-emphasized hubs)
}

/** OpenTUI text-attribute bit for bold (used to emphasize high-degree hub nodes). */
export const ATTR_BOLD = 1;

/** Muted slate for the community "misc" bucket — reads as unclustered, not a real community hue.
 *  Exported so the legend derives its swatch from the SAME constant the renderer paints with. */
export const NEUTRAL_CLUSTER: RGB = { r: 96, g: 102, b: 114 };

/**
 * Structural signature of a graph — changes only when the node/link SET changes (including a
 * REWIRE at constant counts: link endpoints are hashed, not just counted), never on node
 * metadata. Drives layout-cache invalidation: metadata-only reload → same signature → recolor
 * in place; add/remove/rewire → new signature → fresh layout + cache clear.
 */
export function graphSignature(graph: GraphData): string {
  let h = 0;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  };
  for (const n of graph.nodes) mix(n.id);
  for (const l of graph.links) {
    mix(l.source);
    mix('>');
    mix(l.target);
  }
  return `${graph.nodes.length}:${graph.links.length}:${h}`;
}

/** Render-time graph options (the config-modal toggles). Separate from the LAYOUT, so flipping any
 *  of these recolors in place without a reflow. */
export interface RenderConfig {
  attention?: boolean; // apply the attention lightness shading (default true)
  haloOverEdges?: boolean; // let hub halos overwrite the braille edge web (set once zoomed in)
  recencyFade?: boolean; // fade nodes by `updated` age toward the ground (default false)
  recencyNow?: number; // "now" epoch ms for the recency calc (defaults to Date.now())
  emphasizeHubs?: boolean; // bold the highest-degree nodes (default false)
}

/** The full graph configuration surfaced by the config modal — render toggles + the one layout
 *  knob (`statusForce`). Mode is tracked separately (it drives which layout runs). */
export interface GraphConfig {
  attention: boolean;
  recencyFade: boolean;
  emphasizeHubs: boolean;
  /** Typed-edge overlay (render-only): `on` dims the wiki web + draws the vinculum semantic edges
   *  colored by family. Default `off` — default-on is reserved for future focus/neighborhood views. */
  typedEdges: 'off' | 'on';
  /** Transient-orphan filter (render-only): `hide-transient` (default) hides zero-link nodes under
   *  archive/dream/handle/completed paths (transient-by-design), collapsing the orphan noise to the
   *  genuinely fix-worthy orphans; `all` shows every orphan. See `render/orphans.ts` for the predicate. */
  orphans: 'hide-transient' | 'all';
  /** Focus/neighborhood mode hop radius (1..3, default 2): the N in the N-hop BFS when focus mode is
   *  active (`n` on a selected node). Only the radius is configured here — the mode itself (on/off,
   *  which seed) is transient GraphView interaction state. See `render/focus.ts` for the BFS. */
  focusHops: number;
  statusForce: number;
}
export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  attention: true,
  recencyFade: false,
  emphasizeHubs: false,
  typedEdges: 'off',
  orphans: 'hide-transient', // hide transient-by-design orphans by default — surface real orphans
  focusHops: 2, // 2-hop neighborhood by default when focus mode is entered
  statusForce: 0, // raw force by default — the attention-radial bias is opt-in via the config modal
};

const RECENCY_FULL_FADE_DAYS = 180; // a node this stale is fully faded
const HUB_DEGREE = 8; // degree ≥ this → emphasized (bold + a size halo) when emphasizeHubs is on
const MEGA_DEGREE = 20; // degree ≥ this → a fuller 5×5 halo (vs the 3×3 hub halo)
const HALO_CHAR = '░'; // shade block: a hub becomes a fuzzy colored blob, clearly bigger than a leaf
// The full 3×3 ring around the glyph (8 cells); mega-hubs add the 5×5 border (16 more) for a 24-cell
// halo. A filled ring (not a sparse plus) is what makes the size read at a glance.
const HALO_RING1: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const HALO_RING2: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) out.push([dx, dy]);
  return out;
})();

/** Fade factor 0..0.6 by how stale `updated` is (0 = fresh/undated, 0.6 = ≥ RECENCY_FULL_FADE_DAYS). */
function recencyFadeOf(updated: string | undefined, now: number): number {
  if (!updated) return 0;
  const t = Date.parse(updated);
  if (Number.isNaN(t)) return 0;
  const days = (now - t) / 86_400_000;
  if (days <= 0) return 0;
  return Math.min(days / RECENCY_FULL_FADE_DAYS, 1) * 0.6;
}
export interface CellGrid {
  cols: number;
  rows: number;
  cells: (Cell | null)[]; // null = empty (space). Indexed cy*cols+cx.
}

export interface ColorRenderResult {
  grid: CellGrid;
  nodes: PositionedNode[]; // screen positions (sub-pixel) — for hit-testing
  typedFamilies?: FamilyStat[]; // per-family stats for the overlay legend (only when overlay on)
  typedVisible?: number; // typed edges actually drawn — the status line's `typed N` (overlay on)
}

export interface FocusState {
  selected: string;
  neighbors: Set<string>;
}

/** Shared empty sets for the overlay's optional hidden inputs (avoids per-render allocation). */
const EMPTY_FAMILIES: Set<EdgeFamily> = new Set();
const EMPTY_RELATIONS: Set<string> = new Set();

/**
 * Draw the typed overlay edges into `cells` as colored braille lines. Grouped by resolved color so
 * one canvas serves each family/tier hue (≤ 6 families × 2 tiers), then blitted brightest-last so an
 * asserted edge wins over an inferred one at a shared cell. Endpoints are looked up in the `screen`
 * map (already filtered to visible nodes by the caller), so this never draws an edge to a hidden node.
 */
function drawTypedEdges(
  edges: OverlayEdge[],
  screen: Map<string, WorldPoint>,
  width: number,
  height: number,
  cols: number,
  rows: number,
  cells: (Cell | null)[]
): void {
  if (edges.length === 0) return;
  const groups = new Map<number, { color: RGB; canvas: BrailleCanvas }>();
  for (const e of edges) {
    const a = screen.get(e.source);
    const b = screen.get(e.target);
    if (!a || !b) continue;
    const key = (e.color.r << 16) | (e.color.g << 8) | e.color.b;
    let grp = groups.get(key);
    if (!grp) groups.set(key, (grp = { color: e.color, canvas: new BrailleCanvas(width, height) }));
    grp.canvas.line(a.x, a.y, b.x, b.y);
  }
  const lum = (c: RGB) => c.r + c.g + c.b;
  const ordered = [...groups.values()].sort((p, q) => lum(p.color) - lum(q.color)); // dim first → bright wins
  for (const g of ordered) {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const mask = g.canvas.cellAt(cx, cy);
        if (mask !== 0) cells[cy * cols + cx] = { char: String.fromCodePoint(0x2800 + mask), fg: g.color };
      }
    }
  }
}

/**
 * Render a laid-out graph through a viewport into a composite cell grid: edges in a dim
 * braille web, then nodes overlaid as full-cell type-glyphs colored by cluster. Off-screen
 * nodes are skipped. When `focus` is set, the selected node + its incident edges + neighbor
 * nodes are emphasized and everything else is dimmed. Grid maps 1:1 to OpenTUI `setCell`.
 */
export function renderView(
  graph: GraphData,
  world: WorldNode[],
  vp: Viewport,
  opts: {
    cols: number;
    rows: number;
    mode?: LayoutMode;
    hiddenTypes?: Set<string>;
    // Node-subcategory hide keys (`hiddenSubKey(type, sub)`, the hierarchical type-legend drill-down).
    // Same render-time gate as hiddenTypes: a node whose type OR whose `type+sub` key is hidden gets no
    // screen position → not drawn, not hit-testable, edges to it auto-skip. Absent/empty → no-op, so
    // the layout is untouched and toggling never reflows.
    hiddenSubs?: Set<string>;
    // Specific node ids to hide (the transient-orphan filter, `render/orphans.ts`). Same render-time
    // gate as hiddenTypes: hidden nodes get no screen position → not drawn, not hit-testable, and any
    // edge to them auto-skips. Layout is untouched, so toggling never reflows.
    hiddenIds?: Set<string>;
    neutralCluster?: number;
    // Typed-edge overlay (render-only): when `overlay` is on, the wiki web dims and the semantic
    // links draw on top colored by family, respecting hiddenTypes (node-visibility) + hiddenFamilies +
    // hiddenRelations (the per-relation drill-down under a family).
    overlay?: boolean;
    semanticLinks?: SemanticLink[];
    hiddenFamilies?: Set<EdgeFamily>;
    hiddenRelations?: Set<string>;
  } & RenderConfig,
  focus?: FocusState
): ColorRenderResult {
  const width = opts.cols * 2;
  const height = opts.rows * 4;
  const hidden = opts.hiddenTypes;
  const overlayOn = opts.overlay === true && !!opts.semanticLinks && opts.semanticLinks.length > 0;
  const useAttention = opts.attention !== false; // default on
  const recencyNow = opts.recencyNow ?? Date.now();
  const hiddenIds = opts.hiddenIds;
  const hiddenSubs = opts.hiddenSubs;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // A node is hidden when its id is in hiddenIds (orphan filter), its type is in hiddenTypes, OR its
  // `type+sub` key is in hiddenSubs (the type-legend drill-down). Each set empty → its clause is inert,
  // so the default (no hides) is byte-identical to before.
  const isHidden = (id: string) => {
    if (hiddenIds !== undefined && hiddenIds.size > 0 && hiddenIds.has(id)) return true;
    const node = byId.get(id);
    if (hidden && hidden.size > 0 && hidden.has(node?.type ?? '')) return true;
    if (hiddenSubs && hiddenSubs.size > 0 && node) {
      const sub = subKeyOf(node);
      if (sub !== null && hiddenSubs.has(hiddenSubKey(node.type ?? 'other', sub))) return true;
    }
    return false;
  };
  // Hub degree counts edges to VISIBLE neighbors only (both endpoints shown), so hiding the node
  // types that made something a hub demotes it — a node isn't shaded as a hub for links you can't see.
  const deg = opts.emphasizeHubs
    ? (() => {
        const m = new Map<string, number>();
        const bump = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
        for (const l of graph.links) {
          if (isHidden(l.source) || isHidden(l.target)) continue;
          bump(l.source);
          bump(l.target);
        }
        return m;
      })()
    : null;
  const clusterById = new Map(world.map((n) => [n.id, n.cluster]));

  // Only visible-type nodes get a screen position → edges to a hidden node auto-skip (its endpoint
  // is absent from the map), and the node-draw loop below skips hidden nodes outright.
  const screen = new Map<string, WorldPoint>();
  for (const n of world) if (!isHidden(n.id)) screen.set(n.id, worldToScreen(n, vp, width, height));

  // edges → two braille layers: dim (most) + hot (incident to the selected node)
  const dimCanvas = new BrailleCanvas(width, height);
  const hotCanvas = focus ? new BrailleCanvas(width, height) : null;
  for (const link of graph.links) {
    const a = screen.get(link.source);
    const b = screen.get(link.target);
    if (!a || !b) continue;
    if (focus && (link.source === focus.selected || link.target === focus.selected)) {
      hotCanvas!.line(a.x, a.y, b.x, b.y);
    } else {
      dimCanvas.line(a.x, a.y, b.x, b.y);
    }
  }

  const cells: (Cell | null)[] = new Array(opts.cols * opts.rows).fill(null);
  // The wiki web recedes to a dimmer slate while the typed overlay is on (unless already focus-faint),
  // so the colored typed edges read on top of it.
  const edgeColor = focus ? EDGE_FAINT : overlayOn ? EDGE_OVERLAY_DIM : EDGE_DIM;
  for (let cy = 0; cy < opts.rows; cy++) {
    for (let cx = 0; cx < opts.cols; cx++) {
      const mask = dimCanvas.cellAt(cx, cy);
      if (mask !== 0) cells[cy * opts.cols + cx] = { char: String.fromCodePoint(0x2800 + mask), fg: edgeColor };
    }
  }
  if (hotCanvas) {
    for (let cy = 0; cy < opts.rows; cy++) {
      for (let cx = 0; cx < opts.cols; cx++) {
        const mask = hotCanvas.cellAt(cx, cy);
        if (mask !== 0) cells[cy * opts.cols + cx] = { char: String.fromCodePoint(0x2800 + mask), fg: HOT_EDGE };
      }
    }
  }

  // Typed-edge overlay — colored braille lines on top of the (dimmed) wiki web, under the nodes.
  // Same node-visibility gate as the wiki edges (`screen.has`), so hiddenTypes is respected with no
  // reflow; per-family the color already encodes tier (asserted full, inferred dimmed).
  let typedFamilies: FamilyStat[] | undefined;
  let typedVisible: number | undefined;
  if (overlayOn) {
    const ov = computeOverlay(opts.semanticLinks!, (id) => screen.has(id), opts.hiddenFamilies ?? EMPTY_FAMILIES, opts.hiddenRelations ?? EMPTY_RELATIONS);
    typedFamilies = ov.families;
    typedVisible = ov.visibleCount;
    drawTypedEdges(ov.edges, screen, width, height, opts.cols, opts.rows, cells);
  }

  // Collect on-screen nodes with a z-tier, then paint in painter's order so important
  // things land on top: dimmed glyphs (tier 0) underneath → neighbors (1) → selected (2)
  // → labels last of all. Without this, a later-drawn dimmed node clobbers an earlier
  // node's label or focused glyph (the cells share space when nodes/labels overlap).
  type DrawnNode = {
    cx: number;
    cy: number;
    glyph: string;
    fg: RGB;
    attr?: number;
    tier: number; // 0 dimmed/normal · 1 neighbor · 2 selected
    label?: string;
    labelFg?: RGB;
  };
  const drawn: DrawnNode[] = [];
  const positioned: PositionedNode[] = [];
  const halos: { idx: number; fg: RGB }[] = []; // hub size-halo cells, painted under the glyphs
  for (const n of world) {
    const s = screen.get(n.id);
    if (!s) continue; // hidden type — not positioned, not drawn, not hit-testable
    positioned.push({ id: n.id, x: s.x, y: s.y });
    const cx = Math.floor(s.x / 2);
    const cy = Math.floor(s.y / 4);
    if (cx < 0 || cy < 0 || cx >= opts.cols || cy >= opts.rows) continue;
    const node = byId.get(n.id);
    // Hue = cluster; lightness = attention tier (toggleable) then recency (toggleable). A node with
    // no status keeps its exact cluster hue (tier 1 is identity); hot work lifts, stale work sinks.
    // The community "misc" bucket (neutralCluster) is a NEUTRAL gray, not a real community hue.
    const cIdx = clusterById.get(n.id) ?? 0;
    const hue = cIdx === opts.neutralCluster ? NEUTRAL_CLUSTER : clusterColor(cIdx);
    let base = node && useAttention ? attentionShade(hue, attentionTier(node)) : hue;
    if (opts.recencyFade) base = dim(base, recencyFadeOf(node?.updated, recencyNow));
    // Hub emphasis: high-degree nodes get bold PLUS a size halo (surrounding cells), so they read
    // as bigger even when the glyph is solid-filled (bold alone barely shows on ●/◆). Suppressed for
    // off-focus nodes so a focused view stays clean.
    const d = deg ? deg.get(n.id) ?? 0 : 0;
    const emphasized = d >= HUB_DEGREE && (!focus || focus.selected === n.id || focus.neighbors.has(n.id));
    const attr = emphasized ? ATTR_BOLD : undefined;
    if (emphasized) {
      const haloFg = dim(base, 0.3); // keep most of the node's hue so the ring reads as the node's
      const ring = d >= MEGA_DEGREE ? [...HALO_RING1, ...HALO_RING2] : HALO_RING1;
      for (const [dx, dy] of ring) {
        const hx = cx + dx;
        const hy = cy + dy;
        if (hx >= 0 && hy >= 0 && hx < opts.cols && hy < opts.rows) halos.push({ idx: hy * opts.cols + hx, fg: haloFg });
      }
    }
    let fg: RGB = base;
    let glyph = nodeGlyph(node?.type);
    let tier = focus ? 0 : 1;
    let label: string | undefined;
    let labelFg: RGB | undefined;
    if (focus) {
      if (n.id === focus.selected) {
        fg = HIGHLIGHT;
        glyph = '◉';
        tier = 2;
        label = displayLabel(node?.label ?? n.id);
        labelFg = HIGHLIGHT;
      } else if (focus.neighbors.has(n.id)) {
        tier = 1;
        label = displayLabel(node?.label ?? n.id);
        labelFg = base;
      } else {
        fg = dim(base, 0.82);
        tier = 0;
      }
    }
    drawn.push({ cx, cy, glyph, fg, attr, tier, label, labelFg });
  }

  // Hub size-halos, painted under the glyphs (the glyph paints over the center next). By default
  // only into EMPTY cells so the edge web stays intact — but when zoomed in (`haloOverEdges`) they
  // overwrite the braille edges too, since at that scale the halo is otherwise lost under the web
  // and the node-size signal matters more than the local edges.
  for (const h of halos) {
    const occupied = cells[h.idx];
    const isEdge = occupied && occupied.char >= '⠀' && occupied.char <= '⣿';
    if (!occupied || (opts.haloOverEdges && isEdge)) cells[h.idx] = { char: HALO_CHAR, fg: h.fg };
  }

  // glyphs back-to-front by tier (so a focused glyph wins over a dimmed one at a shared cell)
  for (let t = 0; t <= 2; t++) {
    for (const d of drawn) if (d.tier === t) cells[d.cy * opts.cols + d.cx] = { char: d.glyph, fg: d.fg, attr: d.attr };
  }
  // labels paint over edges AND dimmed glyphs (so a dimmed node can't break a label), but
  // NOT over a FOCUSED node marker (don't let a label eat a selected/neighbor glyph)
  const protectedCells = new Set<number>();
  for (const d of drawn) if (d.tier >= 1) protectedCells.add(d.cy * opts.cols + d.cx);
  for (const d of drawn) {
    if (!d.label) continue;
    const text = ` ${d.label}`;
    for (let i = 0; i < text.length; i++) {
      const lx = d.cx + 1 + i;
      if (lx < 0 || lx >= opts.cols) break;
      const idx = d.cy * opts.cols + lx;
      if (protectedCells.has(idx)) continue;
      cells[idx] = { char: text[i], fg: d.labelFg ?? d.fg };
    }
  }

  return { grid: { cols: opts.cols, rows: opts.rows, cells }, nodes: positioned, typedFamilies, typedVisible };
}

export interface RenderOptions {
  cols: number;
  rows: number;
  iterations?: number;
  mode?: LayoutMode;
}

/** Auto-fit render: layout once, fit the viewport to the canvas, render. */
export function renderGraph(graph: GraphData, opts: RenderOptions): ColorRenderResult {
  const width = opts.cols * 2;
  const height = opts.rows * 4;
  const { nodes: world } = layoutWorld(graph, { iterations: opts.iterations, mode: opts.mode });
  const vp = fitViewport(world, width, height);
  return renderView(graph, world, vp, { cols: opts.cols, rows: opts.rows, mode: opts.mode });
}

/** Monochrome canvas render (the raw braille web; kept for the canvas primitive + tests). */
export function renderGraphToCanvas(
  graph: GraphData,
  opts: RenderOptions
): { canvas: BrailleCanvas; nodes: PositionedNode[] } {
  const width = opts.cols * 2;
  const height = opts.rows * 4;
  const { nodes } = layoutGraph(graph, { width, height, iterations: opts.iterations, mode: opts.mode });
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const canvas = new BrailleCanvas(width, height);
  for (const link of graph.links) {
    const a = pos.get(link.source);
    const b = pos.get(link.target);
    if (a && b) canvas.line(a.x, a.y, b.x, b.y);
  }
  for (const n of nodes) {
    canvas.set(n.x, n.y);
    canvas.set(n.x + 1, n.y);
    canvas.set(n.x, n.y + 1);
    canvas.set(n.x + 1, n.y + 1);
  }
  return { canvas, nodes };
}

/** Render a cell grid to a truecolor ANSI string (for standalone terminal smokes). */
export function cellGridToAnsi(grid: CellGrid): string {
  let out = '';
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const cell = grid.cells[cy * grid.cols + cx];
      if (!cell) out += ' ';
      else out += `\x1b[38;2;${cell.fg.r};${cell.fg.g};${cell.fg.b}m${cell.char}`;
    }
    out += '\x1b[0m\n';
  }
  return out;
}
