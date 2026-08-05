// Edge schema for graph/edges.jsonl — the single validation authority for writes.
// Types match the 15-relation set the graph renderer already paints (6 families).

export const EDGE_TYPE_NAMES = [
  'dual-of',
  'contests-at-border',
  'transmission-pair',
  'exemplifies',
  'vice-of',
  'generalizes',
  'refines',
  'supersedes',
  'resolved-by',
  'motivates',
  'depends-on',
  'analogous-to',
  'contradicts',
  'builds-on',
  'addressed-by',
] as const;
export type EdgeType = (typeof EDGE_TYPE_NAMES)[number];

/** Served tiers live in edges.jsonl; `candidate` is reserved for later agentic tiers. */
export const TIERS = ['asserted', 'inferred', 'candidate'] as const;
export type Tier = (typeof TIERS)[number];

/** How the edge was surfaced. Structural derive uses frontmatter / prose-marker. */
export const SIGNALS = [
  'prose-marker',
  'frontmatter',
  'co-tag',
  'co-change',
  'co-link',
  'embedding-neighbor',
  'manual',
] as const;
export type Signal = (typeof SIGNALS)[number];

export type PayloadKey = 'mapping' | 'discriminator' | 'constraint';

export type Family =
  | 'lattice-structural'
  | 'abstraction-ladder'
  | 'lifecycle-lift'
  | 'task-graph'
  | 'analogy-tension'
  | 'knowledge-functional';

export interface TypeSpec {
  family: Family;
  directed: boolean;
  reading: string;
  payloadKey: PayloadKey | null;
  risky: boolean;
}

export const EDGE_TYPES: Record<EdgeType, TypeSpec> = {
  'dual-of': {
    family: 'lattice-structural',
    directed: false,
    reading: 'is the dual of (same insight, opposite poles; mapping nameable)',
    payloadKey: 'mapping',
    risky: true,
  },
  'contests-at-border': {
    family: 'lattice-structural',
    directed: false,
    reading: 'contests at its border with (settled by the named discriminator)',
    payloadKey: 'discriminator',
    risky: false,
  },
  'transmission-pair': {
    family: 'lattice-structural',
    directed: false,
    reading: 'must travel paired with (excerpting one solo is the failure mode)',
    payloadKey: 'constraint',
    risky: false,
  },
  exemplifies: {
    family: 'lattice-structural',
    directed: true,
    reading: 'instance exemplifies principle (source instantiates target)',
    payloadKey: null,
    risky: false,
  },
  'vice-of': {
    family: 'lattice-structural',
    directed: true,
    reading: 'anti-pattern is the vice (negation-by-excess) of principle',
    payloadKey: null,
    risky: false,
  },
  generalizes: {
    family: 'abstraction-ladder',
    directed: true,
    reading: 'pattern generalizes the instance it was lifted from',
    payloadKey: null,
    risky: false,
  },
  refines: {
    family: 'abstraction-ladder',
    directed: true,
    reading: 'sharpener refines the sharpened (both still stand)',
    payloadKey: null,
    risky: false,
  },
  supersedes: {
    family: 'lifecycle-lift',
    directed: true,
    reading: 'new supersedes the retired old',
    payloadKey: null,
    risky: false,
  },
  'resolved-by': {
    family: 'lifecycle-lift',
    directed: true,
    reading: 'open item is resolved by the work that shipped',
    payloadKey: null,
    risky: false,
  },
  motivates: {
    family: 'lifecycle-lift',
    directed: true,
    reading: 'decision/investigation motivates the task that implements it',
    payloadKey: null,
    risky: false,
  },
  'depends-on': {
    family: 'task-graph',
    directed: true,
    reading: 'blocked depends on blocker',
    payloadKey: null,
    risky: false,
  },
  'analogous-to': {
    family: 'analogy-tension',
    directed: false,
    reading: 'is structurally analogous to (correspondence named in the mapping)',
    payloadKey: 'mapping',
    risky: true,
  },
  contradicts: {
    family: 'analogy-tension',
    directed: false,
    reading: 'asserts a claim incompatible with (surfaced for reconciliation)',
    payloadKey: null,
    risky: true,
  },
  'builds-on': {
    family: 'knowledge-functional',
    directed: true,
    reading: 'builder builds on foundation (uses its component/pattern/mechanism)',
    payloadKey: null,
    risky: false,
  },
  'addressed-by': {
    family: 'knowledge-functional',
    directed: true,
    reading: 'problem doc is addressed by solution doc',
    payloadKey: null,
    risky: false,
  },
};

export const VOLUME_WARD_PER_NODE = 12;

/** Marker written on every tier-0 structural edge; reconcile only rewrites these. */
export const STRUCTURAL_ASSERTED_BY = 'structural-v0';

export interface EdgeEvidence {
  quote: string;
  /** Org-relative path, optionally `:line` or `:field`. */
  loc: string;
}

export interface EdgeProvenance {
  signal: Signal;
  asserted_by: string;
  model?: string;
  ts: string;
  judge_confidence?: number;
  /** Structural derivation tier label (tier-0 writes `structural`). */
  tier?: string;
  /** Org-relative source file that exhibited the fact. */
  source_file?: string;
  /** Frontmatter field name, when the exhibit is a field. */
  field?: string;
  /** 1-based line number in the source file, when the exhibit is a body line. */
  line?: number;
}

export interface EdgeVerifyKey {
  src_hash: string;
  tgt_hash: string;
  quote_anchor: string;
}

export interface Edge {
  source: string;
  target: string;
  type: EdgeType;
  directed: boolean;
  confidence: Tier;
  payload: Partial<Record<PayloadKey, string>> | null;
  evidence: EdgeEvidence | null;
  provenance: EdgeProvenance;
  verify_key: EdgeVerifyKey | null;
  refines_wikilink: boolean;
  stale?: boolean;
}

export function isValidNodeId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id.startsWith('lattice:')) return id.length > 'lattice:'.length;
  return (
    id.endsWith('.md') &&
    !id.includes('\\') &&
    !id.startsWith('/') &&
    !id.includes('..') &&
    !/^[A-Za-z]:/.test(id)
  );
}

export function normalizeEdge(e: Edge): Edge {
  const spec = EDGE_TYPES[e.type];
  const out: Edge = { ...e, directed: spec.directed };
  if (!spec.directed && out.source > out.target) {
    const s = out.source;
    out.source = out.target;
    out.target = s;
    if (out.verify_key) {
      out.verify_key = {
        ...out.verify_key,
        src_hash: out.verify_key.tgt_hash,
        tgt_hash: out.verify_key.src_hash,
      };
    }
  }
  return out;
}

/** Canonical identity after normalization: (type, source, target). */
export function edgeKey(e: Pick<Edge, 'source' | 'target' | 'type' | 'directed'> & { type: EdgeType }): string {
  const n = normalizeEdge({
    source: e.source,
    target: e.target,
    type: e.type,
    directed: EDGE_TYPES[e.type].directed,
    confidence: 'asserted',
    payload: null,
    evidence: null,
    provenance: { signal: 'manual', asserted_by: 'key', ts: '1970-01-01T00:00:00.000Z' },
    verify_key: null,
    refines_wikilink: false,
  });
  return `${n.type}|${n.source}|${n.target}`;
}

export interface ValidationOk {
  ok: true;
  edge: Edge;
}
export interface ValidationFail {
  ok: false;
  errors: string[];
}
export type ValidationResult = ValidationOk | ValidationFail;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate an unknown object against the schema. Returns the NORMALIZED edge on
 * success. Served tiers (asserted/inferred) require evidence + verify_key;
 * payload-bearing types require their payload at served tiers.
 */
export function validateEdge(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['edge must be an object'] };

  const type = raw.type;
  if (!nonEmptyString(type) || !(EDGE_TYPE_NAMES as readonly string[]).includes(type)) {
    return { ok: false, errors: [`unknown type: ${JSON.stringify(raw.type)}`] };
  }
  const spec = EDGE_TYPES[type as EdgeType];

  const source = raw.source;
  const target = raw.target;
  if (!nonEmptyString(source) || !isValidNodeId(source)) {
    errors.push(`invalid source node id: ${JSON.stringify(source)}`);
  }
  if (!nonEmptyString(target) || !isValidNodeId(target)) {
    errors.push(`invalid target node id: ${JSON.stringify(target)}`);
  }
  if (nonEmptyString(source) && source === target) errors.push('self-edge (source === target)');

  if (raw.directed !== undefined && typeof raw.directed !== 'boolean') {
    errors.push('directed must be a boolean when present');
  } else if (typeof raw.directed === 'boolean' && raw.directed !== spec.directed) {
    errors.push(`directed=${raw.directed} contradicts type ${type} (spec says ${spec.directed})`);
  }

  const confidence = raw.confidence;
  if (!nonEmptyString(confidence) || !(TIERS as readonly string[]).includes(confidence)) {
    errors.push(`invalid confidence tier: ${JSON.stringify(confidence)} (expected ${TIERS.join('|')})`);
  }
  const tier = confidence as Tier;
  const served = tier === 'asserted' || tier === 'inferred';

  let payload: Partial<Record<PayloadKey, string>> | null = null;
  if (raw.payload !== undefined && raw.payload !== null) {
    if (!isRecord(raw.payload)) {
      errors.push('payload must be an object or null');
    } else {
      const keys = Object.keys(raw.payload);
      for (const k of keys) {
        if (k !== spec.payloadKey) errors.push(`payload key "${k}" not allowed for type ${type}`);
      }
      if (spec.payloadKey && nonEmptyString(raw.payload[spec.payloadKey])) {
        payload = { [spec.payloadKey]: (raw.payload[spec.payloadKey] as string).trim() };
      }
    }
  }
  if (spec.payloadKey && served && !payload) {
    errors.push(`type ${type} requires payload.${spec.payloadKey} at tier ${tier}`);
  }

  if (spec.risky && tier === 'inferred' && !spec.payloadKey) {
    errors.push(`risky payload-less type ${type} admits only asserted (or stage as candidate)`);
  }

  let evidence: EdgeEvidence | null = null;
  if (raw.evidence !== undefined && raw.evidence !== null) {
    if (!isRecord(raw.evidence) || !nonEmptyString(raw.evidence.quote) || !nonEmptyString(raw.evidence.loc)) {
      errors.push('evidence must be { quote, loc } with non-empty strings');
    } else {
      evidence = { quote: raw.evidence.quote, loc: raw.evidence.loc };
    }
  }
  if (served && !evidence) errors.push(`tier ${tier} requires evidence { quote, loc } — no exhibit, no edge`);

  let provenance: EdgeProvenance | null = null;
  if (!isRecord(raw.provenance)) {
    errors.push('provenance is required ({ signal, asserted_by, ts })');
  } else {
    const p = raw.provenance;
    if (!nonEmptyString(p.signal) || !(SIGNALS as readonly string[]).includes(p.signal)) {
      errors.push(`invalid provenance.signal: ${JSON.stringify(p.signal)}`);
    }
    if (!nonEmptyString(p.asserted_by)) errors.push('provenance.asserted_by is required');
    if (!nonEmptyString(p.ts) || Number.isNaN(Date.parse(p.ts))) {
      errors.push('provenance.ts must be an ISO timestamp');
    }
    if (p.judge_confidence !== undefined) {
      if (
        typeof p.judge_confidence !== 'number' ||
        !Number.isFinite(p.judge_confidence) ||
        p.judge_confidence < 0 ||
        p.judge_confidence > 1
      ) {
        errors.push('provenance.judge_confidence must be a number in [0,1]');
      }
    }
    if (p.line !== undefined && (typeof p.line !== 'number' || !Number.isInteger(p.line) || p.line < 1)) {
      errors.push('provenance.line must be a positive integer when present');
    }
    provenance = {
      signal: p.signal as Signal,
      asserted_by: p.asserted_by as string,
      ts: p.ts as string,
      ...(nonEmptyString(p.model) ? { model: p.model } : {}),
      ...(typeof p.judge_confidence === 'number' ? { judge_confidence: p.judge_confidence } : {}),
      ...(nonEmptyString(p.tier) ? { tier: p.tier } : {}),
      ...(nonEmptyString(p.source_file) ? { source_file: p.source_file } : {}),
      ...(nonEmptyString(p.field) ? { field: p.field } : {}),
      ...(typeof p.line === 'number' ? { line: p.line } : {}),
    };
  }

  let verify_key: EdgeVerifyKey | null = null;
  if (raw.verify_key !== undefined && raw.verify_key !== null) {
    if (
      !isRecord(raw.verify_key) ||
      !nonEmptyString(raw.verify_key.src_hash) ||
      !nonEmptyString(raw.verify_key.tgt_hash) ||
      !nonEmptyString(raw.verify_key.quote_anchor)
    ) {
      errors.push('verify_key must be { src_hash, tgt_hash, quote_anchor } with non-empty strings');
    } else {
      verify_key = {
        src_hash: raw.verify_key.src_hash,
        tgt_hash: raw.verify_key.tgt_hash,
        quote_anchor: raw.verify_key.quote_anchor,
      };
    }
  }
  if (served && !verify_key) errors.push(`tier ${tier} requires verify_key`);

  if (raw.refines_wikilink !== undefined && typeof raw.refines_wikilink !== 'boolean') {
    errors.push('refines_wikilink must be a boolean');
  }
  if (raw.stale !== undefined && typeof raw.stale !== 'boolean') {
    errors.push('stale must be a boolean');
  }

  if (errors.length > 0) return { ok: false, errors };

  const edge: Edge = normalizeEdge({
    source: source as string,
    target: target as string,
    type: type as EdgeType,
    directed: spec.directed,
    confidence: tier,
    payload,
    evidence,
    provenance: provenance!,
    verify_key,
    refines_wikilink: raw.refines_wikilink === true,
    ...(raw.stale === true ? { stale: true } : {}),
  });
  return { ok: true, edge };
}

/** Stable field order so JSONL lines diff cleanly. */
export function serializeEdge(e: Edge): string {
  const ordered: Record<string, unknown> = {
    source: e.source,
    target: e.target,
    type: e.type,
    directed: e.directed,
    confidence: e.confidence,
  };
  if (e.payload) ordered.payload = e.payload;
  if (e.evidence) ordered.evidence = e.evidence;
  ordered.provenance = e.provenance;
  if (e.verify_key) ordered.verify_key = e.verify_key;
  ordered.refines_wikilink = e.refines_wikilink;
  if (e.stale) ordered.stale = true;
  return JSON.stringify(ordered);
}

export interface ParsedLine {
  line: number;
  result: ValidationResult;
}

/** Parse a JSONL document of edges; every non-blank line is validated. */
export function parseEdgeJsonl(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      out.push({
        line: i + 1,
        result: { ok: false, errors: [`invalid JSON: ${(err as Error).message}`] },
      });
      continue;
    }
    out.push({ line: i + 1, result: validateEdge(raw) });
  }
  return out;
}

export function isStructuralEdge(e: Edge): boolean {
  return e.provenance.asserted_by === STRUCTURAL_ASSERTED_BY || e.provenance.tier === 'structural';
}

export function isEdgeType(s: string): s is EdgeType {
  return (EDGE_TYPE_NAMES as readonly string[]).includes(s);
}
