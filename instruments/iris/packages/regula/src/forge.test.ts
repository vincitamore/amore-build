import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import matter from 'gray-matter';
import {
  listForge,
  listForgePipelineDetails,
  markDreamActed,
  markPipelineReviewed,
  resolveProposal,
} from './forge';
import { RegulaError } from './errors';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-forge-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const fmOf = (rel: string) => matter(readFileSync(join(root, rel), 'utf-8')).data;

function seed(rel: string, fm: Record<string, unknown>, body = 'Artifact') {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, matter.stringify(`# ${body}\n`, fm));
}

test('listForge reads the lightweight roots and projects manifest shape fields', () => {
  seed('forge/sessions/alpha.manifest.md', {
    type: 'forge', pipeline: 'alpha', recipe: 'custom', goal: 'Do a thing',
    'triggered-by': 'operator', status: 'complete', created: '2026-06-29',
    depth: 2, width: 6, 'total-agents': 9,
  });
  seed('forge/dreams/sessions/dream-x.manifest.md', {
    type: 'forge', pipeline: 'dream-x', recipe: 'dream-digest',
    'triggered-by': 'dream', 'review-status': 'pending', created: '2026-06-04',
    depth: 4, width: 4, 'total-agents': 7,
  });
  seed('forge/dreams/light-report.md', { type: 'forge', 'dream-action': 'tag-regen', status: 'pending', created: '2026-06-10' });
  seed('forge/proposals/prop-1.md', { type: 'forge', status: 'pending', created: '2026-06-11' });
  seed('forge/recipes/gather.md', { type: 'forge', created: '2026-06-01' });

  const items = listForge(root);
  expect(items.length).toBe(5);

  const alpha = items.find((i) => i.pipeline === 'alpha')!;
  expect(alpha.depth).toBe(2);
  expect(alpha.width).toBe(6);
  expect(alpha.totalAgents).toBe(9);
  expect(alpha.triggeredBy).toBe('operator');

  const dream = items.find((i) => i.pipeline === 'dream-x')!;
  expect(dream.reviewStatus).toBe('pending');
  expect(dream.totalAgents).toBe(7);
});

test('listForge RECOVERS a manifest with invalid YAML (unquoted colon in goal) instead of dropping it', () => {
  // The dream-manifest YAML bug: `goal:` with an unquoted colon → strict YAML throws.
  const bad = join(root, 'forge/dreams/sessions/dream-x.manifest.md');
  mkdirSync(dirname(bad), { recursive: true });
  writeFileSync(
    bad,
    `---
type: forge
pipeline: dream-x
recipe: dream-digest
goal: Dream cycle: audit active task status, identify stale work
triggered-by: dream
review-status: reviewed
depth: 4
total-agents: 7
tags: [forge, dream-digest]
---
# Dream
`,
  );
  const items = listForge(root);
  const it = items.find((i) => i.pipeline === 'dream-x');
  expect(it).toBeTruthy();
  expect(it!.triggeredBy).toBe('dream'); // classification field survives
  expect(it!.reviewStatus).toBe('reviewed');
  expect(it!.totalAgents).toBe(7);
  expect(it!.goal).toBe('Dream cycle: audit active task status, identify stale work'); // colon preserved
  expect(it!.tags).toContain('dream-digest');
});

test('listForge EXCLUDES the heavy handles/output trees', () => {
  seed('forge/sessions/alpha.manifest.md', { type: 'forge', pipeline: 'alpha', created: '2026-06-29' });
  seed('forge/handles/alpha/layer0-x.md', { type: 'forge', pipeline: 'alpha', role: 'gatherer', layer: 0 });
  seed('forge/output/alpha/layer0-x.md', { type: 'forge', pipeline: 'alpha', role: 'gatherer', layer: 0 });

  const light = listForge(root);
  expect(light.map((i) => i.path)).toEqual(['forge/sessions/alpha.manifest.md']);

  const details = listForgePipelineDetails(root, 'alpha');
  expect(details.map((i) => i.path).sort()).toEqual([
    'forge/handles/alpha/layer0-x.md',
    'forge/output/alpha/layer0-x.md',
  ]);
});

test('listForge tolerates a malformed file (skips, does not throw)', () => {
  seed('forge/sessions/good.manifest.md', { type: 'forge', pipeline: 'good', created: '2026-06-29' });
  const bad = join(root, 'forge/proposals/bad.md');
  mkdirSync(dirname(bad), { recursive: true });
  writeFileSync(bad, '---\nthis: : : broken yaml\n---\nbody\n');
  const items = listForge(root);
  expect(items.some((i) => i.pipeline === 'good')).toBe(true);
});

test('markDreamActed flips status pending → acted in place', () => {
  seed('forge/dreams/r.md', { type: 'forge', status: 'pending', 'dream-action': 'x' });
  const r = markDreamActed(root, 'forge/dreams/r.md');
  expect(r.status).toBe('acted');
  expect(fmOf('forge/dreams/r.md').status).toBe('acted');
});

test('markPipelineReviewed flips review-status pending → reviewed on the manifest', () => {
  seed('forge/dreams/sessions/d.manifest.md', { type: 'forge', pipeline: 'd', 'review-status': 'pending' });
  markPipelineReviewed(root, 'forge/dreams/sessions/d.manifest.md');
  expect(fmOf('forge/dreams/sessions/d.manifest.md')['review-status']).toBe('reviewed');
});

test('resolveProposal patches status AND atomically moves into proposals/<target>/', () => {
  seed('forge/proposals/p.md', { type: 'forge', status: 'pending' });
  const r = resolveProposal(root, 'forge/proposals/p.md', 'applied');
  expect(r.newPath).toBe('forge/proposals/applied/p.md');
  expect(existsSync(join(root, 'forge/proposals/p.md'))).toBe(false); // moved, not duplicated
  expect(existsSync(join(root, 'forge/proposals/applied/p.md'))).toBe(true);
  expect(fmOf('forge/proposals/applied/p.md').status).toBe('applied');
});

test('resolveProposal on a file already in a subfolder re-patches in place (no move)', () => {
  seed('forge/proposals/applied/p.md', { type: 'forge', status: 'applied' });
  const r = resolveProposal(root, 'forge/proposals/applied/p.md', 'stale');
  expect(r.newPath).toBe('forge/proposals/applied/p.md');
  expect(fmOf('forge/proposals/applied/p.md').status).toBe('stale');
});

test('resolveProposal rejects a non-forge file and a bad target', () => {
  seed('forge/proposals/p.md', { type: 'forge', status: 'pending' });
  expect(() => resolveProposal(root, 'forge/proposals/p.md', 'bogus' as never)).toThrow(RegulaError);
  seed('inbox/decisions/d.md', { type: 'inbox', status: 'open' });
  expect(() => resolveProposal(root, 'inbox/decisions/d.md', 'applied')).toThrow(/Not a forge artifact/);
});
