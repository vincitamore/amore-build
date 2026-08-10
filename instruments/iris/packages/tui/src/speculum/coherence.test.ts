import { describe, expect, test } from 'bun:test';
import {
  CLI_SIDE_EFFECT_SEAM,
  barIsSingleRow,
  firstNineUnchanged,
  honestStageSet,
  noForceGraphEdges,
  noInventedMetrics,
  noSessionBodiesInOrgSearch,
  runCoherenceChecks,
  sessionsIsLastSlot,
  sideEffectsAreCli,
  singleAuditFile,
  wilsonHonest,
  type CoherenceInput,
} from './coherence';

const LEGACY_NINE = [
  'Dashboard',
  'Inbox',
  'Tasks',
  'Knowledge',
  'Files',
  'Graph',
  'Forge',
  'Lucerna',
  'Reminders',
] as const;

const PHASE1_MEMBERS = [...LEGACY_NINE, 'Sessions'] as const;

function greenPhase1(overrides: Partial<CoherenceInput> = {}): CoherenceInput {
  return {
    members: PHASE1_MEMBERS,
    legacyMembers: LEGACY_NINE,
    implementedStages: ['Probes', 'Usage'],
    displayedStages: ['Probes', 'Usage'],
    probes: [
      { n: 40, value: 0.25, ciLow: 0.14, ciHigh: 0.4 },
      { n: 0, value: 0.5, ciLow: 0, ciHigh: 1 },
    ],
    auditPaths: ['~/.speculum/audit.jsonl'],
    sideEffectPath: CLI_SIDE_EFFECT_SEAM,
    orgSearchQuery: 'inbox overdue',
    forceGraphKind: 'org',
    ...overrides,
  };
}

// ── B · Bar ─────────────────────────────────────────────────────────────────

describe('sessionsIsLastSlot (B)', () => {
  test('pass: Sessions is final slot', () => {
    expect(sessionsIsLastSlot(PHASE1_MEMBERS)).toBe(true);
  });

  test('fail: empty members', () => {
    expect(sessionsIsLastSlot([])).toBe(false);
  });

  test('fail: Sessions not last', () => {
    expect(sessionsIsLastSlot(['Sessions', ...LEGACY_NINE])).toBe(false);
    expect(sessionsIsLastSlot([...LEGACY_NINE, 'Other'])).toBe(false);
  });
});

describe('barIsSingleRow (B)', () => {
  test('pass: 10 chips fit one row', () => {
    expect(barIsSingleRow(10)).toBe(true);
    expect(barIsSingleRow(9)).toBe(true);
    expect(barIsSingleRow(0)).toBe(true);
  });

  test('fail: more than 10 would force a second row', () => {
    expect(barIsSingleRow(11)).toBe(false);
  });

  test('fail: negative or non-finite', () => {
    expect(barIsSingleRow(-1)).toBe(false);
    expect(barIsSingleRow(Number.NaN)).toBe(false);
  });
});

describe('firstNineUnchanged (B)', () => {
  test('pass: first nine byte-identical', () => {
    expect(firstNineUnchanged(LEGACY_NINE, PHASE1_MEMBERS)).toBe(true);
  });

  test('fail: empty or short arrays', () => {
    expect(firstNineUnchanged([], [])).toBe(false);
    expect(firstNineUnchanged(LEGACY_NINE, LEGACY_NINE.slice(0, 5))).toBe(
      false,
    );
  });

  test('fail: demotion or reassignment of a legacy slot', () => {
    const demoted = [
      ...LEGACY_NINE.slice(0, 8),
      'Sessions',
      LEGACY_NINE[8]!,
    ];
    expect(firstNineUnchanged(LEGACY_NINE, demoted)).toBe(false);
    const reassigned = ['Inbox', ...LEGACY_NINE.slice(1), 'Sessions'];
    expect(firstNineUnchanged(LEGACY_NINE, reassigned)).toBe(false);
  });
});

// ── A · Honesty ─────────────────────────────────────────────────────────────

describe('honestStageSet (A)', () => {
  test('pass: displayed is subset of implemented (incl. empty display)', () => {
    expect(honestStageSet(['Probes', 'Usage'], ['Probes'])).toBe(true);
    expect(honestStageSet(['Probes', 'Usage'], ['Probes', 'Usage'])).toBe(
      true,
    );
    expect(honestStageSet(['Probes', 'Usage'], [])).toBe(true);
    expect(honestStageSet([], [])).toBe(true);
  });

  test("fail: 'coming soon' extra not in implemented", () => {
    expect(
      honestStageSet(['Probes', 'Usage'], ['Probes', 'Usage', 'Microscope']),
    ).toBe(false);
    expect(honestStageSet(['Probes'], ['Map'])).toBe(false);
  });
});

describe('noInventedMetrics (A)', () => {
  test('pass: finite rate with n>0', () => {
    expect(noInventedMetrics({ value: 0.3, n: 12, unit: 'rate' })).toBe(true);
  });

  test('fail: n===0 fabricates a point claim without interval', () => {
    expect(noInventedMetrics({ value: 0, n: 0, unit: 'rate' })).toBe(false);
    expect(noInventedMetrics({ value: 0.5, n: 0, unit: 'rate' })).toBe(false);
  });
});

describe('wilsonHonest (A)', () => {
  test('pass: n>0 with 0 ≤ ciLow ≤ value ≤ ciHigh ≤ 1', () => {
    expect(
      wilsonHonest({ n: 20, value: 0.5, ciLow: 0.3, ciHigh: 0.7 }),
    ).toBe(true);
  });

  test('pass: n===0 interval covers 1 (full uncertainty)', () => {
    expect(wilsonHonest({ n: 0, value: 0.5, ciLow: 0, ciHigh: 1 })).toBe(true);
    expect(wilsonHonest({ n: 0, value: 0, ciLow: 0.2, ciHigh: 1 })).toBe(true);
  });

  test('fail: n>0 interval violates ordering or bounds', () => {
    expect(
      wilsonHonest({ n: 5, value: 0.9, ciLow: 0.1, ciHigh: 0.5 }),
    ).toBe(false);
    expect(
      wilsonHonest({ n: 5, value: 0.5, ciLow: -0.1, ciHigh: 0.6 }),
    ).toBe(false);
    expect(
      wilsonHonest({ n: 5, value: 0.5, ciLow: 0.1, ciHigh: 1.1 }),
    ).toBe(false);
  });

  test('fail: n===0 interval does not cover 1', () => {
    expect(wilsonHonest({ n: 0, value: 0, ciLow: 0, ciHigh: 0 })).toBe(false);
    expect(wilsonHonest({ n: 0, value: 0, ciLow: 0, ciHigh: 0.5 })).toBe(
      false,
    );
  });
});

// ── N / H · Narrative & privacy ─────────────────────────────────────────────

describe('noSessionBodiesInOrgSearch (N)', () => {
  test('pass: Phase-1 org queries (architecture never feeds bodies)', () => {
    expect(noSessionBodiesInOrgSearch('')).toBe(true);
    expect(noSessionBodiesInOrgSearch('tasks due')).toBe(true);
  });
});

describe('noForceGraphEdges (H)', () => {
  test('pass: non-session kinds may use force layout', () => {
    expect(noForceGraphEdges('org')).toBe(true);
    expect(noForceGraphEdges('task')).toBe(true);
    expect(noForceGraphEdges('')).toBe(true);
  });

  test('fail: session kind must not carry force edges', () => {
    expect(noForceGraphEdges('session')).toBe(false);
  });
});

// ── G · Governance ──────────────────────────────────────────────────────────

describe('singleAuditFile (G)', () => {
  test('pass: zero or one audit path', () => {
    expect(singleAuditFile([])).toBe(true);
    expect(singleAuditFile(['audit.jsonl'])).toBe(true);
  });

  test('fail: two audit files', () => {
    expect(
      singleAuditFile(['audit.jsonl', 'iris-lens-audit.jsonl']),
    ).toBe(false);
  });
});

describe('sideEffectsAreCli (G)', () => {
  test('pass: spawn seam path', () => {
    expect(sideEffectsAreCli(CLI_SIDE_EFFECT_SEAM)).toBe(true);
    expect(sideEffectsAreCli('src/speculum/speculum-spawn.ts')).toBe(true);
  });

  test('fail: direct sqlite or foreign path', () => {
    expect(sideEffectsAreCli('src/daemon/sqlite-write.ts')).toBe(false);
    expect(sideEffectsAreCli('')).toBe(false);
  });
});

// ── Aggregate runner ────────────────────────────────────────────────────────

describe('runCoherenceChecks', () => {
  test('green Phase-1 dashboard config: all checks pass', () => {
    const results = runCoherenceChecks(greenPhase1());
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const r of results) {
      expect(r.pass).toBe(true);
    }
    const families = new Set(results.map((r) => r.family));
    expect(families.has('B')).toBe(true);
    expect(families.has('A')).toBe(true);
    expect(families.has('N')).toBe(true);
    expect(families.has('H')).toBe(true);
    expect(families.has('G')).toBe(true);
  });

  test('red Phase-1 config: multiple families fail', () => {
    const results = runCoherenceChecks(
      greenPhase1({
        members: ['Sessions', ...LEGACY_NINE],
        displayedStages: ['Probes', 'Usage', 'Microscope'],
        probes: [{ n: 0, value: 0, ciLow: 0, ciHigh: 0 }],
        auditPaths: ['a.jsonl', 'b.jsonl'],
        sideEffectPath: 'src/lib/direct-sqlite.ts',
        forceGraphKind: 'session',
      }),
    );
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['B.sessionsIsLastSlot']!.pass).toBe(false);
    expect(byId['B.firstNineUnchanged']!.pass).toBe(false);
    expect(byId['A.honestStageSet']!.pass).toBe(false);
    expect(byId['A.wilsonHonest']!.pass).toBe(false);
    expect(byId['H.noForceGraphEdges']!.pass).toBe(false);
    expect(byId['G.singleAuditFile']!.pass).toBe(false);
    expect(byId['G.sideEffectsAreCli']!.pass).toBe(false);
  });

  test('omit unimplemented stages still green (prefer omit)', () => {
    const results = runCoherenceChecks(
      greenPhase1({
        implementedStages: ['Probes', 'Usage'],
        displayedStages: ['Probes'],
      }),
    );
    expect(results.every((r) => r.pass)).toBe(true);
  });
});
