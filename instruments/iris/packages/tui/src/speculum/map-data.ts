/**
 * Pure session → world mapper for the Sessions Map stage.
 *
 * Sessions are a RECORD (spatial read of activity), not a claimed affinity graph.
 * Placement is O(n) / O(n log n) only — never a force simulation, never fabricated links.
 */
import type { SessionListRow } from './query-service';
import type { GraphData, GraphNode, WorldNode } from '../render/graph';

/** Structure-invalidating map modes (reset viewport on change). */
export type MapMode = 'density' | 'cluster';

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

/** Frozen empty link list — the map never invents session-affinity edges. */
export const SESSION_MAP_LINKS: readonly { source: string; target: string }[] = Object.freeze([]);

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const ANCHOR_R = 100;
const CLUSTER_SPACING = 5;
const DENSITY_X_SPAN = 200;
const DENSITY_Y_STEP = 28;

/** Project path → stable short group key (basename; empty → `∅`). */
export function projectBasename(projectPath: string): string {
  const raw = (projectPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw) return '∅';
  const parts = raw.split('/').filter(Boolean);
  return parts[parts.length - 1] || '∅';
}

/** Short glyph label: last 8 of id (or whole id if shorter). */
export function sessionLabel(id: string): string {
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
      label: sessionLabel(s.id),
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
        label: sessionLabel(s.id),
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
 * Links are ALWAYS empty — no force-edge wiring.
 */
export function sessionWorldToGraph(world: SessionWorld): {
  graph: GraphData;
  worldNodes: WorldNode[];
} {
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
  return {
    graph: { nodes, links: [...SESSION_MAP_LINKS] },
    worldNodes,
  };
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

/** True when a graph has zero links (map invariant). */
export function hasNoForceEdges(graph: GraphData): boolean {
  return !graph.links || graph.links.length === 0;
}
