// Mechanical quote gate — the validity boundary between a model claim and the store.
// An accepted edge ingests only when its supporting quote appears in the named source.
// Not an approval gate: failures drop with a reason and are counted in the run summary.

import { readNodeContent } from './hash';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the raw span of `quote` inside `doc`: exact substring first, then a
 * whitespace-tolerant match (quote tokens joined by \\s+ so line-wraps still pass).
 * Near-miss paraphrases fail. Returns the raw matched span, or null.
 */
export function findQuoteSpan(doc: string, quote: string): string | null {
  const q = quote.trim();
  if (q.length === 0) return null;
  if (doc.includes(q)) return q;
  const tokens = q.split(/\s+/).filter(Boolean).map(escapeRe);
  if (tokens.length === 0) return null;
  const m = doc.match(new RegExp(tokens.join('\\s+')));
  return m ? m[0] : null;
}

export type QuoteGateResult =
  | { ok: true; span: string; sourceFile: string }
  | { ok: false; reason: string };

/**
 * Verify that `quote` appears in the named org-relative source file under the house root.
 */
export function verifyQuote(orgRoot: string, sourceFile: string, quote: string): QuoteGateResult {
  const path = sourceFile.replace(/\\/g, '/').trim();
  if (!path) return { ok: false, reason: 'quote source path is empty' };
  const content = readNodeContent(orgRoot, path);
  if (content === null) {
    return { ok: false, reason: `quote source file not found: ${path}` };
  }
  const span = findQuoteSpan(content, quote);
  if (span === null) {
    const preview = quote.trim().slice(0, 60);
    return {
      ok: false,
      reason: `quote not found in ${path} (quote: "${preview}${quote.trim().length > 60 ? '…' : ''}")`,
    };
  }
  return { ok: true, span, sourceFile: path };
}
