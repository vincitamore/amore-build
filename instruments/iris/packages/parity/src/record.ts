// The recorder. Fires every core case against a base daemon SEQUENTIALLY (the
// live daemon serves other agents — no parallel flood), writes one golden record
// per case, and a run manifest. Read-only GETs only.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { CASES } from './cases';
import { fetchCase, HttpError } from './http';
import {
  type GoldenRecord,
  type Manifest,
  type ManifestEntry,
  MANIFEST_FILE,
  recordPath,
  recordAbsPath,
  hashBody,
  serializeRecord,
} from './manifest';
import { endpointSlug } from './inventory';
import { join } from 'node:path';

export interface RecordResult {
  base: string;
  goldenDir: string;
  caseCount: number;
  totalBytes: number;
  entries: ManifestEntry[];
}

/**
 * Record all core cases against `base` into `goldenDir`. Clears the dir first so
 * a run is a clean snapshot (goldens are ephemeral). Throws HttpError on the
 * FIRST unreachable/timed-out request so a dead base fails fast.
 */
export async function record(base: string, goldenDir: string): Promise<RecordResult> {
  if (existsSync(goldenDir)) rmSync(goldenDir, { recursive: true, force: true });
  mkdirSync(goldenDir, { recursive: true });

  const entries: ManifestEntry[] = [];
  let totalBytes = 0;

  for (const c of CASES) {
    let resp;
    try {
      resp = await fetchCase(base, c.method, c.path);
    } catch (e) {
      if (e instanceof HttpError) {
        throw new HttpError(e.code, `recording ${c.method} ${c.path}: ${e.message}`);
      }
      throw e;
    }

    const bodyHash = hashBody(resp.bodyKind, resp.body);
    const rec: GoldenRecord = {
      case: { id: c.id, endpoint: c.endpoint, method: c.method, path: c.path, desc: c.desc },
      request: { method: c.method, path: c.path },
      status: resp.status,
      contentType: resp.contentType,
      bodyKind: resp.bodyKind,
      body: resp.body,
      bodyHash,
    };

    const abs = recordAbsPath(goldenDir, c);
    mkdirSync(dirname(abs), { recursive: true });
    const serialized = serializeRecord(rec);
    writeFileSync(abs, serialized);
    totalBytes += Buffer.byteLength(serialized);

    entries.push({
      id: c.id,
      endpoint: c.endpoint,
      slug: endpointSlug(c.endpoint),
      file: recordPath(c),
      status: resp.status,
      bodyKind: resp.bodyKind,
      bodyHash,
    });
  }

  const manifest: Manifest = {
    tool: 'vitrum-parity',
    version: 1,
    recordedAt: new Date().toISOString(),
    base,
    caseCount: entries.length,
    entries,
  };
  const manifestStr = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(goldenDir, MANIFEST_FILE), manifestStr);
  totalBytes += Buffer.byteLength(manifestStr);

  return { base, goldenDir, caseCount: entries.length, totalBytes, entries };
}
