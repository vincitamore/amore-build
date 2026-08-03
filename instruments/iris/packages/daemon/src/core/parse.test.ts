import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  parseDoc,
  extractBody,
  extractTitle,
  extractWikilinks,
  computeExcerpt,
  inferType,
  rawBlockMapField,
  rawScalarField,
  splitFrontmatter,
  validateFrontmatterStruct,
} from './parse';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  return rel;
}

// ── title (legacy rule — no trim, raw stem fallback) ──────────────────────────

test('title = first ^#\\s+(.+)$ capture, VERBATIM (no trim)', () => {
  // The `tags/tier-b-plus.md` case: H1 line is `# # Tier B Plus` → title `# Tier B Plus`.
  expect(extractTitle('---\ntype: tag\n---\n\n# # Tier B Plus\n', '/x/tier-b-plus.md')).toBe('# Tier B Plus');
  expect(extractTitle('# Voice\n\nbody', '/x/voice.md')).toBe('Voice');
  expect(extractTitle('## not h1\n# real', '/x/f.md')).toBe('real');
});

test('title falls back to raw file stem (not de-slugged / title-cased)', () => {
  expect(extractTitle('no heading here\n', '/x/some-file-name.md')).toBe('some-file-name');
  expect(extractTitle('body', '/a/b/foo.manifest.md')).toBe('foo.manifest');
});

// ── wikilinks (order, not deduped, label stripped, anchor kept) ───────────────

test('wikilinks: document order, not deduped, |label stripped, #anchor kept', () => {
  const c = 'see [[foo]] and [[bar|Label]] then [[foo]] and [[project-map#Principle Lattice]]';
  expect(extractWikilinks(c)).toEqual(['foo', 'bar', 'foo', 'project-map#Principle Lattice']);
});

test('wikilinks: none → empty', () => {
  expect(extractWikilinks('no links here')).toEqual([]);
});

// ── excerpt ───────────────────────────────────────────────────────────────────

test('excerpt: first prose line, skips #/blank/---/> , collapses whitespace', () => {
  const c = '---\ntype: tag\n---\n\n# heading\n\n> quote\n\n*Documents   tagged*  with   x\n';
  expect(computeExcerpt(c)).toBe('*Documents tagged* with x');
});

test('excerpt: undefined when no prose', () => {
  expect(computeExcerpt('---\ntype: x\n---\n\n# only heading\n')).toBeUndefined();
});

test('excerpt: cut at 120 Unicode chars', () => {
  const line = 'a'.repeat(200);
  const c = `---\nt: 1\n---\n\n${line}\n`;
  expect(computeExcerpt(c)).toBe('a'.repeat(120));
});

// ── type inference ────────────────────────────────────────────────────────────

test('inferType: frontmatter type wins (mapped, lowercased)', () => {
  expect(inferType('tag-index', 'tags/x.md')).toBe('tag');
  expect(inferType('Dream', 'forge/x.md')).toBe('forge');
  expect(inferType('KNOWLEDGE', 'random/x.md')).toBe('knowledge');
});

test('inferType: path fallback then other', () => {
  expect(inferType(undefined, 'tasks/x.md')).toBe('task');
  expect(inferType(undefined, 'reminders/x.md')).toBe('reminder');
  expect(inferType('bogustype', 'inbox/x.md')).toBe('inbox');
  expect(inferType(undefined, 'random/x.md')).toBe('other');
});

test('inferType: index README files keep type index, not their folder type', () => {
  expect(inferType('index', 'inbox/README.md')).toBe('index');
  expect(inferType('index', 'tasks/README.md')).toBe('index');
  expect(inferType('index', 'reminders/README.md')).toBe('index');
});

// ── DATE HAZARD: raw scalar preservation ──────────────────────────────────────

test('rawScalarField preserves the verbatim scalar (ISO-Z NOT collapsed)', () => {
  const yaml = "type: task\ncreated: 2026-07-02T00:00:00.000Z\nupdated: 2026-04-22T21:30\ntag: '2026-04-17'";
  expect(rawScalarField(yaml, 'created')).toBe('2026-07-02T00:00:00.000Z');
  expect(rawScalarField(yaml, 'updated')).toBe('2026-04-22T21:30');
  expect(rawScalarField(yaml, 'tag')).toBe('2026-04-17'); // quoted → unquoted
  expect(rawScalarField(yaml, 'absent')).toBeUndefined();
});

test('parseDoc keeps time-bearing created/updated verbatim (matches live daemon)', () => {
  const rel = write('archive/x.md', '---\ntype: archive\ncreated: 2026-02-12T00:00:00.000Z\nupdated: 2026-04-22T21:30\n---\n\nbody\n');
  const d = parseDoc(root, rel)!;
  expect(d.created).toBe('2026-02-12T00:00:00.000Z');
  expect(d.updated).toBe('2026-04-22T21:30');
});

test('parseDoc: created falls back to started; date-only unquoted preserved', () => {
  const rel = write('forge/m.md', '---\ntype: forge\nstarted: 2026-05-01\n---\n\nbody\n');
  const d = parseDoc(root, rel)!;
  expect(d.created).toBe('2026-05-01');
  expect(d.updated).toBeNull();
});

// ── full parseDoc shape ───────────────────────────────────────────────────────

test('parseDoc: bare knowledge doc — null created/status/updated, empty tags/backlinks', () => {
  const rel = write('knowledge/k.md', '---\ntype: knowledge\n---\n\n# Title\n\nfirst prose line\n');
  const d = parseDoc(root, rel)!;
  expect(d.path).toBe('knowledge/k.md');
  expect(d.title).toBe('Title');
  expect(d.docType).toBe('knowledge');
  expect(d.status).toBeNull();
  expect(d.created).toBeNull();
  expect(d.updated).toBeNull();
  expect(d.tags).toEqual([]);
  expect(d.backlinks).toEqual([]);
  expect(d.excerpt).toBe('first prose line');
  expect(d.pipeline).toBeUndefined();
});

test('parseDoc: forge doc carries pipeline/recipe/role/layer/goal/triggeredBy', () => {
  const rel = write(
    'forge/handles/p/h.md',
    '---\ntype: forge\nstatus: complete\ntags: [forge, gatherer]\ncreated: 2026-06-03\npipeline: my-pipe\nrecipe: custom\nrole: gatherer\nlayer: 0\ngoal: do the thing\ntriggered-by: operator\nreview-status: reviewed\n---\n\n# H\n\nprose\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.pipeline).toBe('my-pipe');
  expect(d.recipe).toBe('custom');
  expect(d.role).toBe('gatherer');
  expect(d.layer).toBe(0);
  expect(d.goal).toBe('do the thing');
  expect(d.triggeredBy).toBe('operator');
  expect(d.reviewStatus).toBe('reviewed');
  expect(d.status).toBe('complete');
  expect(d.tags).toEqual(['forge', 'gatherer']);
  expect(d.created).toBe('2026-06-03');
});

test('parseDoc: recovers a manifest with an unquoted colon in goal (lenient fallback)', () => {
  // strict js-yaml rejects `goal: Dream cycle: audit …`; legacy colon-fixes + parses.
  const rel = write(
    'forge/dreams/sessions/dream.manifest.md',
    '---\ntype: forge\ncreated: 2026-03-18\npipeline: dream-x\nrecipe: project-health\ngoal: Dream cycle: audit active task status\ntriggered-by: dream\nreview-status: reviewed\ntags: [forge, project-health]\n---\n\n- tasks\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.goal).toBe('Dream cycle: audit active task status');
  expect(d.pipeline).toBe('dream-x');
  expect(d.triggeredBy).toBe('dream');
  expect(d.reviewStatus).toBe('reviewed');
  expect(d.tags).toEqual(['forge', 'project-health']);
  expect(d.created).toBe('2026-03-18');
});

test('parseDoc: lenient fallback recovers BLOCK-form tags', () => {
  const rel = write(
    'forge/dreams/sessions/d2.manifest.md',
    '---\ntype: forge\ngoal: Dream cycle: x: y\ntags:\n  - forge\n  - self-orient\n---\n\nbody\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.tags).toEqual(['forge', 'self-orient']);
  expect(d.goal).toBe('Dream cycle: x: y');
});

// ── ALL-OR-NOTHING frontmatter voiding (legacy serde struct semantics) ────────
// document.rs: serde_yaml::from_str::<Frontmatter> with Err(_) => Frontmatter::default().
// One typed-field mismatch voids EVERY frontmatter-derived field. Live-confirmed on
// archive/research/2026-03-12T* + the uisp-api knowledge doc (string-form tags).

test('string-form tags VOID the whole frontmatter: type falls back to path, created null (CRLF)', () => {
  // Mirror of archive/research/2026-03-12T16-16-07-live-network-map-gui-monitoring-dashboard.md
  const rel = write(
    'archive/research/void-crlf.md',
    "---\r\ntype: inbox\r\ncreated: '2026-03-12'\r\nsource: claude\r\ntags: 'networking, monitoring, grafana'\r\n---\r\n# Doc\r\n\r\nprose here\r\n",
  );
  const d = parseDoc(root, rel)!;
  expect(d.docType).toBe('archive'); // NOT 'inbox' — frontmatter is blind, path wins
  expect(d.created).toBeNull(); // NOT '2026-03-12' — struct voided
  expect(d.updated).toBeNull();
  expect(d.status).toBeNull();
  expect(d.tags).toEqual([]);
  // frontmatter-independent fields still work
  expect(d.title).toBe('Doc');
  expect(d.excerpt).toBe('prose here');
});

test('string-form tags VOID with LF + extra unknown fields (uisp-api doc shape)', () => {
  const rel = write(
    'knowledge/routeros/void-lf.md',
    "---\ntype: knowledge\ncreated: '2026-03-12'\nupdated: '2026-03-12'\ntags: 'uisp, networking, api'\ntitle: UISP API access\n---\n# UISP API access\n\nprose\n",
  );
  const d = parseDoc(root, rel)!;
  expect(d.docType).toBe('knowledge'); // path fallback happens to agree here
  expect(d.created).toBeNull();
  expect(d.updated).toBeNull();
  expect(d.tags).toEqual([]);
});

test('unknown extra fields alone do NOT void (serde ignores unknown fields)', () => {
  const rel = write(
    'knowledge/no-void.md',
    "---\ntype: knowledge\ncreated: '2026-03-12'\nsource: claude\ntitle: Extra Title\ngenerated: 2026-05-06\npublish: true\ntags: [a, b]\n---\n# T\n\nprose\n",
  );
  const d = parseDoc(root, rel)!;
  expect(d.created).toBe('2026-03-12');
  expect(d.tags).toEqual(['a', 'b']);
  expect(d.docType).toBe('knowledge');
});

test('bare numeric scalar in a tags SEQUENCE is stringified, not dropped (413 → "413")', () => {
  // Mirror of knowledge/dev-gotchas/webkit-load-failed...md
  const rel = write(
    'knowledge/dev-gotchas/scalar-tag.md',
    '---\ntype: knowledge\ncreated: 2026-05-27\nupdated: 2026-05-27\ntags: [debugging, nginx, 413, diagnosis]\n---\n\n# T\n\nprose\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.tags).toEqual(['debugging', 'nginx', '413', 'diagnosis']); // 4 tags, 413 as STRING
  expect(d.created).toBe('2026-05-27'); // struct NOT voided
});

test('non-u32 layer voids the whole struct', () => {
  const rel = write(
    'forge/bad-layer.md',
    '---\ntype: forge\ncreated: 2026-06-01\npipeline: p\nlayer: not-a-number\ntags: [forge]\n---\n\nprose\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.created).toBeNull();
  expect(d.pipeline).toBeUndefined();
  expect(d.tags).toEqual([]);
  expect(d.docType).toBe('forge'); // path fallback
});

test('non-scalar tags ELEMENT (nested sequence/map) voids the whole struct', () => {
  const rel = write(
    'knowledge/bad-el.md',
    '---\ntype: knowledge\ncreated: 2026-06-01\ntags:\n  - ok\n  - [nested, seq]\n---\n\nprose\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.tags).toEqual([]);
  expect(d.created).toBeNull();
});

test('validateFrontmatterStruct unit: string tags void; scalar-element tags pass', () => {
  expect(validateFrontmatterStruct({ tags: 'a, b' })).toBeNull();
  expect(validateFrontmatterStruct({ tags: ['a', 413, true] })).not.toBeNull();
  expect(validateFrontmatterStruct({ tags: ['a', null] })).toBeNull();
  expect(validateFrontmatterStruct({ created: ['2026'] })).toBeNull(); // seq where string expected
  expect(validateFrontmatterStruct({ layer: 0 })).not.toBeNull();
  expect(validateFrontmatterStruct({ layer: '2' })).not.toBeNull();
  expect(validateFrontmatterStruct({ layer: 1.5 })).toBeNull();
  expect(validateFrontmatterStruct({ signature: { key: 'x' } })).not.toBeNull();
  expect(validateFrontmatterStruct({ signature: 'scalar' })).toBeNull();
  expect(validateFrontmatterStruct({ source: 'claude', title: 'x', anything: [1, 2] })).not.toBeNull(); // unknown fields ignored
});

// ── signature block: raw-scalar-text semantics on nested values ───────────────
// Mirror of forge/output/sample-manifest-pre-strip.md: unquoted nano-precision
// timestamp inside the signature BLOCK MAP must serve verbatim (js-yaml parses it
// into a Date, truncating to `.831Z` — legacy serde_yaml keeps raw scalar text).

test('unquoted nano-precision timestamp inside a signature block map serves VERBATIM', () => {
  const rel = write(
    'forge/output/signed.md',
    '---\ntype: forge\nsignature:\n  algorithm: Ed25519\n  signer: "did:key:z6Mk"\n  timestamp: 2026-05-03T01:18:12.831682200+00:00\n  content-hash: "sha256:aaf0"\n  sig: PfGY1Tzz\ncreated: 2026-05-02\n---\n\n# M\n\nprose\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.signature).toEqual({
    algorithm: 'Ed25519',
    signer: 'did:key:z6Mk',
    timestamp: '2026-05-03T01:18:12.831682200+00:00', // NOT 2026-05-03T01:18:12.831Z
    'content-hash': 'sha256:aaf0',
    sig: 'PfGY1Tzz',
  });
  expect(d.created).toBe('2026-05-02');
});

test('flow/JSON-form signature keeps the js-yaml parse (values quoted → faithful)', () => {
  const rel = write(
    'inbox/ideas/signed-flow.md',
    '---\ntype: inbox\nsignature: {"algorithm":"Ed25519","timestamp":"2026-05-10T23:17:29.453365500+00:00","sig":"U1Gp"}\n---\n\n# T\n\nprose\n',
  );
  const d = parseDoc(root, rel)!;
  expect(d.signature).toEqual({
    algorithm: 'Ed25519',
    timestamp: '2026-05-10T23:17:29.453365500+00:00',
    sig: 'U1Gp',
  });
});

test('rawBlockMapField: nested maps recurse; sequences/inline values bail to undefined', () => {
  const yaml = 'signature:\n  a: 1\n  nested:\n    deep: 2026-05-03T01:18:12.831682200+00:00\ninline: {x: 1}\nseq:\n  - a\n';
  expect(rawBlockMapField(yaml, 'signature')).toEqual({ a: '1', nested: { deep: '2026-05-03T01:18:12.831682200+00:00' } });
  expect(rawBlockMapField(yaml, 'inline')).toBeUndefined(); // inline value → js-yaml fallback
  expect(rawBlockMapField(yaml, 'seq')).toBeUndefined(); // sequence → js-yaml fallback
  expect(rawBlockMapField(yaml, 'absent')).toBeUndefined();
});

// ── extractBody / splitFrontmatter (CRLF fidelity) ────────────────────────────

test('extractBody strips the frontmatter block, keeping the CRLF body verbatim', () => {
  const raw = '---\r\ntype: tag\r\ntag: t\r\n---\r\n\r\n# # T\r\n\r\nbody line\r\n';
  expect(extractBody(raw)).toBe('\r\n# # T\r\n\r\nbody line\r\n');
});

test('splitFrontmatter: no frontmatter → yaml null, body is original', () => {
  expect(splitFrontmatter('# just a doc\n')).toEqual({ yaml: null, body: '# just a doc\n' });
});
