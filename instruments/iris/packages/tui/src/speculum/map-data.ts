/**
 * Pure session → world mapper for the Sessions Map stage.
 *
 * One-house geometry: the map is the spatial read of one operator's session
 * record over time — not a multi-project affinity graph. Placement is O(n) /
 * O(n log n) only (never force). Links are evidence-only: parentage +
 * event_links + session_links from the query-service; never invented affinity.
 */
import type { SessionListRow, SessionMapLink } from './query-service';
import { displayLabel, type GraphData, type GraphLink, type GraphNode, type WorldNode } from '../render/graph';
import { clusterColor, dim, lighten, type RGB } from '../render/color';
import type { LegendEntry } from '../graph-view/blit';
import { classifyCwd, type CwdOrigin } from './cwd-class';
import type { Viewport } from '../render/viewport';
import { worldToScreen } from '../render/viewport';

/** Structure-invalidating map modes (reset viewport on change). */
export type MapMode = 'density' | 'cluster';

/** Edge-kind keys used by the map legend (evidence only). */
export type MapEdgeKind = 'parentage' | 'event' | 'resumed_from' | 'shared_artifact';

/** Origin class used as population filter + hue axis. */
export type MapOrigin = CwdOrigin;

/** Agent class used as population filter + glyph. */
export type MapAgent = 'primary' | 'subagent';

/** Exclusive lightness channel: volume-halo (default) or error-density overlay. */
export type MapLightness = 'volume' | 'error';

/** Closed origin order for hue index (not size-rank). */
export const ORIGIN_ORDER: readonly MapOrigin[] = [
  'operator',
  'experiment',
  'harness',
  'unknown',
] as const;

/** Closed agent vocabulary for legend + filters. */
export const AGENT_ORDER: readonly MapAgent[] = ['primary', 'subagent'] as const;

/** Default population: operator primaries only. */
export const DEFAULT_ALLOWED_ORIGINS: ReadonlySet<MapOrigin> = new Set<MapOrigin>(['operator']);
export const DEFAULT_ALLOWED_AGENTS: ReadonlySet<MapAgent> = new Set<MapAgent>(['primary']);

/** Legend vocabulary (depth-0 non-edge labels) — closed set. */
export const LEGEND_ORIGIN_LABELS = new Set<string>(ORIGIN_ORDER);
export const LEGEND_AGENT_LABELS = new Set<string>(AGENT_ORDER);
export const LEGEND_EDGE_LABELS = new Set([
  'parentage',
  'event links',
  'resumed',
  'shared artifact',
]);

/** Closed legend budget (4 edge kinds + ≤4 origins + 2 agents). */
export const LEGEND_MAX_ROWS = 10;

/** Zoom factor at which top-K node labels appear (besides focus labels). */
export const ZOOM_TIER_MIN = 2;
/** Cap on zoom-tier labels painted per frame. */
export const ZOOM_TIER_MAX_LABELS = 12;

export interface SessionWorldNode {
  id: string;
  label: string;
  /** Origin class (color channel / group key). */
  groupKey: string;
  origin: MapOrigin;
  agent: MapAgent;
  parentSession: string | null;
  x: number;
  y: number;
  /** Index into SessionWorld.groupKeys (origin rank among visible). */
  cluster: number;
  projectPath: string;
  startedAt: string;
  endedAt: string;
  turnCount: number;
  eventCount: number;
  modelId: string | null;
}

export interface SessionWorld {
  mode: MapMode;
  nodes: SessionWorldNode[];
  /**
   * Visible origin keys in fixed ORIGIN_ORDER (cluster index = position).
   * Empty when the canvas is empty.
   */
  groupKeys: string[];
}

export interface PopulationFilters {
  origins: ReadonlySet<MapOrigin>;
  agents: ReadonlySet<MapAgent>;
}

/**
 * Default empty link list for callers that intentionally omit evidence edges.
 * The map never invents session-affinity; real edges come from `links()`.
 */
export const SESSION_MAP_LINKS: readonly GraphLink[] = Object.freeze([]);

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const ANCHOR_R = 100;
const CLUSTER_SPACING = 5;
/** Horizontal world span of the timeline (density) mode — shared by axis ticks. */
export const DENSITY_X_SPAN = 200;
/** Vertical span of the volume band stack in density mode. */
const DENSITY_Y_SPAN = 80;
/** Number of volume quantile bands on Y (density). */
const VOLUME_BANDS = 5;
/** Glyph label budget (matches GraphView displayLabel default). */
export const SESSION_GLYPH_LABEL_MAX = 18;
/** Visible span below this uses week ticks; at/above uses month ticks. */
export const AXIS_WEEK_THRESHOLD_MS = 60 * 86_400_000;
const MS_DAY = 86_400_000;
const MONTH_MMM = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Project path → stable short basename (kept for tooling; not a layout key). */
export function projectBasename(projectPath: string): string {
  const raw = (projectPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw) return '∅';
  const parts = raw.split('/').filter(Boolean);
  return parts[parts.length - 1] || '∅';
}

/** Origin class for a session row. */
export function sessionOrigin(session: SessionListRow | { projectPath: string }): MapOrigin {
  return classifyCwd(session.projectPath ?? '');
}

/** Normalize agent field to primary | subagent. */
export function sessionAgent(session: SessionListRow | { agent?: string | null }): MapAgent {
  return session.agent === 'subagent' ? 'subagent' : 'primary';
}

/**
 * Glyph / hover / info label for a session.
 * Prefer summarized title (via displayLabel — strips machine-slug prefixes before
 * truncating so two different titles never collapse to the same head-slice).
 * Empty title → honest id-suffix fallback.
 */
export function sessionLabel(
  id: string,
  title?: string | null,
  max: number = SESSION_GLYPH_LABEL_MAX,
): string {
  const t = (title ?? '').trim();
  if (t) return displayLabel(t, max);
  const s = id.trim();
  if (s.length <= 10) return s;
  return s.slice(-8);
}

/** Deterministic hash → [0,1) for micro-jitter (same id always same offset). */
export function stableUnit(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/** ~square grid anchors spanning [-r, r] (mirrors graph cluster anchors). */
export function gridAnchors(count: number, r: number = ANCHOR_R): { x: number; y: number }[] {
  const n = Math.max(1, count);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const anchors: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    anchors.push({
      x: cols === 1 ? 0 : (cx / (cols - 1) - 0.5) * 2 * r,
      y: rows === 1 ? 0 : (cy / (rows - 1) - 0.5) * 2 * r,
    });
  }
  return anchors;
}

function parseTs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Volume → GraphNode.linkCount for hub/halo attention.
 * `log1p * 4` floors so low-turn sessions stay under hub thresholds (HUB≈8).
 */
export function volumeLinkCount(turnCount: number): number {
  const n = Number.isFinite(turnCount) ? Math.max(0, turnCount) : 0;
  return Math.max(0, Math.floor(Math.round(Math.log1p(n) * 4)));
}

/** Filter the full list to the population allowed on the canvas. */
export function filterSessionsByPopulation(
  sessions: readonly SessionListRow[],
  filters: PopulationFilters,
): SessionListRow[] {
  return sessions.filter(
    (s) => filters.origins.has(sessionOrigin(s)) && filters.agents.has(sessionAgent(s)),
  );
}

/** Origin keys present in a set, in fixed ORIGIN_ORDER. */
export function visibleOriginKeys(sessions: readonly SessionListRow[]): MapOrigin[] {
  const present = new Set(sessions.map(sessionOrigin));
  return ORIGIN_ORDER.filter((o) => present.has(o));
}

function originClusterIndex(origin: MapOrigin, groupKeys: readonly string[]): number {
  const i = groupKeys.indexOf(origin);
  return i >= 0 ? i : 0;
}

function toWorldNode(
  s: SessionListRow,
  x: number,
  y: number,
  groupKeys: readonly string[],
): SessionWorldNode {
  const origin = sessionOrigin(s);
  return {
    id: s.id,
    label: sessionLabel(s.id, s.title),
    groupKey: origin,
    origin,
    agent: sessionAgent(s),
    parentSession: s.parentSession,
    x,
    y,
    cluster: originClusterIndex(origin, groupKeys),
    projectPath: s.projectPath,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    turnCount: s.turnCount,
    eventCount: s.eventCount,
    modelId: s.modelId,
  };
}

/**
 * Density / timeline: X = normalize(startedAt) across the visible set;
 * Y = volume band from turnCount quantiles + micro-jitter. No project Y-lanes.
 *
 * @param disableJitter — test hook so X order is strictly time-monotonic.
 */
export function buildTimelineWorld(
  sessions: SessionListRow[],
  opts?: { disableJitter?: boolean },
): SessionWorld {
  const mode: MapMode = 'density';
  if (sessions.length === 0) return { mode, nodes: [], groupKeys: [] };

  const groupKeys = visibleOriginKeys(sessions);
  const times = sessions.map((s) => parseTs(s.startedAt));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const spanT = Math.max(1, maxT - minT);

  // Rank by turnCount for volume bands (ties broken by id for stability).
  const byTurns = [...sessions].sort((a, b) => {
    const dt = a.turnCount - b.turnCount;
    return dt !== 0 ? dt : a.id.localeCompare(b.id);
  });
  const bandOf = new Map<string, number>();
  const n = byTurns.length;
  for (let i = 0; i < n; i++) {
    const band =
      n <= 1 ? 0 : Math.min(VOLUME_BANDS - 1, Math.floor((i / n) * VOLUME_BANDS));
    bandOf.set(byTurns[i]!.id, band);
  }
  const yMid = (VOLUME_BANDS - 1) / 2;
  const yStep = DENSITY_Y_SPAN / Math.max(1, VOLUME_BANDS - 1);

  const ordered = [...sessions].sort((a, b) => {
    const dt = parseTs(a.startedAt) - parseTs(b.startedAt);
    return dt !== 0 ? dt : a.id.localeCompare(b.id);
  });

  const jitter = !opts?.disableJitter;
  const nodes = ordered.map((s) => {
    const t = parseTs(s.startedAt);
    const u = (t - minT) / spanT;
    const band = bandOf.get(s.id) ?? 0;
    const jx = jitter ? (stableUnit(s.id) - 0.5) * 4 : 0;
    const jy = jitter ? (stableUnit(s.id + '|y') - 0.5) * 3 : 0;
    return toWorldNode(
      s,
      (u - 0.5) * DENSITY_X_SPAN + jx,
      (band - yMid) * yStep + jy,
      groupKeys,
    );
  });

  return { mode, nodes, groupKeys };
}

/**
 * Cluster / structure: visible primaries anchored on a recency grid;
 * visible subagents phyllotaxed around their visible parent; orphans dim-placed
 * as their own anchors when the parent is filtered out.
 */
export function buildStructureWorld(sessions: SessionListRow[]): SessionWorld {
  const mode: MapMode = 'cluster';
  if (sessions.length === 0) return { mode, nodes: [], groupKeys: [] };

  const groupKeys = visibleOriginKeys(sessions);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const primaries = sessions
    .filter((s) => sessionAgent(s) === 'primary')
    .slice()
    .sort((a, b) => {
      // Recent work claims first anchors.
      const dt = parseTs(b.startedAt) - parseTs(a.startedAt);
      return dt !== 0 ? dt : a.id.localeCompare(b.id);
    });

  const childrenByParent = new Map<string, SessionListRow[]>();
  const orphans: SessionListRow[] = [];
  for (const s of sessions) {
    if (sessionAgent(s) !== 'subagent') continue;
    const p = s.parentSession;
    if (p && byId.has(p) && sessionAgent(byId.get(p)!) === 'primary') {
      let list = childrenByParent.get(p);
      if (!list) childrenByParent.set(p, (list = []));
      list.push(s);
    } else {
      orphans.push(s);
    }
  }

  // Orphans get their own anchors after primaries (still on the grid).
  const anchorSubjects = [...primaries, ...orphans];
  const anchors = gridAnchors(Math.max(1, anchorSubjects.length), ANCHOR_R);
  const out: SessionWorldNode[] = [];

  for (let i = 0; i < anchorSubjects.length; i++) {
    const s = anchorSubjects[i]!;
    const anchor = anchors[i] ?? { x: 0, y: 0 };
    out.push(toWorldNode(s, anchor.x, anchor.y, groupKeys));

    if (sessionAgent(s) !== 'primary') continue;
    const kids = (childrenByParent.get(s.id) ?? []).slice().sort((a, b) => {
      const dt = b.turnCount - a.turnCount;
      if (dt !== 0) return dt;
      const ta = parseTs(b.startedAt) - parseTs(a.startedAt);
      return ta !== 0 ? ta : a.id.localeCompare(b.id);
    });
    kids.forEach((child, k) => {
      // k+1 so the first child is off the parent anchor (not stacked).
      const r = CLUSTER_SPACING * Math.sqrt(k + 1);
      const theta = (k + 1) * GOLDEN_ANGLE;
      out.push(
        toWorldNode(child, anchor.x + r * Math.cos(theta), anchor.y + r * Math.sin(theta), groupKeys),
      );
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return { mode, nodes: out, groupKeys };
}

/**
 * Build a session world for the chosen mode under population filters.
 * Deterministic: same sessions + mode + filters → same coordinates.
 */
export function buildSessionWorld(
  sessions: SessionListRow[],
  mode: MapMode = 'density',
  filters: PopulationFilters = {
    origins: DEFAULT_ALLOWED_ORIGINS,
    agents: DEFAULT_ALLOWED_AGENTS,
  },
  opts?: { disableJitter?: boolean },
): SessionWorld {
  const visible = filterSessionsByPopulation(sessions, filters);
  if (mode === 'density') return buildTimelineWorld(visible, opts);
  return buildStructureWorld(visible);
}

/**
 * Edges whose BOTH endpoints sit in `visibleIds` (current population / world).
 * Status `links drawn/loaded` uses this for the loaded denominator so hiding a
 * class drops both numbers; never counts edges into filtered-out sessions.
 */
export function countCoVisibleLinks(
  links: readonly SessionMapLink[],
  visibleIds: ReadonlySet<string>,
): number {
  let n = 0;
  for (const l of links) {
    if (l.source === l.target) continue;
    if (visibleIds.has(l.source) && visibleIds.has(l.target)) n += 1;
  }
  return n;
}

/** Ids of nodes currently on the canvas (population filters applied). */
export function worldNodeIdSet(world: SessionWorld): Set<string> {
  return new Set(world.nodes.map((n) => n.id));
}

/**
 * Evidence edges to draw under the current policy.
 * HARD RULE: an edge draws only when BOTH endpoints are in the current world
 * (visible population). Hiding a class removes every edge that touched it.
 * - default (no selection): co-visible `resumed_from` + `shared_artifact`
 * - subagents visible, no selection: those plus parentage
 * - selection active: all co-visible kinds among the neighborhood
 * Event links stay selection-scoped. Never invents affinity.
 */
export function selectDrawnLinks(
  world: SessionWorld,
  evidenceLinks: readonly SessionMapLink[],
  opts: {
    selected?: string | null;
    subagentsVisible: boolean;
    hiddenEdgeKinds?: ReadonlySet<MapEdgeKind>;
  },
): SessionMapLink[] {
  const nodeIds = worldNodeIdSet(world);
  const hidden = opts.hiddenEdgeKinds ?? new Set<MapEdgeKind>();
  // Population gate first — never draw an edge into a filtered-out endpoint.
  const coVisible = evidenceLinks.filter(
    (l) =>
      l.source !== l.target && nodeIds.has(l.source) && nodeIds.has(l.target),
  );
  let candidates: SessionMapLink[];

  if (opts.selected && nodeIds.has(opts.selected)) {
    const sel = opts.selected;
    candidates = coVisible.filter((l) => l.source === sel || l.target === sel);
  } else {
    candidates = coVisible.filter((l) => {
      if (l.kind === 'resumed_from' || l.kind === 'shared_artifact') return true;
      if (l.kind === 'parentage' && opts.subagentsVisible) return true;
      return false;
    });
  }

  return filterEvidenceLinks(candidates, hidden);
}

// ── Node paint priority (collision contract) ─────────────────────────────────
/**
 * Per-cell paint priority when multiple nodes collapse into one glyph cell.
 *
 * Contract (higher wins; rare-over-common so dense classes never erase sparse):
 *   selected > hovered > operator(primary) > subagent > harness > experiment > unknown
 *
 * Links always paint under nodes (never overwrite a node glyph cell).
 * Stack size > MAP_STACK_BRIGHTEN_AT slightly lightens the winner via lighten().
 */
export const MAP_STACK_BRIGHTEN_AT = 4;

export function mapNodePaintPriority(
  origin: MapOrigin,
  agent: MapAgent,
  opts?: { selected?: boolean; hovered?: boolean },
): number {
  if (opts?.selected) return 100;
  if (opts?.hovered) return 90;
  if (agent === 'subagent') return 70;
  if (origin === 'operator') return 80;
  if (origin === 'harness') return 60;
  if (origin === 'experiment') return 50;
  return 40; // unknown
}

export interface MapPaintCandidate {
  id: string;
  cx: number;
  cy: number;
  origin: MapOrigin;
  agent: MapAgent;
  glyph: string;
  fg: RGB;
  selected?: boolean;
  hovered?: boolean;
}

export interface MapPaintWinner {
  id: string;
  cx: number;
  cy: number;
  glyph: string;
  fg: RGB;
  /** How many nodes collapsed into this cell (1 = alone). */
  stack: number;
}

/**
 * Resolve one winner per cell by mapNodePaintPriority. Deterministic on ties (id asc).
 * Applies stack brighten when stack ≥ MAP_STACK_BRIGHTEN_AT (existing lighten channel).
 */
export function resolveMapCellWinners(
  candidates: readonly MapPaintCandidate[],
  opts?: { cols?: number; rows?: number },
): MapPaintWinner[] {
  const cols = opts?.cols;
  const rows = opts?.rows;
  type Acc = MapPaintCandidate & { priority: number; stack: number };
  const best = new Map<string, Acc>();
  for (const c of candidates) {
    if (cols != null && (c.cx < 0 || c.cx >= cols)) continue;
    if (rows != null && (c.cy < 0 || c.cy >= rows)) continue;
    const key = `${c.cx},${c.cy}`;
    const priority = mapNodePaintPriority(c.origin, c.agent, {
      selected: c.selected,
      hovered: c.hovered,
    });
    const prev = best.get(key);
    if (!prev) {
      best.set(key, { ...c, priority, stack: 1 });
      continue;
    }
    prev.stack += 1;
    if (
      priority > prev.priority ||
      (priority === prev.priority && c.id.localeCompare(prev.id) < 0)
    ) {
      best.set(key, { ...c, priority, stack: prev.stack });
    }
  }
  const out: MapPaintWinner[] = [];
  for (const w of best.values()) {
    let fg = w.fg;
    if (w.stack >= MAP_STACK_BRIGHTEN_AT) {
      // Density cue within the existing lightness channel — no new palette.
      fg = lighten(fg, Math.min(0.22, 0.06 * (w.stack - MAP_STACK_BRIGHTEN_AT + 1)));
    }
    out.push({
      id: w.id,
      cx: w.cx,
      cy: w.cy,
      glyph: w.glyph,
      fg,
      stack: w.stack,
    });
  }
  return out;
}

/** Solid straight edge (everything except faint shared-artifact). */
export function isSolidLinkKind(kind: SessionMapLink['kind']): boolean {
  return kind !== 'shared_artifact';
}

/** Split drawn edges into solid (resumed/parentage/event) vs faint (shared_artifact). */
export function partitionDrawnLinks(links: readonly SessionMapLink[]): {
  solid: SessionMapLink[];
  faint: SessionMapLink[];
} {
  const solid: SessionMapLink[] = [];
  const faint: SessionMapLink[] = [];
  for (const l of links) {
    if (isSolidLinkKind(l.kind)) solid.push(l);
    else faint.push(l);
  }
  return { solid, faint };
}

/**
 * Neighbor session ids for focus dimming: selected's co-visible evidence endpoints
 * that sit in the current world (both parentage and event from the loaded links).
 */
export function neighborhoodIds(
  selected: string | null | undefined,
  world: SessionWorld,
  evidenceLinks: readonly SessionMapLink[],
): Set<string> {
  const out = new Set<string>();
  if (!selected) return out;
  const nodeIds = new Set(world.nodes.map((n) => n.id));
  if (!nodeIds.has(selected)) return out;
  for (const l of evidenceLinks) {
    if (l.source === selected && nodeIds.has(l.target)) out.add(l.target);
    else if (l.target === selected && nodeIds.has(l.source)) out.add(l.source);
  }
  return out;
}

/**
 * Project a SessionWorld into GraphData + WorldNode[] for `renderView`.
 * Evidence links are co-visible only (both endpoints in the world node set).
 * No affinity fabrication — empty evidence → empty links.
 * `linkCount` carries volume (turn-count mapping), not edge degree.
 */
export function sessionWorldToGraph(
  world: SessionWorld,
  evidenceLinks: readonly SessionMapLink[] = [],
): {
  graph: GraphData;
  worldNodes: WorldNode[];
} {
  const nodeIds = new Set(world.nodes.map((n) => n.id));
  const nodes: GraphNode[] = world.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    // Glyph: primary → ● (knowledge), subagent → ◇ (other) — existing NODE_GLYPH table.
    type: n.agent === 'subagent' ? 'other' : 'knowledge',
    kind: 'doc',
    group: n.groupKey,
    folder: n.groupKey,
    updated: n.endedAt,
    linkCount: volumeLinkCount(n.turnCount),
  }));
  const worldNodes: WorldNode[] = world.nodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    cluster: n.cluster,
  }));

  const links: GraphLink[] = [];
  for (const l of evidenceLinks) {
    if (!nodeIds.has(l.source) || !nodeIds.has(l.target)) continue;
    if (l.source === l.target) continue;
    links.push({ source: l.source, target: l.target });
  }

  return {
    graph: { nodes, links },
    worldNodes,
  };
}

/**
 * Filter evidence links by edge-kind visibility (render-time; never re-layouts).
 */
export function filterEvidenceLinks(
  links: readonly SessionMapLink[],
  hiddenEdgeKinds: ReadonlySet<MapEdgeKind>,
): SessionMapLink[] {
  if (hiddenEdgeKinds.size === 0) return [...links];
  return links.filter((l) => !hiddenEdgeKinds.has(l.kind));
}

/**
 * Build the map legend: edge kinds pinned first (parentage · event · resumed ·
 * shared artifact), then origin rows, then agent rows. Closed vocabulary ≤ 10.
 * Counts come from the full loaded session list / full sessionLinks fetch.
 * Never emits project-basename or session-folder labels.
 */
export function buildMapLegendRows(
  sessions: readonly SessionListRow[],
  evidenceLinks: readonly SessionMapLink[],
  allowedOrigins: ReadonlySet<MapOrigin>,
  allowedAgents: ReadonlySet<MapAgent>,
  hiddenEdgeKinds: ReadonlySet<MapEdgeKind>,
): LegendEntry[] {
  const originCounts: Record<MapOrigin, number> = {
    operator: 0,
    experiment: 0,
    harness: 0,
    unknown: 0,
  };
  const agentCounts: Record<MapAgent, number> = { primary: 0, subagent: 0 };
  for (const s of sessions) {
    originCounts[sessionOrigin(s)] += 1;
    agentCounts[sessionAgent(s)] += 1;
  }

  const edgeCounts: Record<MapEdgeKind, number> = {
    parentage: 0,
    event: 0,
    resumed_from: 0,
    shared_artifact: 0,
  };
  for (const l of evidenceLinks) {
    if (l.kind in edgeCounts) edgeCounts[l.kind as MapEdgeKind] += l.count;
  }

  const edgeColor: RGB = { r: 160, g: 168, b: 180 };
  const agentColor: RGB = { r: 140, g: 148, b: 160 };
  const rows: LegendEntry[] = [];

  // Edge kinds pinned first (indices 0–3).
  const edgeRows: { glyph: string; label: string; kind: MapEdgeKind }[] = [
    { glyph: '─', label: 'parentage', kind: 'parentage' },
    { glyph: '═', label: 'event links', kind: 'event' },
    { glyph: '→', label: 'resumed', kind: 'resumed_from' },
    { glyph: '┄', label: 'shared artifact', kind: 'shared_artifact' },
  ];
  for (const e of edgeRows) {
    rows.push({
      glyph: e.glyph,
      label: e.label,
      color: edgeColor,
      count: edgeCounts[e.kind],
      hidden: hiddenEdgeKinds.has(e.kind),
      depth: 0,
      expandable: false,
      expanded: false,
      partial: false,
    });
  }

  // Origins in fixed order; unknown only when count > 0.
  for (let i = 0; i < ORIGIN_ORDER.length; i++) {
    const origin = ORIGIN_ORDER[i]!;
    const count = originCounts[origin];
    if (origin === 'unknown' && count === 0) continue;
    rows.push({
      glyph: allowedOrigins.has(origin) ? '●' : '○',
      label: origin,
      color: clusterColor(i),
      count,
      hidden: !allowedOrigins.has(origin),
      depth: 0,
      expandable: false,
      expanded: false,
      partial: false,
    });
  }

  // Agent rows.
  for (const agent of AGENT_ORDER) {
    rows.push({
      glyph: agent === 'primary' ? '●' : '◇',
      label: agent,
      color: agentColor,
      count: agentCounts[agent],
      hidden: !allowedAgents.has(agent),
      depth: 0,
      expandable: false,
      expanded: false,
      partial: false,
    });
  }

  return rows.slice(0, LEGEND_MAX_ROWS);
}

/**
 * Char-frame text for one map legend row: `<glyph> label (count)`.
 * Same order/content the React fixed rows render (and H1/H2 assert).
 */
export function formatMapLegendLine(entry: {
  glyph: string;
  label: string;
  count: number;
}): string {
  return `${entry.glyph} ${entry.label} (${entry.count})`;
}

export type LegendToggle =
  | { kind: 'edge'; key: MapEdgeKind }
  | { kind: 'origin'; key: MapOrigin }
  | { kind: 'agent'; key: MapAgent };

/**
 * Map a legend row label to a toggle action for MapStage.
 * Edge / origin / agent only — never project basenames.
 */
export function legendToggleTarget(label: string): LegendToggle | null {
  if (label === 'parentage') return { kind: 'edge', key: 'parentage' };
  if (label === 'event links') return { kind: 'edge', key: 'event' };
  if (label === 'resumed') return { kind: 'edge', key: 'resumed_from' };
  if (label === 'shared artifact') return { kind: 'edge', key: 'shared_artifact' };
  if ((LEGEND_ORIGIN_LABELS as Set<string>).has(label)) {
    return { kind: 'origin', key: label as MapOrigin };
  }
  if ((LEGEND_AGENT_LABELS as Set<string>).has(label)) {
    return { kind: 'agent', key: label as MapAgent };
  }
  return null;
}

/**
 * Short filter summary for the status line (e.g. `op·prim`, `op+exp·prim+sub`).
 */
export function filtersShortLabel(
  origins: ReadonlySet<MapOrigin>,
  agents: ReadonlySet<MapAgent>,
): string {
  const oParts: string[] = [];
  if (origins.has('operator')) oParts.push('op');
  if (origins.has('experiment')) oParts.push('exp');
  if (origins.has('harness')) oParts.push('har');
  if (origins.has('unknown')) oParts.push('unk');
  const aParts: string[] = [];
  if (agents.has('primary')) aParts.push('prim');
  if (agents.has('subagent')) aParts.push('sub');
  const o = oParts.length > 0 ? oParts.join('+') : '∅';
  const a = aParts.length > 0 ? aParts.join('+') : '∅';
  return `${o}·${a}`;
}

/** Mode label for status copy (code keys stay density/cluster). */
export function modeStatusLabel(mode: MapMode): string {
  return mode === 'density' ? 'timeline' : 'structure';
}

/** Active lightness-channel name for the control line. */
export function lightnessStatusLabel(mode: MapLightness): string {
  return mode === 'error' ? 'error-density' : 'volume-halo';
}

/** Unified links vocabulary for status + load flash: `links {drawn}/{loaded}`. */
export function formatLinksStatus(drawn: number, loaded: number): string {
  return `links ${drawn}/${loaded}`;
}

/** Canvas body rows for graph glyphs — timeline reserves the bottom row as axis strip. */
export function mapCanvasBodyRows(canvasRows: number, mode: MapMode): number {
  const n = Math.max(0, Math.floor(canvasRows));
  if (n <= 0) return 0;
  if (mode === 'density' && n > 1) return n - 1;
  return n;
}

/**
 * Fit-clamp canvas rows from the residual stage host.
 * stageH is the MapStage host (includes panel title/borders + status + canvas).
 * baseChrome = panel title/borders (~3) + status/control lines (2).
 * legendRows — kept for API stability; map legend is a canvas OVERLAY and must
 * pass 0 so the canvas reclaims the full residual (no flex block under the blit).
 * Never returns a negative; 0 means the host cannot hold a canvas.
 */
export function budgetMapCanvasRows(
  stageH: number,
  legendRows: number = 0,
  baseChrome: number = 5,
): number {
  const h = Math.max(0, Math.floor(stageH));
  // Overlay legends consume no layout rows; ignore non-zero only for legacy callers.
  const legend = 0;
  void legendRows;
  const chrome = Math.max(0, Math.floor(baseChrome));
  return Math.max(0, h - chrome - legend);
}

// ── Map legend overlay (canvas blit; graph-view geometry) ─────────────────────
// Right-aligned top-right so it stays clear of the bottom axis strip. Draw and
// hit-test share mapLegendX0 + clampMapLegendEntries so a click never resolves
// to an undrawn row.

const MAP_LEGEND_FG: RGB = { r: 200, g: 206, b: 214 };

/** "label (count)" text width (glyph column excluded — matches graph-view row layout). */
function mapLegendText(e: { label: string; count: number }): string {
  return `${e.label} (${e.count})`;
}

/** Row print width: `[glyph]@0 ' '@1 [label (count)]@2+` → 2 + text. */
export function mapLegendRowWidth(e: { label: string; count: number }): number {
  return 2 + mapLegendText(e).length;
}

/** Width of the overlay block: widest row + one-cell right margin. */
export function mapLegendBlockWidth(entries: readonly { label: string; count: number }[]): number {
  return entries.reduce((m, e) => Math.max(m, mapLegendRowWidth(e)), 0) + 1;
}

/** Left column of the right-aligned overlay given canvas cols. */
export function mapLegendX0(
  entries: readonly { label: string; count: number }[],
  cols: number,
): number {
  return Math.max(0, cols - mapLegendBlockWidth(entries));
}

/**
 * Clamp overlay entries to the paintable canvas rows.
 * When reserveAxis is true (timeline mode), leave the last row for the axis strip.
 */
export function clampMapLegendEntries<T>(
  entries: readonly T[],
  canvasRows: number,
  opts?: { reserveAxis?: boolean; maxRows?: number },
): T[] {
  const maxCap = opts?.maxRows ?? LEGEND_MAX_ROWS;
  let room = Math.max(0, Math.floor(canvasRows));
  if (opts?.reserveAxis && room > 0) room -= 1;
  const n = Math.min(entries.length, maxCap, room);
  return entries.slice(0, n);
}

export type MapLegendHit = { kind: 'toggle'; label: string };

/**
 * Hit-test a cell against the drawn overlay. Geometry mirrors paintMapLegendOntoGrid:
 * right-aligned, top-down, clamped to drawn row count. Null = fall through to world.
 */
export function mapLegendHitAt(
  entries: readonly { label: string; count: number }[],
  cols: number,
  drawnRows: number,
  cellX: number,
  cellY: number,
): MapLegendHit | null {
  if (drawnRows <= 0 || entries.length === 0) return null;
  if (cellY < 0 || cellY >= drawnRows || cellY >= entries.length) return null;
  const visible = entries.slice(0, drawnRows);
  const x0 = mapLegendX0(visible, cols);
  if (cellX < x0 || cellX >= cols) return null;
  const e = visible[cellY];
  if (!e) return null;
  return { kind: 'toggle', label: e.label };
}

// ── Event ↔ canvas cell (shared draw/hit geometry) ───────────────────────────
// OpenTUI mouse events carry SCREEN-ABSOLUTE cell coords (the same space used
// for hit-grid dispatch and for setCell on the root buffer). The map paints a
// LOCAL grid then blits at (_screenX, _screenY). Every mouse path must convert
// event → local canvas cell with the SAME origin the blit used.

/** Screen-cell origin of the map canvas (from the renderable at paint time). */
export type MapCanvasOrigin = { x: number; y: number };

/**
 * Convert an OpenTUI mouse event (screen-absolute cells) into canvas-local
 * cell coordinates. Draw-space and hit-space both use this origin so they
 * cannot silently diverge.
 */
export function eventToCanvasCell(
  e: { x: number; y: number },
  origin: MapCanvasOrigin,
): { cellX: number; cellY: number } {
  return {
    cellX: Math.floor(e.x) - Math.floor(origin.x),
    cellY: Math.floor(e.y) - Math.floor(origin.y),
  };
}

/**
 * Event → canvas sub-pixel center (matches GraphView `cell*2+1` / `cell*4+2`
 * contract after the origin transform). Used for pan/zoom anchors.
 */
export function eventToCanvasSubpixel(
  e: { x: number; y: number },
  origin: MapCanvasOrigin,
): { x: number; y: number } {
  const { cellX, cellY } = eventToCanvasCell(e, origin);
  return { x: cellX * 2 + 1, y: cellY * 4 + 2 };
}

/**
 * Paint legend rows into a cell grid (local coords). Overwrites world glyphs under
 * the overlay block. Caller blits the grid with the screen-origin offset.
 */
export function paintMapLegendOntoGrid(
  cells: ({ char: string; fg: RGB; attr?: number } | null)[],
  gridCols: number,
  entries: readonly LegendEntry[],
  canvasCols: number,
  drawnRows: number,
): void {
  if (drawnRows <= 0 || entries.length === 0 || gridCols <= 0) return;
  const visible = entries.slice(0, drawnRows);
  const x0 = mapLegendX0(visible, canvasCols);
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!;
    const gc = e.hidden ? dim(e.color, 0.6) : e.color;
    const tc = e.hidden ? dim(MAP_LEGEND_FG, 0.55) : MAP_LEGEND_FG;
    const mark = e.hidden ? '○' : e.glyph;
    const put = (x: number, ch: string, c: RGB) => {
      if (x < 0 || x >= canvasCols || x >= gridCols) return;
      cells[i * gridCols + x] = { char: ch, fg: c };
    };
    put(x0, mark, gc);
    put(x0 + 1, ' ', tc);
    const text = mapLegendText(e);
    for (let j = 0; j < text.length; j++) put(x0 + 2 + j, text[j]!, tc);
  }
}

/** Minimum canvas rows to paint honestly: timeline needs body+axis (2), structure needs 1. */
export function minMapCanvasRows(mode: MapMode): number {
  return mode === 'density' ? 2 : 1;
}

/** True when the budgeted canvas cannot paint glyphs for the active mode. */
export function mapCanvasTooSmall(canvasRows: number, mode: MapMode): boolean {
  return Math.max(0, Math.floor(canvasRows)) < minMapCanvasRows(mode);
}

/**
 * Subpixel padding for fitViewport so short canvases keep a positive scale.
 * Default graph padding (4) zeroes the scale when bodyHeight ≤ 8 (2 cell rows).
 */
export function mapFitPadding(subpixelH: number, subpixelW: number): number {
  const h = Math.max(0, subpixelH);
  const w = Math.max(0, subpixelW);
  if (h < 8 || w < 8) return 1;
  if (h < 16 || w < 16) return 2;
  return 4;
}

/**
 * Nearest session glyph to a cell within subpixel d² ≤ 36 (GraphView contract).
 * cell center = cellX*2+1, cellY*4+2.
 */
export function hitTestSession(
  nodes: { id: string; x: number; y: number }[],
  cellX: number,
  cellY: number,
  maxD2 = 36,
): string | null {
  const sx = cellX * 2 + 1;
  const sy = cellY * 4 + 2;
  let best: string | null = null;
  let bestD = Infinity;
  for (const node of nodes) {
    const d = (node.x - sx) ** 2 + (node.y - sy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = node.id;
    }
  }
  return best && bestD <= maxD2 ? best : null;
}

/** True when a graph has zero links (no evidence edges projected). */
export function hasNoForceEdges(graph: GraphData): boolean {
  return !graph.links || graph.links.length === 0;
}

// ── Time axis (timeline mode) ────────────────────────────────────────────────

export type AxisGranularity = 'month' | 'week';

export interface AxisTick {
  /** World X matching buildTimelineWorld's time mapping. */
  worldX: number;
  /** Boundary instant (ms). */
  t: number;
  label: string;
  kind: AxisGranularity;
}

export interface AxisTickCell {
  cellX: number;
  label: string;
  kind: AxisGranularity;
}

/** Min/max startedAt of a population, in ms. Empty → zeros. */
export function populationTimeRange(
  nodes: readonly { startedAt: string }[],
): { minT: number; maxT: number; spanMs: number } {
  if (nodes.length === 0) return { minT: 0, maxT: 0, spanMs: 0 };
  let minT = Infinity;
  let maxT = -Infinity;
  for (const n of nodes) {
    const t = parseTs(n.startedAt);
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  if (!Number.isFinite(minT) || !Number.isFinite(maxT)) return { minT: 0, maxT: 0, spanMs: 0 };
  return { minT, maxT, spanMs: Math.max(0, maxT - minT) };
}

/** World X for a timestamp under the timeline mapping (no jitter). */
export function timeToWorldX(t: number, minT: number, maxT: number): number {
  const spanT = Math.max(1, maxT - minT);
  const u = (t - minT) / spanT;
  return (u - 0.5) * DENSITY_X_SPAN;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function utcMonthStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextUtcMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Monday 00:00 UTC of the week containing t. */
function utcWeekStart(t: number): number {
  const d = new Date(t);
  const day = d.getUTCDay(); // 0=Sun
  const sinceMon = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMon);
}

function nextUtcWeek(t: number): number {
  return utcWeekStart(t) + 7 * MS_DAY;
}

function monthLabel(t: number): string {
  return MONTH_MMM[new Date(t).getUTCMonth()] ?? '???';
}

function weekLabel(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Axis ticks for the visible population's time range.
 * Week boundaries when span < 60 days; month boundaries otherwise.
 */
export function deriveAxisTicks(minT: number, maxT: number): AxisTick[] {
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT < minT) return [];
  const spanMs = Math.max(0, maxT - minT);
  // Single-instant population: one label at center.
  if (spanMs === 0) {
    const kind: AxisGranularity = 'month';
    return [{ worldX: 0, t: minT, label: monthLabel(minT), kind }];
  }
  const kind: AxisGranularity = spanMs < AXIS_WEEK_THRESHOLD_MS ? 'week' : 'month';
  const ticks: AxisTick[] = [];
  if (kind === 'month') {
    let cur = utcMonthStart(minT);
    // Include the month that contains minT even if the boundary is before minT.
    if (cur < minT - MS_DAY) cur = nextUtcMonth(cur);
    // Walk from the month start at/before minT through maxT.
    cur = utcMonthStart(minT);
    const end = maxT + MS_DAY; // allow last boundary near max
    let guard = 0;
    while (cur <= end && guard++ < 240) {
      if (cur >= minT - MS_DAY && cur <= maxT + MS_DAY) {
        ticks.push({
          worldX: timeToWorldX(cur, minT, maxT),
          t: cur,
          label: monthLabel(cur),
          kind,
        });
      }
      cur = nextUtcMonth(cur);
    }
  } else {
    let cur = utcWeekStart(minT);
    const end = maxT + MS_DAY;
    let guard = 0;
    while (cur <= end && guard++ < 520) {
      if (cur >= minT - MS_DAY && cur <= maxT + MS_DAY) {
        ticks.push({
          worldX: timeToWorldX(cur, minT, maxT),
          t: cur,
          label: weekLabel(cur),
          kind,
        });
      }
      cur = nextUtcWeek(cur);
    }
  }
  // Deduplicate by label+worldX (single-month span may only yield one).
  if (ticks.length === 0) {
    ticks.push({
      worldX: 0,
      t: minT,
      label: kind === 'month' ? monthLabel(minT) : weekLabel(minT),
      kind,
    });
  }
  return ticks;
}

/**
 * Project world-space axis ticks through the current viewport into cell columns
 * on the graph body. Off-screen ticks are dropped; pan/zoom recomputes labels.
 */
export function projectAxisTicks(
  ticks: readonly AxisTick[],
  vp: Viewport,
  cols: number,
  bodyRows: number,
): AxisTickCell[] {
  if (cols <= 0 || bodyRows <= 0 || ticks.length === 0) return [];
  const width = cols * 2;
  const height = bodyRows * 4;
  const out: AxisTickCell[] = [];
  const seen = new Set<number>();
  for (const tick of ticks) {
    const s = worldToScreen({ x: tick.worldX, y: 0 }, vp, width, height);
    const cellX = Math.floor(s.x / 2);
    if (cellX < 0 || cellX >= cols) continue;
    if (seen.has(cellX)) continue;
    seen.add(cellX);
    out.push({ cellX, label: tick.label, kind: tick.kind });
  }
  return out;
}

/**
 * Full axis layout for timeline mode: derive ticks from population times, project
 * through the viewport. Empty when there are no nodes.
 */
export function layoutAxisStrip(
  nodes: readonly { startedAt: string }[],
  vp: Viewport,
  cols: number,
  bodyRows: number,
): { ticks: AxisTickCell[]; granularity: AxisGranularity | null; range: { minT: number; maxT: number; spanMs: number } } {
  const range = populationTimeRange(nodes);
  if (nodes.length === 0 || range.spanMs < 0) {
    return { ticks: [], granularity: null, range };
  }
  const derived = deriveAxisTicks(range.minT, range.maxT);
  const granularity = derived[0]?.kind ?? null;
  return {
    ticks: projectAxisTicks(derived, vp, cols, bodyRows),
    granularity,
    range,
  };
}

// ── Hover / selection readout ────────────────────────────────────────────────

/** Glanceable age from an ISO timestamp (`Xm ago` / `Xh ago` / `Xd ago`). */
export function formatSessionAge(iso: string | null | undefined, now = Date.now()): string {
  if (iso == null || iso === '') return '?';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '?';
  const ms = Math.max(0, now - ts);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Hover info line when no node is selected:
 * `◌ {title} · t:{n} · {age}`
 */
export function formatHoverReadout(
  node: {
    id: string;
    label: string;
    turnCount: number;
    endedAt?: string;
    startedAt?: string;
  },
  now = Date.now(),
): string {
  const title = displayLabel(node.label || node.id);
  const age = formatSessionAge(node.endedAt || node.startedAt || '', now);
  return `◌ ${title} · t:${node.turnCount} · ${age}`;
}

/**
 * Selection info fragment (appended after the status prefix):
 * `◉ {title} · turns {n} · {origin}`
 */
export function formatSelectionReadout(node: {
  label: string;
  turnCount: number;
  origin: string;
}): string {
  return `◉ ${displayLabel(node.label)} · turns ${node.turnCount} · ${node.origin}`;
}

// ── Zoom-tier labels ─────────────────────────────────────────────────────────

export interface ZoomLabelCandidate {
  id: string;
  turnCount: number;
  /** Session title or glyph label (displayLabel applied here). */
  label: string;
  /** Glyph cell coordinates. */
  cx: number;
  cy: number;
}

export interface ZoomLabelPlacement {
  id: string;
  text: string;
  /** First character cell (to the right of the glyph). */
  cx: number;
  cy: number;
}

/**
 * Top-K visible nodes by turn count at zoom ≥ ZOOM_TIER_MIN. Skips any label
 * whose cells collide with occupied cells or a previously placed label.
 */
export function selectZoomTierLabels(
  candidates: readonly ZoomLabelCandidate[],
  opts: {
    cols: number;
    rows: number;
    maxLabels?: number;
    occupied?: ReadonlySet<number>;
  },
): ZoomLabelPlacement[] {
  const cols = opts.cols;
  const rows = opts.rows;
  const max = opts.maxLabels ?? ZOOM_TIER_MAX_LABELS;
  if (cols <= 0 || rows <= 0 || max <= 0) return [];

  const occupied = new Set<number>(opts.occupied ?? []);
  const ranked = [...candidates]
    .filter((c) => c.cx >= 0 && c.cy >= 0 && c.cx < cols && c.cy < rows)
    .sort((a, b) => {
      const dt = b.turnCount - a.turnCount;
      return dt !== 0 ? dt : a.id.localeCompare(b.id);
    });

  const out: ZoomLabelPlacement[] = [];
  for (const c of ranked) {
    if (out.length >= max) break;
    const text = displayLabel(c.label);
    if (!text) continue;
    // Leading space matches renderView focus labels (` ${label}`).
    const chars = ` ${text}`;
    const cells: number[] = [];
    let collides = false;
    for (let i = 0; i < chars.length; i++) {
      const lx = c.cx + 1 + i;
      if (lx < 0 || lx >= cols) {
        collides = true;
        break;
      }
      const idx = c.cy * cols + lx;
      if (occupied.has(idx)) {
        collides = true;
        break;
      }
      cells.push(idx);
    }
    if (collides || cells.length === 0) continue;
    for (const idx of cells) occupied.add(idx);
    // Reserve the glyph cell too so a later label cannot overwrite it.
    occupied.add(c.cy * cols + c.cx);
    out.push({ id: c.id, text, cx: c.cx + 1, cy: c.cy });
  }
  return out;
}

// ── Error-density → attention tier ───────────────────────────────────────────

export type ErrorDensityTier = 0 | 1 | 2 | 3;

/**
 * Map session_annotations.error_density (tool_errors / max(1, turns), ≥0)
 * onto attention tiers 0–3 for attentionShade. Zero/absent → dormant.
 */
export function errorDensityTier(density: number): ErrorDensityTier {
  if (!Number.isFinite(density) || density <= 0) return 0;
  if (density < 0.05) return 1;
  if (density < 0.15) return 2;
  return 3;
}

/**
 * @deprecated Prefer population filters. Kept as a no-op compatibility shim
 * for any caller that still passes project hides — always returns undefined.
 */
export function hiddenIdsForProjects(
  _world: SessionWorld,
  _hiddenProjects: ReadonlySet<string>,
): Set<string> | undefined {
  return undefined;
}
