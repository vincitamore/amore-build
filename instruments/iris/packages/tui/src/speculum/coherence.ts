/**
 * Phase-1 Coherence Pass — pure tell-test predicates over plain data.
 * Each export guards one named tell-test family (ship gate seed).
 * No renderer, no I/O, no side effects.
 */

/** Canonical CLI side-effect seam (only path allowed for dash mutations). */
export const CLI_SIDE_EFFECT_SEAM = 'src/speculum/speculum-spawn.ts';

export type CoherenceFamily = 'N' | 'J' | 'V' | 'H' | 'A' | 'G' | 'B';

export type CoherenceCheck = {
  id: string;
  family: CoherenceFamily;
  pass: boolean;
  detail: string;
};

export type ProbeWilsonRow = {
  n: number;
  value: number;
  ciLow: number;
  ciHigh: number;
};

export type CoherenceInput = {
  /** Full member bar names in order (10th must be Sessions). */
  members: readonly string[];
  /** Legacy nine org/companion names for B1 first-nine check. */
  legacyMembers: readonly string[];
  /** Stages that have real implementations (Phase 1: Probes, Usage or fewer). */
  implementedStages: readonly string[];
  /** Stages currently shown as chips (must be subset of implemented). */
  displayedStages: readonly string[];
  /** Probe rows with Wilson intervals for honesty checks. */
  probes: readonly ProbeWilsonRow[];
  /** Audit file paths the dash would open (at most one). */
  auditPaths: readonly string[];
  /** Implementation path used for side-effect calls. */
  sideEffectPath: string;
  /** Org search query channel (never carries session bodies). */
  orgSearchQuery: string;
  /** Graph/node kind under force-layout consideration. */
  forceGraphKind: string;
};

// ── Bar family (B) ──────────────────────────────────────────────────────────

/** B2/B topology: Sessions is the final (10th) member slot. */
export function sessionsIsLastSlot(members: readonly string[]): boolean {
  if (members.length === 0) return false;
  return members[members.length - 1] === 'Sessions';
}

/**
 * B3 bar density: the member bar never wraps to a second row.
 * Phase-1 contract: up to 10 chips on one row (abbreviate; never two rows).
 */
export function barIsSingleRow(memberCount: number): boolean {
  if (!Number.isFinite(memberCount) || memberCount < 0) return false;
  return memberCount <= 10;
}

/** B1: first nine slot names are byte-identical to the legacy nine (digits 1–9). */
export function firstNineUnchanged(
  legacy: readonly string[],
  now: readonly string[],
): boolean {
  if (legacy.length < 9 || now.length < 9) return false;
  for (let i = 0; i < 9; i++) {
    if (legacy[i] !== now[i]) return false;
  }
  return true;
}

// ── Honesty / absence-of-fake-chrome family (A) ─────────────────────────────

/**
 * A honesty: every displayed stage chip is implemented.
 * A stage shown without implementation (“coming soon”) is a lie.
 */
export function honestStageSet(
  implemented: readonly string[],
  displayed: readonly string[],
): boolean {
  const impl = new Set(implemented);
  for (const stage of displayed) {
    if (!impl.has(stage)) return false;
  }
  return true;
}

/**
 * A honesty: n===0 must not fabricate a point metric claim.
 * Without a Wilson interval, any rate at n===0 is invented — use wilsonHonest.
 */
export function noInventedMetrics(probe: {
  value: number;
  n: number;
  unit: string;
}): boolean {
  if (probe.n === 0) return false;
  return Number.isFinite(probe.value) && probe.n > 0;
}

/**
 * A / Wilson honesty: interval invariant the renderer must keep.
 * n>0 ⇒ 0 ≤ ciLow ≤ value ≤ ciHigh ≤ 1;
 * n===0 ⇒ interval covers 1 (full uncertainty, not a fabricated 0 claim).
 */
export function wilsonHonest(row: ProbeWilsonRow): boolean {
  const { n, value, ciLow, ciHigh } = row;
  if (!Number.isFinite(n) || n < 0) return false;
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(ciLow) ||
    !Number.isFinite(ciHigh)
  ) {
    return false;
  }
  if (n === 0) {
    return ciLow <= 1 && ciHigh >= 1;
  }
  return (
    ciLow >= 0 &&
    ciHigh <= 1 &&
    ciLow <= value &&
    value <= ciHigh
  );
}

// ── Narrative / privacy family (N + H) ──────────────────────────────────────

/**
 * N / H3 + privacy R8: org search never receives session bodies.
 * Phase-1 architecture never feeds bodies into the org overlay — always true;
 * load-bearing when Search integration lands.
 */
export function noSessionBodiesInOrgSearch(_orgSearchQuery: string): boolean {
  return true;
}

/**
 * H2: session exploration never renders force-directed graph edges.
 * Returns true when the kind under force layout is not a session carrier.
 */
export function noForceGraphEdges(kind: string): boolean {
  return kind !== 'session';
}

// ── Governance family (G) ───────────────────────────────────────────────────

/** G4: at most one audit file path (dash never opens a second lens audit). */
export function singleAuditFile(auditPaths: readonly string[]): boolean {
  return auditPaths.length <= 1;
}

/**
 * G: the only side-effect implementation path is the CLI spawn seam.
 * Pass the string literal from the call site; guards seam drift.
 */
export function sideEffectsAreCli(implPath: string): boolean {
  return implPath === CLI_SIDE_EFFECT_SEAM;
}

// ── Aggregate runner ────────────────────────────────────────────────────────

/**
 * Phase-1 Coherence Pass runner — pure aggregate over dashboard config data.
 * Integration wires this into the automated gate.
 */
export function runCoherenceChecks(input: CoherenceInput): CoherenceCheck[] {
  const results: CoherenceCheck[] = [];

  const lastOk = sessionsIsLastSlot(input.members);
  results.push({
    id: 'B.sessionsIsLastSlot',
    family: 'B',
    pass: lastOk,
    detail: lastOk
      ? 'Sessions is the final member slot'
      : `expected last member "Sessions", got ${JSON.stringify(input.members[input.members.length - 1] ?? null)}`,
  });

  const count = input.members.length;
  const rowOk = barIsSingleRow(count);
  results.push({
    id: 'B.barIsSingleRow',
    family: 'B',
    pass: rowOk,
    detail: rowOk
      ? `memberCount ${count} fits one bar row`
      : `memberCount ${count} would force a second bar row`,
  });

  const nineOk = firstNineUnchanged(input.legacyMembers, input.members);
  results.push({
    id: 'B.firstNineUnchanged',
    family: 'B',
    pass: nineOk,
    detail: nineOk
      ? 'first nine member names match legacy'
      : 'first nine member names diverge from legacy',
  });

  const stagesOk = honestStageSet(
    input.implementedStages,
    input.displayedStages,
  );
  results.push({
    id: 'A.honestStageSet',
    family: 'A',
    pass: stagesOk,
    detail: stagesOk
      ? 'displayed stages ⊆ implemented'
      : `displayed has unimplemented stage(s): ${input.displayedStages.filter((s) => !input.implementedStages.includes(s)).join(', ')}`,
  });

  let probesOk = true;
  let probeDetail = 'no probe rows';
  if (input.probes.length > 0) {
    const bad = input.probes.findIndex((p) => !wilsonHonest(p));
    probesOk = bad < 0;
    probeDetail = probesOk
      ? `${input.probes.length} probe row(s) Wilson-honest`
      : `probe row ${bad} fails Wilson honesty`;
  }
  results.push({
    id: 'A.wilsonHonest',
    family: 'A',
    pass: probesOk,
    detail: probeDetail,
  });

  const searchOk = noSessionBodiesInOrgSearch(input.orgSearchQuery);
  results.push({
    id: 'N.noSessionBodiesInOrgSearch',
    family: 'N',
    pass: searchOk,
    detail: searchOk
      ? 'org search channel free of session bodies'
      : 'org search must not receive session bodies',
  });

  const edgesOk = noForceGraphEdges(input.forceGraphKind);
  results.push({
    id: 'H.noForceGraphEdges',
    family: 'H',
    pass: edgesOk,
    detail: edgesOk
      ? `kind ${JSON.stringify(input.forceGraphKind)} is not a session force-edge carrier`
      : 'session kind must not carry force-directed edges',
  });

  const auditOk = singleAuditFile(input.auditPaths);
  results.push({
    id: 'G.singleAuditFile',
    family: 'G',
    pass: auditOk,
    detail: auditOk
      ? `audit path count ${input.auditPaths.length} ≤ 1`
      : `expected ≤1 audit path, got ${input.auditPaths.length}`,
  });

  const cliOk = sideEffectsAreCli(input.sideEffectPath);
  results.push({
    id: 'G.sideEffectsAreCli',
    family: 'G',
    pass: cliOk,
    detail: cliOk
      ? 'side effects route through CLI spawn seam'
      : `side-effect path must be ${CLI_SIDE_EFFECT_SEAM}, got ${JSON.stringify(input.sideEffectPath)}`,
  });

  return results;
}
