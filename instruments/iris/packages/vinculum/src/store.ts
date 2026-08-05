// Edge store — graph/edges.jsonl (canonical served store).
// Append for pure adds; atomic rewrite for reconcile / remove. Dedup key: (type, source, target).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Edge,
  edgeKey,
  parseEdgeJsonl,
  serializeEdge,
  validateEdge,
  VOLUME_WARD_PER_NODE,
} from './schema';

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
  tier?: string;
  node?: string;
  signal?: string;
}

export function filterEdges(edges: Edge[], f: EdgeFilter): Edge[] {
  return edges.filter(
    (e) =>
      (!f.type || e.type === f.type) &&
      (!f.tier || e.confidence === f.tier) &&
      (!f.node || e.source === f.node || e.target === f.node) &&
      (!f.signal || e.provenance.signal === f.signal),
  );
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
}

/** Remove edges matching (source, target, type) after normalization. */
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
    // type/node id invalid — treat as no match rather than throwing from schema alone
    return { removed: 0, remaining: edges.length };
  }
  const key = edgeKey(probe.edge);
  const kept = edges.filter((e) => edgeKey(e) !== key);
  const removed = edges.length - kept.length;
  if (removed > 0) rewriteEdges(orgRoot, kept);
  return { removed, remaining: kept.length };
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
