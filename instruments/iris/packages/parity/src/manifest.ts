// ─────────────────────────────────────────────────────────────────────────────
// Golden record + run-manifest SCHEMA. The schema is tracked spec; the instances
// it describes live under golden/ and are gitignored (ephemeral). This file also
// carries the canonical body serialization (sorted keys) + hashing + on-disk
// layout used by both the recorder and the replayer.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { endpointSlug } from './inventory';
import type { Case } from './cases';

export type BodyKind = 'json' | 'raw' | 'binary';

export interface GoldenRecord {
  case: { id: string; endpoint: string; method: string; path: string; desc: string };
  request: { method: string; path: string };
  status: number;
  contentType: string | null;
  bodyKind: BodyKind;
  /** Parsed value (json) · raw UTF-8 string (raw) · base64 (binary). */
  body: unknown;
  /** sha256 of the canonical body serialization. */
  bodyHash: string;
}

export interface ManifestEntry {
  id: string;
  endpoint: string;
  slug: string;
  /** golden-dir-relative path to the record file. */
  file: string;
  status: number;
  bodyKind: BodyKind;
  bodyHash: string;
}

export interface Manifest {
  tool: 'vitrum-parity';
  version: 1;
  recordedAt: string;
  base: string;
  caseCount: number;
  entries: ManifestEntry[];
}

export const MANIFEST_FILE = 'manifest.json';

/** golden-dir-relative record path for a case: `<endpoint-slug>/<case-id>.json`. */
export function recordPath(c: Case): string {
  return `${endpointSlug(c.endpoint)}/${c.id}.json`;
}

/** Absolute record path under a golden dir. */
export function recordAbsPath(goldenDir: string, c: Case): string {
  return join(goldenDir, endpointSlug(c.endpoint), `${c.id}.json`);
}

/**
 * Canonicalize a value to a stable string. Objects get SORTED KEYS at every
 * depth so two structurally-equal bodies serialize identically (stable diffs +
 * stable hashes); arrays keep their order (order is significant).
 */
export function canonicalize(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

export function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
  return out;
}

export function hashBody(bodyKind: BodyKind, body: unknown): string {
  const material = bodyKind === 'json' ? canonicalize(body) : String(body);
  return createHash('sha256').update(material).digest('hex');
}

/** Pretty-print a golden record for on-disk storage (sorted keys throughout). */
export function serializeRecord(rec: GoldenRecord): string {
  return JSON.stringify(sortKeys(rec), null, 2) + '\n';
}
