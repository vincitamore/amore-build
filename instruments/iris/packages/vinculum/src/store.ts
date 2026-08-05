// Edge store — graph/edges.jsonl (canonical served store).
// Append for pure adds; atomic rewrite for reconcile / remove. Dedup key: (type, source, target).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressEdges, edgeIdOf, resolveEdgeId } from './edge-id';
import {
  type Edge,
  edgeKey,
  parseEdgeJsonl,
  serializeEdge,
  validateEdge,
  VOLUME_WARD_PER_NODE,
} from './schema';
import { addSuppression, applyOverride, overrideMap, upsertOverride } from './stewardship';

export interface StoreFiles {
  dir: string;
  edges: string;
}

export function storeFiles(orgRoot: string): StoreFiles {
  const dir = join(orgRoot, 'graph');
  return { dir, edges: join(dir, 'edges.jsonl') };
}

export interface BadLine {
  line: number;
  errors: string[];
}

export interface StoreContents {
  edges: Edge[];
  badLines: BadLine[];
}

function readJsonl(path: string): { edges: Edge[]; badLines: BadLine[] } {
  if (!existsSync(path)) return { edges: [], badLines: [] };
  const parsed = parseEdgeJsonl(readFileSync(path, 'utf8'));
  const edges: Edge[] = [];
  const badLines: BadLine[] = [];
  for (const p of parsed) {
    if (p.result.ok) edges.push(p.result.edge);
    else badLines.push({ line: p.line, errors: p.result.errors });
  }
  return { edges, badLines };
}

/** Read the served store. Bad lines are surfaced, never silently dropped. */
export function readStore(orgRoot: string): StoreContents {
  const f = storeFiles(orgRoot);
  return readJsonl(f.edges);
}

/** Atomic full rewrite (tmp + rename). Edges written in stable edgeKey order. */
export function rewriteEdges(orgRoot: string, edges: Edge[]): void {
  const f = storeFiles(orgRoot);
  mkdirSync(f.dir, { recursive: true });
  const sorted = [...edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const tmp = `${f.edges}.tmp`;
  const body = sorted.map(serializeEdge).join('\n') + (sorted.length ? '\n' : '');
  writeFileSync(tmp, body);
  renameSync(tmp, f.edges);
}

/** Ensure graph/ exists with an empty edges.jsonl when missing. */
export function ensureStore(orgRoot: string): void {
  const f = storeFiles(orgRoot);
  mkdirSync(f.dir, { recursive: true });
  if (!existsSync(f.edges)) writeFileSync(f.edges, '');
}

export interface EdgeFilter {
  type?: string;
  /** Confidence tier (asserted|inferred|candidate). */
  confidence?: string;
  /**
   * Derivation ladder tier on provenance.tier (`structural` | `2` | …).
   * Also accepts `--tier` CLI alias for derivation tier.
   */
  tier?: string;
  /** structural | judged — missing mechanism treated as structural when asserted_by is structural-v0. */
  mechanism?: string;
  node?: string;
  signal?: string;
  source?: string;
  target?: string;
  assertedBy?: string;
  model?: string;
  /** Keep only the N most recent edges by provenance.ts (desc). Applied after other filters. */
  recent?: number;
  /** ISO timestamp lower bound on provenance.ts (inclusive). */
  since?: string;
}

function edgeMechanism(e: Edge): string {
  if (e.provenance.mechanism) return e.provenance.mechanism;
  if (e.provenance.asserted_by === 'structural-v0' || e.provenance.tier === 'structural') {
    return 'structural';
  }
  return 'judged';
}

export function filterEdges(edges: Edge[], f: EdgeFilter): Edge[] {
  let out = edges.filter((e) => {
    if (f.type && e.type !== f.type) return false;
    if (f.confidence && e.confidence !== f.confidence) return false;
    if (f.tier) {
      const pt = e.provenance.tier ?? '';
      const want = f.tier;
      const match =
        pt === want ||
        (want === '0' && (pt === 'structural' || pt === '0')) ||
        (want === 'structural' && (pt === 'structural' || pt === '0'));
      if (!match) return false;
    }
    if (f.mechanism && edgeMechanism(e) !== f.mechanism) return false;
    if (f.node && e.source !== f.node && e.target !== f.node) return false;
    if (f.signal && e.provenance.signal !== f.signal) return false;
    if (f.source && e.source !== f.source) return false;
    if (f.target && e.target !== f.target) return false;
    if (f.assertedBy && e.provenance.asserted_by !== f.assertedBy) return false;
    if (f.model && e.provenance.model !== f.model) return false;
    if (f.since) {
      const t = Date.parse(e.provenance.ts);
      const since = Date.parse(f.since);
      if (Number.isNaN(t) || Number.isNaN(since) || t < since) return false;
    }
    return true;
  });
  if (f.recent !== undefined && f.recent >= 0) {
    out = [...out].sort((a, b) => {
      const ta = Date.parse(a.provenance.ts);
      const tb = Date.parse(b.provenance.ts);
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    });
    out = out.slice(0, f.recent);
  }
  return out;
}

export interface StoreStats {
  served: number;
  byType: Record<string, number>;
  byTier: Record<string, number>;
  bySignal: Record<string, number>;
  byAssertedBy: Record<string, number>;
  nodes: number;
  refinesWikilink: number;
  stale: number;
  badLines: number;
  overWard: string[];
}

export function storeStats(orgRoot: string): StoreStats {
  const { edges, badLines } = readStore(orgRoot);
  const byType: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const bySignal: Record<string, number> = {};
  const byAssertedBy: Record<string, number> = {};
  const perNode = new Map<string, number>();
  let refines = 0;
  let stale = 0;
  for (const e of edges) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    byTier[e.confidence] = (byTier[e.confidence] ?? 0) + 1;
    bySignal[e.provenance.signal] = (bySignal[e.provenance.signal] ?? 0) + 1;
    byAssertedBy[e.provenance.asserted_by] = (byAssertedBy[e.provenance.asserted_by] ?? 0) + 1;
    if (e.refines_wikilink) refines++;
    if (e.stale) stale++;
    perNode.set(e.source, (perNode.get(e.source) ?? 0) + 1);
    perNode.set(e.target, (perNode.get(e.target) ?? 0) + 1);
  }
  const overWard = [...perNode.entries()]
    .filter(([, n]) => n > VOLUME_WARD_PER_NODE)
    .map(([node, n]) => `${node} (${n})`);
  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.source);
    nodeSet.add(e.target);
  }
  return {
    served: edges.length,
    byType,
    byTier,
    bySignal,
    byAssertedBy,
    nodes: nodeSet.size,
    refinesWikilink: refines,
    stale,
    badLines: badLines.length,
    overWard,
  };
}

export interface RemoveResult {
  removed: number;
  remaining: number;
  id?: string;
  edge?: Edge;
  suppression?: ReturnType<typeof addSuppression>;
}

/** Remove edges matching (source, target, type) after normalization. Records a suppression. */
export function removeEdge(orgRoot: string, source: string, target: string, type: string): RemoveResult {
  const { edges } = readStore(orgRoot);
  const probe = validateEdge({
    source,
    target,
    type,
    confidence: 'candidate',
    evidence: null,
    provenance: { signal: 'manual', asserted_by: 'remove', ts: new Date().toISOString() },
    verify_key: null,
    refines_wikilink: false,
  });
  if (!probe.ok) {
    return { removed: 0, remaining: edges.length };
  }
  const key = edgeKey(probe.edge);
  const hit = edges.find((e) => edgeKey(e) === key);
  const kept = edges.filter((e) => edgeKey(e) !== key);
  const removed = edges.length - kept.length;
  if (removed > 0 && hit) {
    rewriteEdges(orgRoot, kept);
    const suppression = addSuppression(orgRoot, hit);
    return {
      removed,
      remaining: kept.length,
      id: edgeIdOf(hit),
      edge: hit,
      suppression,
    };
  }
  return { removed: 0, remaining: edges.length };
}

export type RemoveByIdResult =
  | { ok: true; removed: 1; remaining: number; id: string; edge: Edge; suppression: ReturnType<typeof addSuppression> }
  | { ok: false; reason: 'not-found' | 'ambiguous'; remaining: number; matches?: string[] };

/** Remove one edge by stable id (or unique prefix). Suppression makes it durable across re-derive. */
export function removeEdgeById(orgRoot: string, id: string): RemoveByIdResult {
  const { edges } = readStore(orgRoot);
  const resolved = resolveEdgeId(edges, id);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, remaining: edges.length, matches: resolved.matches };
  }
  const key = edgeKey(resolved.edge);
  const kept = edges.filter((e) => edgeKey(e) !== key);
  rewriteEdges(orgRoot, kept);
  const suppression = addSuppression(orgRoot, resolved.edge);
  return {
    ok: true,
    removed: 1,
    remaining: kept.length,
    id: resolved.id,
    edge: resolved.edge,
    suppression,
  };
}

export type EditByIdResult =
  | { ok: true; id: string; edge: Edge }
  | { ok: false; reason: 'not-found' | 'ambiguous'; matches?: string[] };

/**
 * Edit user-adjustable fields (note, label) on an edge by id.
 * Writes the served store and an override record so structural re-derive preserves the edit.
 */
export function editEdgeById(
  orgRoot: string,
  id: string,
  patch: { note?: string | null; label?: string | null },
): EditByIdResult {
  const { edges } = readStore(orgRoot);
  const resolved = resolveEdgeId(edges, id);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, matches: resolved.matches };
  }
  const key = edgeKey(resolved.edge);
  let next: Edge = { ...resolved.edge };
  if (patch.note !== undefined) {
    if (patch.note === null || patch.note.trim() === '') delete next.note;
    else next.note = patch.note.trim();
  }
  if (patch.label !== undefined) {
    if (patch.label === null || patch.label.trim() === '') delete next.label;
    else next.label = patch.label.trim();
  }
  const updated = edges.map((e) => (edgeKey(e) === key ? next : e));
  rewriteEdges(orgRoot, updated);
  upsertOverride(orgRoot, next, patch);
  // Re-read override application is already on `next`; stamp from override map for consistency.
  const stamped = applyOverride(next, overrideMap(orgRoot).get(key));
  const finalEdges = updated.map((e) => (edgeKey(e) === key ? stamped : e));
  if (JSON.stringify(stamped) !== JSON.stringify(next)) rewriteEdges(orgRoot, finalEdges);
  return { ok: true, id: resolved.id, edge: stamped };
}

export function listAddressedEdges(orgRoot: string, filter: EdgeFilter = {}) {
  const { edges, badLines } = readStore(orgRoot);
  const filtered = filterEdges(edges, filter);
  return { edges: addressEdges(filtered), badLines, count: filtered.length };
}

export function showEdgeById(orgRoot: string, id: string): EditByIdResult {
  const { edges } = readStore(orgRoot);
  const resolved = resolveEdgeId(edges, id);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, matches: resolved.matches };
  return { ok: true, id: resolved.id, edge: resolved.edge };
}

export interface ValidateReport {
  ok: boolean;
  served: number;
  badLines: BadLine[];
}

export function validateStore(orgRoot: string): ValidateReport {
  const { edges, badLines } = readStore(orgRoot);
  return { ok: badLines.length === 0, served: edges.length, badLines };
}
