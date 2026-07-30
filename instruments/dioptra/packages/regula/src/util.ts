import { basename, relative } from 'path';

/**
 * ISO date (YYYY-MM-DD) — the org system's date stamp, in LOCAL time.
 * Not `toISOString()`: that renders UTC, so any stamp written after ~18:00–19:00 Central
 * rolled to tomorrow's date — wrong for an org whose created/completed/resolved dates are
 * load-bearing. Local calendar date is what the operator means by "today".
 */
export function today(date: Date = new Date()): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Local ISO-style timestamp (YYYY-MM-DDTHH:mm:ss, no zone) — filename stamps, capture ids. */
export function localIso(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${today(date)}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * gray-matter/js-yaml parses an UNQUOTED YAML date (`created: 2026-05-28`) into a `Date`
 * object (at UTC midnight), not a string. Left raw, those Dates (a) scramble string sorts
 * (`String(Date)` renders "Wed May 27 2026 19:00:00 GMT-0500…" — alphabetical-by-weekday,
 * and shifted a day in any western zone), (b) leak full ISO timestamps into `--json`
 * envelopes, and (c) re-serialize as `created: 2026-05-28T00:00:00.000Z` on the next
 * `matter.stringify` — schema-noncompliant frontmatter churn on every write round-trip.
 *
 * Normalize every Date back to the string the file meant: a date-only value (UTC midnight —
 * exactly how js-yaml parses a bare date) → `YYYY-MM-DD`; a time-bearing value keeps full
 * ISO precision. Containers are rebuilt, so the result is independent of the parser's
 * internals — callers may mutate the returned structure freely.
 */
export function normalizeYamlDates(v: unknown): unknown {
  if (v instanceof Date) {
    const dateOnly =
      v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    return dateOnly ? v.toISOString().slice(0, 10) : v.toISOString();
  }
  if (Array.isArray(v)) return v.map(normalizeYamlDates);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = normalizeYamlDates(val);
    return out;
  }
  return v;
}

/** Filename slug: lowercase, runs of non-alphanumerics → '-', trimmed. (Matches examen.) */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Org-root-relative POSIX path (forward slashes) — the canonical path form in result envelopes. */
export function relPath(orgRoot: string, filePath: string): string {
  return relative(orgRoot, filePath).replace(/\\/g, '/');
}

/** A document's display title: the first H1, else the de-slugged filename. */
export function extractTitle(content: string, filePath: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return basename(filePath, '.md')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
