// ─────────────────────────────────────────────────────────────────────────────
// core/parse.ts — one markdown file → IndexedDoc.
//
// Frontmatter is acquired through @selene/regula's `tryReadDoc` (the cache-skipped
// gray-matter path + real YAML for arrays/nested), with a lenient line-parser
// fallback for the forge dream manifests that strict js-yaml rejects (unquoted
// colon in a `goal:` value) — legacy recovers those via `fix_yaml_unquoted_colons`
// + serde_yaml, so we must too or ~139 forge manifests would index blank.
//
// title / excerpt / links / type / body follow the LEGACY rules from
// src-tauri/src/server/document.rs — NOT regula's helpers (regula's extractTitle
// trims + Title-Cases the fallback; legacy keeps the raw H1 capture and the raw
// file stem). Verified against the live daemon: `tags/tier-b-plus.md` serves title
// "# Tier B Plus" because its H1 line is literally `# # Tier B Plus` and the legacy
// regex `^#\s+(.+)$` captures `# Tier B Plus` (no trim).
//
// DATE HAZARD (empirically confirmed vs live daemon 2026-07-02): legacy serde_yaml
// reads created/updated/started into Option<String>, keeping the scalar VERBATIM —
// the live wire carries `created: 2026-07-02T00:00:00.000Z` and `updated:
// 2026-04-22T21:30` exactly as written. regula's `normalizeYamlDates` (js-yaml Date
// → string) would collapse the former to `2026-07-02` (all-zero UTC → treated
// date-only) and inflate the latter to `2026-04-22T21:30:00.000Z`. So these three
// fields are read as RAW scalars off the YAML block, never through regula's
// normalized frontmatter.
//
// ALL-OR-NOTHING HAZARD (live-confirmed 2026-07-02): legacy's frontmatter parse is
// `serde_yaml::from_str::<Frontmatter>(&fixed_yaml)` with
// `Err(_) => Frontmatter::default()` — a single typed-field mismatch (e.g.
// `tags: 'a, b'` string-form where Option<Vec<String>> is expected) voids the
// ENTIRE struct: type falls back to the path segment, created/updated serve null
// even though the raw YAML carries them, tags [], no forge extras. Unknown fields
// (`source:`, `title:`, `generated:`…) do NOT void — serde ignores them (no
// deny_unknown_fields). Scalar sequence elements deserialize to their raw text
// (`tags: [.., 413, ..]` → "413"). `validateFrontmatterStruct` replicates this.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tryReadDoc } from '@selene/regula';
import type { IndexedDoc } from '../contract';

/** Scalar in the YAML sense as js-yaml surfaces it: string/number/boolean/Date/null. */
const isYamlScalar = (v: unknown): boolean =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date;

/**
 * Render a js-yaml scalar the way serde_yaml renders it into a `String` — raw
 * scalar text. Numbers/booleans stringify (`413` → `"413"`); a Date (js-yaml's
 * unquoted-date artifact) renders back to its source-text form (date-only UTC →
 * `YYYY-MM-DD`, else full ISO). undefined for null/non-scalars.
 */
const scalarToString = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) {
    const dateOnly =
      v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    return dateOnly ? v.toISOString().slice(0, 10) : v.toISOString();
  }
  return undefined;
};

const asNum = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
};

/** Fields legacy's serde `Frontmatter` struct types as `Option<String>`. */
const STRING_FIELDS = [
  'type',
  'status',
  'created',
  'updated',
  'started',
  'pipeline',
  'recipe',
  'goal',
  'role',
  'triggered-by',
  'dream-action',
  'review-status',
] as const;

/**
 * Replicate legacy's all-or-nothing frontmatter deserialization (see the
 * ALL-OR-NOTHING HAZARD header note). Returns the map when the serde struct would
 * deserialize; null when it would error → `Frontmatter::default()` (every field
 * voided). Rules mirrored from the `document.rs` struct:
 *   - Option<String> fields: absent/null/scalar OK; sequence or map → void.
 *   - tags (Option<Vec<String>>): absent/null OK; must be a sequence of NON-NULL
 *     scalars; a plain string, or any null/sequence/map element → void.
 *   - layer (Option<u32>): absent/null OK; non-negative integer within u32 (or a
 *     digit-string — the lenient path surfaces numbers as strings) → OK; else void.
 *   - signature (Option<SignatureBlock>): absent/null/map OK; scalar or sequence →
 *     void. (SignatureBlock's inner shape is not re-validated — corpus signature
 *     blocks are well-formed; a field-level mismatch would void in legacy too.)
 */
export function validateFrontmatterStruct(fm: Record<string, unknown>): Record<string, unknown> | null {
  for (const k of STRING_FIELDS) {
    const v = fm[k];
    if (v !== undefined && !isYamlScalar(v)) return null;
  }
  const tags = fm.tags;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) return null;
    for (const el of tags) {
      if (el === null || !isYamlScalar(el)) return null;
    }
  }
  const layer = fm.layer;
  if (layer !== undefined && layer !== null) {
    if (typeof layer === 'number') {
      if (!Number.isInteger(layer) || layer < 0 || layer > 0xffffffff) return null;
    } else if (typeof layer === 'string') {
      if (!/^\d+$/.test(layer.trim()) || Number(layer) > 0xffffffff) return null;
    } else {
      return null;
    }
  }
  const sig = fm.signature;
  if (sig !== undefined && sig !== null) {
    if (typeof sig !== 'object' || Array.isArray(sig) || sig instanceof Date) return null;
  }
  return fm;
}

/**
 * Split lines exactly like Rust's `str::lines()`: split on `\n`, drop a single
 * trailing `\r` per line, and omit the final empty segment produced by a trailing
 * newline. Load-bearing for byte-faithful title/excerpt parity on CRLF files.
 */
export function rustLines(s: string): string[] {
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * Port of `document.rs::split_frontmatter`. Strips a leading BOM, requires the
 * first line to be exactly `---`, then scans for a closing `---` line (CR-tolerant).
 * Returns `{ yaml, body }`; `yaml` is null when there is no well-formed block, in
 * which case `body` is the ORIGINAL content (BOM included) — matching legacy.
 */
export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const s = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  if (!s.startsWith('---')) return { yaml: null, body: content };
  const nl = s.indexOf('\n');
  if (nl === -1) return { yaml: null, body: content };
  const afterOpen = nl + 1;
  if (s.slice(0, afterOpen).trim() !== '---') return { yaml: null, body: content };
  const rest = s.slice(afterOpen);
  let pos = 0;
  while (pos < rest.length) {
    let lineEnd = rest.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = rest.length;
    const line = rest.slice(pos, lineEnd).replace(/\r+$/, '');
    if (line === '---') {
      const yaml = rest.slice(0, pos);
      const bodyStart = lineEnd < rest.length ? lineEnd + 1 : rest.length;
      return { yaml, body: rest.slice(bodyStart) };
    }
    pos = lineEnd < rest.length ? lineEnd + 1 : rest.length;
  }
  return { yaml: null, body: content };
}

/** Body with the frontmatter block stripped — legacy `document.rs::extract_body`. */
export function extractBody(raw: string): string {
  return splitFrontmatter(raw).body;
}

/**
 * Legacy `document.rs::extract_title`: first line matching `^#\s+(.+)$`, capture
 * group 1 VERBATIM (no trim — this is why `# # Tier B Plus` is served whole); else
 * the raw file stem (last path segment minus its final extension). Operates on the
 * FULL raw content, including frontmatter, exactly as legacy does.
 */
export function extractTitle(content: string, absPath: string): string {
  for (const line of rustLines(content)) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1];
  }
  const name = basename(absPath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Legacy `document.rs::extract_wikilinks`: regex `\[\[([^\]|]+)(?:\|[^\]]+)?\]\]`,
 * capture group 1, document order, NOT deduped, `|label` stripped, `#anchor` KEPT.
 * Runs over the full raw content (frontmatter included), matching legacy.
 */
export function extractWikilinks(content: string): string[] {
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

/**
 * Legacy `document.rs::compute_excerpt`: first prose line of the body (skips blank
 * / `#` / `---` / `> ` lines), internal whitespace collapsed to single spaces, cut
 * at 120 Unicode scalar chars. undefined when there is no prose line.
 */
export function computeExcerpt(content: string): string | undefined {
  const { body } = splitFrontmatter(content);
  let chosen: string | undefined;
  for (const line of rustLines(body)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('---') || t.startsWith('> ')) continue;
    chosen = t;
    break;
  }
  if (chosen === undefined) return undefined;
  const collapsed = chosen.split(/\s+/).filter((x) => x.length > 0).join(' ');
  if (collapsed === '') return undefined;
  const chars = Array.from(collapsed);
  return chars.length <= 120 ? collapsed : chars.slice(0, 120).join('');
}

/**
 * Legacy `document.rs::infer_type`: frontmatter `type` (lowercased + mapped) wins;
 * else the top-level path segment maps; else `other`.
 */
export function inferType(fmType: unknown, relPath: string): string {
  if (typeof fmType === 'string') {
    switch (fmType.toLowerCase()) {
      case 'task':
        return 'task';
      case 'knowledge':
        return 'knowledge';
      case 'inbox':
        return 'inbox';
      case 'reminder':
        return 'reminder';
      case 'project':
        return 'project';
      case 'tag-index':
      case 'tag':
        return 'tag';
      case 'forge':
      case 'dream':
        return 'forge';
      case 'archive':
        return 'archive';
      case 'scratchpad':
        return 'scratchpad';
      default:
        break;
    }
  }
  switch (relPath.split('/')[0] ?? '') {
    case 'tasks':
      return 'task';
    case 'knowledge':
      return 'knowledge';
    case 'inbox':
      return 'inbox';
    case 'reminders':
      return 'reminder';
    case 'projects':
      return 'project';
    case 'tags':
      return 'tag';
    case 'forge':
      return 'forge';
    case 'archive':
      return 'archive';
    case 'scratchpad':
      return 'scratchpad';
    default:
      return 'other';
  }
}

/**
 * Read a top-level `key:` scalar off the raw YAML block as serde_yaml would render
 * it into a `String` — the verbatim scalar text, unquoted, inline-comment trimmed.
 * This preserves the exact date string the legacy daemon serves (see DATE HAZARD).
 */
export function rawScalarField(yaml: string, key: string): string | undefined {
  for (const line of rustLines(yaml)) {
    if (line.startsWith(' ') || line.startsWith('\t')) continue; // indented = nested, not ours
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    const val = line.slice(idx + 1).trim();
    if (val === '') return undefined;
    return rawScalarText(val);
  }
  return undefined;
}

/**
 * Render one raw YAML scalar token to the text serde_yaml would hand a `String`:
 * quoted → unquoted content; plain → verbatim with a trailing inline comment
 * (` #…`) trimmed.
 */
function rawScalarText(valIn: string): string {
  const val = valIn;
  if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
    return val.slice(1, -1).replace(/\\"/g, '"');
  }
  if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
    return val.slice(1, -1).replace(/''/g, "'");
  }
  const c = val.indexOf(' #'); // YAML inline comment requires a leading space
  return c !== -1 ? val.slice(0, c).trimEnd() : val;
}

/**
 * Parse a top-level `key:` BLOCK MAP off the raw YAML text with raw-scalar-text
 * semantics on every leaf — the nested extension of the DATE HAZARD: serde_yaml
 * deserializes the `signature:` map's values from raw scalar text, so an unquoted
 * nano-precision `timestamp: 2026-05-03T01:18:12.831682200+00:00` must serve
 * VERBATIM (js-yaml turns it into a Date, truncating to `.831Z` — the raw text is
 * unrecoverable from the Date object; live-confirmed on
 * forge/output/sample-manifest-pre-strip.md). Returns undefined when the key is
 * absent, carries an inline value (flow-map/JSON form — js-yaml's parse is
 * already faithful there, the values being quoted), or the block isn't a simple
 * nesting of maps + scalars (caller falls back to the js-yaml value).
 */
export function rawBlockMapField(yaml: string, key: string): Record<string, unknown> | undefined {
  const lines = rustLines(yaml);
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    if (line.slice(idx + 1).trim() !== '') return undefined; // inline value → not a block map
    break;
  }
  if (i >= lines.length) return undefined;
  return parseRawBlockMap(lines, i + 1, 0)?.map;
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

/** Indent-based block-map parser: nested maps + raw-text scalar leaves only. */
function parseRawBlockMap(
  lines: string[],
  start: number,
  parentIndent: number,
): { map: Record<string, unknown>; next: number } | undefined {
  const map: Record<string, unknown> = {};
  let levelIndent = -1;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (levelIndent === -1) {
      if (ind <= parentIndent) break; // no children at this level
      levelIndent = ind;
    }
    if (ind < levelIndent) break; // dedent → this map is done
    if (ind > levelIndent) return undefined; // stray deeper line → bail to js-yaml
    const body = line.slice(ind);
    if (body.startsWith('- ') || body === '-') return undefined; // sequence → bail
    const idx = body.indexOf(':');
    if (idx === -1) return undefined;
    const k = rawScalarText(body.slice(0, idx).trim());
    const rest = body.slice(idx + 1).trim();
    if (rest === '') {
      const child = parseRawBlockMap(lines, i + 1, levelIndent);
      if (child === undefined) return undefined; // null value or non-map child → bail
      map[k] = child.map;
      i = child.next;
    } else {
      map[k] = rawScalarText(rest);
      i++;
    }
  }
  if (Object.keys(map).length === 0) return undefined;
  return { map, next: i };
}

/**
 * Lenient line-by-line frontmatter recovery — the fallback for manifests strict
 * js-yaml rejects (an unquoted colon in a value). Everything after the first
 * `key:` is taken verbatim (so the embedded colon survives); flow `[a, b]` and
 * block `- item` sequences are both parsed. Ports + extends regula's forge.ts
 * `parseFrontmatterLenient` (block-sequence support added so block-form `tags:`
 * survive, matching legacy's colon-fix + serde_yaml which preserves them).
 */
export function parseFrontmatterLenient(raw: string): Record<string, unknown> | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w-]*):\s?(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === '') {
      const items: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const seq = lines[j].match(/^\s*-\s+(.*)$/);
        if (!seq) break;
        items.push(seq[1].trim().replace(/^['"]|['"]$/g, ''));
      }
      if (items.length > 0) {
        fm[key] = items;
        i = j - 1;
      }
    } else if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      fm[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return fm;
}

/**
 * Parse one file into an IndexedDoc. `relPath` is org-relative with forward slashes
 * (the canonical id). Returns null ONLY when the file cannot be read — malformed
 * frontmatter still yields an indexed doc with recovered/empty fields (legacy
 * `parse_document` falls back to `Frontmatter::default()`, never dropping the doc).
 */
export function parseDoc(orgRoot: string, relPath: string): IndexedDoc | null {
  const absPath = join(orgRoot, relPath);
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }

  const title = extractTitle(raw, absPath);
  const links = extractWikilinks(raw);
  const excerpt = computeExcerpt(raw);

  // Acquire the frontmatter map: strict (regula tryReadDoc → gray-matter/js-yaml),
  // else the lenient colon-recovery (legacy's fix_yaml_unquoted_colons analogue).
  // Then apply the ALL-OR-NOTHING struct gate — a validation failure voids every
  // frontmatter-derived field, exactly like legacy's Err(_) => Frontmatter::default().
  const parsed = tryReadDoc(absPath);
  const rawFm: Record<string, unknown> | null = parsed
    ? (parsed.frontmatter as unknown as Record<string, unknown>)
    : parseFrontmatterLenient(raw);
  const fm = rawFm === null ? null : validateFrontmatterStruct(rawFm);
  const fmOk = fm !== null;
  const f: Record<string, unknown> = fm ?? {};

  // created/updated values come VERBATIM off the raw YAML block (date hazard), but
  // their PRESENCE is gated by the struct parse — legacy's Option fields are None
  // when the whole struct voids, regardless of what the raw text carries.
  const yamlBlock = splitFrontmatter(raw).yaml ?? '';
  const created = fmOk
    ? rawScalarField(yamlBlock, 'created') ?? rawScalarField(yamlBlock, 'started') ?? null
    : null;
  const updated = fmOk ? rawScalarField(yamlBlock, 'updated') ?? null : null;

  const doc: IndexedDoc = {
    path: relPath,
    title,
    docType: inferType(fmOk ? scalarToString(f.type) : undefined, relPath),
    status: scalarToString(f.status) ?? null,
    created,
    updated,
    tags: Array.isArray(f.tags)
      ? (f.tags as unknown[]).map(scalarToString).filter((x): x is string => x !== undefined)
      : [],
    links,
    backlinks: [],
  };
  if (excerpt !== undefined) doc.excerpt = excerpt;

  // Forge extras — populated only when the frontmatter carries them (omit-when-absent).
  const pipeline = scalarToString(f.pipeline);
  if (pipeline !== undefined) doc.pipeline = pipeline;
  const recipe = scalarToString(f.recipe);
  if (recipe !== undefined) doc.recipe = recipe;
  const role = scalarToString(f.role);
  if (role !== undefined) doc.role = role;
  const layer = asNum(f.layer);
  if (layer !== undefined) doc.layer = layer;
  const goal = scalarToString(f.goal);
  if (goal !== undefined) doc.goal = goal;
  const triggeredBy = scalarToString(f['triggered-by']);
  if (triggeredBy !== undefined) doc.triggeredBy = triggeredBy;
  const reviewStatus = scalarToString(f['review-status']);
  if (reviewStatus !== undefined) doc.reviewStatus = reviewStatus;
  const dreamAction = scalarToString(f['dream-action']);
  if (dreamAction !== undefined) doc.dreamAction = dreamAction;
  if (f.signature !== undefined && f.signature !== null) {
    // Block-map signatures re-read from raw text so unquoted scalars (the
    // nano-precision timestamp) serve verbatim; flow/JSON-form signatures keep
    // js-yaml's parse (their values are quoted → already faithful).
    doc.signature = rawBlockMapField(yamlBlock, 'signature') ?? f.signature;
  }

  return doc;
}
