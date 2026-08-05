// ─────────────────────────────────────────────────────────────────────────────
// core/serialize.ts — IndexedDoc → WireDoc (the files-list / search / get_file
// payload). Reproduces the legacy Regime-B (BTreeMap → alphabetical keys)
// serialization + the §0.4 presence rules.
//
// Presence:
//   - created / status / updated : ALWAYS present (JSON null when absent).
//   - backlinks / links / tags / path / title / type : always present.
//   - excerpt + forge extras (pipeline/recipe/role/layer/goal/triggeredBy/
//     reviewStatus/dreamAction/signature) : omit when absent.
//   - content : only when opts.content is provided (get_file).
//   - resolvedBacklinks / resolvedOutbound : only when provided (get_file).
//
// Keys are inserted in ASCII-lexicographic order so JSON.stringify emits them in
// Rust `BTreeMap` order (all keys are ASCII → plain byte order). Confirmed against
// the live daemon, including `triggeredBy` sorting between `title` and `type`.
// Regime B alphabetizes NESTED object keys too (`to_value` maps every object to a
// BTreeMap) — so `signature`'s keys are deep-sorted here (live-confirmed: a
// signed manifest serves algorithm, content-hash, sig, signer, timestamp —
// not the raw-file order).
// ─────────────────────────────────────────────────────────────────────────────

import type { IndexedDoc, ResolvedBacklink, ResolvedOutbound, WireDoc } from '../contract';

/** Recursively rebuild objects with ASCII-sorted keys (arrays keep element order). */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return v;
}

export function serializeDoc(
  doc: IndexedDoc,
  opts?: { content?: string; resolvedBacklinks?: ResolvedBacklink[]; resolvedOutbound?: ResolvedOutbound[] },
): WireDoc {
  const out: Record<string, unknown> = {};

  out.backlinks = doc.backlinks;
  if (opts?.content !== undefined) out.content = opts.content;
  out.created = doc.created;
  if (doc.dreamAction !== undefined) out.dreamAction = doc.dreamAction;
  if (doc.excerpt !== undefined) out.excerpt = doc.excerpt;
  if (doc.goal !== undefined) out.goal = doc.goal;
  if (doc.layer !== undefined) out.layer = doc.layer;
  out.links = doc.links;
  out.path = doc.path;
  if (doc.pipeline !== undefined) out.pipeline = doc.pipeline;
  if (doc.recipe !== undefined) out.recipe = doc.recipe;
  if (opts?.resolvedBacklinks !== undefined) out.resolvedBacklinks = opts.resolvedBacklinks;
  if (opts?.resolvedOutbound !== undefined) out.resolvedOutbound = opts.resolvedOutbound;
  if (doc.reviewStatus !== undefined) out.reviewStatus = doc.reviewStatus;
  if (doc.role !== undefined) out.role = doc.role;
  if (doc.signature !== undefined) out.signature = sortKeysDeep(doc.signature);
  out.status = doc.status;
  out.tags = doc.tags;
  out.title = doc.title;
  // `triggeredBy` is a legacy wire key (spec §0.4, live-confirmed) that the frozen
  // WireDoc interface omits — emit it at its alphabetical slot (title < triggeredBy
  // < type) so forge docs stay parity-faithful. See the contract patch in the
  // builder summary. The cast-through below keeps this runtime-correct.
  if (doc.triggeredBy !== undefined) out.triggeredBy = doc.triggeredBy;
  out.type = doc.docType;
  out.updated = doc.updated;

  return out as unknown as WireDoc;
}
