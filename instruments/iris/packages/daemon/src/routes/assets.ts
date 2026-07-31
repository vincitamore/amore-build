// ─────────────────────────────────────────────────────────────────────────────
// GET /api/assets/{*path} — routes::get_asset. Serves raw file bytes from under
// org_root, guarded by canonicalize-under-root. NON-JSON body.
//
// Legacy control flow + status ladder (order matters):
//   1. canonicalize(org_root/path)         → 404 on failure (missing).
//   2. canonicalize(org_root)              → 500 on failure.
//   3. canonical NOT under root            → 403 (traversal).
//   4. canonical is not a regular file     → 404.
//   5. else 200 with the §6 mime + `cache-control: private, max-age=300`.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { DaemonDeps } from '../contract.ts';
import { emptyStatus, raw } from './http.ts';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

/** Rust `Path::starts_with` — component-wise prefix, not raw string prefix
 *  (so `/a/bc` is NOT under `/a/b`). */
function isUnder(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function getAsset(deps: DaemonDeps, path: string): Response {
  let canonical: string;
  try {
    canonical = realpathSync(join(deps.config.orgRoot, path));
  } catch {
    return emptyStatus(404);
  }

  let root: string;
  try {
    root = realpathSync(deps.config.orgRoot);
  } catch {
    return emptyStatus(500);
  }

  if (!isUnder(canonical, root)) return emptyStatus(403);

  try {
    if (!statSync(canonical).isFile()) return emptyStatus(404);
  } catch {
    return emptyStatus(404);
  }

  const ext = extname(canonical).toLowerCase().replace(/^\./, '');
  const mime = MIME[ext] ?? 'application/octet-stream';
  const data = readFileSync(canonical);
  return raw(data, mime, { 'cache-control': 'private, max-age=300' });
}
