// After-the-fact stewardship records under graph/.
// Suppressions keep removed structural edges from returning on re-derive.
// Overrides re-apply user note/label after structural re-derive (user wins).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { edgeIdOf } from './edge-id';
import { EDGE_TYPES, edgeKey, type Edge, type EdgeType, isEdgeType } from './schema';

export interface Suppression {
  source: string;
  target: string;
  type: string;
  id: string;
  removed_at: string;
  asserted_by?: string;
}

export interface Override {
  source: string;
  target: string;
  type: string;
  id: string;
  edited_at: string;
  note?: string;
  label?: string;
}

export interface StewardshipFiles {
  dir: string;
  suppressions: string;
  overrides: string;
}

export function stewardshipFiles(orgRoot: string): StewardshipFiles {
  const dir = join(orgRoot, 'graph');
  return {
    dir,
    suppressions: join(dir, 'suppressions.jsonl'),
    overrides: join(dir, 'overrides.jsonl'),
  };
}

function suppressionKey(s: Pick<Suppression, 'source' | 'target' | 'type'>): string {
  if (!isEdgeType(s.type)) return `${s.type}|${s.source}|${s.target}`;
  return edgeKey({
    source: s.source,
    target: s.target,
    type: s.type,
    directed: EDGE_TYPES[s.type].directed,
  });
}

function overrideKey(o: Pick<Override, 'source' | 'target' | 'type'>): string {
  return suppressionKey(o);
}

function readJsonlObjects(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // skip corrupt lines; validate surfaces elsewhere if needed
    }
  }
  return out;
}

function rewriteJsonl(path: string, rows: object[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function parseSuppression(raw: Record<string, unknown>): Suppression | null {
  if (typeof raw.source !== 'string' || typeof raw.target !== 'string' || typeof raw.type !== 'string') {
    return null;
  }
  if (typeof raw.removed_at !== 'string') return null;
  const id =
    typeof raw.id === 'string' && raw.id
      ? raw.id
      : edgeIdOf({ source: raw.source, target: raw.target, type: raw.type as EdgeType });
  return {
    source: raw.source,
    target: raw.target,
    type: raw.type,
    id,
    removed_at: raw.removed_at,
    ...(typeof raw.asserted_by === 'string' ? { asserted_by: raw.asserted_by } : {}),
  };
}

function parseOverride(raw: Record<string, unknown>): Override | null {
  if (typeof raw.source !== 'string' || typeof raw.target !== 'string' || typeof raw.type !== 'string') {
    return null;
  }
  if (typeof raw.edited_at !== 'string') return null;
  const id =
    typeof raw.id === 'string' && raw.id
      ? raw.id
      : edgeIdOf({ source: raw.source, target: raw.target, type: raw.type as EdgeType });
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
  return {
    source: raw.source,
    target: raw.target,
    type: raw.type,
    id,
    edited_at: raw.edited_at,
    ...(note ? { note } : {}),
    ...(label ? { label } : {}),
  };
}

export function readSuppressions(orgRoot: string): Suppression[] {
  return readJsonlObjects(stewardshipFiles(orgRoot).suppressions)
    .map(parseSuppression)
    .filter((s): s is Suppression => s !== null);
}

export function readOverrides(orgRoot: string): Override[] {
  return readJsonlObjects(stewardshipFiles(orgRoot).overrides)
    .map(parseOverride)
    .filter((o): o is Override => o !== null);
}

export function writeSuppressions(orgRoot: string, rows: Suppression[]): void {
  rewriteJsonl(stewardshipFiles(orgRoot).suppressions, rows);
}

export function writeOverrides(orgRoot: string, rows: Override[]): void {
  rewriteJsonl(stewardshipFiles(orgRoot).overrides, rows);
}

/** Keys currently suppressed (normalized edgeKey when type is known). */
export function suppressionKeySet(orgRoot: string): Set<string> {
  return new Set(readSuppressions(orgRoot).map(suppressionKey));
}

export function overrideMap(orgRoot: string): Map<string, Override> {
  const map = new Map<string, Override>();
  for (const o of readOverrides(orgRoot)) map.set(overrideKey(o), o);
  return map;
}

export function addSuppression(orgRoot: string, edge: Edge, removedAt = new Date().toISOString()): Suppression {
  const rec: Suppression = {
    source: edge.source,
    target: edge.target,
    type: edge.type,
    id: edgeIdOf(edge),
    removed_at: removedAt,
    asserted_by: edge.provenance.asserted_by,
  };
  const key = suppressionKey(rec);
  const kept = readSuppressions(orgRoot).filter((s) => suppressionKey(s) !== key);
  kept.push(rec);
  kept.sort((a, b) => suppressionKey(a).localeCompare(suppressionKey(b)));
  writeSuppressions(orgRoot, kept);
  // Drop override for the same edge — nothing left to annotate.
  const oKey = overrideKey(rec);
  const overrides = readOverrides(orgRoot).filter((o) => overrideKey(o) !== oKey);
  writeOverrides(orgRoot, overrides);
  return rec;
}

export function upsertOverride(
  orgRoot: string,
  edge: Edge,
  patch: { note?: string | null; label?: string | null },
  editedAt = new Date().toISOString(),
): Override {
  const key = edgeKey(edge);
  const existing = overrideMap(orgRoot).get(key);
  let note = existing?.note;
  let label = existing?.label;
  if (patch.note !== undefined) note = patch.note === null || patch.note.trim() === '' ? undefined : patch.note.trim();
  if (patch.label !== undefined)
    label = patch.label === null || patch.label.trim() === '' ? undefined : patch.label.trim();

  const rec: Override = {
    source: edge.source,
    target: edge.target,
    type: edge.type,
    id: edgeIdOf(edge),
    edited_at: editedAt,
    ...(note ? { note } : {}),
    ...(label ? { label } : {}),
  };

  const others = readOverrides(orgRoot).filter((o) => overrideKey(o) !== key);
  if (note || label) others.push(rec);
  others.sort((a, b) => overrideKey(a).localeCompare(overrideKey(b)));
  writeOverrides(orgRoot, others);
  return rec;
}

/** Apply override note/label onto an edge (user fields win). */
export function applyOverride(edge: Edge, o: Override | undefined): Edge {
  if (!o) return edge;
  const out: Edge = { ...edge };
  if (o.note) out.note = o.note;
  else delete out.note;
  if (o.label) out.label = o.label;
  else delete out.label;
  return out;
}

/** Filter derived edges by suppressions and stamp overrides. */
export function applyStewardship(orgRoot: string, edges: Edge[]): Edge[] {
  const suppressed = suppressionKeySet(orgRoot);
  const overrides = overrideMap(orgRoot);
  const out: Edge[] = [];
  for (const e of edges) {
    const k = edgeKey(e);
    if (suppressed.has(k)) continue;
    out.push(applyOverride(e, overrides.get(k)));
  }
  return out;
}
