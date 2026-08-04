import type { ForgeListItem } from '@amore/regula';

// Pipeline reconstruction — forge has no "list pipelines" shape on disk; a pipeline is
// rebuilt from many files (manifest + handle/output pairs) sharing a `pipeline` key. Ported
// from the Tauri ForgeView's buildForgeData, enriched with the manifest SHAPE fields
// (depth/width/totalAgents) so a collapsed pipeline card shows its shape without the lazy load.

export interface AgentPair {
  concern: string;
  role: string;
  handle?: ForgeListItem;
  output?: ForgeListItem;
}

export interface Pipeline {
  name: string;
  goal: string;
  recipe: string;
  status?: string;
  triggeredBy?: string;
  reviewStatus?: string;
  created?: string;
  manifest?: ForgeListItem;
  depth?: number;
  width?: number;
  totalAgents?: number;
  started?: string;
  completed?: string;
  /** Whether real handle/output artifacts exist on disk (set by the browser from forgePipelineDirs). */
  hasArtifacts?: boolean;
  /** Populated only after the heavy handles/outputs are lazy-loaded for this pipeline. */
  layers: Map<number, AgentPair[]>;
}

/**
 * The timestamp to sort/display a pipeline by. Operator/custom manifests carry `started`/`completed`
 * but NO `created` — so sorting on `created` alone buried every recent custom run beneath old dream
 * pipelines (which do carry `created`). Fall through created → started → completed.
 */
export function pipelineDate(p: Pipeline): string {
  return String(p.created || p.started || p.completed || '');
}

export interface ForgeData {
  pipelines: Pipeline[];
  dreamPipelines: Pipeline[];
  dreams: ForgeListItem[];
  recipes: ForgeListItem[];
  proposals: ForgeListItem[];
  other: ForgeListItem[];
}

export function inferPipelineFromPath(path: string): string | null {
  const parts = path.split('/');
  if ((parts[1] === 'handles' || parts[1] === 'output') && parts.length >= 4) return parts[2];
  if (parts[1] === 'sessions' && parts[2]) return parts[2].replace('.manifest.md', '').replace('.md', '');
  if (parts[1] === 'dreams' && parts[2] === 'sessions' && parts[3]) return parts[3].replace('.manifest.md', '').replace('.md', '');
  return null;
}

export function buildForgeData(items: ForgeListItem[]): ForgeData {
  const pipelineMap = new Map<string, Pipeline>();
  const dreams: ForgeListItem[] = [];
  const recipes: ForgeListItem[] = [];
  const proposals: ForgeListItem[] = [];
  const other: ForgeListItem[] = [];

  for (const item of items) {
    // Light dream artifacts — but forge/dreams/sessions/ (heavy MANIFESTS) MUST fall through
    // to pipeline grouping so they become dreamPipelines (the review queue). Mis-bucketing them
    // here empties the review surface (the 2026-06-17 reorg trap).
    if (item.path.startsWith('forge/dreams/') && !item.path.startsWith('forge/dreams/sessions/')) {
      dreams.push(item);
      continue;
    }
    if (item.path.startsWith('forge/recipes/')) {
      recipes.push(item);
      continue;
    }
    // ALL proposals, incl. the terminal subfolders (applied/rejected/stale) — the Proposals
    // section buckets them by frontmatter status. (The Tauri version excluded the subfolders,
    // which made its Applied/Rejected/Stale groups dead code: an applied proposal moved into
    // applied/ vanished from the UI. Here those groups actually populate.)
    if (item.path.startsWith('forge/proposals/')) {
      proposals.push(item);
      continue;
    }

    const name = item.pipeline || inferPipelineFromPath(item.path);
    if (!name) {
      other.push(item);
      continue;
    }

    let pipeline = pipelineMap.get(name);
    if (!pipeline) {
      pipeline = {
        name,
        goal: item.goal || '',
        recipe: item.recipe || '',
        triggeredBy: item.triggeredBy,
        created: item.created,
        layers: new Map(),
      };
      pipelineMap.set(name, pipeline);
    }

    // Manifests (operator forge/sessions/ + dream forge/dreams/sessions/) carry status + shape.
    if (item.path.startsWith('forge/sessions/') || item.path.startsWith('forge/dreams/sessions/')) {
      pipeline.manifest = item;
      pipeline.status = item.status;
      pipeline.reviewStatus = item.reviewStatus;
      if (item.goal) pipeline.goal = item.goal;
      if (item.recipe) pipeline.recipe = item.recipe;
      if (item.triggeredBy) pipeline.triggeredBy = item.triggeredBy;
      if (item.created) pipeline.created = item.created;
      if (item.depth !== undefined) pipeline.depth = item.depth;
      if (item.width !== undefined) pipeline.width = item.width;
      if (item.totalAgents !== undefined) pipeline.totalAgents = item.totalAgents;
      if (item.started) pipeline.started = item.started;
      if (item.completed) pipeline.completed = item.completed;
      continue;
    }

    // Handle/output pairs by concern within a layer.
    const layer = item.layer ?? 0;
    let group = pipeline.layers.get(layer);
    if (!group) {
      group = [];
      pipeline.layers.set(layer, group);
    }
    const filename = item.path.split('/').pop()?.replace('.md', '') || '';
    const concern = filename.match(/^layer\d+-(.+)$/)?.[1] || filename;
    let pair = group.find((a) => a.concern === concern);
    if (!pair) {
      pair = { concern, role: item.role || '' };
      group.push(pair);
    }
    if (item.path.startsWith('forge/handles/')) pair.handle = item;
    else if (item.path.startsWith('forge/output/')) pair.output = item;
    if (item.role) pair.role = item.role;
  }

  const all = Array.from(pipelineMap.values());
  const dreamPipelines = all.filter((p) => p.triggeredBy === 'dream');
  const pipelines = all.filter((p) => p.triggeredBy !== 'dream');

  // Newest first; dream names carry ISO timestamps so name-desc is the sub-day tiebreak.
  // Sort by the effective pipeline date (created → started → completed), newest first.
  const byDate = (a: Pipeline, b: Pipeline) => {
    const d = pipelineDate(b).localeCompare(pipelineDate(a));
    return d !== 0 ? d : b.name.localeCompare(a.name);
  };
  pipelines.sort(byDate);
  dreamPipelines.sort(byDate);
  dreams.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));

  return { pipelines, dreamPipelines, dreams, recipes, proposals, other };
}

/** Layer count — loaded detail if present, else the manifest's `depth`. */
export function pipelineLayerCount(p: Pipeline): number {
  return p.layers.size > 0 ? p.layers.size : p.depth ?? 0;
}

/** Agent count — loaded detail if present, else the manifest's `total-agents`. */
export function pipelineAgentCount(p: Pipeline): number {
  let loaded = 0;
  for (const agents of p.layers.values()) loaded += agents.length;
  return loaded > 0 ? loaded : p.totalAgents ?? 0;
}

export function roleLabel(layer: number, agents: AgentPair[]): string {
  if (agents.length === 0) return `Layer ${layer}`;
  const role = agents[0].role;
  const plural = agents.length > 1 ? 's' : '';
  return role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}${plural}` : `Layer ${layer}`;
}
