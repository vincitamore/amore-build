/**
 * Pure session → world mapper for the Sessions Map stage.
 *
 * One-house geometry: the map is the spatial read of one operator's session
 * record over time — not a multi-project affinity graph. Placement is O(n) /
 * O(n log n) only (never force). Links are evidence-only: parentage +
 * event_links from the query-service; never invented affinity.
 */
import type { SessionListRow, SessionMapLink } from './query-service';
import { displayLabel, type GraphData, type GraphLink, type GraphNode, type WorldNode } from '../render/graph';
import { clusterColor, type RGB } from '../render/color';
import type { LegendEntry } from '../graph-view/blit';
import { classifyCwd, type CwdOrigin } from './cwd-class';

/** Structure-invalidating map modes (reset viewport on change). */
export type MapMode = 'density' | 'cluster';

/** Edge-kind keys used by the map legend (evidence only). */
export type MapEdgeKind = 'parentage' | 'event';

/** Origin class used as population filter + hue axis. */
export type MapOrigin = CwdOrigin;

/** Agent class used as population filter + glyph. */
export type MapAgent = 'primary' | 'subagent';

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
export const LEGEND_EDGE_LABELS = new Set(['parentage', 'event links']);

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
const DENSITY_X_SPAN = 200;
/** Vertical span of the volume band stack in density mode. */
const DENSITY_Y_SPAN = 80;
/** Number of volume quantile bands on Y (density). */
const VOLUME_BANDS = 5;
/** Glyph label budget (matches GraphView displayLabel default). */
export const SESSION_GLYPH_LABEL_MAX = 18;

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
 * Evidence edges to draw under the current policy:
 * - default (no selection, subagents hidden): none
 * - subagents visible, no selection: parentage with both ends visible
 * - selection active: raw parentage + event among the neighborhood
 * Never invents affinity; always a subset of `evidenceLinks`.
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
  const nodeIds = new Set(world.nodes.map((n) => n.id));
  const hidden = opts.hiddenEdgeKinds ?? new Set<MapEdgeKind>();
  let candidates: SessionMapLink[];

  if (opts.selected && nodeIds.has(opts.selected)) {
    const sel = opts.selected;
    candidates = evidenceLinks.filter(
      (l) =>
        (l.source === sel || l.target === sel) &&
        nodeIds.has(l.source) &&
        nodeIds.has(l.target) &&
        l.source !== l.target,
    );
  } else if (opts.subagentsVisible) {
    candidates = evidenceLinks.filter(
      (l) =>
        l.kind === 'parentage' &&
        nodeIds.has(l.source) &&
        nodeIds.has(l.target) &&
        l.source !== l.target,
    );
  } else {
    candidates = [];
  }

  return filterEvidenceLinks(candidates, hidden);
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
 * Build the map legend: edge kinds pinned first, then origin rows, then agent
 * rows. Counts come from the full loaded session list / full links() fetch.
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

  let parentageCount = 0;
  let eventCount = 0;
  for (const l of evidenceLinks) {
    if (l.kind === 'parentage') parentageCount += l.count;
    else eventCount += l.count;
  }

  const edgeColor: RGB = { r: 160, g: 168, b: 180 };
  const agentColor: RGB = { r: 140, g: 148, b: 160 };
  const rows: LegendEntry[] = [];

  // Edge kinds pinned first (indices 0–1).
  rows.push({
    glyph: '─',
    label: 'parentage',
    color: edgeColor,
    count: parentageCount,
    hidden: hiddenEdgeKinds.has('parentage'),
    depth: 0,
    expandable: false,
    expanded: false,
    partial: false,
  });
  rows.push({
    glyph: '═',
    label: 'event links',
    color: edgeColor,
    count: eventCount,
    hidden: hiddenEdgeKinds.has('event'),
    depth: 0,
    expandable: false,
    expanded: false,
    partial: false,
  });

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

  return rows;
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
