import { test, expect } from 'bun:test';
import type { ForgeListItem } from '@amore/regula';
import {
  buildForgeData,
  pipelineAgentCount,
  pipelineHasProducts,
  pipelineLayerCount,
} from './forge-data';
import { flattenForge, forgeTabs, rowOpenPath, type ForgeViewState } from './forge-rows';

function item(path: string, extra: Partial<ForgeListItem> = {}): ForgeListItem {
  return { path, title: path.split('/').pop() || path, tags: [], ...extra };
}
const view = (o: Partial<ForgeViewState> = {}): ForgeViewState => ({
  expanded: new Set(),
  toggled: new Set(),
  loading: new Set(),
  ...o,
});

test('dreams/sessions manifests become dreamPipelines, NOT light dreams (the reorg trap)', () => {
  const data = buildForgeData([
    item('forge/dreams/sessions/dream-x.manifest.md', { pipeline: 'dream-x', triggeredBy: 'dream', reviewStatus: 'pending' }),
    item('forge/dreams/light.md', { status: 'pending', dreamAction: 'tag-regen' }),
  ]);
  expect(data.dreamPipelines.map((p) => p.name)).toEqual(['dream-x']);
  expect(data.dreams.map((d) => d.path)).toEqual(['forge/dreams/light.md']); // light dream stays light
});

test('operator vs dream pipelines split by triggered-by', () => {
  const data = buildForgeData([
    item('forge/sessions/op.manifest.md', { pipeline: 'op', triggeredBy: 'operator' }),
    item('forge/dreams/sessions/dr.manifest.md', { pipeline: 'dr', triggeredBy: 'dream' }),
  ]);
  expect(data.pipelines.map((p) => p.name)).toEqual(['op']);
  expect(data.dreamPipelines.map((p) => p.name)).toEqual(['dr']);
});

test('handle + output pair by concern; manifest supplies shape fields', () => {
  const data = buildForgeData([
    item('forge/sessions/alpha.manifest.md', { pipeline: 'alpha', triggeredBy: 'operator', depth: 2, width: 3, totalAgents: 5, status: 'complete' }),
    item('forge/handles/alpha/layer0-structure.md', { pipeline: 'alpha', role: 'analyst', layer: 0 }),
    item('forge/output/alpha/layer0-structure.md', { pipeline: 'alpha', role: 'analyst', layer: 0 }),
    item('forge/handles/alpha/layer1-synthesis.md', { pipeline: 'alpha', role: 'synthesizer', layer: 1 }),
  ]);
  const p = data.pipelines[0];
  const l0 = p.layers.get(0)!;
  expect(l0).toHaveLength(1);
  expect(l0[0].concern).toBe('structure');
  expect(l0[0].handle?.path).toBe('forge/handles/alpha/layer0-structure.md');
  expect(l0[0].output?.path).toBe('forge/output/alpha/layer0-structure.md');
  expect(p.layers.get(1)![0].concern).toBe('synthesis');
  // Loaded detail wins for the counts...
  expect(pipelineLayerCount(p)).toBe(2);
  expect(pipelineAgentCount(p)).toBe(2);
});

test('collapsed pipeline shows shape from the manifest (no lazy load needed)', () => {
  const data = buildForgeData([
    item('forge/sessions/beta.manifest.md', { pipeline: 'beta', triggeredBy: 'operator', depth: 3, totalAgents: 9 }),
  ]);
  const p = data.pipelines[0];
  expect(p.layers.size).toBe(0); // no handles/outputs loaded
  expect(pipelineLayerCount(p)).toBe(3); // falls back to manifest depth
  expect(pipelineAgentCount(p)).toBe(9); // falls back to manifest total-agents
});

test('proposals INCLUDE terminal subfolders (bucketed by status); recipes separate', () => {
  const data = buildForgeData([
    item('forge/proposals/p1.md', { status: 'pending' }),
    item('forge/proposals/applied/p2.md', { status: 'applied' }),
    item('forge/recipes/gather.md'),
  ]);
  // Both proposals present (the Applied group populates, unlike the Tauri dead-code groups).
  expect(data.proposals.map((p) => p.path).sort()).toEqual(['forge/proposals/applied/p2.md', 'forge/proposals/p1.md']);
  expect(data.recipes.map((r) => r.path)).toEqual(['forge/recipes/gather.md']);

  // Proposals section: pending group open, applied group present+collapsed.
  const rows = flattenForge('proposals', data, view());
  const groups = rows.filter((r) => r.kind === 'group').map((r) => (r as { label: string }).label);
  expect(groups).toEqual(['Pending (1)', 'Applied (1)']);
});

test('forgeTabs surfaces pending alerts for dreams + proposals', () => {
  const data = buildForgeData([
    item('forge/dreams/sessions/d.manifest.md', { pipeline: 'd', triggeredBy: 'dream', reviewStatus: 'pending' }),
    item('forge/dreams/light.md', { status: 'pending' }),
    item('forge/proposals/p.md', { status: 'pending' }),
    item('forge/proposals/applied/q.md', { status: 'applied' }),
  ]);
  const tabs = forgeTabs(data);
  expect(tabs.find((t) => t.key === 'dreams')!.alert).toBe(2); // 1 pending pipeline + 1 pending light
  expect(tabs.find((t) => t.key === 'proposals')!.alert).toBe(1);
});

test('flattenForge: pipeline collapsed→1 row, expanded→manifest+layer+agent rows', () => {
  const data = buildForgeData([
    item('forge/sessions/alpha.manifest.md', { pipeline: 'alpha', triggeredBy: 'operator' }),
    item('forge/handles/alpha/layer0-x.md', { pipeline: 'alpha', role: 'gatherer', layer: 0 }),
    item('forge/output/alpha/layer0-x.md', { pipeline: 'alpha', role: 'gatherer', layer: 0 }),
  ]);
  expect(flattenForge('pipelines', data, view())).toHaveLength(1); // collapsed
  const rows = flattenForge('pipelines', data, view({ expanded: new Set(['alpha']) }));
  expect(rows.map((r) => r.kind)).toEqual(['pipeline', 'manifest', 'layer', 'agent']);
  expect(rowOpenPath(rows[3])).toBe('forge/output/alpha/layer0-x.md'); // agent opens output
});

test('flattenForge dreams: pending groups expand by default, reviewed/acted collapse', () => {
  const data = buildForgeData([
    item('forge/dreams/sessions/dp.manifest.md', { pipeline: 'dp', triggeredBy: 'dream', reviewStatus: 'pending' }),
    item('forge/dreams/sessions/dr.manifest.md', { pipeline: 'dr', triggeredBy: 'dream', reviewStatus: 'reviewed' }),
    item('forge/dreams/lp.md', { status: 'pending' }),
  ]);
  const rows = flattenForge('dreams', data, view());
  const kinds = rows.map((r) => (r.kind === 'group' ? `group:${(r as { label: string }).label}` : r.kind));
  // pending-pipelines group open → its pipeline row present; reviewed group collapsed → no child
  expect(kinds).toContain('pipeline');
  const reviewedGroup = rows.find((r) => r.kind === 'group' && r.label.startsWith('Reviewed'))!;
  expect(reviewedGroup.kind === 'group' && reviewedGroup.collapsed).toBe(true);
});

test('agentic dream: report + proposal join pipeline by frontmatter pipeline: (not Other)', () => {
  const data = buildForgeData([
    item('forge/dreams/sessions/20260805-120000-self-orient.manifest.md', {
      pipeline: 'dream-self-orient',
      recipe: 'dream',
      triggeredBy: 'dream',
      reviewStatus: 'pending',
      created: '2026-08-05',
      goal: 'Self-orient cycle',
    }),
    item('forge/dreams/self-orient-report.md', {
      pipeline: 'dream-self-orient',
      recipe: 'dream',
      status: 'pending',
      created: '2026-08-05',
      triggeredBy: 'dream',
    }),
    item('forge/proposals/tweak-orient.md', {
      pipeline: 'dream-self-orient',
      status: 'pending',
      title: 'Tweak orient docs',
      created: '2026-08-05',
    }),
    // Unlinked light — stays in standalone dreams
    item('forge/dreams/orphan-light.md', { status: 'pending', dreamAction: 'other' }),
  ]);

  expect(data.dreamPipelines).toHaveLength(1);
  const p = data.dreamPipelines[0]!;
  expect(p.name).toBe('dream-self-orient');
  expect(p.linkedArtifacts?.map((a) => a.path).sort()).toEqual([
    'forge/dreams/self-orient-report.md',
    'forge/proposals/tweak-orient.md',
  ]);
  // Not double-listed in standalone buckets
  expect(data.dreams.map((d) => d.path)).toEqual(['forge/dreams/orphan-light.md']);
  expect(data.proposals).toEqual([]);
  expect(pipelineHasProducts(p)).toBe(true);

  const rows = flattenForge(
    'dreams',
    data,
    view({ expanded: new Set(['dream-self-orient']) }),
  );
  const note = rows.find((r) => r.kind === 'note');
  expect(note).toBeUndefined(); // must NOT say "manifest only"
  const artifactPaths = rows
    .filter((r) => r.kind === 'artifact')
    .map((r) => (r.kind === 'artifact' ? r.item.path : ''));
  expect(artifactPaths).toContain('forge/dreams/self-orient-report.md');
  expect(artifactPaths).toContain('forge/proposals/tweak-orient.md');
  // Orphan stays in Pending light group, not under pipeline
  expect(artifactPaths).toContain('forge/dreams/orphan-light.md');
});

test('agentic dream legacy action+date joins report without pipeline field', () => {
  const data = buildForgeData([
    item('forge/dreams/sessions/20260805-091500-substrate-health.manifest.md', {
      pipeline: 'dream-substrate-health',
      triggeredBy: 'dream',
      reviewStatus: 'pending',
      created: '2026-08-05',
    }),
    item('forge/dreams/20260805-091500-substrate-health.md', {
      status: 'pending',
      created: '2026-08-05',
      dreamAction: 'substrate-health',
    }),
  ]);
  expect(data.dreams).toEqual([]);
  expect(data.dreamPipelines[0]!.linkedArtifacts).toHaveLength(1);
  const rows = flattenForge(
    'dreams',
    data,
    view({ expanded: new Set(['dream-substrate-health']) }),
  );
  expect(rows.some((r) => r.kind === 'note')).toBe(false);
  expect(rows.some((r) => r.kind === 'artifact')).toBe(true);
});

test('true manifest-only dream still shows the annotation', () => {
  const data = buildForgeData([
    item('forge/dreams/sessions/empty-dream.manifest.md', {
      pipeline: 'dream-empty',
      triggeredBy: 'dream',
      reviewStatus: 'pending',
    }),
  ]);
  const rows = flattenForge('dreams', data, view({ expanded: new Set(['dream-empty']) }));
  const note = rows.find((r) => r.kind === 'note');
  expect(note && note.kind === 'note' && note.text).toContain('manifest only');
});

test('forge-master-shaped pipeline still renders handle/output layers unchanged', () => {
  const data = buildForgeData([
    item('forge/sessions/alpha.manifest.md', {
      pipeline: 'alpha',
      triggeredBy: 'operator',
      depth: 2,
      totalAgents: 2,
      status: 'complete',
    }),
    item('forge/handles/alpha/layer0-structure.md', { pipeline: 'alpha', role: 'analyst', layer: 0 }),
    item('forge/output/alpha/layer0-structure.md', { pipeline: 'alpha', role: 'analyst', layer: 0 }),
    item('forge/handles/alpha/layer1-synthesis.md', { pipeline: 'alpha', role: 'synthesizer', layer: 1 }),
    item('forge/output/alpha/layer1-synthesis.md', { pipeline: 'alpha', role: 'synthesizer', layer: 1 }),
  ]);
  const p = data.pipelines[0]!;
  expect(p.layers.size).toBe(2);
  expect(p.linkedArtifacts ?? []).toEqual([]);
  expect(pipelineLayerCount(p)).toBe(2);
  expect(pipelineAgentCount(p)).toBe(2);

  const rows = flattenForge('pipelines', data, view({ expanded: new Set(['alpha']) }));
  expect(rows.map((r) => r.kind)).toEqual([
    'pipeline',
    'manifest',
    'layer',
    'agent',
    'layer',
    'agent',
  ]);
  expect(rows.some((r) => r.kind === 'note')).toBe(false);
  // Agent still opens output path
  const agents = rows.filter((r) => r.kind === 'agent');
  expect(rowOpenPath(agents[0]!)).toBe('forge/output/alpha/layer0-structure.md');
});
