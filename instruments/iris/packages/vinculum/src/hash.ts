// Content hashing for verify-keys. Node ids are org-relative doc paths.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function nodeAbsPath(orgRoot: string, nodeId: string): string {
  return join(orgRoot, ...nodeId.split('/'));
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Hash a node's backing doc content; null when the doc is missing. */
export function hashNode(orgRoot: string, nodeId: string): string | null {
  const abs = nodeAbsPath(orgRoot, nodeId);
  if (!existsSync(abs)) return null;
  return sha256OfBytes(readFileSync(abs));
}

/** Read a node's backing doc content; null when missing. */
export function readNodeContent(orgRoot: string, nodeId: string): string | null {
  const abs = nodeAbsPath(orgRoot, nodeId);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

/** Short stable substring of a quote for re-finding in the source doc. */
export function quoteAnchor(quote: string, maxLen = 80): string {
  const t = quote.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen);
}
