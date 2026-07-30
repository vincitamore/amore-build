// athanor.ts pure-helper tests against tmpdir fixture org trees. dispatchRun (the
// only side-effecting function — a real detached spawn) is NEVER exercised here;
// buildRunPlan/previewRun prove the dispatch would be correct without running it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRunPlan,
  listPipelines,
  parseRecipeRegistry,
  pipelineResults,
  pipelineStatus,
  previewRun,
} from './athanor.ts';
import { RegulaError } from '@selene/regula';

let org: string;

beforeEach(() => {
  org = mkdtempSync(join(tmpdir(), 'dioptra-athanor-'));
});
afterEach(() => rmSync(org, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const abs = join(org, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** Minimal but faithful athanor recipe source tree (registry + 2 recipe files + entry). */
function scaffoldAthanor(): void {
  write('instruments/athanor/src/index.ts', '// entry\n');
  write(
    'instruments/athanor/src/recipe/registry.ts',
    [
      'import type { RecipeDefinition } from "./types";',
      'import { gatherSynthesize } from "./gather-synthesize";',
      'import { assay } from "./assay";',
      'export class RecipeRegistry {',
      '  constructor() { this.register(gatherSynthesize); this.register(assay); }',
      '}',
    ].join('\n'),
  );
  write(
    'instruments/athanor/src/recipe/gather-synthesize.ts',
    [
      'import type { RecipeDefinition } from "./types";',
      'export const gatherSynthesize: RecipeDefinition = {',
      '  name: "gather-synthesize",',
      '  description: "N gatherers fan out over sources, " +',
      '    "1 synthesizer fans in.",',
      '  layers: [',
      '    { index: 0, agents: [] },',
      '    { index: 1, agents: [] },',
      '  ],',
      '};',
    ].join('\n'),
  );
  write(
    'instruments/athanor/src/recipe/assay.ts',
    [
      'import type { RecipeDefinition } from "./types";',
      'export const assay: RecipeDefinition = {',
      '  name: "assay",',
      '  description: "Multi-perspective audit.",',
      '  layers: [{ index: 0, agents: [] }, { index: 1, agents: [] }, { index: 2, agents: [] }],',
      '};',
    ].join('\n'),
  );
}

// ── recipes: read the REAL registry ─────────────────────────────────────────────
describe('parseRecipeRegistry', () => {
  test('enumerates registered recipes from the registry source (not a hardcoded list)', () => {
    scaffoldAthanor();
    const r = parseRecipeRegistry(org);
    expect(r.total).toBe(2);
    expect(r.source).toBe('instruments/athanor/src/recipe/registry.ts');
    expect(r.recipes.map((x) => x.name)).toEqual(['gather-synthesize', 'assay']);
  });

  test('enriches each recipe with description (multi-line concat) + layer count', () => {
    scaffoldAthanor();
    const r = parseRecipeRegistry(org);
    const gs = r.recipes.find((x) => x.name === 'gather-synthesize')!;
    expect(gs.description).toBe('N gatherers fan out over sources, 1 synthesizer fans in.');
    expect(gs.layers).toBe(2);
    expect(r.recipes.find((x) => x.name === 'assay')!.layers).toBe(3);
  });

  test('skips the ./types import; a new recipe appears with zero list edits', () => {
    scaffoldAthanor();
    // add a third recipe purely by editing the registry imports/register calls
    write(
      'instruments/athanor/src/recipe/registry.ts',
      [
        'import type { RecipeDefinition } from "./types";',
        'import { gatherSynthesize } from "./gather-synthesize";',
        'import { assay } from "./assay";',
        'import { distill } from "./distill";',
      ].join('\n'),
    );
    write(
      'instruments/athanor/src/recipe/distill.ts',
      'export const distill = { name: "distill", description: "Compress.", layers: [{ index: 0, agents: [] }] };',
    );
    const r = parseRecipeRegistry(org);
    expect(r.recipes.map((x) => x.name)).toEqual(['gather-synthesize', 'assay', 'distill']);
  });

  test('absent registry → NOT_FOUND', () => {
    expect(() => parseRecipeRegistry(org)).toThrow(RegulaError);
  });
});

// ── list ────────────────────────────────────────────────────────────────────────
describe('listPipelines', () => {
  const manifest = (fm: Record<string, string>) =>
    `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# body\n`;

  test('empty when no sessions dir', () => {
    expect(listPipelines(org)).toEqual({ pipelines: [], total: 0 });
  });

  test('newest-first by filename, projected fields, honors limit', () => {
    write('forge/sessions/aaa.manifest.md', manifest({ status: 'complete', recipe: 'distill', goal: 'A', 'total-agents': '3' }));
    write('forge/sessions/bbb.manifest.md', manifest({ status: 'running', recipe: 'assay', goal: 'B', 'total-agents': '5' }));
    write('forge/sessions/ccc.manifest.md', manifest({ status: 'partial', recipe: 'copia', goal: 'C', 'total-agents': '2' }));
    const all = listPipelines(org);
    expect(all.total).toBe(3);
    expect(all.pipelines.map((p) => p.name)).toEqual(['ccc', 'bbb', 'aaa']); // sort().reverse()
    expect(all.pipelines[0]).toMatchObject({ name: 'ccc', status: 'partial', recipe: 'copia', agents: 2 });
    const limited = listPipelines(org, 1);
    expect(limited.total).toBe(3); // total counts all
    expect(limited.pipelines).toHaveLength(1);
  });
});

// ── status ────────────────────────────────────────────────────────────────────
describe('pipelineStatus', () => {
  test('manifest present → parsed status + recent events + outcome', () => {
    write(
      'forge/sessions/mypipe.manifest.md',
      [
        '---',
        'status: complete',
        'recipe: distill',
        'goal: Do a thing',
        'started: 2026-07-03T10:00:00',
        'completed: 2026-07-03T10:20:00',
        'depth: 2',
        'width: 3',
        'total-agents: 4',
        '---',
        '',
        '## Execution Log',
        '<!-- appended as the pipeline runs -->',
        '- ev1',
        '- ev2',
        '',
        '## Outcome',
        'All good.',
      ].join('\n'),
    );
    const s = pipelineStatus(org, 'mypipe');
    expect(s).toMatchObject({
      name: 'mypipe',
      status: 'complete',
      recipe: 'distill',
      goal: 'Do a thing',
      depth: 2,
      width: 3,
      totalAgents: 4,
      totalEvents: 2,
      outcome: 'All good.',
    });
    expect(s.recentEvents).toEqual(['- ev1', '- ev2']);
  });

  test('no manifest + crash log with content → failed', () => {
    write('forge/.tmp/crashed.log', 'Error: boom\nstack...');
    const s = pipelineStatus(org, 'crashed');
    expect(s.status).toBe('failed');
    expect(String(s.error)).toContain('boom');
  });

  test('no manifest + empty log → starting', () => {
    write('forge/.tmp/pending.log', '');
    expect(pipelineStatus(org, 'pending').status).toBe('starting');
  });

  test('neither manifest nor log → NOT_FOUND', () => {
    expect(() => pipelineStatus(org, 'ghost')).toThrow(RegulaError);
  });
});

// ── results ─────────────────────────────────────────────────────────────────────
describe('pipelineResults', () => {
  test('incomplete pipeline → results-not-ready message', () => {
    write('forge/sessions/p.manifest.md', '---\nstatus: active\n---\n');
    const r = pipelineResults(org, 'p');
    expect(r.status).toBe('active');
    expect(String(r.message)).toContain('not yet available');
  });

  test('complete pipeline → namespaced layer handles keyed by concern (+ --full outputs)', () => {
    write('forge/sessions/p.manifest.md', '---\nstatus: complete\n---\n');
    write('forge/handles/p/layer0-alpha.md', 'handle-alpha');
    write('forge/handles/p/layer0-beta.md', 'handle-beta');
    write('forge/handles/p/layer1-synth.md', 'handle-synth');
    write('forge/output/p/layer1-synth.md', 'output-synth');

    const last = pipelineResults(org, 'p'); // default: last layer (1)
    expect(last.layer).toBe(1);
    expect(Object.keys(last.results as object)).toEqual(['synth']);
    expect((last.results as Record<string, { handle: string }>).synth.handle).toBe('handle-synth');

    const l0 = pipelineResults(org, 'p', { layer: 0 });
    expect(Object.keys(l0.results as object).sort()).toEqual(['alpha', 'beta']);

    const full = pipelineResults(org, 'p', { layer: 1, full: true });
    expect((full.results as Record<string, { output?: string }>).synth.output).toBe('output-synth');
  });

  test('absent manifest → NOT_FOUND', () => {
    expect(() => pipelineResults(org, 'nope')).toThrow(RegulaError);
  });
});

// ── run: buildRunPlan / previewRun (NO spawn) ─────────────────────────────────────
describe('buildRunPlan', () => {
  test('valid plan always passes --name (authoritative for a follow-up status)', () => {
    scaffoldAthanor();
    const plan = buildRunPlan(org, { recipe: 'gather-synthesize', goal: 'Analyze forge conventions', sources: ['a.md', 'b.md'] });
    expect(plan.name).toBe('analyze-forge-conventions');
    expect(plan.args).toContain('--name');
    expect(plan.args[plan.args.indexOf('--name') + 1]).toBe('analyze-forge-conventions');
    expect(plan.args).toContain('--recipe');
    expect(plan.args[plan.args.indexOf('--sources') + 1]).toBe('a.md,b.md');
    expect(plan.args[plan.args.indexOf('--org-root') + 1]).toBe(org);
    expect(plan.concernsFileToWrite).toBeUndefined();
  });

  test('missing athanor entry → NOT_FOUND', () => {
    expect(() => buildRunPlan(org, { recipe: 'x', goal: 'y', sources: ['a.md'] })).toThrow(RegulaError);
  });

  test('missing recipe/goal/sources → USAGE (before any spawn)', () => {
    scaffoldAthanor();
    expect(() => buildRunPlan(org, { recipe: '', goal: 'g', sources: ['a.md'] })).toThrow(/--recipe/);
    expect(() => buildRunPlan(org, { recipe: 'r', goal: '', sources: ['a.md'] })).toThrow(/--goal/);
    expect(() => buildRunPlan(org, { recipe: 'r', goal: 'g', sources: [] })).toThrow(/--sources/);
  });

  test('a concerns-requiring recipe without concerns → USAGE; with concerns → temp file planned', () => {
    scaffoldAthanor();
    expect(() => buildRunPlan(org, { recipe: 'assay', goal: 'Audit', sources: ['x.md'] })).toThrow(/requires concerns/);
    const plan = buildRunPlan(
      org,
      { recipe: 'assay', goal: 'Audit', sources: ['x.md'], concerns: { '1': ['a', 'b'] } },
      1234,
    );
    expect(plan.concernsFileToWrite).toBe(join(org, 'forge', '.tmp', 'concerns-1234.json'));
    expect(plan.args).toContain('--concerns-file');
  });

  test('--concerns-file passthrough: resolved path in args, nothing to write', () => {
    scaffoldAthanor();
    write('forge/.tmp/my-concerns.json', JSON.stringify({ '1': ['a', 'b'] }));
    const plan = buildRunPlan(org, { recipe: 'assay', goal: 'Audit', sources: ['x.md'], concernsFile: 'forge/.tmp/my-concerns.json' });
    expect(plan.concernsFileToWrite).toBeUndefined();
    expect(plan.args[plan.args.indexOf('--concerns-file') + 1]).toBe(join(org, 'forge', '.tmp', 'my-concerns.json'));
  });

  test('previewRun exposes the exact would-run command, dispatched:false', () => {
    scaffoldAthanor();
    const plan = buildRunPlan(org, { recipe: 'gather-synthesize', goal: 'G', sources: ['a.md'], clean: true });
    const p = previewRun(plan);
    expect(p.preview).toBe(true);
    expect(p.dispatched).toBe(false);
    expect(p.command).toBe('bun');
    expect(p.args).toEqual(plan.args);
    expect((plan.args as string[]).includes('--clean')).toBe(true);
  });
});
