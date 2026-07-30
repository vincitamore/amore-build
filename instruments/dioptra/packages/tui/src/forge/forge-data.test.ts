import { test, expect } from 'bun:test';
import type { ForgeListItem } from '@selene/regula';
import { buildForgeData, pipelineAgentCount, pipelineLayerCount } from './forge-data';
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
