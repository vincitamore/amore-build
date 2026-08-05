// proxies/lucerna-review.ts — house forge dream + proposal review surface.
//
// Reads (and single-field frontmatter flips) under the house root:
//   forge/dreams/sessions/*.manifest.md  → session dream manifests
//   forge/dreams/*.md (not sessions/)     → light-dream reports
//   forge/proposals/*.md                 → proposals (root only for list default;
//                                           subfolders included with kind honesty)
//
// Review verbs touch exactly one frontmatter field, preserve the rest of the file
// byte-exact (line replace + temp + rename), and refuse when the current value is
// not the expected pre-state. Never execute artifact body content.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { isInstalled, readEnablement, type LucernaEnablement } from './lucerna.ts';

// ── shared shapes ─────────────────────────────────────────────────────────────

export type DreamKind = 'manifest' | 'light';
export type ProposalStatus = 'pending' | 'applied' | 'closed' | string;

export interface DreamItem {
  id: string;
  kind: DreamKind;
  path: string;
  title?: string;
  goal?: string;
  pipeline?: string;
  recipe?: string;
  created?: string;
  triggeredBy?: string;
  /** Session manifests: pending | reviewed. Light dreams: status field when present. */
  reviewStatus?: string;
  /** Light-dream status (pending | acted | …); absent when not set. */
  status?: string;
  tags: string[];
  dreamAction?: string;
  /**
   * When kind=manifest and a sibling report under forge/dreams/ was folded into
   * this row, the org-relative path of that report (for detail overlay).
   */
  reportPath?: string;
}

export interface ProposalItem {
  id: string;
  path: string;
  title?: string;
  target?: string;
  created?: string;
  triggeredBy?: string;
  status?: string;
  tags: string[];
}

export interface DreamsListWire {
  available: boolean;
  reason?: string;
  lucernaInstalled: boolean;
  dreamsEnabled: boolean;
  items: DreamItem[];
  pendingCount: number;
  total: number;
}

export interface DreamShowWire {
  available: boolean;
  reason?: string;
  found: boolean;
  item?: DreamItem;
  /** Full file text when found (frontmatter + body). */
  raw?: string;
  body?: string;
  /** Linked agentic report body (when a forge/dreams report was folded under a manifest). */
  reportBody?: string;
  reportPath?: string;
  /**
   * Ready-to-render markdown for the detail overlay: manifest body, then the
   * linked report under a heading when present.
   */
  displayBody?: string;
}

export interface ProposalsListWire {
  available: boolean;
  reason?: string;
  lucernaInstalled: boolean;
  dreamsEnabled: boolean;
  items: ProposalItem[];
  pendingCount: number;
  total: number;
}

export interface ProposalShowWire {
  available: boolean;
  reason?: string;
  found: boolean;
  item?: ProposalItem;
  raw?: string;
  body?: string;
}

export interface ReviewWriteWire {
  available: boolean;
  ok: boolean;
  reason?: string;
  message?: string;
  path?: string;
  field?: string;
  from?: string;
  to?: string;
}

// ── frontmatter helpers (lenient; never throw on partial files) ────────────────

function asStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s || undefined;
}

function asTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * Lenient line-by-line frontmatter parse. Survives unquoted colons in values
 * (common in dream `goal:` lines) and missing fields without throwing.
 */
export function parseFrontmatterLenient(raw: string): {
  fm: Record<string, unknown>;
  body: string;
  hasFence: boolean;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
  if (!m) {
    return { fm: {}, body: raw, hasFence: false };
  }
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
  const body = raw.slice(m[0].length);
  return { fm, body, hasFence: true };
}

/**
 * Replace a single scalar frontmatter field value in-place when it currently
 * equals `from`. Body and all other lines stay byte-exact. Atomic write via
 * temp + rename. Returns ok:false with reason when the field is missing or
 * the current value is not `from`.
 */
export function flipFrontmatterField(
  filePath: string,
  field: string,
  from: string,
  to: string,
): ReviewWriteWire {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { available: true, ok: false, reason: 'not-found', message: `File not found: ${filePath}` };
  }

  const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) {
    return {
      available: true,
      ok: false,
      reason: 'no-frontmatter',
      message: 'File has no YAML frontmatter fence',
      field,
    };
  }

  const fmBlock = fence[1];
  const lines = fmBlock.split(/\r?\n/);
  const fieldRe = new RegExp(`^(${escapeRegExp(field)}):\\s*(.*)$`);
  let matchedLine = -1;
  let currentRaw = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(fieldRe);
    if (!m) continue;
    matchedLine = i;
    currentRaw = m[2].trim();
    break;
  }

  if (matchedLine < 0) {
    return {
      available: true,
      ok: false,
      reason: 'field-absent',
      message: `Frontmatter field '${field}' is absent`,
      field,
      from,
      to,
    };
  }

  // Normalize quotes around the stored value for comparison.
  const current = currentRaw.replace(/^['"]|['"]$/g, '');
  if (current !== from) {
    return {
      available: true,
      ok: false,
      reason: 'unexpected-value',
      message: `Expected ${field}: ${from}, found ${current || '(empty)'}`,
      field,
      from,
      to,
    };
  }

  // Preserve original quoting style when the value was quoted.
  const quoted =
    (currentRaw.startsWith("'") && currentRaw.endsWith("'")) ||
    (currentRaw.startsWith('"') && currentRaw.endsWith('"'));
  const nextVal = quoted ? `'${to}'` : to;
  lines[matchedLine] = `${field}: ${nextVal}`;

  // Replace only the frontmatter interior; delimiters and body stay byte-exact.
  const newFm = lines.join('\n');
  const prefixEnd = raw.indexOf(fmBlock);
  if (prefixEnd < 0) {
    return {
      available: true,
      ok: false,
      reason: 'parse-failed',
      message: 'Could not relocate frontmatter block',
      field,
    };
  }
  const finalRaw = raw.slice(0, prefixEnd) + newFm + raw.slice(prefixEnd + fmBlock.length);

  const dir = dirname(filePath);
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, finalRaw, 'utf8');
    renameSync(tmp, filePath);
    return {
      available: true,
      ok: true,
      path: filePath,
      field,
      from,
      to,
    };
  } catch (e) {
    try {
      if (existsSync(tmp)) writeFileSync(tmp, '');
    } catch {
      /* ignore */
    }
    return {
      available: true,
      ok: false,
      reason: 'write-failed',
      message: e instanceof Error ? e.message : String(e),
      field,
      from,
      to,
    };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── path / id helpers ─────────────────────────────────────────────────────────

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function relFromOrg(orgRoot: string, abs: string): string {
  return toPosix(relative(orgRoot, abs));
}

/** Session id from path: basename without .manifest.md / .md. */
export function dreamIdFromPath(relPath: string): string {
  const base = basename(relPath);
  if (base.endsWith('.manifest.md')) return base.slice(0, -'.manifest.md'.length);
  if (base.endsWith('.md')) return base.slice(0, -3);
  return base;
}

export function proposalIdFromPath(relPath: string): string {
  const base = basename(relPath);
  if (base.endsWith('.md')) return base.slice(0, -3);
  return base;
}

function walkMdFiles(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...walkMdFiles(p, true));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

function projectDream(orgRoot: string, abs: string, kind: DreamKind): DreamItem | null {
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const { fm } = parseFrontmatterLenient(raw);
  const rel = relFromOrg(orgRoot, abs);
  const goal = asStr(fm.goal);
  const title = goal ?? asStr(fm.title) ?? dreamIdFromPath(rel);
  return {
    id: dreamIdFromPath(rel),
    kind,
    path: rel,
    title,
    goal,
    pipeline: asStr(fm.pipeline),
    recipe: asStr(fm.recipe),
    created: asStr(fm.created),
    triggeredBy: asStr(fm['triggered-by']),
    reviewStatus: asStr(fm['review-status']),
    status: asStr(fm.status),
    tags: asTags(fm.tags),
    dreamAction: asStr(fm['dream-action']),
  };
}

function projectProposal(orgRoot: string, abs: string): ProposalItem | null {
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const { fm } = parseFrontmatterLenient(raw);
  const rel = relFromOrg(orgRoot, abs);
  const title = asStr(fm.title) ?? proposalIdFromPath(rel);
  return {
    id: proposalIdFromPath(rel),
    path: rel,
    title,
    target: asStr(fm.target),
    created: asStr(fm.created),
    triggeredBy: asStr(fm['triggered-by']),
    status: asStr(fm.status),
    tags: asTags(fm.tags),
  };
}

function enablementContext(orgRoot: string): {
  lucernaInstalled: boolean;
  dreamsEnabled: boolean;
  enablement: LucernaEnablement;
} {
  const lucernaInstalled = isInstalled(orgRoot);
  const enablement = readEnablement(orgRoot);
  return {
    lucernaInstalled,
    dreamsEnabled: enablement.dreamsEnabled,
    enablement,
  };
}

/** Pending first, then newest created desc, then path desc. */
function sortDreams(items: DreamItem[]): DreamItem[] {
  const pendingRank = (d: DreamItem): number => {
    if (d.kind === 'manifest') return d.reviewStatus === 'pending' || !d.reviewStatus ? 0 : 1;
    // light dreams: status pending (or absent) first
    return d.status === 'pending' || !d.status ? 0 : 1;
  };
  return [...items].sort((a, b) => {
    const pr = pendingRank(a) - pendingRank(b);
    if (pr !== 0) return pr;
    const ca = a.created ?? '';
    const cb = b.created ?? '';
    if (ca !== cb) return cb.localeCompare(ca);
    return b.path.localeCompare(a.path);
  });
}

/**
 * Parse session manifest id stamp: `YYYYMMDD-HHmmss-<action>` (protocol) or
 * looser `YYYYMMDD-<action>`.
 */
export function parseManifestStamp(
  id: string,
): { ymd: string; hms?: string; action: string } | null {
  const full = id.match(/^(\d{8})-(\d{6})-(.+)$/);
  if (full) return { ymd: full[1], hms: full[2], action: full[3] };
  const loose = id.match(/^(\d{8})-(.+)$/);
  if (loose && !/^\d{6}$/.test(loose[2].slice(0, 6))) {
    return { ymd: loose[1], action: loose[2] };
  }
  return null;
}

function ymdDashed(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function sameCalendarDay(created: string | undefined, ymd: string): boolean {
  if (!created) return false;
  const compact = created.replace(/-/g, '').slice(0, 8);
  return compact === ymd;
}

/**
 * Whether a forge/dreams report belongs to a session manifest (one agentic
 * dream → one review row). Primary: shared `pipeline`. Fallback for older
 * artifacts: same basename id, or action+date from the session stamp vs
 * report filename / dream-action / created.
 */
export function lightBelongsToManifest(light: DreamItem, man: DreamItem): boolean {
  if (light.kind !== 'light' || man.kind !== 'manifest') return false;

  // 1. pipeline linkage (preferred — writer may stamp the same pipeline on both)
  if (light.pipeline && man.pipeline && light.pipeline === man.pipeline) return true;
  if (light.pipeline && man.id && light.pipeline === man.id) return true;
  if (man.pipeline && light.id && man.pipeline === light.id) return true;
  if (man.pipeline && light.pipeline) {
    const a = man.pipeline.replace(/^dream-/, '');
    const b = light.pipeline.replace(/^dream-/, '');
    if (a && a === b) return true;
  }

  // 2. identical basename id
  if (light.id === man.id) return true;

  // 3. legacy: action + date from session stamp vs report fields/filename
  const stamp = parseManifestStamp(man.id);
  if (!stamp) return false;
  const action = stamp.action.toLowerCase();
  const idL = light.id.toLowerCase();

  if (idL === man.id.toLowerCase()) return true;
  // filename carries both compact date and action (common legacy naming)
  if (idL.includes(action) && idL.includes(stamp.ymd)) return true;

  if (light.dreamAction?.toLowerCase() === action && sameCalendarDay(light.created, stamp.ymd)) {
    return true;
  }

  // pipeline on either side encodes dream-<action> with matching created day
  const pipeAction = (light.pipeline ?? man.pipeline ?? '')
    .replace(/^dream-/, '')
    .toLowerCase();
  if (pipeAction && pipeAction === action) {
    if (sameCalendarDay(light.created, stamp.ymd) || sameCalendarDay(man.created, stamp.ymd)) {
      if (light.pipeline || light.dreamAction?.toLowerCase() === action || idL.includes(action)) {
        return true;
      }
    }
  }

  // light created day matches man created day AND action appears in light id/tags
  if (
    man.created &&
    light.created &&
    man.created.slice(0, 10) === light.created.slice(0, 10) &&
    (idL.includes(action) ||
      light.dreamAction?.toLowerCase() === action ||
      light.tags.some((t) => t.toLowerCase() === action))
  ) {
    return true;
  }

  // light filename uses dashed date + action (e.g. tag-regen-2026-08-05)
  if (idL.includes(action) && idL.includes(ymdDashed(stamp.ymd))) return true;

  return false;
}

/**
 * Fold agentic report artifacts under their session manifest. Standalone light
 * dreams (no matching manifest) remain as their own rows.
 */
export function dedupeDreamItems(manifests: DreamItem[], lights: DreamItem[]): DreamItem[] {
  const usedLight = new Set<string>();
  const outManifests = manifests.map((man) => {
    const linked = lights.find((l) => !usedLight.has(l.path) && lightBelongsToManifest(l, man));
    if (!linked) return man;
    usedLight.add(linked.path);
    return { ...man, reportPath: linked.path };
  });
  const standalone = lights.filter((l) => !usedLight.has(l.path));
  return [...outManifests, ...standalone];
}

function sortProposals(items: ProposalItem[]): ProposalItem[] {
  const rank = (p: ProposalItem): number => (p.status === 'pending' || !p.status ? 0 : 1);
  return [...items].sort((a, b) => {
    const pr = rank(a) - rank(b);
    if (pr !== 0) return pr;
    const ca = a.created ?? '';
    const cb = b.created ?? '';
    if (ca !== cb) return cb.localeCompare(ca);
    return b.path.localeCompare(a.path);
  });
}

function isDreamPending(d: DreamItem): boolean {
  if (d.kind === 'manifest') return d.reviewStatus === 'pending' || d.reviewStatus === undefined;
  return d.status === 'pending' || d.status === undefined;
}

function isProposalPending(p: ProposalItem): boolean {
  return p.status === 'pending' || p.status === undefined;
}

// ── list / show ───────────────────────────────────────────────────────────────

/**
 * List session manifests + light-dream reports under forge/dreams/.
 * Skips non-.md files. Partial frontmatter degrades field-by-field.
 * Agentic pairs (session manifest + forge/dreams report) collapse to ONE
 * manifest row; standalone light reports keep their own row.
 */
export function listDreams(orgRoot: string, opts: { pendingOnly?: boolean } = {}): DreamsListWire {
  const ctx = enablementContext(orgRoot);
  const sessionsDir = join(orgRoot, 'forge', 'dreams', 'sessions');
  const dreamsDir = join(orgRoot, 'forge', 'dreams');

  const manifests: DreamItem[] = [];
  const lights: DreamItem[] = [];

  // Session manifests
  for (const abs of walkMdFiles(sessionsDir, false)) {
    const base = basename(abs);
    // Prefer *.manifest.md; also accept plain .md under sessions/
    if (!base.endsWith('.md')) continue;
    const item = projectDream(orgRoot, abs, 'manifest');
    if (item) manifests.push(item);
  }

  // Light dreams: forge/dreams/*.md only (not sessions/, not nested)
  if (existsSync(dreamsDir)) {
    try {
      for (const e of readdirSync(dreamsDir, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const abs = join(dreamsDir, e.name);
        const item = projectDream(orgRoot, abs, 'light');
        if (item) lights.push(item);
      }
    } catch {
      /* unreadable dreams dir */
    }
  }

  const items = dedupeDreamItems(manifests, lights);
  const sorted = sortDreams(items);
  const filtered = opts.pendingOnly ? sorted.filter(isDreamPending) : sorted;
  const pendingCount = sorted.filter(isDreamPending).length;

  return {
    available: true,
    lucernaInstalled: ctx.lucernaInstalled,
    dreamsEnabled: ctx.dreamsEnabled,
    items: filtered,
    pendingCount,
    total: filtered.length,
  };
}

/** Collect raw light reports under forge/dreams/ (no dedupe). */
function collectLightReports(orgRoot: string): DreamItem[] {
  const dreamsDir = join(orgRoot, 'forge', 'dreams');
  const lights: DreamItem[] = [];
  if (!existsSync(dreamsDir)) return lights;
  try {
    for (const e of readdirSync(dreamsDir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const item = projectDream(orgRoot, join(dreamsDir, e.name), 'light');
      if (item) lights.push(item);
    }
  } catch {
    /* ignore */
  }
  return lights;
}

/** Resolve linked report path for a manifest (pipeline / stamp fallback). */
export function findLinkedReportPath(orgRoot: string, man: DreamItem): string | undefined {
  if (man.reportPath) return man.reportPath;
  if (man.kind !== 'manifest') return undefined;
  const lights = collectLightReports(orgRoot);
  const hit = lights.find((l) => lightBelongsToManifest(l, man));
  return hit?.path;
}

/** Resolve a dream by id, relative path, pipeline name, or basename. */
export function resolveDreamPath(orgRoot: string, idOrPath: string): string | null {
  const needle = idOrPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const list = listDreams(orgRoot);
  for (const it of list.items) {
    if (it.path === needle) return it.path;
    if (it.id === needle) return it.path;
    if (it.pipeline === needle) return it.path;
    if (basename(it.path) === needle) return it.path;
    if (basename(it.path) === `${needle}.md`) return it.path;
    if (basename(it.path) === `${needle}.manifest.md`) return it.path;
  }
  // Direct path if it exists under org
  const abs = join(orgRoot, needle);
  if (existsSync(abs) && abs.endsWith('.md')) {
    const rel = relFromOrg(orgRoot, abs);
    if (rel.startsWith('forge/dreams/')) return rel;
  }
  return null;
}

export function showDream(orgRoot: string, idOrPath: string): DreamShowWire {
  const rel = resolveDreamPath(orgRoot, idOrPath);
  if (!rel) {
    return { available: true, found: false, reason: 'not-found' };
  }
  const abs = join(orgRoot, rel);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return { available: true, found: false, reason: 'not-found' };
  }
  const kind: DreamKind = rel.includes('/sessions/') ? 'manifest' : 'light';
  let item = projectDream(orgRoot, abs, kind);
  const { body } = parseFrontmatterLenient(raw);

  let reportBody: string | undefined;
  let reportPath: string | undefined;
  if (item && kind === 'manifest') {
    reportPath = findLinkedReportPath(orgRoot, item);
    if (reportPath) {
      item = { ...item, reportPath };
      try {
        const reportRaw = readFileSync(join(orgRoot, reportPath), 'utf8');
        reportBody = parseFrontmatterLenient(reportRaw).body;
      } catch {
        reportBody = undefined;
      }
    }
  }

  const manBody = (body ?? '').trimEnd();
  const repBody = (reportBody ?? '').trimEnd();
  let displayBody = manBody;
  if (kind === 'manifest' && repBody) {
    displayBody =
      (manBody ? `${manBody}\n\n` : '') +
      `## Linked report\n\n` +
      (reportPath ? `_${reportPath}_\n\n` : '') +
      repBody;
  } else if (!displayBody && repBody) {
    displayBody = repBody;
  }

  return {
    available: true,
    found: true,
    item: item ?? undefined,
    raw,
    body,
    reportBody,
    reportPath,
    displayBody: displayBody || '(empty body)',
  };
}

/**
 * List proposals under forge/proposals/ (recursive so applied/ subfolders still
 * show; pending root files sort first).
 */
export function listProposals(
  orgRoot: string,
  opts: { pendingOnly?: boolean } = {},
): ProposalsListWire {
  const ctx = enablementContext(orgRoot);
  const propsDir = join(orgRoot, 'forge', 'proposals');
  const items: ProposalItem[] = [];
  for (const abs of walkMdFiles(propsDir, true)) {
    const item = projectProposal(orgRoot, abs);
    if (item) items.push(item);
  }
  const sorted = sortProposals(items);
  const filtered = opts.pendingOnly ? sorted.filter(isProposalPending) : sorted;
  const pendingCount = sorted.filter(isProposalPending).length;
  return {
    available: true,
    lucernaInstalled: ctx.lucernaInstalled,
    dreamsEnabled: ctx.dreamsEnabled,
    items: filtered,
    pendingCount,
    total: filtered.length,
  };
}

export function resolveProposalPath(orgRoot: string, idOrPath: string): string | null {
  const needle = idOrPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const list = listProposals(orgRoot);
  for (const it of list.items) {
    if (it.path === needle) return it.path;
    if (it.id === needle) return it.path;
    if (basename(it.path) === needle) return it.path;
    if (basename(it.path) === `${needle}.md`) return it.path;
  }
  const abs = join(orgRoot, needle);
  if (existsSync(abs) && abs.endsWith('.md')) {
    const rel = relFromOrg(orgRoot, abs);
    if (rel.startsWith('forge/proposals/')) return rel;
  }
  return null;
}

export function showProposal(orgRoot: string, idOrPath: string): ProposalShowWire {
  const rel = resolveProposalPath(orgRoot, idOrPath);
  if (!rel) {
    return { available: true, found: false, reason: 'not-found' };
  }
  const abs = join(orgRoot, rel);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return { available: true, found: false, reason: 'not-found' };
  }
  const item = projectProposal(orgRoot, abs);
  const { body } = parseFrontmatterLenient(raw);
  return {
    available: true,
    found: true,
    item: item ?? undefined,
    raw,
    body,
  };
}

// ── review verbs (single-field flips) ─────────────────────────────────────────

/**
 * Flip a session manifest's review-status pending → reviewed.
 * Light dreams: flip status pending → acted (same verb surface for operator convenience).
 */
export function reviewDream(orgRoot: string, idOrPath: string): ReviewWriteWire {
  const rel = resolveDreamPath(orgRoot, idOrPath);
  if (!rel) {
    return { available: true, ok: false, reason: 'not-found', message: `Dream not found: ${idOrPath}` };
  }
  const abs = join(orgRoot, rel);
  const isManifest = rel.includes('/sessions/');
  if (isManifest) {
    const r = flipFrontmatterField(abs, 'review-status', 'pending', 'reviewed');
    return { ...r, path: rel };
  }
  // Light dream: status pending → acted (shipped forge convention)
  const r = flipFrontmatterField(abs, 'status', 'pending', 'acted');
  return { ...r, path: rel };
}

/**
 * Flip proposal status pending → applied. Does not apply content — status only.
 */
export function applyProposal(orgRoot: string, idOrPath: string): ReviewWriteWire {
  const rel = resolveProposalPath(orgRoot, idOrPath);
  if (!rel) {
    return {
      available: true,
      ok: false,
      reason: 'not-found',
      message: `Proposal not found: ${idOrPath}`,
    };
  }
  const r = flipFrontmatterField(join(orgRoot, rel), 'status', 'pending', 'applied');
  return { ...r, path: rel };
}

/**
 * Flip proposal status pending → closed. Does not apply content — status only.
 */
export function closeProposal(orgRoot: string, idOrPath: string): ReviewWriteWire {
  const rel = resolveProposalPath(orgRoot, idOrPath);
  if (!rel) {
    return {
      available: true,
      ok: false,
      reason: 'not-found',
      message: `Proposal not found: ${idOrPath}`,
    };
  }
  const r = flipFrontmatterField(join(orgRoot, rel), 'status', 'pending', 'closed');
  return { ...r, path: rel };
}

/** Combined pending count for pulse / header badges. */
export function pendingReviewCounts(orgRoot: string): {
  dreams: number;
  proposals: number;
  total: number;
  lucernaInstalled: boolean;
  dreamsEnabled: boolean;
} {
  const d = listDreams(orgRoot);
  const p = listProposals(orgRoot);
  return {
    dreams: d.pendingCount,
    proposals: p.pendingCount,
    total: d.pendingCount + p.pendingCount,
    lucernaInstalled: d.lucernaInstalled,
    dreamsEnabled: d.dreamsEnabled,
  };
}
