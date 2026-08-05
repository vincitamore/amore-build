// Derive reconcile — write structural edges straight into graph/edges.jsonl.
// No approval gate, no candidates queue. Re-derive is idempotent:
//   - adds newly exhibited structural edges
//   - drops structural edges whose source fact vanished
//   - never mutates edges with non-structural provenance
//   - consults graph/suppressions.jsonl (removed structural edges stay gone)
//   - merges graph/overrides.jsonl (user note/label wins over deriver output)

import { type Edge, edgeKey, isStructuralEdge } from './schema';
import { applyOverride, overrideMap, suppressionKeySet } from './stewardship';
import { ensureStore, readStore, rewriteEdges } from './store';
import { deriveStructuralEdges } from './structural';

export interface DeriveResult {
  derived: number;
  added: number;
  removed: number;
  preserved: number;
  suppressed: number;
  byType: Record<string, number>;
  edges: Edge[];
}

export function deriveAndReconcile(orgRoot: string): DeriveResult {
  ensureStore(orgRoot);
  const { edges: existing } = readStore(orgRoot);
  const preserved = existing.filter((e) => !isStructuralEdge(e));
  const preservedKeys = new Set(preserved.map(edgeKey));

  const derived = deriveStructuralEdges(orgRoot);
  const suppressedKeys = suppressionKeySet(orgRoot);
  const overrides = overrideMap(orgRoot);

  // Non-structural wins on key collision — never overwrite hand / agent edges.
  // Suppressions drop structural edges that the operator removed after the fact.
  let suppressed = 0;
  const structural: Edge[] = [];
  for (const e of derived) {
    const k = edgeKey(e);
    if (preservedKeys.has(k)) continue;
    if (suppressedKeys.has(k)) {
      suppressed++;
      continue;
    }
    structural.push(applyOverride(e, overrides.get(k)));
  }

  // Non-structural edges also receive override stamps when present.
  const preservedStamped = preserved.map((e) => applyOverride(e, overrides.get(edgeKey(e))));

  const oldStructuralKeys = new Set(existing.filter(isStructuralEdge).map(edgeKey));
  const newStructuralKeys = new Set(structural.map(edgeKey));

  let added = 0;
  let removed = 0;
  for (const k of newStructuralKeys) if (!oldStructuralKeys.has(k)) added++;
  for (const k of oldStructuralKeys) if (!newStructuralKeys.has(k)) removed++;

  const finalEdges = [...preservedStamped, ...structural];
  rewriteEdges(orgRoot, finalEdges);

  const byType: Record<string, number> = {};
  for (const e of structural) byType[e.type] = (byType[e.type] ?? 0) + 1;

  return {
    derived: structural.length,
    added,
    removed,
    preserved: preservedStamped.length,
    suppressed,
    byType,
    edges: finalEdges,
  };
}
