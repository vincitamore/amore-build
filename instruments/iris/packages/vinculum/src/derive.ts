// Derive reconcile — write structural edges straight into graph/edges.jsonl.
// No approval gate, no candidates queue. Re-derive is idempotent:
//   - adds newly exhibited structural edges
//   - drops structural edges whose source fact vanished
//   - never mutates edges with non-structural provenance

import { type Edge, edgeKey, isStructuralEdge } from './schema';
import { ensureStore, readStore, rewriteEdges } from './store';
import { deriveStructuralEdges } from './structural';

export interface DeriveResult {
  derived: number;
  added: number;
  removed: number;
  preserved: number;
  byType: Record<string, number>;
  edges: Edge[];
}

export function deriveAndReconcile(orgRoot: string): DeriveResult {
  ensureStore(orgRoot);
  const { edges: existing } = readStore(orgRoot);
  const preserved = existing.filter((e) => !isStructuralEdge(e));
  const preservedKeys = new Set(preserved.map(edgeKey));

  const derived = deriveStructuralEdges(orgRoot);
  // Non-structural wins on key collision — never overwrite hand / agent edges.
  const structural = derived.filter((e) => !preservedKeys.has(edgeKey(e)));

  const oldStructuralKeys = new Set(existing.filter(isStructuralEdge).map(edgeKey));
  const newStructuralKeys = new Set(structural.map(edgeKey));

  let added = 0;
  let removed = 0;
  for (const k of newStructuralKeys) if (!oldStructuralKeys.has(k)) added++;
  for (const k of oldStructuralKeys) if (!newStructuralKeys.has(k)) removed++;

  const finalEdges = [...preserved, ...structural];
  rewriteEdges(orgRoot, finalEdges);

  const byType: Record<string, number> = {};
  for (const e of structural) byType[e.type] = (byType[e.type] ?? 0) + 1;

  return {
    derived: structural.length,
    added,
    removed,
    preserved: preserved.length,
    byType,
    edges: finalEdges,
  };
}
