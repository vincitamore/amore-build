// Tier-0 structural derivers — deterministic facts only, no models.
//
// (a) blocked-by: frontmatter → depends-on
// (b) resolution: wikilink → resolved-by
// (c) body self-labels [[target]] (type) for the served 15-type set
// (d) supersedes / superseded-by frontmatter → supersedes

import { join } from 'node:path';
import { tryReadDoc } from '@amore/regula';
import { hashNode, quoteAnchor } from './hash';
import { buildDocIndex, extractWikilinkTargets, resolveTarget, type DocIndex } from './resolve';
import {
  type Edge,
  type EdgeType,
  EDGE_TYPES,
  isEdgeType,
  MECHANISM_STRUCTURAL,
  STRUCTURAL_ASSERTED_BY,
  edgeKey,
} from './schema';
import { walkDurableDocs } from './walk';

export interface DerivedEdgeInput {
  source: string;
  target: string;
  type: EdgeType;
  signal: 'frontmatter' | 'prose-marker';
  quote: string;
  loc: string;
  sourceFile: string;
  field?: string;
  line?: number;
}

function buildStructuralEdge(orgRoot: string, d: DerivedEdgeInput, now: string): Edge | null {
  if (d.source === d.target) return null;
  const srcHash = hashNode(orgRoot, d.source);
  const tgtHash = hashNode(orgRoot, d.target);
  if (!srcHash || !tgtHash) return null;
  const spec = EDGE_TYPES[d.type];
  // Risky payload-required types need a mapping at asserted — tier-0 never invents payload.
  if (spec.payloadKey) return null;

  return {
    source: d.source,
    target: d.target,
    type: d.type,
    directed: spec.directed,
    confidence: 'asserted',
    payload: null,
    evidence: { quote: d.quote, loc: d.loc },
    provenance: {
      signal: d.signal,
      asserted_by: STRUCTURAL_ASSERTED_BY,
      ts: now,
      tier: 'structural',
      mechanism: MECHANISM_STRUCTURAL,
      source_file: d.sourceFile,
      ...(d.field ? { field: d.field } : {}),
      ...(d.line !== undefined ? { line: d.line } : {}),
    },
    verify_key: {
      src_hash: srcHash,
      tgt_hash: tgtHash,
      quote_anchor: quoteAnchor(d.quote),
    },
    refines_wikilink: false,
  };
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Resolve a free-text blocked-by entry to a doc path when it names one. */
function resolveBlockedByRef(orgRoot: string, entry: string, index: DocIndex, from: string): string | null {
  const links = extractWikilinkTargets(entry);
  if (links.length > 0) {
    for (const l of links) {
      const r = resolveTarget(orgRoot, l, index, from);
      if (r) return r;
    }
    return null;
  }
  // bare path-ish tokens
  const pathish = entry.match(/(?:tasks|knowledge|inbox|context)\/[\w./-]+(?:\.md)?/);
  if (pathish) return resolveTarget(orgRoot, pathish[0], index, from);
  // whole entry as path/stem
  return resolveTarget(orgRoot, entry, index, from);
}

/**
 * Self-label grammar: `[[target]] (type)` optionally with a pipe label on the
 * wikilink. Type must be one of the 15 served types.
 */
const SELF_LABEL_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]\s*\(([a-z-]+)\)/g;

function deriveFromDoc(
  orgRoot: string,
  relPath: string,
  index: DocIndex,
  now: string,
): Edge[] {
  const abs = join(orgRoot, ...relPath.split('/'));
  const doc = tryReadDoc(abs);
  if (!doc) return [];
  const fm = doc.frontmatter as Record<string, unknown>;
  const body = doc.content;
  const out: DerivedEdgeInput[] = [];

  // (a) blocked-by → depends-on (blocked task depends on blocker)
  for (const entry of asStringList(fm['blocked-by'])) {
    const target = resolveBlockedByRef(orgRoot, entry, index, relPath);
    if (!target) continue;
    out.push({
      source: relPath,
      target,
      type: 'depends-on',
      signal: 'frontmatter',
      quote: entry,
      loc: `${relPath}:blocked-by`,
      sourceFile: relPath,
      field: 'blocked-by',
    });
  }

  // (b) resolution: wikilink → resolved-by (open item resolved by work that shipped)
  const resolution = asString(fm.resolution);
  if (resolution) {
    for (const link of extractWikilinkTargets(resolution)) {
      const target = resolveTarget(orgRoot, link, index, relPath);
      if (!target) continue;
      out.push({
        source: relPath,
        target,
        type: 'resolved-by',
        signal: 'frontmatter',
        quote: resolution,
        loc: `${relPath}:resolution`,
        sourceFile: relPath,
        field: 'resolution',
      });
    }
  }

  // (d) supersedes / superseded-by frontmatter
  for (const entry of asStringList(fm.supersedes)) {
    const targets = extractWikilinkTargets(entry);
    const refs = targets.length ? targets : [entry];
    for (const ref of refs) {
      const target = resolveTarget(orgRoot, ref, index, relPath);
      if (!target) continue;
      out.push({
        source: relPath,
        target,
        type: 'supersedes',
        signal: 'frontmatter',
        quote: entry,
        loc: `${relPath}:supersedes`,
        sourceFile: relPath,
        field: 'supersedes',
      });
    }
  }
  for (const entry of asStringList(fm['superseded-by'])) {
    const targets = extractWikilinkTargets(entry);
    const refs = targets.length ? targets : [entry];
    for (const ref of refs) {
      // A is superseded-by B ⇒ B supersedes A
      const newer = resolveTarget(orgRoot, ref, index, relPath);
      if (!newer) continue;
      out.push({
        source: newer,
        target: relPath,
        type: 'supersedes',
        signal: 'frontmatter',
        quote: entry,
        loc: `${relPath}:superseded-by`,
        sourceFile: relPath,
        field: 'superseded-by',
      });
    }
  }

  // (c) body self-labels [[target]] (type) — line numbers are 1-based within the body.
  const bodyLines = body.split(/\r?\n/);
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    SELF_LABEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SELF_LABEL_RE.exec(line)) !== null) {
      const typeRaw = m[2];
      if (!isEdgeType(typeRaw)) continue;
      if (EDGE_TYPES[typeRaw].payloadKey) continue; // need payload — skip in tier-0
      const target = resolveTarget(orgRoot, m[1].trim(), index, relPath);
      if (!target) continue;
      out.push({
        source: relPath,
        target,
        type: typeRaw,
        signal: 'prose-marker',
        quote: m[0],
        loc: `${relPath}:body`,
        sourceFile: relPath,
        line: i + 1,
      });
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const d of out) {
    const e = buildStructuralEdge(orgRoot, d, now);
    if (!e) continue;
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push(e);
  }
  return edges;
}

/** Derive all tier-0 structural edges over the house tree (does not write). */
export function deriveStructuralEdges(orgRoot: string, now: string = new Date().toISOString()): Edge[] {
  const paths = walkDurableDocs(orgRoot);
  const index = buildDocIndex(paths);
  const all: Edge[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    for (const e of deriveFromDoc(orgRoot, p, index, now)) {
      const k = edgeKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(e);
    }
  }
  return all;
}
