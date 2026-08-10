import { describe, expect, test } from 'bun:test';
import type { SessionListRow, SessionMapLink } from './query-service';
import {
  AGENT_ORDER,
  buildMapLegendRows,
  buildSessionWorld,
  buildStructureWorld,
  buildTimelineWorld,
  DEFAULT_ALLOWED_AGENTS,
  DEFAULT_ALLOWED_ORIGINS,
  filterEvidenceLinks,
  filterSessionsByPopulation,
  filtersShortLabel,
  formatMapLegendLine,
  gridAnchors,
  hasNoForceEdges,
  hitTestSession,
  LEGEND_AGENT_LABELS,
  LEGEND_EDGE_LABELS,
  LEGEND_ORIGIN_LABELS,
  legendToggleTarget,
  modeStatusLabel,
  neighborhoodIds,
  ORIGIN_ORDER,
  projectBasename,
  selectDrawnLinks,
  sessionAgent,
  sessionLabel,
  sessionOrigin,
  sessionWorldToGraph,
  SESSION_MAP_LINKS,
  stableUnit,
  volumeLinkCount,
  type MapMode,
  type MapOrigin,
  type PopulationFilters,
} from './map-data';

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

  test('selectDrawnLinks: default zero edges; parentage when subagents on', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'parent', projectPath: OP }),
        row({ id: 'child', projectPath: OP, agent: 'subagent', parentSession: 'parent' }),
      ],
      'cluster',
      { origins: DEFAULT_ALLOWED_ORIGINS, agents: new Set(['primary', 'subagent']) },
    );
    const evidence: SessionMapLink[] = [
      { source: 'child', target: 'parent', kind: 'parentage', count: 1 },
      { source: 'parent', target: 'child', kind: 'event', count: 2 },
    ];
    expect(selectDrawnLinks(w, evidence, { subagentsVisible: false })).toHaveLength(0);
    const withSub = selectDrawnLinks(w, evidence, { subagentsVisible: true });
    expect(withSub).toHaveLength(1);
    expect(withSub[0]!.kind).toBe('parentage');
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
  test('edge kinds pinned at 0 and 1', () => {
    const rows = buildMapLegendRows(mixed, [], DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows[0]!.label).toBe('parentage');
    expect(rows[1]!.label).toBe('event links');
  });

  test('legend vocabulary closed — no session-folder / A-sen- labels', () => {
    const evidence: SessionMapLink[] = [
      { source: 'op-s1', target: 'op-p1', kind: 'parentage', count: 1 },
      { source: 'op-p1', target: 'op-p2', kind: 'event', count: 2 },
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
    // Never project basenames.
    expect(rows.some((r) => r.label === 'amore')).toBe(false);
    expect(rows.some((r) => r.label === 'A-sen-01-r1-Fz7FoM')).toBe(false);
  });

  test('legend cardinality ≤ 8', () => {
    const rows = buildMapLegendRows(mixed, [], DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows.length).toBeLessThanOrEqual(8);
  });

  test('corpus edge totals on legend from full links fetch', () => {
    const evidence: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'parentage', count: 4 },
      { source: 'c', target: 'd', kind: 'event', count: 7 },
    ];
    const rows = buildMapLegendRows(mixed, evidence, DEFAULT_ALLOWED_ORIGINS, DEFAULT_ALLOWED_AGENTS, new Set());
    expect(rows.find((r) => r.label === 'parentage')!.count).toBe(4);
    expect(rows.find((r) => r.label === 'event links')!.count).toBe(7);
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
    expect(legendToggleTarget('operator')).toEqual({ kind: 'origin', key: 'operator' });
    expect(legendToggleTarget('experiment')).toEqual({ kind: 'origin', key: 'experiment' });
    expect(legendToggleTarget('primary')).toEqual({ kind: 'agent', key: 'primary' });
    expect(legendToggleTarget('subagent')).toEqual({ kind: 'agent', key: 'subagent' });
    expect(legendToggleTarget('alpha')).toBe(null);
    expect(legendToggleTarget('A-sen-01')).toBe(null);
  });

  test('filterEvidenceLinks hides by kind', () => {
    const links: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'parentage', count: 1 },
      { source: 'a', target: 'c', kind: 'event', count: 2 },
    ];
    expect(filterEvidenceLinks(links, new Set(['parentage']))).toEqual([
      { source: 'a', target: 'c', kind: 'event', count: 2 },
    ]);
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

  test('filtered N < total M on mixed fixtures when experiment hidden', () => {
    const N = filterSessionsByPopulation(mixed, defaultFilters).length;
    const M = mixed.length;
    expect(N).toBe(2);
    expect(M).toBe(5);
    expect(N).toBeLessThan(M);
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
