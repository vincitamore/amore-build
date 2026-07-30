import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'fs';
import { basename, join } from 'path';
import matter from 'gray-matter';
import { readDoc, writeDoc } from './doc';
import { extractTitle, relPath } from './util';
import { RegulaError } from './errors';

// ─────────────────────────────────────────────────────────────────────────────
// Forge artifact listing
//
// Forge has no natural "list pipelines" shape on disk — a pipeline is reconstructed
// from many files (manifest + handle/output pairs) sharing a `pipeline:` key. This
// module is the flat read layer; the pipeline → layer → agent grouping is presentation
// (the Forge browser builds it). The projection keeps the manifest SHAPE fields
// (depth/width/totalAgents) the daemon's /api/files drops, so a collapsed pipeline can
// show its shape without lazy-loading the heavy handles/outputs.
// ─────────────────────────────────────────────────────────────────────────────

export interface ForgeListItem {
  /** org-relative path. */
  path: string;
  title: string;
  status?: string;
  tags: string[];
  created?: string;
  pipeline?: string;
  recipe?: string;
  goal?: string;
  role?: string;
  layer?: number;
  triggeredBy?: string;
  reviewStatus?: string;
  dreamAction?: string;
  /** Manifest shape (present on session/dream-session manifests). */
  depth?: number;
  width?: number;
  totalAgents?: number;
  /** Run timestamps (full ISO) — operator/custom manifests carry these instead of `created`. */
  started?: string;
  completed?: string;
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNum = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
};
// gray-matter/js-yaml parses an UNQUOTED YAML date (`created: 2026-06-04`) as a Date object, not
// a string — so a naive `.localeCompare` on it throws. Normalize to a 'YYYY-MM-DD' string.
const asDate = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s ? s.slice(0, 10) : undefined; // ISO datetime strings collapse to the date too
};
// Full-precision timestamp (Date or ISO string) — for sort tiebreaks where a date alone collides.
const asTime = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' && v ? v : undefined;
};

function projectForgeItem(orgRoot: string, filePath: string, fm: Record<string, unknown>, body: string): ForgeListItem {
  return {
    path: relPath(orgRoot, filePath),
    title: extractTitle(body, filePath),
    status: asStr(fm.status),
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
    created: asDate(fm.created),
    pipeline: asStr(fm.pipeline),
    recipe: asStr(fm.recipe),
    goal: asStr(fm.goal),
    role: asStr(fm.role),
    layer: asNum(fm.layer),
    triggeredBy: asStr(fm['triggered-by']),
    reviewStatus: asStr(fm['review-status']),
    dreamAction: asStr(fm['dream-action']),
    depth: asNum(fm.depth),
    width: asNum(fm.width),
    totalAgents: asNum(fm['total-agents']),
    started: asTime(fm.started),
    completed: asTime(fm.completed),
  };
}

/**
 * Lenient line-by-line frontmatter parse — a fallback for files that are NOT valid YAML. The big
 * case: forge dream manifests with `goal: Dream cycle: audit …` (an unquoted colon in the value)
 * — strict js-yaml throws on the second colon, which would silently drop the whole pipeline. Here
 * everything after the first `key:` is taken verbatim as the value (so the embedded colon survives),
 * and `[a, b]` arrays are split. Good enough for the flat scalar fields the forge browser needs.
 */
function parseFrontmatterLenient(raw: string): Record<string, unknown> | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s?(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[kv[1]] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      fm[kv[1]] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return fm;
}

function readForgeItem(orgRoot: string, filePath: string): ForgeListItem | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8'); // ONE read; try strict, else recover leniently
  } catch {
    return null;
  }
  let fm: Record<string, unknown>;
  let body: string;
  try {
    // Pass an options object so gray-matter SKIPS its content cache (it only caches when called
    // with no options). Without this, the cache poisons repeat reads: gray-matter caches the file
    // object BEFORE parsing, so when strict YAML throws (an unquoted-colon `goal:` in a dream
    // manifest), the SECOND read returns the cached file with EMPTY data and does NOT throw — the
    // lenient fallback never fires, `triggered-by` is lost, and every dream misclassifies as a
    // plain pipeline until the process restarts. Fresh parse every time = deterministic.
    const parsed = matter(raw, {});
    fm = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Strict YAML failed (e.g. an unquoted colon in `goal:`) — recover, don't drop the pipeline.
    const lenient = parseFrontmatterLenient(raw);
    if (!lenient) return null;
    fm = lenient;
    body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  }
  return projectForgeItem(orgRoot, filePath, fm, body);
}

/** Recursively collect `.md` files under `dir` (forge subtrees nest at most a level or two). */
function walkMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** The lightweight forge roots loaded on mount — manifests + light dreams + proposals + recipes. */
const LIGHT_ROOTS = ['forge/sessions', 'forge/dreams', 'forge/proposals', 'forge/recipes'];

/**
 * List the LIGHTWEIGHT forge set (manifests, light dream artifacts, proposals, recipes).
 * Excludes the heavy `forge/handles/` + `forge/output/` trees (1500+ files) — those load
 * per-pipeline on demand via {@link listForgePipelineDetails}. Reads frontmatter directly,
 * so the manifest shape fields survive (the daemon projection drops them).
 */
export function listForge(orgRoot: string): ForgeListItem[] {
  const items: ForgeListItem[] = [];
  for (const root of LIGHT_ROOTS) {
    for (const f of walkMd(join(orgRoot, root))) {
      const item = readForgeItem(orgRoot, f);
      if (item) items.push(item);
    }
  }
  return items;
}

/**
 * The set of pipeline names that actually have artifacts on disk — the union of the (non-empty)
 * subdirectory names under forge/handles/ and forge/output/. Cheap (two readdirs, no file reads).
 * Lets the browser separate manifest-only pipelines from ones with real handle/output content
 * without loading 1500+ files.
 */
export function forgePipelineDirs(orgRoot: string): string[] {
  const names = new Set<string>();
  for (const r of ['forge/handles', 'forge/output']) {
    const dir = join(orgRoot, r);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && readdirSync(join(dir, e.name)).some((f) => f.endsWith('.md'))) names.add(e.name);
    }
  }
  return [...names];
}

/** Load the handle + output artifacts for ONE pipeline (the heavy per-pipeline detail). */
export function listForgePipelineDetails(orgRoot: string, pipeline: string): ForgeListItem[] {
  const items: ForgeListItem[] = [];
  for (const root of [`forge/handles/${pipeline}`, `forge/output/${pipeline}`]) {
    for (const f of walkMd(join(orgRoot, root))) {
      const item = readForgeItem(orgRoot, f);
      if (item) items.push(item);
    }
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle verbs (atomic — the governance surface)
// ─────────────────────────────────────────────────────────────────────────────

export type ProposalTarget = 'applied' | 'rejected' | 'stale';
const PROPOSAL_TARGETS: readonly ProposalTarget[] = ['applied', 'rejected', 'stale'];

/** Mark a light dream artifact acted (status: pending → acted). */
export function markDreamActed(orgRoot: string, ref: string): { path: string; status: string } {
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath); // throws NOT_FOUND
  doc.frontmatter.status = 'acted';
  writeDoc(filePath, doc.frontmatter, doc.content);
  return { path: ref, status: 'acted' };
}

/** Mark a dream-pipeline MANIFEST reviewed (review-status: pending → reviewed). */
export function markPipelineReviewed(orgRoot: string, ref: string): { path: string; reviewStatus: string } {
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath); // throws NOT_FOUND
  doc.frontmatter['review-status'] = 'reviewed';
  writeDoc(filePath, doc.frontmatter, doc.content);
  return { path: ref, reviewStatus: 'reviewed' };
}

/**
 * Resolve a proposal: set its terminal status AND move it into forge/proposals/<target>/.
 *
 * Climb over the Tauri ForgeView, which did a client-side patch-THEN-move as two separate
 * API calls — the exact half-complete anti-pattern the inbox-resolve handler was built to
 * avoid (flip succeeds, move fails on a 409/crash → a phantom). Here it is one verb: patch
 * in place, then move; a failed move leaves the file status-patched in proposals/ root
 * (re-runnable), never a phantom in the target dir. A proposal already in a target subfolder
 * is re-patched in place (no move).
 */
export function resolveProposal(
  orgRoot: string,
  ref: string,
  target: ProposalTarget,
): { oldPath: string; newPath: string; status: string } {
  if (!PROPOSAL_TARGETS.includes(target)) {
    throw new RegulaError('USAGE', `Not a proposal target status: ${target}`);
  }
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath); // throws NOT_FOUND
  if (doc.frontmatter.type !== 'forge') {
    throw new RegulaError('USAGE', `Not a forge artifact (type: ${String(doc.frontmatter.type)}): ${ref}`);
  }
  doc.frontmatter.status = target;
  writeDoc(filePath, doc.frontmatter, doc.content);

  const rel = relPath(orgRoot, filePath);
  const inRoot =
    rel.startsWith('forge/proposals/') &&
    !rel.startsWith('forge/proposals/applied/') &&
    !rel.startsWith('forge/proposals/rejected/') &&
    !rel.startsWith('forge/proposals/stale/');
  if (!inRoot) {
    return { oldPath: rel, newPath: rel, status: target }; // already terminal-foldered — patched in place
  }
  const targetDir = join(orgRoot, 'forge', 'proposals', target);
  const targetPath = join(targetDir, basename(filePath));
  mkdirSync(targetDir, { recursive: true });
  if (existsSync(targetPath)) {
    throw new RegulaError('CONFLICT', `Move target already exists: ${relPath(orgRoot, targetPath)}`);
  }
  renameSync(filePath, targetPath);
  return { oldPath: rel, newPath: relPath(orgRoot, targetPath), status: target };
}
