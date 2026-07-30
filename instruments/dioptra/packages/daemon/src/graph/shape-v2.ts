// ─────────────────────────────────────────────────────────────────────────────
// graph/shape-v2.ts — the RATIFIED v2 graph shape (ratified 2026-07-02).
//
// Applied ONLY when `params.shape === 'v2'`. Absent / 'legacy' / any other value
// yields the legacy-exact output (the byte-parity gate). Three transforms, none
// of which may leak into the legacy shape:
//
//   (1) kind:'file' nodes — a MISSING wikilink target whose resolved path has a
//       non-.md extension AND exists on disk under orgRoot becomes a `file` node
//       instead of a placeholder. Bare non-md stems (no '/') stay placeholders
//       (honest — no disk-wide stem search).
//   (2) forge type split — forge docs get type (and group, when groupBy=type)
//       'dream' if under forge/dreams/, else 'pipeline'.
//   (3) subtype field — task nodes → status value; inbox nodes → the type
//       subfolder segment; all other nodes never carry subtype.
//
// These helpers are pure; build.ts gates every call on the v2 flag.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IndexedDoc } from '../contract.ts';
import { topFolder } from './util.ts';

/** A minted v2 file node's identity (before linkCount aggregation). */
export interface FileNodeInfo {
  /** Org-relative path (forward slashes) — the node id. */
  id: string;
  /** Last path segment. */
  label: string;
  /** Top folder segment of the id. */
  folder: string;
}

/**
 * v2 transform (2): forge docs split into 'dream' (under forge/dreams/) or
 * 'pipeline'. Only call for docs whose derived docType is 'forge'.
 */
export function forgeSplit(docPath: string): 'dream' | 'pipeline' {
  return docPath.startsWith('forge/dreams/') ? 'dream' : 'pipeline';
}

/**
 * v2 transform (3): the `subtype` value for a doc node, or undefined when the
 * node carries none.
 *   - task → its `status` value (when non-null);
 *   - inbox → the second path segment when the path is `inbox/<sub>/...`;
 *   - everything else → undefined.
 */
export function docSubtype(doc: IndexedDoc): string | undefined {
  if (doc.docType === 'task') {
    return doc.status !== null ? doc.status : undefined;
  }
  if (doc.docType === 'inbox') {
    const segs = doc.path.split('/');
    // inbox/<sub>/... — needs a real leaf beyond the subfolder (length ≥ 3).
    if (segs[0] === 'inbox' && segs.length >= 3 && segs[1].length > 0) {
      return segs[1];
    }
  }
  return undefined;
}

/**
 * v2 transform (1): decide whether a MISSING wikilink target `rawLink` written
 * in `sourcePath` should mint a `file` node. Returns the node identity when it
 * qualifies, else null (caller then mints a placeholder as in legacy).
 *
 * Qualifies iff, after stripping `|label`/`#anchor`:
 *   - the target contains a '/' (bare stems stay placeholders — no stem search);
 *   - its org-relative resolution (doc-relative `./`,`../` normalized against the
 *     source's dir, else org-root-relative) stays under orgRoot;
 *   - the last segment has an extension that is present and not `md`;
 *   - the file exists on disk under orgRoot (stat check).
 */
export function fileNodeCandidate(
  rawLink: string,
  sourcePath: string,
  orgRoot: string,
): FileNodeInfo | null {
  // Strip |label and #anchor, trim (mirrors the resolver's step 0).
  let t = rawLink;
  const bar = t.indexOf('|');
  if (bar !== -1) t = t.slice(0, bar);
  const hash = t.indexOf('#');
  if (hash !== -1) t = t.slice(0, hash);
  t = t.trim();

  if (!t.includes('/')) return null; // bare stem — stays a placeholder

  let candidate: string;
  if (t.startsWith('./') || t.startsWith('../')) {
    // Doc-relative: normalize against the source doc's directory.
    const srcDir = path.posix.dirname(sourcePath);
    candidate = path.posix.normalize(path.posix.join(srcDir, t));
  } else {
    candidate = path.posix.normalize(t);
  }
  // Escapes org root, or is absolute — not a servable in-tree file.
  if (candidate.startsWith('..') || candidate.startsWith('/')) return null;

  const lastSeg = candidate.slice(candidate.lastIndexOf('/') + 1);
  const dot = lastSeg.lastIndexOf('.');
  if (dot <= 0) return null; // no extension (or dotfile) — not a file node
  const ext = lastSeg.slice(dot + 1).toLowerCase();
  if (ext.length === 0 || ext === 'md') return null;

  // Stat check under orgRoot. `candidate` has no '..'/leading-'/', so the join
  // stays inside orgRoot.
  const full = path.join(orgRoot, candidate);
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }

  return { id: candidate, label: lastSeg, folder: topFolder(candidate) };
}
