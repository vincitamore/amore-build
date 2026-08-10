import { describe, expect, test } from 'bun:test';
import type { SessionListRow } from './query-service';
import {
  buildSessionWorld,
  gridAnchors,
  hasNoForceEdges,
  hitTestSession,
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
  };
}

describe('projectBasename / labels', () => {
  test('basename from posix and windows paths', () => {
    expect(projectBasename('/home/u/proj/iris')).toBe('iris');
    expect(projectBasename('C:\\Users\\x\\proj\\iris')).toBe('iris');
    expect(projectBasename('')).toBe('∅');
    expect(projectBasename('/')).toBe('∅');
  });

  test('sessionLabel shortens long ids', () => {
    expect(sessionLabel('ab')).toBe('ab');
    expect(sessionLabel('1234567890abcdef')).toBe('90abcdef');
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

describe('sessionWorldToGraph / no force edges', () => {
  test('SESSION_MAP_LINKS is empty and frozen', () => {
    expect(SESSION_MAP_LINKS).toHaveLength(0);
    expect(Object.isFrozen(SESSION_MAP_LINKS)).toBe(true);
  });

  test('graph projection never adds links', () => {
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
