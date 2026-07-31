// Cold-index benchmark — the empirical exhibit for the Workstream C language decision
// (tasks/vitrum-vinculum-master, ratified Bun 2026-07-02 pending this number).
//
// Simulates the new Bun daemon's cold-start index build over the real org corpus, using the
// REAL production parse path (gray-matter, regula's parser — the whole point of the Bun
// unification is that the daemon imports this very package). Phases mirror what the legacy
// Rust daemon does on cold start before first /api/graph: enumerate -> read -> frontmatter
// parse -> wikilink extraction -> stem/link map build.
//
// Run:  bun scripts/cold-index-bench.ts [orgRoot]
// Caveat: OS file cache is warm on any non-first-boot run; the legacy daemon's ~10s
// comparison figure is equally warm-cache, so the comparison is like-for-like.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import matter from 'gray-matter';

const ORG = process.argv[2] ?? process.cwd();
// The org roots the daemon indexes (graph corpus), not the whole repo working tree.
const ROOTS = ['tasks', 'knowledge', 'inbox', 'context', 'forge', 'archive', 'reminders'];
const EXCLUDE = new Set(['node_modules', '.git', 'target', 'dist', '.next', 'coverage']);

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!EXCLUDE.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.name.endsWith('.md')) {
      out.push(join(dir, e.name));
    }
  }
}

const t0 = performance.now();

// Phase 1 — enumerate
const files: string[] = [];
for (const r of ROOTS) walk(join(ORG, r), files);
const t1 = performance.now();

// Phase 2 — read
const bodies = new Map<string, string>();
let bytes = 0;
for (const f of files) {
  try {
    const s = readFileSync(f, 'utf-8');
    bytes += s.length;
    bodies.set(f, s);
  } catch {
    // unreadable — skip, count stays honest via bodies.size
  }
}
const t2 = performance.now();

// Phase 3 — frontmatter parse (gray-matter, the regula production parser)
let parsed = 0;
let parseFailures = 0;
const fm = new Map<string, Record<string, unknown>>();
const content = new Map<string, string>();
for (const [f, s] of bodies) {
  try {
    const m = matter(s);
    fm.set(f, m.data as Record<string, unknown>);
    content.set(f, m.content);
    parsed++;
  } catch {
    parseFailures++;
    content.set(f, s); // fall back to raw body for link extraction
  }
}
const t3 = performance.now();

// Phase 4 — wikilink extraction
const WIKI = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const outbound = new Map<string, string[]>();
let linkCount = 0;
for (const [f, s] of content) {
  const links: string[] = [];
  for (const m of s.matchAll(WIKI)) {
    links.push(m[1].trim());
    linkCount++;
  }
  outbound.set(f, links);
}
const t4 = performance.now();

// Phase 5 — stem map + resolve pass (bare-stem resolution + backlink accumulation,
// the shape of the daemon's resolve_link_ctx fast path)
const stemMap = new Map<string, string[]>();
for (const f of files) {
  const rel = relative(ORG, f);
  const stem = rel.split(sep).pop()!.replace(/\.md$/, '').toLowerCase();
  const arr = stemMap.get(stem) ?? [];
  arr.push(rel);
  stemMap.set(stem, arr);
}
let resolved = 0;
let ambiguous = 0;
let missing = 0;
const backlinks = new Map<string, number>();
for (const links of outbound.values()) {
  for (const l of links) {
    const stem = l.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
    const hits = stemMap.get(stem);
    if (!hits) missing++;
    else if (hits.length > 1) ambiguous++;
    else {
      resolved++;
      backlinks.set(hits[0], (backlinks.get(hits[0]) ?? 0) + 1);
    }
  }
}
const t5 = performance.now();

const ms = (a: number, b: number) => (b - a).toFixed(0).padStart(6);
console.log(`corpus: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB across ${ROOTS.join('/')}`);
console.log(`  enumerate   ${ms(t0, t1)} ms`);
console.log(`  read        ${ms(t1, t2)} ms`);
console.log(`  frontmatter ${ms(t2, t3)} ms   (${parsed} parsed, ${parseFailures} failures)`);
console.log(`  wikilinks   ${ms(t3, t4)} ms   (${linkCount} links)`);
console.log(`  link map    ${ms(t4, t5)} ms   (${resolved} resolved, ${ambiguous} ambiguous, ${missing} missing)`);
console.log(`  TOTAL       ${ms(t0, t5)} ms`);
