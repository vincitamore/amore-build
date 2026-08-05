// Tier-1 candidate generation — deterministic heuristics over the org tree.
// Emits CANDIDATES only (never edges). Channels: co-link clustering, rare-tag
// affinity, unlabeled-wikilink typing. No models.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDocIndex, extractWikilinkTargets, resolveTarget, type DocIndex } from './resolve';
import { extractTags } from './tags';
import { walkDurableDocs } from './walk';

/** Self-label grammar — same as tier-0 structural. */
const SELF_LABEL_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]\s*\(([a-z-]+)\)/g;

export type CandidateChannel = 'colink' | 'raretag' | 'unlabeled-wikilink';

export interface CandidatePair {
  /** Stable id: first 12 hex of sha256(a|b) with a < b. */
  id: string;
  a: string;
  b: string;
  score: number;
  /** Direct wikilink already exists between the pair. */
  linked: boolean;
  channels: {
    colink?: { sharedNeighbors: number };
    raretag?: { tags: string[] };
    unlabeledWikilink?: { from: string; target: string; quote: string };
  };
}

export interface GenRun {
  ts: string;
  docCount: number;
  candidates: CandidatePair[];
  channels: {
    colink: { pairs: number; hubsSkipped: number; graphNodes: number; graphLinks: number };
    raretag: { pairs: number; rareTags: number; taggedDocs: number };
    unlabeledWikilink: { pairs: number };
  };
}

export interface GenOptions {
  orgRoot: string;
  /** Max neighbors before a node is treated as a hub (skipped for co-link pairs). */
  hubCap?: number;
  /** Tags with more members than this are not "rare". */
  maxTagSize?: number;
  /** Per-doc pair budget after blend (0 = no prune). */
  topPerDoc?: number;
  /** Existing undirected pair keys `a|b` (a < b) to skip. */
  skipPairs?: Set<string>;
}

const BLEND = { colink: 0.5, raretag: 0.35, unlabeledWikilink: 0.4 };

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function candidateId(a: string, b: string): string {
  const key = pairKey(a, b);
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function readDoc(orgRoot: string, rel: string): string | null {
  const abs = join(orgRoot, ...rel.split('/'));
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

/** Build undirected wikilink adjacency from durable docs (no daemon). */
export function buildLocalLinkGraph(
  orgRoot: string,
  docs: string[],
  index: DocIndex,
): {
  adj: Map<string, Set<string>>;
  linked: Set<string>;
  linkCount: number;
} {
  const adj = new Map<string, Set<string>>();
  const linked = new Set<string>();
  let linkCount = 0;
  const addAdj = (x: string, y: string) => {
    let s = adj.get(x);
    if (!s) adj.set(x, (s = new Set()));
    s.add(y);
  };
  for (const doc of docs) {
    const content = readDoc(orgRoot, doc);
    if (content === null) continue;
    // Body only for link graph (strip frontmatter fences for target extract)
    const bodyStart = content.startsWith('---') ? content.indexOf('\n---', 3) : -1;
    const body = bodyStart >= 0 ? content.slice(bodyStart + 4) : content;
    const targets = extractWikilinkTargets(body);
    // Also collect wikilinks from frontmatter values commonly used as links
    const fmBlock =
      content.startsWith('---') && bodyStart >= 0
        ? content.slice(content.indexOf('\n') + 1, bodyStart)
        : '';
    const fmTargets = extractWikilinkTargets(fmBlock);
    for (const raw of [...targets, ...fmTargets]) {
      const resolved = resolveTarget(orgRoot, raw, index, doc);
      if (!resolved || resolved === doc) continue;
      addAdj(doc, resolved);
      addAdj(resolved, doc);
      linked.add(pairKey(doc, resolved));
      linkCount++;
    }
  }
  return { adj, linked, linkCount };
}

export function scoreColink(sharedNeighbors: number): number {
  return Math.min(1, sharedNeighbors / 3);
}

export function scoreRareTag(sharedTags: string[], tagSizes: Map<string, number>): number {
  let w = 0;
  for (const t of sharedTags) w += 1 / Math.max(1, (tagSizes.get(t) ?? 2) - 1);
  return Math.min(1, w);
}

/**
 * Co-link channel: docs that share a wikilink neighbor (friend-of-friend).
 * Hubs above hubCap are skipped. Pure local graph — no daemon.
 */
export function colinkChannel(
  adj: Map<string, Set<string>>,
  scopeDocs: Set<string>,
  hubCap: number,
): { pairs: Map<string, number>; hubsSkipped: number } {
  const pairs = new Map<string, number>();
  let hubsSkipped = 0;
  for (const [, nbrs] of adj) {
    if (nbrs.size > hubCap) {
      hubsSkipped++;
      continue;
    }
    const inScope = [...nbrs].filter((n) => scopeDocs.has(n)).sort();
    for (let i = 0; i < inScope.length; i++) {
      for (let j = i + 1; j < inScope.length; j++) {
        const key = `${inScope[i]}|${inScope[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  return { pairs, hubsSkipped };
}

/**
 * Rare-tag affinity: all-pairs within tags whose membership is small.
 */
export function raretagChannel(
  orgRoot: string,
  docs: string[],
  maxTagSize: number,
): { pairs: Map<string, string[]>; tagSizes: Map<string, number>; rareTagCount: number; taggedDocs: number } {
  const byTag = new Map<string, string[]>();
  let taggedDocs = 0;
  for (const doc of docs) {
    const content = readDoc(orgRoot, doc);
    if (content === null) continue;
    const tags = extractTags(content);
    if (tags.length > 0) taggedDocs++;
    for (const t of tags) {
      const arr = byTag.get(t);
      if (arr) arr.push(doc);
      else byTag.set(t, [doc]);
    }
  }
  const pairs = new Map<string, string[]>();
  const tagSizes = new Map<string, number>();
  let rareTagCount = 0;
  for (const [tag, members] of byTag) {
    if (members.length < 2 || members.length > maxTagSize) continue;
    rareTagCount++;
    tagSizes.set(tag, members.length);
    const sorted = [...members].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        const arr = pairs.get(key);
        if (arr) arr.push(tag);
        else pairs.set(key, [tag]);
      }
    }
  }
  return { pairs, tagSizes, rareTagCount, taggedDocs };
}

/**
 * Unlabeled-wikilink typing candidates: resolved direct wikilinks that do not
 * already carry a self-label type marker on the source line.
 */
export function unlabeledWikilinkChannel(
  orgRoot: string,
  docs: string[],
  index: DocIndex,
): Map<string, { from: string; target: string; quote: string }> {
  const out = new Map<string, { from: string; target: string; quote: string }>();
  for (const doc of docs) {
    const content = readDoc(orgRoot, doc);
    if (content === null) continue;
    const bodyStart = content.startsWith('---') ? content.indexOf('\n---', 3) : -1;
    const body = bodyStart >= 0 ? content.slice(bodyStart + 4) : content;
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      // Collect self-labeled ranges on this line first
      const labeled = new Set<string>();
      SELF_LABEL_RE.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = SELF_LABEL_RE.exec(line)) !== null) {
        labeled.add(sm[1].trim().toLowerCase());
      }
      const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const raw = m[1].trim();
        if (labeled.has(raw.toLowerCase())) continue;
        const target = resolveTarget(orgRoot, raw, index, doc);
        if (!target || target === doc) continue;
        const key = pairKey(doc, target);
        if (out.has(key)) continue;
        out.set(key, { from: doc, target, quote: m[0] });
      }
    }
  }
  return out;
}

/**
 * Generate tier-1 candidates. Deterministic for a given tree snapshot.
 * Candidates alone never land as edges.
 */
export function generateCandidates(opts: GenOptions): GenRun {
  const {
    orgRoot,
    hubCap = 25,
    maxTagSize = 8,
    topPerDoc = 8,
    skipPairs,
  } = opts;

  const docs = walkDurableDocs(orgRoot);
  const docSet = new Set(docs);
  const index = buildDocIndex(docs);
  const { adj, linked, linkCount } = buildLocalLinkGraph(orgRoot, docs, index);

  const cl = colinkChannel(adj, docSet, hubCap);
  const rt = raretagChannel(orgRoot, docs, maxTagSize);
  const uw = unlabeledWikilinkChannel(orgRoot, docs, index);

  const merged = new Map<string, CandidatePair>();
  const at = (a: string, b: string): CandidatePair => {
    const key = pairKey(a, b);
    let p = merged.get(key);
    if (!p) {
      const [x, y] = a < b ? [a, b] : [b, a];
      merged.set(
        key,
        (p = {
          id: candidateId(x, y),
          a: x,
          b: y,
          score: 0,
          linked: linked.has(key),
          channels: {},
        }),
      );
    }
    return p;
  };

  for (const [key, n] of cl.pairs) {
    const [a, b] = key.split('|');
    at(a, b).channels.colink = { sharedNeighbors: n };
  }
  for (const [key, tags] of rt.pairs) {
    const [a, b] = key.split('|');
    at(a, b).channels.raretag = { tags };
  }
  for (const [key, info] of uw) {
    const [a, b] = key.split('|');
    at(a, b).channels.unlabeledWikilink = info;
  }

  for (const p of merged.values()) {
    let s = 0;
    if (p.channels.colink) s += BLEND.colink * scoreColink(p.channels.colink.sharedNeighbors);
    if (p.channels.raretag) s += BLEND.raretag * scoreRareTag(p.channels.raretag.tags, rt.tagSizes);
    if (p.channels.unlabeledWikilink) s += BLEND.unlabeledWikilink;
    p.score = Number(s.toFixed(4));
  }

  let allPairs = [...merged.values()].sort(
    (x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
  );

  if (skipPairs && skipPairs.size > 0) {
    allPairs = allPairs.filter((p) => !skipPairs.has(pairKey(p.a, p.b)));
  }

  let pairs = allPairs;
  if (topPerDoc > 0 && allPairs.length > 0) {
    const byDoc = new Map<string, CandidatePair[]>();
    for (const p of allPairs) {
      for (const d of [p.a, p.b]) {
        const arr = byDoc.get(d);
        if (arr) arr.push(p);
        else byDoc.set(d, [p]);
      }
    }
    const keep = new Set<CandidatePair>();
    for (const [, arr] of byDoc) {
      arr.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a));
      for (const p of arr.slice(0, topPerDoc)) keep.add(p);
    }
    pairs = allPairs.filter((p) => keep.has(p));
  }

  // Stable order for determinism
  pairs = [...pairs].sort(
    (x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
  );

  return {
    ts: new Date().toISOString(),
    docCount: docs.length,
    candidates: pairs,
    channels: {
      colink: {
        pairs: cl.pairs.size,
        hubsSkipped: cl.hubsSkipped,
        graphNodes: adj.size,
        graphLinks: linkCount,
      },
      raretag: {
        pairs: rt.pairs.size,
        rareTags: rt.rareTagCount,
        taggedDocs: rt.taggedDocs,
      },
      unlabeledWikilink: { pairs: uw.size },
    },
  };
}
