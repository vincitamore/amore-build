import type { ForgeListItem } from '@selene/regula';
import { type AgentPair, type ForgeData, type Pipeline, roleLabel } from './forge-data';

export type ForgeSection = 'pipelines' | 'dreams' | 'recipes' | 'proposals';

// One flat list of heterogeneous rows drives the windowed tree (fixed-slot render). Expansion
// (pipelines) and group collapse change which rows are present; the cursor walks them.
export type ForgeRow =
  | { kind: 'group'; id: string; label: string; collapsed: boolean; depth: number }
  | { kind: 'pipeline'; pipeline: Pipeline; expanded: boolean; loading: boolean; depth: number }
  | { kind: 'manifest'; path: string; depth: number }
  | { kind: 'layer'; label: string; depth: number }
  | { kind: 'agent'; agent: AgentPair; last: boolean; depth: number }
  | { kind: 'note'; text: string; depth: number }
  | { kind: 'artifact'; item: ForgeListItem; icon: string; depth: number };

export interface ForgeViewState {
  /** Expanded pipeline names. */
  expanded: Set<string>;
  /** Groups the user manually toggled (XOR with each group's default-collapsed). */
  toggled: Set<string>;
  /** Pipelines whose heavy detail is mid-load. */
  loading: Set<string>;
}

export const DREAM_ICON = '☽'; // dream artifacts (monochrome glyph — fine; the rule is NO emoji)
export const PROPOSAL_ICON = '▶';
export const RECIPE_ICON = '⌘';

function groupCollapsed(id: string, defaultCollapsed: boolean, view: ForgeViewState): boolean {
  return defaultCollapsed !== view.toggled.has(id); // XOR: toggling flips the default
}

export interface ForgeTab {
  key: ForgeSection;
  label: string;
  count: number;
  alert: number;
}

export function forgeTabs(data: ForgeData): ForgeTab[] {
  const pendingDreams =
    data.dreams.filter((d) => d.status === 'pending').length +
    data.dreamPipelines.filter((p) => p.reviewStatus === 'pending').length;
  const pendingProps = data.proposals.filter((p) => p.status === 'pending' || !p.status).length;
  return [
    { key: 'pipelines', label: 'Pipelines', count: data.pipelines.length, alert: 0 },
    { key: 'dreams', label: 'Dreams', count: data.dreamPipelines.length + data.dreams.length, alert: pendingDreams },
    { key: 'recipes', label: 'Recipes', count: data.recipes.length, alert: 0 },
    { key: 'proposals', label: 'Proposals', count: data.proposals.length, alert: pendingProps },
  ];
}

export function flattenForge(section: ForgeSection, data: ForgeData, view: ForgeViewState): ForgeRow[] {
  const rows: ForgeRow[] = [];

  const pushPipeline = (p: Pipeline, depth: number) => {
    const expanded = view.expanded.has(p.name);
    rows.push({ kind: 'pipeline', pipeline: p, expanded, loading: view.loading.has(p.name), depth });
    if (!expanded) return;
    if (p.manifest) rows.push({ kind: 'manifest', path: p.manifest.path, depth: depth + 1 });
    const layers = Array.from(p.layers.entries()).sort(([a], [b]) => a - b);
    // Detail is loaded synchronously on expand, so an empty layer set here means the pipeline
    // genuinely has no handle/output artifacts on disk (manifest-only) — say so, don't look broken.
    if (layers.length === 0) rows.push({ kind: 'note', text: '(manifest only — no handle/output artifacts on disk)', depth: depth + 1 });
    for (const [idx, agents] of layers) {
      rows.push({ kind: 'layer', label: `Layer ${idx} — ${roleLabel(idx, agents)}`, depth: depth + 1 });
      agents.forEach((agent, i) =>
        rows.push({ kind: 'agent', agent, last: i === agents.length - 1, depth: depth + 2 }),
      );
    }
  };

  const pushGroup = (id: string, label: string, defaultCollapsed: boolean, children: () => void) => {
    const collapsed = groupCollapsed(id, defaultCollapsed, view);
    rows.push({ kind: 'group', id, label, collapsed, depth: 0 });
    if (!collapsed) children();
  };

  const pushArtifacts = (items: ForgeListItem[], icon: string) => {
    for (const item of items) rows.push({ kind: 'artifact', item, icon, depth: 1 });
  };

  if (section === 'pipelines') {
    // Pipelines with real handle/output artifacts first; manifest-only ones tucked into a
    // collapsed group (they're just noise without content, but the manifest is kept for provenance).
    const full = data.pipelines.filter((p) => p.hasArtifacts !== false);
    const empty = data.pipelines.filter((p) => p.hasArtifacts === false);
    for (const p of full) pushPipeline(p, 0);
    if (empty.length) pushGroup('pipelines:empty', `Manifest-only — no artifacts (${empty.length})`, true, () => empty.forEach((p) => pushPipeline(p, 1)));
  } else if (section === 'dreams') {
    const pendingP = data.dreamPipelines.filter((p) => p.reviewStatus === 'pending');
    const reviewedP = data.dreamPipelines.filter((p) => p.reviewStatus !== 'pending');
    const pending = data.dreams.filter((d) => d.status === 'pending');
    const acted = data.dreams.filter((d) => d.status === 'acted' || d.status === 'reviewed');
    const otherD = data.dreams.filter((d) => d.status !== 'pending' && d.status !== 'acted' && d.status !== 'reviewed');
    if (pendingP.length) pushGroup('dream:pending-pipelines', `Pending Pipelines (${pendingP.length})`, false, () => pendingP.forEach((p) => pushPipeline(p, 1)));
    if (reviewedP.length) pushGroup('dream:reviewed-pipelines', `Reviewed Pipelines (${reviewedP.length})`, true, () => reviewedP.forEach((p) => pushPipeline(p, 1)));
    if (pending.length) pushGroup('dream:pending', `Pending (${pending.length})`, false, () => pushArtifacts(pending, DREAM_ICON));
    if (acted.length) pushGroup('dream:acted', `Acted (${acted.length})`, true, () => pushArtifacts(acted, DREAM_ICON));
    if (otherD.length) pushGroup('dream:other', `Other (${otherD.length})`, true, () => pushArtifacts(otherD, DREAM_ICON));
  } else if (section === 'recipes') {
    pushArtifacts(data.recipes, RECIPE_ICON);
  } else if (section === 'proposals') {
    const pending = data.proposals.filter((p) => p.status === 'pending' || !p.status);
    const applied = data.proposals.filter((p) => p.status === 'applied');
    const rejected = data.proposals.filter((p) => p.status === 'rejected');
    const stale = data.proposals.filter((p) => p.status === 'stale');
    if (pending.length) pushGroup('prop:pending', `Pending (${pending.length})`, false, () => pushArtifacts(pending, PROPOSAL_ICON));
    if (applied.length) pushGroup('prop:applied', `Applied (${applied.length})`, true, () => pushArtifacts(applied, PROPOSAL_ICON));
    if (rejected.length) pushGroup('prop:rejected', `Rejected (${rejected.length})`, true, () => pushArtifacts(rejected, PROPOSAL_ICON));
    if (stale.length) pushGroup('prop:stale', `Stale (${stale.length})`, true, () => pushArtifacts(stale, PROPOSAL_ICON));
  }

  return rows;
}

/** What Enter opens for a row (the artifact path), or null for toggle/structural rows. */
export function rowOpenPath(row: ForgeRow): string | null {
  switch (row.kind) {
    case 'manifest':
      return row.path;
    case 'agent':
      return row.agent.output?.path ?? row.agent.handle?.path ?? null;
    case 'artifact':
      return row.item.path;
    default:
      return null;
  }
}
