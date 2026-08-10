/**
 * Pure session → world mapper for the Sessions Map stage.
 *
 * Sessions are a RECORD (spatial read of activity), not a claimed affinity graph.
 * Placement is O(n) / O(n log n) only — never a force simulation.
 * Links are evidence-only: parentage + event_links projected from the query-service.
 */
import type { SessionListRow, SessionMapLink } from './query-service';
import { displayLabel, type GraphData, type GraphLink, type GraphNode, type WorldNode } from '../render/graph';
import { clusterColor, type RGB } from '../render/color';
import type { LegendEntry } from '../graph-view/blit';

/** Structure-invalidating map modes (reset viewport on change). */
export type MapMode = 'density' | 'cluster';

/** Edge-kind keys used by the map legend (evidence only). */
export type MapEdgeKind = 'parentage' | 'event';

export interface SessionWorldNode {
  id: string;
  label: string;
  /** Project basename and/or time bucket used for coloring + anchors. */
  groupKey: string;
  x: number;
  y: number;
  /** Index into SessionWorld.groupKeys (stable color channel). */
  cluster: number;
  projectPath: string;
  startedAt: string;
  endedAt: string;
  turnCount: number;
  eventCount: number;
}

export interface SessionWorld {
  mode: MapMode;
  nodes: SessionWorldNode[];
  /** Sorted unique group keys — cluster index is position here. */
  groupKeys: string[];
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
const DENSITY_Y_STEP = 28;
/** Glyph label budget (matches GraphView displayLabel default). */
export const SESSION_GLYPH_LABEL_MAX = 18;

/** Project path → stable short group key (basename; empty → `∅`). */
export function projectBasename(projectPath: string): string {
  const raw = (projectPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw) return '∅';
  const parts = raw.split('/').filter(Boolean);
  return parts[parts.length - 1] || '∅';
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
 * Build a session world for the chosen mode.
 * Deterministic: same sessions + mode → same coordinates (order-stable via id sort within groups).
 */
export function buildSessionWorld(
  sessions: SessionListRow[],
  mode: MapMode = 'cluster',
): SessionWorld {
  if (sessions.length === 0) {
    return { mode, nodes: [], groupKeys: [] };
  }

  // Stable group order: sorted basenames (not first-seen) so input order cannot recolor.
  const groupKeys = [
    ...new Set(sessions.map((s) => projectBasename(s.projectPath))),
  ].sort((a, b) => a.localeCompare(b));
  const groupIndex = new Map(groupKeys.map((k, i) => [k, i]));

  if (mode === 'density') {
    return { mode, nodes: densityLayout(sessions, groupKeys, groupIndex), groupKeys };
  }
  return { mode, nodes: clusterLayout(sessions, groupKeys, groupIndex), groupKeys };
}

/**
 * Density: project rows × time columns.
 * X = normalized start time across the corpus; Y = group index; micro-jitter avoids total stack.
 */
function densityLayout(
  sessions: SessionListRow[],
  groupKeys: string[],
  groupIndex: Map<string, number>,
): SessionWorldNode[] {
  const times = sessions.map((s) => parseTs(s.startedAt));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const spanT = Math.max(1, maxT - minT);
  const yMid = (groupKeys.length - 1) / 2;

  // Stable paint order: by startedAt then id.
  const ordered = [...sessions].sort((a, b) => {
    const dt = parseTs(a.startedAt) - parseTs(b.startedAt);
    return dt !== 0 ? dt : a.id.localeCompare(b.id);
  });

  return ordered.map((s) => {
    const groupKey = projectBasename(s.projectPath);
    const cluster = groupIndex.get(groupKey) ?? 0;
    const t = parseTs(s.startedAt);
    const u = (t - minT) / spanT;
    const jx = (stableUnit(s.id) - 0.5) * 4;
    const jy = (stableUnit(s.id + '|y') - 0.5) * 4;
    return {
      id: s.id,
      label: sessionLabel(s.id, s.title),
      groupKey,
      x: (u - 0.5) * DENSITY_X_SPAN + jx,
      y: (cluster - yMid) * DENSITY_Y_STEP + jy,
      cluster,
      projectPath: s.projectPath,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      turnCount: s.turnCount,
      eventCount: s.eventCount,
    };
  });
}

/**
 * Cluster: grid anchors per project group + phyllotaxis scatter within each group
 * (ranked by turnCount desc, then startedAt). Instant O(n log n), no force.
 */
function clusterLayout(
  sessions: SessionListRow[],
  groupKeys: string[],
  groupIndex: Map<string, number>,
): SessionWorldNode[] {
  const anchors = gridAnchors(groupKeys.length, ANCHOR_R);
  const byGroup = new Map<string, SessionListRow[]>();
  for (const s of sessions) {
    const k = projectBasename(s.projectPath);
    let list = byGroup.get(k);
    if (!list) byGroup.set(k, (list = []));
    list.push(s);
  }

  const out: SessionWorldNode[] = [];
  for (const key of groupKeys) {
    const cluster = groupIndex.get(key) ?? 0;
    const anchor = anchors[cluster] ?? { x: 0, y: 0 };
    const members = (byGroup.get(key) ?? []).slice().sort((a, b) => {
      const dt = b.turnCount - a.turnCount;
      if (dt !== 0) return dt;
      const ta = parseTs(b.startedAt) - parseTs(a.startedAt);
      return ta !== 0 ? ta : a.id.localeCompare(b.id);
    });
    members.forEach((s, i) => {
      const r = CLUSTER_SPACING * Math.sqrt(i);
      const theta = i * GOLDEN_ANGLE;
      out.push({
        id: s.id,
        label: sessionLabel(s.id, s.title),
        groupKey: key,
        x: anchor.x + r * Math.cos(theta),
        y: anchor.y + r * Math.sin(theta),
        cluster,
        projectPath: s.projectPath,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        turnCount: s.turnCount,
        eventCount: s.eventCount,
      });
    });
  }
  // Stable overall order by id for consumers that iterate without sorting.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Project a SessionWorld into GraphData + WorldNode[] for `renderView`.
 * Evidence links are co-visible only (both endpoints in the world node set).
 * No affinity fabrication — empty evidence → empty links.
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
    type: 'project',
    kind: 'doc',
    group: n.groupKey,
    folder: n.groupKey,
    updated: n.endedAt,
    linkCount: 0,
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
  // Degree for attention: recount from projected links.
  if (links.length > 0) {
    const deg = new Map<string, number>();
    for (const l of links) {
      deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
      deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
    }
    for (const n of nodes) n.linkCount = deg.get(n.id) ?? 0;
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
 * Session ids whose project group is hidden — feed to renderView.hiddenIds
 * so toggling skips draw/hit without re-running layout.
 */
export function hiddenIdsForProjects(
  world: SessionWorld,
  hiddenProjects: ReadonlySet<string>,
): Set<string> | undefined {
  if (hiddenProjects.size === 0) return undefined;
  const out = new Set<string>();
  for (const n of world.nodes) {
    if (hiddenProjects.has(n.groupKey)) out.add(n.id);
  }
  return out.size > 0 ? out : undefined;
}

/**
 * Build the map legend rows: project groups (clusterColor from group index) then
 * edge-kind rows. Swatches use the same clusterColor the nodes use — never a second palette.
 */
export function buildMapLegendRows(
  world: SessionWorld,
  evidenceLinks: readonly SessionMapLink[],
  hiddenProjects: ReadonlySet<string>,
  hiddenEdgeKinds: ReadonlySet<MapEdgeKind>,
): LegendEntry[] {
  const counts = new Map<string, number>();
  for (const n of world.nodes) {
    counts.set(n.groupKey, (counts.get(n.groupKey) ?? 0) + 1);
  }
  const rows: LegendEntry[] = [];
  for (let i = 0; i < world.groupKeys.length; i++) {
    const key = world.groupKeys[i]!;
    const color: RGB = clusterColor(i);
    rows.push({
      glyph: '●',
      label: key,
      color,
      count: counts.get(key) ?? 0,
      hidden: hiddenProjects.has(key),
      depth: 0,
      expandable: false,
      expanded: false,
      partial: false,
    });
  }

  let parentageCount = 0;
  let eventCount = 0;
  for (const l of evidenceLinks) {
    if (l.kind === 'parentage') parentageCount += l.count;
    else eventCount += l.count;
  }
  // Edge-kind rows share a neutral slate so they read as chrome, not project clusters.
  const edgeColor: RGB = { r: 160, g: 168, b: 180 };
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
  return rows;
}

/**
 * Map a legend row label to a toggle action for MapStage.
 * Project keys toggle projects; reserved edge labels toggle edge kinds.
 */
export function legendToggleTarget(
  label: string,
): { kind: 'project'; key: string } | { kind: 'edge'; key: MapEdgeKind } | null {
  if (label === 'parentage') return { kind: 'edge', key: 'parentage' };
  if (label === 'event links') return { kind: 'edge', key: 'event' };
  if (!label) return null;
  return { kind: 'project', key: label };
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
