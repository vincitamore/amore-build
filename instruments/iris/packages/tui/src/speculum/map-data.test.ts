import { describe, expect, test } from 'bun:test';
import type { SessionListRow, SessionMapLink } from './query-service';
import {
  AGENT_ORDER,
  AXIS_WEEK_THRESHOLD_MS,
  buildMapLegendRows,
  buildSessionWorld,
  buildStructureWorld,
  buildTimelineWorld,
  DEFAULT_ALLOWED_AGENTS,
  DEFAULT_ALLOWED_ORIGINS,
  deriveAxisTicks,
  errorDensityTier,
  filterEvidenceLinks,
  filterSessionsByPopulation,
  filtersShortLabel,
  formatHoverReadout,
  formatLinksStatus,
  formatMapLegendLine,
  formatSelectionReadout,
  formatSessionAge,
  gridAnchors,
  hasNoForceEdges,
  hitTestSession,
  layoutAxisStrip,
  LEGEND_AGENT_LABELS,
  LEGEND_EDGE_LABELS,
  LEGEND_MAX_ROWS,
  LEGEND_ORIGIN_LABELS,
  legendToggleTarget,
  lightnessStatusLabel,
  budgetMapCanvasRows,
  clampMapLegendEntries,
  countCoVisibleLinks,
  eventToCanvasCell,
  eventToCanvasSubpixel,
  mapCanvasBodyRows,
  mapCanvasTooSmall,
  mapFitPadding,
  mapLegendBlockWidth,
  mapLegendHitAt,
  mapLegendRowWidth,
  mapLegendX0,
  mapNodePaintPriority,
  minMapCanvasRows,
  paintMapLegendOntoGrid,
  resolveMapCellWinners,
  worldNodeIdSet,
  modeStatusLabel,
  neighborhoodIds,
  ORIGIN_ORDER,
  partitionDrawnLinks,
  projectAxisTicks,
  projectBasename,
  selectDrawnLinks,
  selectZoomTierLabels,
  sessionAgent,
  sessionLabel,
  sessionOrigin,
  sessionWorldToGraph,
  SESSION_MAP_LINKS,
  stableUnit,
  timeToWorldX,
  volumeLinkCount,
  ZOOM_TIER_MAX_LABELS,
  type MapEdgeKind,
  type MapMode,
  type MapOrigin,
  type PopulationFilters,
} from './map-data';
import { fitViewport } from '../render/viewport';

function row(partial: Partial<SessionListRow> & { id: string }): SessionListRow {
  return {
    id: partial.id,
    projectPath: partial.projectPath ?? 'C:\\Users\\AlexMoyer\\Documents\\amore',
    agent: partial.agent ?? 'primary',
    parentSession: partial.parentSession ?? null,
    modelId: partial.modelId ?? null,
    startedAt: partial.startedAt ?? '2026-06-01T12:00:00.000Z',
    endedAt: partial.endedAt ?? '2026-06-01T13:00:00.000Z',
    turnCount: partial.turnCount ?? 1,
    userMsgCount: partial.userMsgCount ?? 1,
    toolCallCount: partial.toolCallCount ?? 0,
    toolErrorCount: partial.toolErrorCount ?? 0,
    eventCount: partial.eventCount ?? 1,
    title: partial.title ?? '',
  };
}

const OP = 'C:\\Users\\AlexMoyer\\Documents\\amore';
const EXP = 'C:\\Users\\AlexMoyer\\AppData\\Local\\Temp\\arcus-identity-study\\A-sen-01-r1-Fz7FoM';
const HAR = '/tmp/chat-mode-build-refuse-1';

const mixed: SessionListRow[] = [
  row({ id: 'op-p1', projectPath: OP, agent: 'primary', startedAt: '2026-01-01T00:00:00.000Z', turnCount: 10, title: 'Operator Deep Forge' }),
  row({ id: 'op-p2', projectPath: OP, agent: 'primary', startedAt: '2026-06-01T00:00:00.000Z', turnCount: 40, title: 'Operator Mid' }),
  row({ id: 'op-s1', projectPath: OP, agent: 'subagent', parentSession: 'op-p1', startedAt: '2026-01-01T01:00:00.000Z', turnCount: 5, title: 'Child of Forge' }),
  row({
    id: 'exp-p1',
    projectPath: EXP,
    agent: 'primary',
    startedAt: '2026-03-01T00:00:00.000Z',
    turnCount: 3,
    title: 'Study Arm',
  }),
  row({ id: 'har-p1', projectPath: HAR, agent: 'primary', startedAt: '2026-02-01T00:00:00.000Z', turnCount: 1 }),
];

const defaultFilters: PopulationFilters = {
  origins: DEFAULT_ALLOWED_ORIGINS,
  agents: DEFAULT_ALLOWED_AGENTS,
};

describe('projectBasename / labels / origin', () => {
  test('basename from posix and windows paths', () => {
    expect(projectBasename('/home/u/proj/iris')).toBe('iris');
    expect(projectBasename('C:\\Users\\x\\proj\\iris')).toBe('iris');
    expect(projectBasename('')).toBe('∅');
    expect(projectBasename('/')).toBe('∅');
  });

  test('sessionOrigin classifies operator / experiment / harness', () => {
    expect(sessionOrigin(row({ id: 'a', projectPath: OP }))).toBe('operator');
    expect(sessionOrigin(row({ id: 'b', projectPath: EXP }))).toBe('experiment');
    expect(sessionOrigin(row({ id: 'c', projectPath: HAR }))).toBe('harness');
  });

  test('sessionAgent normalizes', () => {
    expect(sessionAgent(row({ id: 'a', agent: 'primary' }))).toBe('primary');
    expect(sessionAgent(row({ id: 'b', agent: 'subagent' }))).toBe('subagent');
    expect(sessionAgent(row({ id: 'c', agent: 'other' }))).toBe('primary');
  });

  test('sessionLabel falls back to id suffix when title empty', () => {
    expect(sessionLabel('ab')).toBe('ab');
    expect(sessionLabel('1234567890abcdef')).toBe('90abcdef');
    expect(sessionLabel('1234567890abcdef', '')).toBe('90abcdef');
    expect(sessionLabel('1234567890abcdef', '   ')).toBe('90abcdef');
  });

  test('sessionLabel prefers title via displayLabel (head-slice doctrine)', () => {
    expect(sessionLabel('uuid-long-enough', 'KB Link Density Report')).toBe('KB Link Density Re');
    const a = sessionLabel('id-a', 'Pipeline: dream-2026-02-17T09-31-56-dream-digest');
    const b = sessionLabel('id-b', 'Pipeline: dream-2026-02-17T12-42-09-self-orient');
    expect(a).not.toBe(b);
    expect(a.startsWith('dream-digest')).toBe(true);
    expect(b.startsWith('self-orient')).toBe(true);
  });

  test('stableUnit is deterministic in [0,1)', () => {
    const a = stableUnit('sess-1');
    const b = stableUnit('sess-1');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(stableUnit('sess-1')).not.toBe(stableUnit('sess-2'));
  });

  test('volumeLinkCount is deterministic and floors log1p*4', () => {
    expect(volumeLinkCount(0)).toBe(0);
    expect(volumeLinkCount(1)).toBe(Math.floor(Math.round(Math.log1p(1) * 4)));
    expect(volumeLinkCount(100)).toBe(Math.floor(Math.round(Math.log1p(100) * 4)));
    expect(volumeLinkCount(100)).toBe(volumeLinkCount(100));
  });
});

describe('population filters (§7.4 default population)', () => {
  test('default filters keep operator∩primary only', () => {
    const vis = filterSessionsByPopulation(mixed, defaultFilters);
    expect(vis.map((s) => s.id).sort()).toEqual(['op-p1', 'op-p2']);
  });

  test('default world node count equals operator∩primary', () => {
    const w = buildSessionWorld(mixed, 'density', defaultFilters);
    expect(w.nodes).toHaveLength(2);
    expect(w.nodes.every((n) => n.origin === 'operator' && n.agent === 'primary')).toBe(true);
  });

  test('enabling experiment adds experiment primaries', () => {
    const w = buildSessionWorld(mixed, 'density', {
      origins: new Set<MapOrigin>(['operator', 'experiment']),
      agents: DEFAULT_ALLOWED_AGENTS,
    });
    expect(w.nodes.map((n) => n.id).sort()).toEqual(['exp-p1', 'op-p1', 'op-p2']);
  });
});

describe('buildSessionWorld / timeline / structure', () => {
  test('empty input → empty world', () => {
    for (const mode of ['density', 'cluster'] as MapMode[]) {
      const w = buildSessionWorld([], mode, defaultFilters);
      expect(w.nodes).toEqual([]);
      expect(w.groupKeys).toEqual([]);
      expect(w.mode).toBe(mode);
    }
  });

  test('one session lands at a finite anchor', () => {
    const w = buildSessionWorld([row({ id: 'only', projectPath: OP })], 'cluster', defaultFilters);
    expect(w.nodes).toHaveLength(1);
    expect(Number.isFinite(w.nodes[0]!.x)).toBe(true);
    expect(Number.isFinite(w.nodes[0]!.y)).toBe(true);
    expect(w.nodes[0]!.groupKey).toBe('operator');
    expect(w.nodes[0]!.cluster).toBe(0);
  });

  test('title becomes glyph label', () => {
    const w = buildSessionWorld(
      [row({ id: 'sess-long-id-abcdef01', projectPath: OP, title: 'Repeat Previous Single Word' })],
      'cluster',
      defaultFilters,
    );
    expect(w.nodes[0]!.label).toBe(
      sessionLabel('sess-long-id-abcdef01', 'Repeat Previous Single Word'),
    );
  });

  test('determinism: same input → same world (order-invariant)', () => {
    const a = [
      row({ id: 's2', projectPath: OP, startedAt: '2026-06-02T00:00:00.000Z', turnCount: 5 }),
      row({ id: 's1', projectPath: OP, startedAt: '2026-06-01T00:00:00.000Z', turnCount: 2 }),
      row({ id: 's3', projectPath: OP, startedAt: '2026-06-03T00:00:00.000Z', turnCount: 9 }),
    ];
    const b = [a[2]!, a[0]!, a[1]!];
    for (const mode of ['density', 'cluster'] as MapMode[]) {
      const wa = buildSessionWorld(a, mode, defaultFilters);
      const wb = buildSessionWorld(b, mode, defaultFilters);
      expect(wa.groupKeys).toEqual(wb.groupKeys);
      const byIdA = new Map(wa.nodes.map((n) => [n.id, n]));
      const byIdB = new Map(wb.nodes.map((n) => [n.id, n]));
      for (const id of ['s1', 's2', 's3']) {
        const na = byIdA.get(id)!;
        const nb = byIdB.get(id)!;
        expect(na.x).toBe(nb.x);
        expect(na.y).toBe(nb.y);
        expect(na.cluster).toBe(nb.cluster);
        expect(na.groupKey).toBe(nb.groupKey);
      }
    }
  });

  test('§7.5 timeline order: X monotonic with startedAt when jitter disabled', () => {
    const sessions = [
      row({ id: 'early', projectPath: OP, startedAt: '2026-01-01T00:00:00.000Z', turnCount: 1 }),
      row({ id: 'mid', projectPath: OP, startedAt: '2026-06-01T00:00:00.000Z', turnCount: 50 }),
      row({ id: 'late', projectPath: OP, startedAt: '2026-12-01T00:00:00.000Z', turnCount: 10 }),
    ];
    const w = buildTimelineWorld(sessions, { disableJitter: true });
    const byId = new Map(w.nodes.map((n) => [n.id, n]));
    expect(byId.get('early')!.x).toBeLessThan(byId.get('mid')!.x);
    expect(byId.get('mid')!.x).toBeLessThan(byId.get('late')!.x);
    // Sorting by x matches sorting by startedAt.
    const byX = [...w.nodes].sort((a, b) => a.x - b.x).map((n) => n.id);
    expect(byX).toEqual(['early', 'mid', 'late']);
  });

  test('density uses volume bands on Y, not project lanes', () => {
    const w = buildTimelineWorld(
      [
        row({ id: 'low', projectPath: OP, turnCount: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
        row({ id: 'high', projectPath: OP, turnCount: 100, startedAt: '2026-01-02T00:00:00.000Z' }),
      ],
      { disableJitter: true },
    );
    const low = w.nodes.find((n) => n.id === 'low')!;
    const high = w.nodes.find((n) => n.id === 'high')!;
    // Higher volume → higher band index → larger Y (bands increase with rank).
    expect(high.y).toBeGreaterThan(low.y);
    // Same origin → same groupKey / cluster.
    expect(low.groupKey).toBe('operator');
    expect(high.groupKey).toBe('operator');
    expect(low.cluster).toBe(high.cluster);
  });

  test('§7.6 structure parentage: child nearer its parent than a far primary', () => {
    const sessions = [
      row({ id: 'parent', projectPath: OP, agent: 'primary', startedAt: '2026-06-01T00:00:00.000Z', turnCount: 20 }),
      row({
        id: 'child',
        projectPath: OP,
        agent: 'subagent',
        parentSession: 'parent',
        startedAt: '2026-06-01T01:00:00.000Z',
        turnCount: 5,
      }),
      row({ id: 'far', projectPath: OP, agent: 'primary', startedAt: '2026-01-01T00:00:00.000Z', turnCount: 3 }),
    ];
    const w = buildStructureWorld(sessions);
    const parent = w.nodes.find((n) => n.id === 'parent')!;
    const child = w.nodes.find((n) => n.id === 'child')!;
    const far = w.nodes.find((n) => n.id === 'far')!;
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y);
    expect(dist(child, parent)).toBeLessThan(dist(child, far));
  });

  test('orphans with filtered-out parent still place when subagents allowed', () => {
    const sessions = [
      row({ id: 'op', projectPath: OP, agent: 'primary' }),
      row({
        id: 'orphan',
        projectPath: OP,
        agent: 'subagent',
        parentSession: 'missing-parent',
      }),
    ];
    const w = buildSessionWorld(sessions, 'cluster', {
      origins: DEFAULT_ALLOWED_ORIGINS,
      agents: new Set(['primary', 'subagent']),
    });
    expect(w.nodes.some((n) => n.id === 'orphan')).toBe(true);
  });
});

describe('sessionWorldToGraph / evidence / edge honesty (§7.7–§7.9)', () => {
  test('SESSION_MAP_LINKS is empty and frozen (no invented affinity default)', () => {
    expect(SESSION_MAP_LINKS).toHaveLength(0);
    expect(Object.isFrozen(SESSION_MAP_LINKS)).toBe(true);
  });

  test('graph projection without evidence → empty links', () => {
    const w = buildSessionWorld(
      [row({ id: 's1', projectPath: OP }), row({ id: 's2', projectPath: OP })],
      'cluster',
      defaultFilters,
    );
    const { graph, worldNodes } = sessionWorldToGraph(w);
    expect(graph.links).toHaveLength(0);
    expect(hasNoForceEdges(graph)).toBe(true);
    expect(graph.nodes).toHaveLength(2);
    expect(worldNodes).toHaveLength(2);
  });

  test('§7.8 no fabricated affinity: same-project sessions without links produce no edge', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'a', projectPath: OP, turnCount: 10 }),
        row({ id: 'b', projectPath: OP, turnCount: 20 }),
      ],
      'density',
      defaultFilters,
    );
    const { graph } = sessionWorldToGraph(w, []);
    expect(graph.links).toHaveLength(0);
  });

  test('projects co-visible evidence links; drops endpoints outside the world', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'parent', projectPath: OP }),
        row({ id: 'child', projectPath: OP, agent: 'subagent', parentSession: 'parent' }),
        row({ id: 'other', projectPath: OP }),
      ],
      'cluster',
      { origins: DEFAULT_ALLOWED_ORIGINS, agents: new Set(['primary', 'subagent']) },
    );
    const evidence: SessionMapLink[] = [
      { source: 'child', target: 'parent', kind: 'parentage', count: 1 },
      { source: 'parent', target: 'other', kind: 'event', count: 3 },
      { source: 'child', target: 'missing-out-of-set', kind: 'event', count: 1 },
    ];
    const { graph } = sessionWorldToGraph(w, evidence);
    expect(graph.links).toHaveLength(2);
    expect(graph.links).toContainEqual({ source: 'child', target: 'parent' });
    expect(graph.links).toContainEqual({ source: 'parent', target: 'other' });
  });

  test('linkCount carries volume mapping, not edge degree', () => {
    const w = buildSessionWorld(
      [row({ id: 'heavy', projectPath: OP, turnCount: 100 })],
      'density',
      defaultFilters,
    );
    const { graph } = sessionWorldToGraph(w, []);
    expect(graph.nodes[0]!.linkCount).toBe(volumeLinkCount(100));
  });

  test('glyph types: primary knowledge (●), subagent other (◇)', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'p', projectPath: OP, agent: 'primary' }),
        row({ id: 's', projectPath: OP, agent: 'subagent', parentSession: 'p' }),
      ],
      'cluster',
      { origins: DEFAULT_ALLOWED_ORIGINS, agents: new Set(['primary', 'subagent']) },
    );
    const { graph } = sessionWorldToGraph(w);
    expect(graph.nodes.find((n) => n.id === 'p')!.type).toBe('knowledge');
    expect(graph.nodes.find((n) => n.id === 's')!.type).toBe('other');
  });

  test('countCoVisibleLinks / selectDrawnLinks: both endpoints must be in world', () => {
    const sessions = [
      row({ id: 'op-a', projectPath: OP, agent: 'primary' }),
      row({ id: 'op-b', projectPath: OP, agent: 'primary' }),
      row({ id: 'exp-a', projectPath: EXP, agent: 'primary' }),
      row({ id: 'exp-b', projectPath: EXP, agent: 'primary' }),
    ];
    const links: SessionMapLink[] = [
      { source: 'op-a', target: 'op-b', kind: 'shared_artifact', count: 1 },
      { source: 'op-a', target: 'exp-a', kind: 'shared_artifact', count: 1 },
      { source: 'exp-a', target: 'exp-b', kind: 'shared_artifact', count: 1 },
      { source: 'op-a', target: 'op-b', kind: 'resumed_from', count: 1 },
    ];
    const opWorld = buildSessionWorld(sessions, 'density', defaultFilters);
    const opIds = worldNodeIdSet(opWorld);
    expect(opIds.has('exp-a')).toBe(false);
    // Loaded denominator drops when experiments leave the population.
    expect(countCoVisibleLinks(links, opIds)).toBe(2); // op-a↔op-b shared + resumed
    const drawn = selectDrawnLinks(opWorld, links, { subagentsVisible: false });
    expect(drawn.every((l) => opIds.has(l.source) && opIds.has(l.target))).toBe(true);
    expect(drawn.some((l) => l.source === 'exp-a' || l.target === 'exp-a')).toBe(false);
    expect(drawn).toHaveLength(2);

    const allWorld = buildSessionWorld(sessions, 'density', {
      origins: new Set(['operator', 'experiment']),
      agents: DEFAULT_ALLOWED_AGENTS,
    });
    expect(countCoVisibleLinks(links, worldNodeIdSet(allWorld))).toBe(4);
    expect(
      selectDrawnLinks(allWorld, links, { subagentsVisible: false }).length,
    ).toBe(4);
  });

  test('mapNodePaintPriority: rare-over-common contract', () => {
    expect(mapNodePaintPriority('operator', 'primary', { selected: true })).toBeGreaterThan(
      mapNodePaintPriority('operator', 'primary'),
    );
    expect(mapNodePaintPriority('operator', 'primary')).toBeGreaterThan(
      mapNodePaintPriority('operator', 'subagent'),
    );
    expect(mapNodePaintPriority('operator', 'subagent')).toBeGreaterThan(
      mapNodePaintPriority('harness', 'primary'),
    );
    expect(mapNodePaintPriority('harness', 'primary')).toBeGreaterThan(
      mapNodePaintPriority('experiment', 'primary'),
    );
  });

  test('resolveMapCellWinners: operator wins cell over experiment stack', () => {
    const winners = resolveMapCellWinners(
      [
        {
          id: 'e1',
          cx: 5,
          cy: 3,
          origin: 'experiment',
          agent: 'primary',
          glyph: '●',
          fg: { r: 100, g: 100, b: 100 },
        },
        {
          id: 'e2',
          cx: 5,
          cy: 3,
          origin: 'experiment',
          agent: 'primary',
          glyph: '●',
          fg: { r: 100, g: 100, b: 100 },
        },
        {
          id: 'op',
          cx: 5,
          cy: 3,
          origin: 'operator',
          agent: 'primary',
          glyph: '●',
          fg: { r: 200, g: 50, b: 50 },
        },
        {
          id: 'sub',
          cx: 5,
          cy: 3,
          origin: 'operator',
          agent: 'subagent',
          glyph: '◇',
          fg: { r: 50, g: 200, b: 50 },
        },
      ],
      { cols: 20, rows: 10 },
    );
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe('op'); // operator primary beats subagent + experiments
    expect(winners[0]!.stack).toBe(4);
  });

  test('selectDrawnLinks: default draws resumed/shared only; parentage when subagents on', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'parent', projectPath: OP }),
        row({ id: 'child', projectPath: OP, agent: 'subagent', parentSession: 'parent' }),
        row({ id: 'peer', projectPath: OP }),
      ],
      'cluster',
      { origins: DEFAULT_ALLOWED_ORIGINS, agents: new Set(['primary', 'subagent']) },
    );
    const evidence: SessionMapLink[] = [
      { source: 'child', target: 'parent', kind: 'parentage', count: 1 },
      { source: 'parent', target: 'child', kind: 'event', count: 2 },
      { source: 'parent', target: 'peer', kind: 'resumed_from', count: 1 },
      { source: 'peer', target: 'parent', kind: 'shared_artifact', count: 1 },
    ];
    const def = selectDrawnLinks(w, evidence, { subagentsVisible: false });
    expect(def.map((l) => l.kind).sort()).toEqual(['resumed_from', 'shared_artifact']);
    expect(def.every((l) => l.kind !== 'parentage' && l.kind !== 'event')).toBe(true);
    const withSub = selectDrawnLinks(w, evidence, { subagentsVisible: true });
    expect(withSub.some((l) => l.kind === 'parentage')).toBe(true);
    expect(withSub.some((l) => l.kind === 'resumed_from')).toBe(true);
    expect(withSub.some((l) => l.kind === 'event')).toBe(false);
  });

  test('selectDrawnLinks: focus neighborhood includes both edge kinds', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'parent', projectPath: OP }),
        row({ id: 'child', projectPath: OP, agent: 'subagent', parentSession: 'parent' }),
        row({ id: 'peer', projectPath: OP }),
      ],
      'cluster',
      { origins: DEFAULT_ALLOWED_ORIGINS, agents: new Set(['primary', 'subagent']) },
    );
    const evidence: SessionMapLink[] = [
      { source: 'child', target: 'parent', kind: 'parentage', count: 1 },
      { source: 'parent', target: 'peer', kind: 'event', count: 1 },
    ];
    const drawn = selectDrawnLinks(w, evidence, { selected: 'parent', subagentsVisible: false });
    expect(drawn).toHaveLength(2);
  });

  test('§7.7 edge honesty: every drawn edge ∈ links() after kind filter', () => {
    const w = buildSessionWorld(
      [row({ id: 'a', projectPath: OP }), row({ id: 'b', projectPath: OP })],
      'density',
      defaultFilters,
    );
    const evidence: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'event', count: 1 },
    ];
    const drawn = selectDrawnLinks(w, evidence, {
      selected: 'a',
      subagentsVisible: false,
      hiddenEdgeKinds: new Set(['event']),
    });
    expect(drawn).toHaveLength(0);
    expect(selectDrawnLinks(w, [], { selected: 'a', subagentsVisible: true })).toHaveLength(0);
  });

  test('§7.9 hide edge without reflow: toggling edge kind does not change node coords', () => {
    const sessions = [
      row({ id: 'a', projectPath: OP, startedAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'b', projectPath: OP, startedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const w1 = buildSessionWorld(sessions, 'density', defaultFilters);
    const w2 = buildSessionWorld(sessions, 'density', defaultFilters);
    // Edge kind is render-time only — worlds are identical regardless of hiddenEdgeKinds.
    expect(w1.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))).toEqual(
      w2.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
    );
    const evidence: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'parentage', count: 1 },
    ];
    const d1 = selectDrawnLinks(w1, evidence, { selected: 'a', subagentsVisible: false });
    const d2 = selectDrawnLinks(w1, evidence, {
      selected: 'a',
      subagentsVisible: false,
      hiddenEdgeKinds: new Set(['parentage']),
    });
    expect(d1).toHaveLength(1);
    expect(d2).toHaveLength(0);
    expect(w1.nodes[0]!.x).toBe(w2.nodes[0]!.x);
  });

  test('neighborhoodIds returns co-visible endpoints', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'a', projectPath: OP }),
        row({ id: 'b', projectPath: OP }),
        row({ id: 'c', projectPath: OP }),
      ],
      'density',
      defaultFilters,
    );
    const evidence: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'event', count: 1 },
      { source: 'c', target: 'b', kind: 'parentage', count: 1 },
    ];
    const n = neighborhoodIds('a', w, evidence);
    expect([...n].sort()).toEqual(['b']);
  });
});

describe('legend (§7.1–§7.3)', () => {
  test('edge kinds pinned first (parentage · event · resumed · shared artifact)', () => {
    const rows = buildMapLegendRows(mixed, [], DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows[0]!.label).toBe('parentage');
    expect(rows[1]!.label).toBe('event links');
    expect(rows[2]!.label).toBe('resumed');
    expect(rows[3]!.label).toBe('shared artifact');
  });

  test('legend vocabulary closed — no session-folder / A-sen- labels', () => {
    const evidence: SessionMapLink[] = [
      { source: 'op-s1', target: 'op-p1', kind: 'parentage', count: 1 },
      { source: 'op-p1', target: 'op-p2', kind: 'event', count: 2 },
      { source: 'op-p1', target: 'op-p2', kind: 'resumed_from', count: 1 },
      { source: 'op-p2', target: 'op-p1', kind: 'shared_artifact', count: 1 },
    ];
    const rows = buildMapLegendRows(
      mixed,
      evidence,
      DEFAULT_ALLOWED_ORIGINS,
      DEFAULT_ALLOWED_AGENTS,
      new Set(),
    );
    for (const r of rows) {
      const ok =
        LEGEND_EDGE_LABELS.has(r.label) ||
        LEGEND_ORIGIN_LABELS.has(r.label) ||
        LEGEND_AGENT_LABELS.has(r.label);
      expect(ok).toBe(true);
      expect(r.label).not.toMatch(/^[A-Z]-sen-/i);
      expect(r.label).not.toMatch(/^chat-mode-/i);
    }
    expect(rows.some((r) => r.label === 'operator')).toBe(true);
    expect(rows.some((r) => r.label === 'parentage')).toBe(true);
    expect(rows.some((r) => r.label === 'resumed')).toBe(true);
    expect(rows.some((r) => r.label === 'shared artifact')).toBe(true);
    // Never project basenames.
    expect(rows.some((r) => r.label === 'amore')).toBe(false);
    expect(rows.some((r) => r.label === 'A-sen-01-r1-Fz7FoM')).toBe(false);
  });

  test('legend cardinality ≤ 10', () => {
    const rows = buildMapLegendRows(mixed, [], DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows.length).toBeLessThanOrEqual(LEGEND_MAX_ROWS);
    expect(LEGEND_MAX_ROWS).toBe(10);
  });

  test('corpus edge totals on legend from full links fetch', () => {
    const evidence: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'parentage', count: 4 },
      { source: 'c', target: 'd', kind: 'event', count: 7 },
      { source: 'a', target: 'c', kind: 'resumed_from', count: 2 },
      { source: 'b', target: 'd', kind: 'shared_artifact', count: 3 },
    ];
    const rows = buildMapLegendRows(mixed, evidence, DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows.find((r) => r.label === 'parentage')!.count).toBe(4);
    expect(rows.find((r) => r.label === 'event links')!.count).toBe(7);
    expect(rows.find((r) => r.label === 'resumed')!.count).toBe(2);
    expect(rows.find((r) => r.label === 'shared artifact')!.count).toBe(3);
  });

  test('v5 absence: resumed/shared legend rows show 0', () => {
    const evidence: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'parentage', count: 1 },
      { source: 'a', target: 'b', kind: 'event', count: 1 },
    ];
    const rows = buildMapLegendRows(mixed, evidence, DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows.find((r) => r.label === 'resumed')!.count).toBe(0);
    expect(rows.find((r) => r.label === 'shared artifact')!.count).toBe(0);
  });

  test('origin/agent default hidden flags match default population', () => {
    const rows = buildMapLegendRows(mixed, [], DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows.find((r) => r.label === 'operator')!.hidden).toBe(false);
    expect(rows.find((r) => r.label === 'experiment')!.hidden).toBe(true);
    expect(rows.find((r) => r.label === 'harness')!.hidden).toBe(true);
    expect(rows.find((r) => r.label === 'primary')!.hidden).toBe(false);
    expect(rows.find((r) => r.label === 'subagent')!.hidden).toBe(true);
  });

  test('unknown omitted when count is 0', () => {
    const onlyOp = [row({ id: 'a', projectPath: OP })];
    const rows = buildMapLegendRows(onlyOp, [], DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows.some((r) => r.label === 'unknown')).toBe(false);
  });

  test('legendToggleTarget distinguishes edge / origin / agent', () => {
    expect(legendToggleTarget('parentage')).toEqual({ kind: 'edge', key: 'parentage' });
    expect(legendToggleTarget('event links')).toEqual({ kind: 'edge', key: 'event' });
    expect(legendToggleTarget('resumed')).toEqual({ kind: 'edge', key: 'resumed_from' });
    expect(legendToggleTarget('shared artifact')).toEqual({
      kind: 'edge',
      key: 'shared_artifact',
    });
    expect(legendToggleTarget('operator')).toEqual({ kind: 'origin', key: 'operator' });
    expect(legendToggleTarget('experiment')).toEqual({ kind: 'origin', key: 'experiment' });
    expect(legendToggleTarget('primary')).toEqual({ kind: 'agent', key: 'primary' });
    expect(legendToggleTarget('subagent')).toEqual({ kind: 'agent', key: 'subagent' });
    expect(legendToggleTarget('alpha')).toBe(null);
    expect(legendToggleTarget('A-sen-01')).toBe(null);
  });

  test('filterEvidenceLinks hides by kind (incl. resumed/shared)', () => {
    const links: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'parentage', count: 1 },
      { source: 'a', target: 'c', kind: 'event', count: 2 },
      { source: 'a', target: 'd', kind: 'resumed_from', count: 1 },
      { source: 'a', target: 'e', kind: 'shared_artifact', count: 1 },
    ];
    expect(filterEvidenceLinks(links, new Set(['parentage']))).toEqual([
      { source: 'a', target: 'c', kind: 'event', count: 2 },
      { source: 'a', target: 'd', kind: 'resumed_from', count: 1 },
      { source: 'a', target: 'e', kind: 'shared_artifact', count: 1 },
    ]);
    const hidden = new Set<MapEdgeKind>(['resumed_from', 'shared_artifact']);
    expect(filterEvidenceLinks(links, hidden).map((l) => l.kind).sort()).toEqual([
      'event',
      'parentage',
    ]);
  });

  test('legend toggle filters resumed/shared independently', () => {
    const edges = new Set<MapEdgeKind>();
    const toggle = (label: string) => {
      const t = legendToggleTarget(label);
      if (!t || t.kind !== 'edge') return;
      if (edges.has(t.key)) edges.delete(t.key);
      else edges.add(t.key);
    };
    toggle('resumed');
    expect(edges.has('resumed_from')).toBe(true);
    toggle('shared artifact');
    expect(edges.has('shared_artifact')).toBe(true);
    const evidence: SessionMapLink[] = [
      { source: 'op-p1', target: 'op-p2', kind: 'resumed_from', count: 1 },
      { source: 'op-p2', target: 'op-p1', kind: 'shared_artifact', count: 1 },
    ];
    const w = buildSessionWorld(mixed, 'density', defaultFilters);
    expect(selectDrawnLinks(w, evidence, { subagentsVisible: false, hiddenEdgeKinds: edges })).toHaveLength(
      0,
    );
    toggle('resumed'); // unhide resumed → only shared stays hidden
    expect(
      selectDrawnLinks(w, evidence, { subagentsVisible: false, hiddenEdgeKinds: edges }).map(
        (l) => l.kind,
      ),
    ).toEqual(['resumed_from']);
  });

  test('origin swatches use fixed ORIGIN_ORDER clusterColor indices', () => {
    const rows = buildMapLegendRows(mixed, [], new Set(ORIGIN_ORDER), new Set(AGENT_ORDER), new Set());
    const op = rows.find((r) => r.label === 'operator')!;
    const exp = rows.find((r) => r.label === 'experiment')!;
    expect(op.color).not.toEqual(exp.color);
  });

  test('formatMapLegendLine is glyph + label + count (char-frame assert surface)', () => {
    expect(formatMapLegendLine({ glyph: '─', label: 'parentage', count: 12 })).toBe(
      '─ parentage (12)',
    );
    expect(formatMapLegendLine({ glyph: '●', label: 'operator', count: 244 })).toBe(
      '● operator (244)',
    );
    expect(formatMapLegendLine({ glyph: '◇', label: 'subagent', count: 0 })).toBe('◇ subagent (0)');
  });

  test('legend toggle via legendToggleTarget flips origin/agent/edge membership sets', () => {
    // Pure state-transition proof (React rows call the same helper).
    const origins = new Set<MapOrigin>(['operator']);
    const agents = new Set(['primary']);
    const edges = new Set<string>();

    const toggle = (label: string) => {
      const t = legendToggleTarget(label);
      if (!t) return;
      if (t.kind === 'edge') {
        if (edges.has(t.key)) edges.delete(t.key);
        else edges.add(t.key);
      } else if (t.kind === 'origin') {
        if (origins.has(t.key) && origins.size > 1) origins.delete(t.key);
        else origins.add(t.key);
      } else if (t.kind === 'agent') {
        if (agents.has(t.key) && agents.size > 1) agents.delete(t.key);
        else agents.add(t.key);
      }
    };

    toggle('experiment');
    expect(origins.has('experiment')).toBe(true);
    toggle('subagent');
    expect(agents.has('subagent')).toBe(true);
    toggle('parentage');
    expect(edges.has('parentage')).toBe(true);
    toggle('parentage');
    expect(edges.has('parentage')).toBe(false);

    // Rebuilt legend reflects population/hidden flags.
    const rows = buildMapLegendRows(
      mixed,
      [{ source: 'a', target: 'b', kind: 'parentage', count: 1 }],
      origins,
      agents as Set<'primary' | 'subagent'>,
      edges as Set<'parentage' | 'event'>,
    );
    expect(rows.find((r) => r.label === 'experiment')!.hidden).toBe(false);
    expect(rows.find((r) => r.label === 'subagent')!.hidden).toBe(false);
    expect(rows.find((r) => r.label === 'parentage')!.hidden).toBe(false);
    expect(rows.map(formatMapLegendLine).join('\n')).toContain('parentage');
    expect(rows.map(formatMapLegendLine).join('\n')).toContain('operator');
  });
});

describe('status helpers (§7.10 showing N of M)', () => {
  test('filtersShortLabel + modeStatusLabel', () => {
    expect(filtersShortLabel(DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS)).toBe('op·prim');
    expect(
      filtersShortLabel(new Set(['operator', 'experiment']), new Set(['primary', 'subagent'])),
    ).toBe('op+exp·prim+sub');
    expect(modeStatusLabel('density')).toBe('timeline');
    expect(modeStatusLabel('structure' as never)).toBe('structure');
    expect(modeStatusLabel('cluster')).toBe('structure');
  });

  test('formatLinksStatus unifies drawn/loaded vocabulary', () => {
    expect(formatLinksStatus(0, 12)).toBe('links 0/12');
    expect(formatLinksStatus(3, 3)).toBe('links 3/3');
  });

  test('lightnessStatusLabel names the active channel', () => {
    expect(lightnessStatusLabel('volume')).toBe('volume-halo');
    expect(lightnessStatusLabel('error')).toBe('error-density');
  });

  test('filtered N < total M on mixed fixtures when experiment hidden', () => {
    const N = filterSessionsByPopulation(mixed, defaultFilters).length;
    const M = mixed.length;
    expect(N).toBe(2);
    expect(M).toBe(5);
    expect(N).toBeLessThan(M);
  });
});

describe('time axis (timeline mode)', () => {
  test('month ticks when span ≥ 60 days', () => {
    const minT = Date.parse('2026-01-15T00:00:00.000Z');
    const maxT = Date.parse('2026-06-15T00:00:00.000Z');
    expect(maxT - minT).toBeGreaterThanOrEqual(AXIS_WEEK_THRESHOLD_MS);
    const ticks = deriveAxisTicks(minT, maxT);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.kind === 'month')).toBe(true);
    expect(ticks.some((t) => t.label === 'Jan' || t.label === 'Feb' || t.label === 'Mar')).toBe(
      true,
    );
    // World X is finite and ordered.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.worldX).toBeGreaterThanOrEqual(ticks[i - 1]!.worldX);
    }
  });

  test('week ticks when span < 60 days', () => {
    const minT = Date.parse('2026-05-01T00:00:00.000Z');
    const maxT = Date.parse('2026-05-20T00:00:00.000Z');
    expect(maxT - minT).toBeLessThan(AXIS_WEEK_THRESHOLD_MS);
    const ticks = deriveAxisTicks(minT, maxT);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.kind === 'week')).toBe(true);
    expect(ticks[0]!.label).toMatch(/^\d{2}-\d{2}$/);
  });

  test('timeToWorldX matches timeline endpoints', () => {
    const minT = Date.parse('2026-01-01T00:00:00.000Z');
    const maxT = Date.parse('2026-12-01T00:00:00.000Z');
    expect(timeToWorldX(minT, minT, maxT)).toBeCloseTo(-100, 5);
    expect(timeToWorldX(maxT, minT, maxT)).toBeCloseTo(100, 5);
    expect(timeToWorldX((minT + maxT) / 2, minT, maxT)).toBeCloseTo(0, 5);
  });

  test('projectAxisTicks drops off-screen ticks after pan (viewport recompute)', () => {
    const minT = Date.parse('2026-01-01T00:00:00.000Z');
    const maxT = Date.parse('2026-12-01T00:00:00.000Z');
    const derived = deriveAxisTicks(minT, maxT);
    const cols = 40;
    const bodyRows = 10;
    const width = cols * 2;
    const height = bodyRows * 4;
    // Fit around the full timeline span.
    const nodes = [
      { x: -100, y: 0 },
      { x: 100, y: 0 },
    ];
    const fit = fitViewport(nodes, width, height);
    const atFit = projectAxisTicks(derived, fit, cols, bodyRows);
    expect(atFit.length).toBeGreaterThan(0);
    // Pan far right → left-side ticks leave the screen.
    const panned = { ...fit, cx: fit.cx + 200 };
    const afterPan = projectAxisTicks(derived, panned, cols, bodyRows);
    // Not every tick that was visible need vanish, but the set must recompute.
    expect(afterPan.map((t) => t.cellX).join(',')).not.toBe(atFit.map((t) => t.cellX).join(','));
  });

  test('layoutAxisStrip wires population → ticks → cells', () => {
    const nodes = [
      { startedAt: '2026-01-01T00:00:00.000Z', x: -100, y: 0 },
      { startedAt: '2026-06-01T00:00:00.000Z', x: 0, y: 0 },
      { startedAt: '2026-12-01T00:00:00.000Z', x: 100, y: 0 },
    ];
    const vp = fitViewport(nodes, 80, 40);
    const layout = layoutAxisStrip(nodes, vp, 40, 10);
    expect(layout.granularity).toBe('month');
    expect(layout.ticks.length).toBeGreaterThan(0);
    expect(layout.ticks.every((t) => t.cellX >= 0 && t.cellX < 40)).toBe(true);
  });

  test('mapCanvasBodyRows reserves one row for the axis in timeline mode', () => {
    expect(mapCanvasBodyRows(12, 'density')).toBe(11);
    expect(mapCanvasBodyRows(12, 'cluster')).toBe(12);
    expect(mapCanvasBodyRows(1, 'density')).toBe(1);
    expect(mapCanvasBodyRows(0, 'density')).toBe(0);
  });

  test('budgetMapCanvasRows fit-clamps host minus chrome; legend overlay costs 0 layout rows', () => {
    // Overlay legend: legendRows arg is ignored — canvas reclaims full residual.
    expect(budgetMapCanvasRows(21, 0, 5)).toBe(16);
    expect(budgetMapCanvasRows(21, 9, 5)).toBe(16); // non-zero legendRows no longer steals
    expect(budgetMapCanvasRows(21, 10, 5)).toBe(16);
    // host too small → 0, never negative
    expect(budgetMapCanvasRows(5, 0, 5)).toBe(0);
    expect(budgetMapCanvasRows(4, 0, 5)).toBe(0);
  });

  test('eventToCanvasCell: screen-absolute event → local cell (shared draw/hit origin)', () => {
    // Isolated canvas at terminal origin — identity transform.
    expect(eventToCanvasCell({ x: 5, y: 3 }, { x: 0, y: 0 })).toEqual({ cellX: 5, cellY: 3 });
    // Nested under Sessions chrome (round-1 lesson): canvas at (3, 9).
    // Click on local cell (5, 2) arrives as screen event (8, 11).
    expect(eventToCanvasCell({ x: 8, y: 11 }, { x: 3, y: 9 })).toEqual({ cellX: 5, cellY: 2 });
    // Top-left of nested canvas
    expect(eventToCanvasCell({ x: 3, y: 9 }, { x: 3, y: 9 })).toEqual({ cellX: 0, cellY: 0 });
    // Subpixel center for pan/zoom anchors
    expect(eventToCanvasSubpixel({ x: 8, y: 11 }, { x: 3, y: 9 })).toEqual({
      x: 5 * 2 + 1,
      y: 2 * 4 + 2,
    });
  });

  test('event wiring: nested origin + legend/node hit use the same transform', () => {
    const origin = { x: 3, y: 9 }; // nested Sessions residual
    const legend = [
      {
        glyph: '─',
        label: 'parentage',
        count: 1,
        color: { r: 160, g: 168, b: 180 },
        hidden: false,
        depth: 0 as const,
        expandable: false,
        expanded: false,
        partial: false,
      },
      {
        glyph: '→',
        label: 'resumed',
        count: 2,
        color: { r: 160, g: 168, b: 180 },
        hidden: false,
        depth: 0 as const,
        expandable: false,
        expanded: false,
        partial: false,
      },
    ];
    const cols = 40;
    const drawn = clampMapLegendEntries(legend, 10, { reserveAxis: true });
    const x0 = mapLegendX0(drawn, cols);
    // Screen event on first legend row mid-label
    const legEvent = { x: origin.x + x0 + 3, y: origin.y + 0 };
    const legCell = eventToCanvasCell(legEvent, origin);
    expect(mapLegendHitAt(drawn, cols, drawn.length, legCell.cellX, legCell.cellY)).toEqual({
      kind: 'toggle',
      label: 'parentage',
    });
    // Click left of legend (world zone) falls through
    const worldEvent = { x: origin.x + 2, y: origin.y + 2 };
    const worldCell = eventToCanvasCell(worldEvent, origin);
    expect(
      mapLegendHitAt(drawn, cols, drawn.length, worldCell.cellX, worldCell.cellY),
    ).toBe(null);
    // Node sitting at local cell (2, 2) — screen event must hit after transform
    const nodes = [{ id: 'n1', x: 2 * 2 + 1, y: 2 * 4 + 2 }];
    expect(hitTestSession(nodes, worldCell.cellX, worldCell.cellY)).toBe('n1');
    // Without transform (raw screen as cell) — the classic round-3 miss
    expect(hitTestSession(nodes, worldEvent.x, worldEvent.y)).toBe(null);
  });

  test('map legend overlay geometry: right-aligned, clamp, hit-test shared with draw', () => {
    const entries = [
      { glyph: '─', label: 'parentage', count: 1, color: { r: 1, g: 1, b: 1 }, hidden: false, depth: 0 as const, expandable: false, expanded: false, partial: false },
      { glyph: '═', label: 'event links', count: 2, color: { r: 1, g: 1, b: 1 }, hidden: false, depth: 0 as const, expandable: false, expanded: false, partial: false },
      { glyph: '→', label: 'resumed', count: 0, color: { r: 1, g: 1, b: 1 }, hidden: false, depth: 0 as const, expandable: false, expanded: false, partial: false },
      { glyph: '┄', label: 'shared artifact', count: 3, color: { r: 1, g: 1, b: 1 }, hidden: false, depth: 0 as const, expandable: false, expanded: false, partial: false },
      { glyph: '●', label: 'operator', count: 10, color: { r: 1, g: 1, b: 1 }, hidden: false, depth: 0 as const, expandable: false, expanded: false, partial: false },
    ];
    expect(mapLegendRowWidth(entries[0]!)).toBe(2 + 'parentage (1)'.length);
    const w = mapLegendBlockWidth(entries);
    expect(mapLegendX0(entries, 80)).toBe(80 - w);
    expect(mapLegendX0(entries, 5)).toBe(0); // too narrow → pinned left

    // Clamp leaves axis row free in timeline
    expect(clampMapLegendEntries(entries, 4, { reserveAxis: true })).toHaveLength(3);
    expect(clampMapLegendEntries(entries, 2, { reserveAxis: true })).toHaveLength(1);
    expect(clampMapLegendEntries(entries, 1, { reserveAxis: true })).toHaveLength(0);
    expect(clampMapLegendEntries(entries, 3, { reserveAxis: false })).toHaveLength(3);

    const drawn = clampMapLegendEntries(entries, 10, { reserveAxis: true });
    const x0 = mapLegendX0(drawn, 80);
    // Click on first legend row → toggle
    expect(mapLegendHitAt(drawn, 80, drawn.length, x0 + 2, 0)).toEqual({
      kind: 'toggle',
      label: 'parentage',
    });
    // Click past drawn rows → null (fall through to world)
    expect(mapLegendHitAt(drawn, 80, drawn.length, x0 + 2, drawn.length)).toBe(null);
    // Click left of overlay block → null
    expect(mapLegendHitAt(drawn, 80, drawn.length, 0, 0)).toBe(null);

    // Paint does not write past clamp
    const cells: ({ char: string; fg: { r: number; g: number; b: number } } | null)[] =
      new Array(80 * 10).fill(null);
    paintMapLegendOntoGrid(cells, 80, drawn, 80, drawn.length);
    // First row has a glyph at x0
    expect(cells[x0]?.char).toBe('─');
    // Row beyond clamp stays empty
    const beyond = drawn.length * 80 + x0;
    if (beyond < cells.length) expect(cells[beyond]).toBe(null);
  });

  test('mapCanvasTooSmall / minMapCanvasRows', () => {
    expect(minMapCanvasRows('density')).toBe(2);
    expect(minMapCanvasRows('cluster')).toBe(1);
    expect(mapCanvasTooSmall(0, 'density')).toBe(true);
    expect(mapCanvasTooSmall(1, 'density')).toBe(true);
    expect(mapCanvasTooSmall(2, 'density')).toBe(false);
    expect(mapCanvasTooSmall(0, 'cluster')).toBe(true);
    expect(mapCanvasTooSmall(1, 'cluster')).toBe(false);
  });

  test('mapFitPadding keeps positive scale budget on short canvases', () => {
    expect(mapFitPadding(4, 100)).toBe(1);
    expect(mapFitPadding(12, 100)).toBe(2);
    expect(mapFitPadding(40, 200)).toBe(4);
    // bodyHeight 8 with pad 1 → span room 6 > 0 (unlike default pad 4 → 0)
    const h = 8;
    const pad = mapFitPadding(h, 100);
    expect(h - 2 * pad).toBeGreaterThan(0);
  });
});

describe('hover / selection readout', () => {
  test('formatHoverReadout composition', () => {
    const now = Date.parse('2026-06-02T12:00:00.000Z');
    const line = formatHoverReadout(
      {
        id: 'abc',
        label: 'Operator Deep Forge',
        turnCount: 12,
        endedAt: '2026-06-02T10:00:00.000Z',
      },
      now,
    );
    expect(line).toBe('◌ Operator Deep Forg · t:12 · 2h ago');
  });

  test('formatSelectionReadout keeps full facts shape', () => {
    expect(
      formatSelectionReadout({
        label: 'Operator Deep Forge',
        turnCount: 12,
        origin: 'operator',
      }),
    ).toBe('◉ Operator Deep Forg · turns 12 · operator');
  });

  test('formatSessionAge buckets', () => {
    const now = Date.parse('2026-06-02T12:00:00.000Z');
    expect(formatSessionAge('2026-06-02T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatSessionAge('2026-06-02T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatSessionAge('2026-05-30T12:00:00.000Z', now)).toBe('3d ago');
    expect(formatSessionAge('', now)).toBe('?');
  });
});

describe('zoom-tier labels', () => {
  test('selects top-K by turn count and skips collisions', () => {
    const candidates = [
      { id: 'a', turnCount: 50, label: 'Alpha Primary Session', cx: 5, cy: 2 },
      { id: 'b', turnCount: 40, label: 'Beta Review Pass', cx: 6, cy: 2 }, // collides with a's label
      { id: 'c', turnCount: 30, label: 'Gamma Notes', cx: 30, cy: 2 },
      { id: 'd', turnCount: 10, label: 'Delta', cx: 5, cy: 5 },
    ];
    // Occupy nothing initially.
    const placed = selectZoomTierLabels(candidates, { cols: 50, rows: 10, maxLabels: 12 });
    expect(placed[0]!.id).toBe('a'); // highest turns
    // b shares the row and sits inside a's label run → skipped
    expect(placed.some((p) => p.id === 'b')).toBe(false);
    expect(placed.some((p) => p.id === 'c')).toBe(true);
    expect(placed.length).toBeLessThanOrEqual(ZOOM_TIER_MAX_LABELS);
  });

  test('respects maxLabels cap', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      turnCount: 100 - i,
      label: `Session ${i}`,
      cx: (i * 5) % 80,
      cy: Math.floor(i / 16),
    }));
    const placed = selectZoomTierLabels(candidates, { cols: 100, rows: 20, maxLabels: 5 });
    expect(placed.length).toBeLessThanOrEqual(5);
  });
});

describe('error-density tier mapping', () => {
  test('maps density onto attention tiers 0–3', () => {
    expect(errorDensityTier(0)).toBe(0);
    expect(errorDensityTier(-1)).toBe(0);
    expect(errorDensityTier(0.02)).toBe(1);
    expect(errorDensityTier(0.1)).toBe(2);
    expect(errorDensityTier(0.2)).toBe(3);
    expect(errorDensityTier(1)).toBe(3);
  });
});

describe('link partition solid/faint', () => {
  test('shared_artifact is faint; resumed/parentage/event solid', () => {
    const links: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'resumed_from', count: 1 },
      { source: 'a', target: 'c', kind: 'shared_artifact', count: 1 },
      { source: 'a', target: 'd', kind: 'parentage', count: 1 },
      { source: 'a', target: 'e', kind: 'event', count: 1 },
    ];
    const { solid, faint } = partitionDrawnLinks(links);
    expect(solid.map((l) => l.kind).sort()).toEqual(['event', 'parentage', 'resumed_from']);
    expect(faint.map((l) => l.kind)).toEqual(['shared_artifact']);
  });
});

describe('hitTestSession / gridAnchors', () => {
  test('picks nearest within radius; null outside', () => {
    const nodes = [
      { id: 'near', x: 5, y: 6 },
      { id: 'far', x: 80, y: 80 },
    ];
    expect(hitTestSession(nodes, 2, 1)).toBe('near');
    expect(hitTestSession(nodes, 40, 40)).toBe(null);
  });

  test('gridAnchors count matches and is deterministic', () => {
    const a = gridAnchors(4);
    const b = gridAnchors(4);
    expect(a).toHaveLength(4);
    expect(a).toEqual(b);
  });
});

describe('§7.12 performance budget (soft)', () => {
  test('buildSessionWorld for ≥1000 sessions under 50ms', () => {
    const big: SessionListRow[] = [];
    for (let i = 0; i < 1200; i++) {
      big.push(
        row({
          id: `bulk-${String(i).padStart(5, '0')}`,
          projectPath: OP,
          startedAt: `2026-04-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
          turnCount: 1 + (i % 40),
          title: `Session ${i}`,
        }),
      );
    }
    const t0 = performance.now();
    const w = buildSessionWorld(big, 'density', defaultFilters);
    const t1 = performance.now();
    const w2 = buildSessionWorld(big, 'cluster', defaultFilters);
    const t2 = performance.now();
    expect(w.nodes.length).toBe(1200);
    expect(w2.nodes.length).toBe(1200);
    const densityMs = t1 - t0;
    const clusterMs = t2 - t1;
    // Soft budget — report, don't flake CI on a cold machine spike.
    expect(densityMs).toBeLessThan(50);
    expect(clusterMs).toBeLessThan(50);
  });
});
