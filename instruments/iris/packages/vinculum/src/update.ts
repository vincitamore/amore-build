// `iris edges update` ladder — tier 0 structural / tier 1 gen inventory / tier 2
// gen → judge → validity-gated live ingest. Default tier is 0 (never surprise a
// user with a model call). Model path is the user's own amore configuration.

import type { spawn } from 'node:child_process';
import {
  AmoreBinaryMissingError,
  callAmoreJudge,
  resolveAmoreBin,
  type AmoreSpawnOptions,
} from './amore-spawn';
import {
  buildBriefUnits,
  formatJudgePrompt,
  JUDGE_JSON_SCHEMA,
  parseJudgeOutput,
  type JudgeVerdict,
} from './brief';
import { deriveAndReconcile, type DeriveResult } from './derive';
import { generateCandidates, pairKey, type GenRun } from './gen';
import { ingestVerdicts, type IngestResult } from './ingest';
import { edgeKey, isStructuralEdge } from './schema';
import { readStore } from './store';

export type UpdateTier = 0 | 1 | 2;

export interface UpdateOptions {
  orgRoot: string;
  /** Derivation tier. Default 0. */
  tier?: UpdateTier;
  /** Override amore binary (tests). */
  amoreBin?: string;
  spawnImpl?: typeof spawn;
  maxTurns?: number;
  wallMs?: number;
  batchSize?: number;
  /** Inject judge results (tests) — skips spawn when provided. */
  judgeStub?: (prompt: string, schema: object) => Promise<unknown> | unknown;
  skipBinaryCheck?: boolean;
  log?: (msg: string) => void;
}

export interface UpdateSummary {
  tier: UpdateTier;
  house: string;
  /** Structural re-derive counts (tier 0, and optionally pre-step). */
  structural?: {
    derived: number;
    added: number;
    removed: number;
    preserved: number;
    suppressed: number;
    byType: Record<string, number>;
  };
  /** Tier-1 candidate inventory (tier 1 and 2). */
  candidates?: {
    count: number;
    channels: GenRun['channels'];
    /** Present on tier 1 only — dry inventory ids. */
    ids?: string[];
  };
  /** Tier-2 judge + ingest. */
  judge?: {
    model: string | null;
    proposed: number;
    accepted: number;
    rejected: number;
    quoteGateFailed: number;
    otherDropped: number;
    added: number;
    updated: number;
    suppressed: number;
    dropReasons: { reason: string; count: number }[];
  };
  /** Machine summary counts (protocol §3 shape helpers). */
  added: number;
  updated: number;
  suppressed: number;
  byTier: Record<string, number>;
  ok: true;
}

export class UpdateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

export function parseUpdateTier(raw: string | boolean | undefined): UpdateTier {
  if (raw === undefined || raw === true || raw === '') return 0;
  const s = String(raw).trim();
  if (s === '0') return 0;
  if (s === '1') return 1;
  if (s === '2') return 2;
  throw new UpdateError('USAGE', `--tier must be 0, 1, or 2 (got ${JSON.stringify(raw)})`);
}

function countByProvenanceTier(orgRoot: string): Record<string, number> {
  const { edges } = readStore(orgRoot);
  const by: Record<string, number> = {};
  for (const e of edges) {
    const t = e.provenance.tier ?? (isStructuralEdge(e) ? 'structural' : 'unknown');
    by[t] = (by[t] ?? 0) + 1;
  }
  return by;
}

function structuralSummary(r: DeriveResult): UpdateSummary['structural'] {
  return {
    derived: r.derived,
    added: r.added,
    removed: r.removed,
    preserved: r.preserved,
    suppressed: r.suppressed,
    byType: r.byType,
  };
}

function dropReasonCounts(ingest: IngestResult): {
  quoteGateFailed: number;
  rejected: number;
  otherDropped: number;
  reasons: { reason: string; count: number }[];
} {
  const map = new Map<string, number>();
  let quoteGateFailed = 0;
  let rejected = 0;
  let otherDropped = 0;
  for (const d of ingest.dropped) {
    map.set(d.reason, (map.get(d.reason) ?? 0) + 1);
    if (d.reason.startsWith('quote not found') || d.reason.includes('quote source file not found')) {
      quoteGateFailed++;
    } else if (d.reason === 'rejected by judge') {
      rejected++;
    } else {
      otherDropped++;
    }
  }
  const reasons = [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return { quoteGateFailed, rejected, otherDropped, reasons };
}

/** Existing undirected pair keys that already have any served edge. */
function existingPairKeys(orgRoot: string): Set<string> {
  const { edges } = readStore(orgRoot);
  const keys = new Set<string>();
  for (const e of edges) {
    keys.add(pairKey(e.source, e.target));
  }
  return keys;
}

async function runJudgeBatches(
  orgRoot: string,
  run: GenRun,
  opts: UpdateOptions,
): Promise<{ verdicts: JudgeVerdict[]; modelId: string | null }> {
  const units = buildBriefUnits(orgRoot, run, { batchSize: opts.batchSize });
  const all: JudgeVerdict[] = [];
  let modelId: string | null = null;
  const log = opts.log ?? (() => {});

  if (units.length === 0) {
    return { verdicts: [], modelId: null };
  }

  // Preflight binary once when not stubbing
  if (!opts.judgeStub) {
    const bin = resolveAmoreBin(opts.amoreBin);
    const { isAmoreBinaryAvailable, AmoreBinaryMissingError: Miss } = await import('./amore-spawn');
    if (!opts.skipBinaryCheck && !isAmoreBinaryAvailable(bin)) {
      throw new Miss(bin);
    }
  }

  for (const unit of units) {
    const prompt = formatJudgePrompt(unit);
    log(`judge ${unit.unit}: ${unit.candidates.length} candidates`);
    let raw: unknown;
    if (opts.judgeStub) {
      raw = await opts.judgeStub(prompt, JUDGE_JSON_SCHEMA);
    } else {
      const spawnOpts: AmoreSpawnOptions = {
        cwd: orgRoot,
        prompt,
        jsonSchema: JUDGE_JSON_SCHEMA,
        maxTurns: opts.maxTurns,
        wallMs: opts.wallMs,
        amoreBin: opts.amoreBin,
        spawnImpl: opts.spawnImpl,
        skipBinaryCheck: opts.skipBinaryCheck,
      };
      try {
        const result = await callAmoreJudge(spawnOpts);
        raw = result.structuredOutput;
        if (result.modelId) modelId = result.modelId;
      } catch (err) {
        if (err instanceof AmoreBinaryMissingError) throw err;
        throw new UpdateError(
          'SPAWN',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    try {
      const parsed = parseJudgeOutput(raw);
      all.push(...parsed.verdicts);
    } catch (err) {
      throw new UpdateError(
        'JUDGE_OUTPUT',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { verdicts: all, modelId };
}

/**
 * Run the edges update ladder at the requested tier.
 */
export async function runEdgesUpdate(opts: UpdateOptions): Promise<UpdateSummary> {
  const tier: UpdateTier = opts.tier ?? 0;
  const orgRoot = opts.orgRoot;
  const log = opts.log ?? (() => {});

  if (tier === 0) {
    log('tier 0: structural re-derive');
    const r = deriveAndReconcile(orgRoot);
    return {
      tier: 0,
      house: orgRoot,
      structural: structuralSummary(r),
      added: r.added,
      updated: 0,
      suppressed: r.suppressed,
      byTier: countByProvenanceTier(orgRoot),
      ok: true,
    };
  }

  if (tier === 1) {
    log('tier 1: candidate generation (no land, no model)');
    const skip = existingPairKeys(orgRoot);
    const run = generateCandidates({ orgRoot, skipPairs: skip });
    return {
      tier: 1,
      house: orgRoot,
      candidates: {
        count: run.candidates.length,
        channels: run.channels,
        ids: run.candidates.map((c) => c.id),
      },
      added: 0,
      updated: 0,
      suppressed: 0,
      byTier: countByProvenanceTier(orgRoot),
      ok: true,
    };
  }

  // tier 2 — gen → judge → validity-gated live ingest
  log('tier 2: gen → judge → ingest');
  const skip = existingPairKeys(orgRoot);
  const run = generateCandidates({ orgRoot, skipPairs: skip });
  log(`candidates: ${run.candidates.length}`);

  if (run.candidates.length === 0) {
    return {
      tier: 2,
      house: orgRoot,
      candidates: { count: 0, channels: run.channels },
      judge: {
        model: null,
        proposed: 0,
        accepted: 0,
        rejected: 0,
        quoteGateFailed: 0,
        otherDropped: 0,
        added: 0,
        updated: 0,
        suppressed: 0,
        dropReasons: [],
      },
      added: 0,
      updated: 0,
      suppressed: 0,
      byTier: countByProvenanceTier(orgRoot),
      ok: true,
    };
  }

  let verdicts: JudgeVerdict[];
  let modelId: string | null;
  try {
    ({ verdicts, modelId } = await runJudgeBatches(orgRoot, run, opts));
  } catch (err) {
    if (err instanceof AmoreBinaryMissingError) {
      throw new UpdateError('AMORE_MISSING', err.message);
    }
    throw err;
  }

  // If judgeStub provided model via structured envelope shape with model field — already null.
  // Prefer model from stub payload if present is handled inside callAmoreJudge only.

  const ingest = ingestVerdicts(orgRoot, verdicts, {
    modelId,
    candidates: run.candidates,
  });
  const drops = dropReasonCounts(ingest);

  return {
    tier: 2,
    house: orgRoot,
    candidates: { count: run.candidates.length, channels: run.channels },
    judge: {
      model: modelId,
      proposed: ingest.proposed,
      accepted: ingest.accepted,
      rejected: drops.rejected,
      quoteGateFailed: drops.quoteGateFailed,
      otherDropped: drops.otherDropped,
      added: ingest.added,
      updated: ingest.updated,
      suppressed: ingest.suppressed,
      dropReasons: drops.reasons,
    },
    added: ingest.added,
    updated: ingest.updated,
    suppressed: ingest.suppressed,
    byTier: countByProvenanceTier(orgRoot),
    ok: true,
  };
}

// re-export for store skip helpers in tests
export { existingPairKeys, edgeKey };
