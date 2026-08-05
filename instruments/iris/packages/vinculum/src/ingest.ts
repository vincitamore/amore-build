// Live ingest of judge-accepted edges — quote gate + schema + store write.
// Flow-through doctrine: passing edges land LIVE in graph/edges.jsonl with tier
// and provenance. Suppressions are honored (suppressed keys never re-land).
// There is no approval queue.

import { hashNode, quoteAnchor } from './hash';
import type { CandidatePair } from './gen';
import { pairKey } from './gen';
import type { JudgeVerdict } from './brief';
import { JUDGE_ASSERTED_BY } from './brief';
import { verifyQuote } from './quote-gate';
import {
  type Edge,
  type EdgeType,
  type Signal,
  EDGE_TYPES,
  edgeKey,
  isEdgeType,
  validateEdge,
  MECHANISM_JUDGED,
} from './schema';
import { applyOverride, overrideMap, suppressionKeySet } from './stewardship';
import { ensureStore, readStore, rewriteEdges } from './store';

export interface IngestDrop {
  candidate_id?: string;
  source?: string;
  target?: string;
  type?: string;
  reason: string;
}

export interface IngestAccepted {
  edge: Edge;
  candidate_id?: string;
}

export interface IngestResult {
  proposed: number;
  accepted: number;
  dropped: IngestDrop[];
  added: number;
  updated: number;
  suppressed: number;
  edges: Edge[];
}

function signalForCandidate(c: CandidatePair | undefined): Signal {
  if (!c) return 'manual';
  if (c.channels.colink) return 'co-link';
  if (c.channels.raretag) return 'co-tag';
  if (c.channels.unlabeledWikilink) return 'prose-marker';
  return 'manual';
}

function normPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^.*?(knowledge|tasks|inbox|context)\//, '$1/')
    .trim();
}

/**
 * Build a served edge from an accept verdict after quote + schema gates.
 * Returns null + drop reason on failure.
 */
export function edgeFromVerdict(
  orgRoot: string,
  v: JudgeVerdict,
  opts: {
    modelId: string | null;
    candidate?: CandidatePair;
    ts?: string;
  },
): { edge: Edge } | { drop: IngestDrop } {
  const ts = opts.ts ?? new Date().toISOString();
  const drop = (reason: string): { drop: IngestDrop } => ({
    drop: {
      candidate_id: v.candidate_id,
      source: v.source,
      target: v.target,
      type: v.type,
      reason,
    },
  });

  if (v.verdict !== 'accept') {
    return drop('verdict is reject');
  }
  if (!v.type || !isEdgeType(v.type)) {
    return drop(`invalid or missing edge type: ${JSON.stringify(v.type)}`);
  }
  if (!v.source || !v.target) {
    return drop('accept requires source and target');
  }
  if (!v.quote || !v.quote_source) {
    return drop('accept requires quote and quote_source');
  }

  const source = normPath(v.source);
  const target = normPath(v.target);
  const quoteSource = normPath(v.quote_source);

  if (quoteSource !== source && quoteSource !== target) {
    return drop(`quote_source (${quoteSource}) is neither endpoint`);
  }

  const gate = verifyQuote(orgRoot, quoteSource, v.quote);
  if (!gate.ok) {
    return drop(gate.reason);
  }

  const srcHash = hashNode(orgRoot, source);
  const tgtHash = hashNode(orgRoot, target);
  if (!srcHash || !tgtHash) {
    return drop(`endpoint missing on disk: ${!srcHash ? source : target}`);
  }

  const spec = EDGE_TYPES[v.type as EdgeType];
  if (spec.payloadKey) {
    // Judge may not supply payload in this schema — skip payload-required types.
    return drop(`type ${v.type} requires payload.${spec.payloadKey}; not admitted without payload`);
  }

  const conf =
    typeof v.confidence === 'number' && v.confidence >= 0.85 ? 'asserted' : 'inferred';

  const raw = {
    source,
    target,
    type: v.type,
    confidence: conf,
    payload: null,
    evidence: { quote: gate.span, loc: quoteSource },
    provenance: {
      signal: signalForCandidate(opts.candidate),
      asserted_by: JUDGE_ASSERTED_BY,
      ts,
      tier: '2',
      mechanism: MECHANISM_JUDGED,
      source_file: quoteSource,
      ...(opts.modelId ? { model: opts.modelId } : {}),
      ...(typeof v.confidence === 'number' ? { judge_confidence: v.confidence } : {}),
    },
    verify_key: {
      src_hash: srcHash,
      tgt_hash: tgtHash,
      quote_anchor: quoteAnchor(gate.span),
    },
    refines_wikilink: opts.candidate?.linked === true,
  };

  const validated = validateEdge(raw);
  if (!validated.ok) {
    return drop(`schema: ${validated.errors.join('; ')}`);
  }
  return { edge: validated.edge };
}

/**
 * Ingest accept verdicts into the live store. Suppressions prevent re-land.
 * Non-matching existing edges are preserved. Matching keys update in place.
 */
export function ingestVerdicts(
  orgRoot: string,
  verdicts: JudgeVerdict[],
  opts: {
    modelId: string | null;
    candidates?: CandidatePair[];
    ts?: string;
  },
): IngestResult {
  ensureStore(orgRoot);
  const { edges: existing } = readStore(orgRoot);
  const suppressed = suppressionKeySet(orgRoot);
  const overrides = overrideMap(orgRoot);
  const candById = new Map((opts.candidates ?? []).map((c) => [c.id, c]));
  // also index by pair key for fallback
  const candByPair = new Map((opts.candidates ?? []).map((c) => [pairKey(c.a, c.b), c]));

  const dropped: IngestDrop[] = [];
  const accepted: IngestAccepted[] = [];
  let suppressedCount = 0;

  for (const v of verdicts) {
    if (v.verdict === 'reject') {
      dropped.push({
        candidate_id: v.candidate_id,
        reason: 'rejected by judge',
      });
      continue;
    }
    const candidate =
      candById.get(v.candidate_id) ??
      (v.source && v.target ? candByPair.get(pairKey(normPath(v.source), normPath(v.target))) : undefined);
    const built = edgeFromVerdict(orgRoot, v, {
      modelId: opts.modelId,
      candidate,
      ts: opts.ts,
    });
    if ('drop' in built) {
      dropped.push(built.drop);
      continue;
    }
    const k = edgeKey(built.edge);
    if (suppressed.has(k)) {
      suppressedCount++;
      dropped.push({
        candidate_id: v.candidate_id,
        source: built.edge.source,
        target: built.edge.target,
        type: built.edge.type,
        reason: 'suppressed — will not re-land',
      });
      continue;
    }
    accepted.push({ edge: applyOverride(built.edge, overrides.get(k)), candidate_id: v.candidate_id });
  }

  // Merge into store: update matching keys, preserve others
  const byKey = new Map(existing.map((e) => [edgeKey(e), e]));
  let added = 0;
  let updated = 0;
  for (const { edge } of accepted) {
    const k = edgeKey(edge);
    if (byKey.has(k)) {
      byKey.set(k, edge);
      updated++;
    } else {
      byKey.set(k, edge);
      added++;
    }
  }
  const finalEdges = [...byKey.values()];
  rewriteEdges(orgRoot, finalEdges);

  return {
    proposed: verdicts.length,
    accepted: accepted.length,
    dropped,
    added,
    updated,
    suppressed: suppressedCount,
    edges: finalEdges,
  };
}
