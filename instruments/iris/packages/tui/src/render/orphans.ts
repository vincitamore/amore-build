// Transient-orphan filter — the render-only predicate that hides zero-link nodes which are
// transient-BY-DESIGN (archived / completed / dream / handle artifacts that are SUPPOSED to be
// linkless), so the graph's orphan noise collapses to the genuinely fix-worthy orphans.
//
// This module is PURE (path matching + set arithmetic only — no positions, no config, no OpenTUI):
// given the graph's node/link set it returns the set of node ids to hide. `GraphView` gates on the
// config knob (`orphans: 'hide-transient' | 'all'`) and hands the set to `renderView` as a
// node-visibility filter, exactly like `hiddenTypes` — layout + `graphSignature` never see it, so
// toggling the filter never reflows (the same doctrine as the typed-edge overlay in `overlay.ts`).

/**
 * Doc-path prefixes whose ORPHAN nodes are transient-by-design. A node is a "transient orphan" iff
 * it has zero links (neither end of any rendered link) AND its path is under one of these. The list
 * is the decided design surface — deliberately narrow: a LINKED doc under any of these paths is not
 * filtered (it earned its place in the web), and an orphan OUTSIDE these paths is not filtered (it's
 * a genuinely fix-worthy orphan the filter exists to surface).
 */
export const TRANSIENT_ORPHAN_PREFIXES = [
  'archive/',
  'forge/', // the WHOLE forge tree: dreams/handles/output/proposals/sessions are all pipeline
  // artifacts, transient-by-design as orphans (live-measured 2026-07-02: the narrower
  // dreams+handles pair left 538 forge orphans in "remaining fix-worthy" — output 345,
  // proposals 136, sessions 57). The orphan-only guard keeps this safe: a LINKED forge doc
  // (a recipe cited by a task, a manifest wikilinked from a decision) is never hidden.
  'inbox/captures/',
  'tasks/completed/',
  'reminders/completed/',
] as const;

/** Node ids / doc paths are org-relative with forward slashes (verified against /api/graph), but a
 *  handful carry backslashes — normalize so both separators match the same prefixes. */
function normalizePath(id: string): string {
  return id.replace(/\\/g, '/');
}

/** Whether a doc path falls under one of the transient-orphan prefixes. Pure, path-only. The
 *  trailing slash on each prefix is load-bearing: `archived/x.md` is NOT under `archive/`. */
export function isTransientPath(path: string): boolean {
  const p = normalizePath(path);
  return TRANSIENT_ORPHAN_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/** The node/link shape the predicate needs (a structural VIEW of GraphData — the node id IS its path). */
export interface OrphanGraph {
  nodes: { id: string }[];
  links: { source: string; target: string }[];
}

/**
 * The set of node ids to hide as transient orphans: nodes with ZERO links whose path is transient.
 * Pure — no positions, no config; the caller decides whether to apply it. Nodes with any link (a
 * linked archive doc, a completed task someone still references) are NEVER hidden, and orphans
 * outside the transient prefixes are NEVER hidden.
 */
export function transientOrphans(graph: OrphanGraph): Set<string> {
  const linked = new Set<string>();
  for (const l of graph.links) {
    linked.add(l.source);
    linked.add(l.target);
  }
  const hidden = new Set<string>();
  for (const n of graph.nodes) {
    if (linked.has(n.id)) continue; // has a link (either end) → not an orphan
    if (isTransientPath(n.id)) hidden.add(n.id);
  }
  return hidden;
}
