import { describe, expect, test } from 'bun:test';
import type { SessionListRow, SessionMapLink } from './query-service';
import {
  buildMapLegendRows,
  buildSessionWorld,
  filterEvidenceLinks,
  gridAnchors,
  hasNoForceEdges,
  hiddenIdsForProjects,
  hitTestSession,
  legendToggleTarget,
  projectBasename,
  sessionLabel,
  sessionWorldToGraph,
  SESSION_MAP_LINKS,
  stableUnit,
  type MapMode,
} from './map-data';

function row(partial: Partial<SessionListRow> & { id: string }): SessionListRow {
  return {
    id: partial.id,
    projectPath: partial.projectPath ?? '/proj/a',
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

describe('projectBasename / labels', () => {
  test('basename from posix and windows paths', () => {
    expect(projectBasename('/home/u/proj/iris')).toBe('iris');
    expect(projectBasename('C:\\Users\\x\\proj\\iris')).toBe('iris');
    expect(projectBasename('')).toBe('∅');
    expect(projectBasename('/')).toBe('∅');
  });

  test('sessionLabel falls back to id suffix when title empty', () => {
    expect(sessionLabel('ab')).toBe('ab');
    expect(sessionLabel('1234567890abcdef')).toBe('90abcdef');
    expect(sessionLabel('1234567890abcdef', '')).toBe('90abcdef');
    expect(sessionLabel('1234567890abcdef', '   ')).toBe('90abcdef');
  });

  test('sessionLabel prefers title via displayLabel (head-slice doctrine)', () => {
    expect(sessionLabel('uuid-long-enough', 'KB Link Density Report')).toBe('KB Link Density Re');
    // Machine-slug dream titles: distinctive tail leads so two family members never share a glyph label.
    const a = sessionLabel('id-a', 'Pipeline: dream-2026-02-17T09-31-56-dream-digest');
    const b = sessionLabel('id-b', 'Pipeline: dream-2026-02-17T12-42-09-self-orient');
    expect(a).not.toBe(b);
    expect(a.startsWith('dream-digest')).toBe(true);
    expect(b.startsWith('self-orient')).toBe(true);
    // Naive head-slice would collapse both to the shared prefix.
    const naiveA = 'Pipeline: dream-2026-02-17T09-31-56-dream-digest'.slice(0, 18);
    const naiveB = 'Pipeline: dream-2026-02-17T12-42-09-self-orient'.slice(0, 18);
    expect(naiveA).toBe(naiveB);
    expect(a).not.toBe(naiveA);
  });

  test('stableUnit is deterministic in [0,1)', () => {
    const a = stableUnit('sess-1');
    const b = stableUnit('sess-1');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(stableUnit('sess-1')).not.toBe(stableUnit('sess-2'));
  });
});

describe('buildSessionWorld', () => {
  test('empty input → empty world', () => {
    for (const mode of ['density', 'cluster'] as MapMode[]) {
      const w = buildSessionWorld([], mode);
      expect(w.nodes).toEqual([]);
      expect(w.groupKeys).toEqual([]);
      expect(w.mode).toBe(mode);
    }
  });

  test('one session lands at a finite anchor', () => {
    const w = buildSessionWorld([row({ id: 'only', projectPath: '/p/solo' })], 'cluster');
    expect(w.nodes).toHaveLength(1);
    expect(w.groupKeys).toEqual(['solo']);
    expect(Number.isFinite(w.nodes[0].x)).toBe(true);
    expect(Number.isFinite(w.nodes[0].y)).toBe(true);
    expect(w.nodes[0].groupKey).toBe('solo');
    expect(w.nodes[0].cluster).toBe(0);
  });

  test('title becomes glyph label', () => {
    const w = buildSessionWorld(
      [row({ id: 'sess-long-id-abcdef01', title: 'Repeat Previous Single Word' })],
      'cluster',
    );
    expect(w.nodes[0]!.label).toBe(sessionLabel('sess-long-id-abcdef01', 'Repeat Previous Single Word'));
    expect(w.nodes[0]!.label).not.toBe('abcdef01');
  });

  test('determinism: same input → same world (order-invariant groups)', () => {
    const a = [
      row({ id: 's2', projectPath: '/p/beta', startedAt: '2026-06-02T00:00:00.000Z', turnCount: 5 }),
      row({ id: 's1', projectPath: '/p/alpha', startedAt: '2026-06-01T00:00:00.000Z', turnCount: 2 }),
      row({ id: 's3', projectPath: '/p/alpha', startedAt: '2026-06-03T00:00:00.000Z', turnCount: 9 }),
    ];
    const b = [a[2], a[0], a[1]];
    for (const mode of ['density', 'cluster'] as MapMode[]) {
      const wa = buildSessionWorld(a, mode);
      const wb = buildSessionWorld(b, mode);
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

  test('bucket/group stability: two projects → two cluster indices', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'a1', projectPath: '/work/alpha' }),
        row({ id: 'b1', projectPath: '/work/beta' }),
        row({ id: 'a2', projectPath: '/work/alpha' }),
      ],
      'cluster',
    );
    expect(w.groupKeys).toEqual(['alpha', 'beta']);
    const clusters = new Set(w.nodes.map((n) => n.cluster));
    expect(clusters.size).toBe(2);
    expect(w.nodes.filter((n) => n.groupKey === 'alpha').every((n) => n.cluster === 0)).toBe(true);
    expect(w.nodes.filter((n) => n.groupKey === 'beta').every((n) => n.cluster === 1)).toBe(true);
  });

  test('density separates groups on Y and time on X', () => {
    const w = buildSessionWorld(
      [
        row({
          id: 'early-a',
          projectPath: '/p/alpha',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
        row({
          id: 'late-a',
          projectPath: '/p/alpha',
          startedAt: '2026-12-01T00:00:00.000Z',
        }),
        row({
          id: 'mid-b',
          projectPath: '/p/beta',
          startedAt: '2026-06-01T00:00:00.000Z',
        }),
      ],
      'density',
    );
    const early = w.nodes.find((n) => n.id === 'early-a')!;
    const late = w.nodes.find((n) => n.id === 'late-a')!;
    const midB = w.nodes.find((n) => n.id === 'mid-b')!;
    expect(late.x).toBeGreaterThan(early.x);
    // Different projects → different Y bands (beyond micro-jitter).
    expect(Math.abs(midB.y - early.y)).toBeGreaterThan(8);
  });

  test('cluster mode packs same-group sessions near shared anchor', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'a1', projectPath: '/p/alpha', turnCount: 10 }),
        row({ id: 'a2', projectPath: '/p/alpha', turnCount: 3 }),
        row({ id: 'b1', projectPath: '/p/beta', turnCount: 5 }),
      ],
      'cluster',
    );
    const a1 = w.nodes.find((n) => n.id === 'a1')!;
    const a2 = w.nodes.find((n) => n.id === 'a2')!;
    const b1 = w.nodes.find((n) => n.id === 'b1')!;
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y);
    expect(dist(a1, a2)).toBeLessThan(dist(a1, b1));
  });
});

describe('sessionWorldToGraph / evidence links', () => {
  test('SESSION_MAP_LINKS is empty and frozen (no invented affinity default)', () => {
    expect(SESSION_MAP_LINKS).toHaveLength(0);
    expect(Object.isFrozen(SESSION_MAP_LINKS)).toBe(true);
  });

  test('graph projection without evidence → empty links', () => {
    const w = buildSessionWorld(
      [
        row({ id: 's1', projectPath: '/p/a' }),
        row({ id: 's2', projectPath: '/p/b' }),
      ],
      'cluster',
    );
    const { graph, worldNodes } = sessionWorldToGraph(w);
    expect(graph.links).toHaveLength(0);
    expect(hasNoForceEdges(graph)).toBe(true);
    expect(graph.nodes).toHaveLength(2);
    expect(worldNodes).toHaveLength(2);
    expect(graph.nodes.every((n) => n.kind === 'doc')).toBe(true);
  });

  test('projects co-visible evidence links; drops endpoints outside the world', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'parent', projectPath: '/p/a' }),
        row({ id: 'child', projectPath: '/p/a', parentSession: 'parent' }),
        row({ id: 'other', projectPath: '/p/b' }),
      ],
      'cluster',
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
    expect(hasNoForceEdges(graph)).toBe(false);
  });
});

describe('legend + visibility helpers', () => {
  test('buildMapLegendRows colors projects via cluster index; edge kinds present', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'a1', projectPath: '/work/alpha' }),
        row({ id: 'b1', projectPath: '/work/beta' }),
      ],
      'cluster',
    );
    const evidence: SessionMapLink[] = [
      { source: 'a1', target: 'b1', kind: 'parentage', count: 1 },
      { source: 'a1', target: 'b1', kind: 'event', count: 2 },
    ];
    const rows = buildMapLegendRows(w, evidence, new Set(), new Set());
    expect(rows.some((r) => r.label === 'alpha')).toBe(true);
    expect(rows.some((r) => r.label === 'beta')).toBe(true);
    expect(rows.some((r) => r.label === 'parentage' && r.count === 1)).toBe(true);
    expect(rows.some((r) => r.label === 'event links' && r.count === 2)).toBe(true);
    const alpha = rows.find((r) => r.label === 'alpha')!;
    const beta = rows.find((r) => r.label === 'beta')!;
    // Different cluster indices → different colors (same function nodes use).
    expect(alpha.color).not.toEqual(beta.color);
  });

  test('hiddenIdsForProjects skips hidden groups without changing layout', () => {
    const w = buildSessionWorld(
      [
        row({ id: 'a1', projectPath: '/p/alpha' }),
        row({ id: 'b1', projectPath: '/p/beta' }),
      ],
      'cluster',
    );
    const hidden = hiddenIdsForProjects(w, new Set(['alpha']));
    expect(hidden?.has('a1')).toBe(true);
    expect(hidden?.has('b1')).toBe(false);
  });

  test('filterEvidenceLinks + legendToggleTarget', () => {
    const links: SessionMapLink[] = [
      { source: 'a', target: 'b', kind: 'parentage', count: 1 },
      { source: 'a', target: 'c', kind: 'event', count: 2 },
    ];
    expect(filterEvidenceLinks(links, new Set(['parentage']))).toEqual([
      { source: 'a', target: 'c', kind: 'event', count: 2 },
    ]);
    expect(legendToggleTarget('parentage')).toEqual({ kind: 'edge', key: 'parentage' });
    expect(legendToggleTarget('event links')).toEqual({ kind: 'edge', key: 'event' });
    expect(legendToggleTarget('alpha')).toEqual({ kind: 'project', key: 'alpha' });
  });
});

describe('hitTestSession', () => {
  test('picks nearest within radius; null outside', () => {
    const nodes = [
      { id: 'near', x: 5, y: 6 },
      { id: 'far', x: 80, y: 80 },
    ];
    // cell (2,1) → subpx center (5, 6)
    expect(hitTestSession(nodes, 2, 1)).toBe('near');
    expect(hitTestSession(nodes, 40, 40)).toBe(null);
  });
});

describe('gridAnchors', () => {
  test('count matches and is deterministic', () => {
    const a = gridAnchors(4);
    const b = gridAnchors(4);
    expect(a).toHaveLength(4);
    expect(a).toEqual(b);
  });
});
