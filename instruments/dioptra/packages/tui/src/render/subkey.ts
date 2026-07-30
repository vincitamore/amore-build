// Node subcategory derivation for the hierarchical type legend — a PURE function mapping a node to
// the sub-bucket it drills into (status for task/reminder, first sub-folder for the rest), plus the
// collision-safe key join the render gate + legend build share. No positions, no color, no OpenTUI.
//
// The "is this type expandable" decision is cross-node (a type is flat when every node sits at its
// root) and cannot be made from one node, so `subKeyOf` returns the ROOT_SUB marker for a root-level
// file and the legend build drops it when the type has no real sub-folder among its current nodes.

import type { GraphNode } from './graph';

/** The sub-bucket for a doc/file sitting directly at a type root (e.g. `knowledge/README.md`). The
 *  legend keeps it only when the type ALSO has at least one real sub-folder among the current nodes. */
export const ROOT_SUB = '(root)';

/**
 * The subcategory a node drills into under its type, or null when the type is never expandable for
 * this node: placeholder/cluster kinds and the tag type never drill; a task/reminder with no status
 * has no bucket; an inbox item with no sub-folder has none. Doc/file types nest by their first path
 * segment (`knowledge/<domain>/…`); a root-level file returns ROOT_SUB (the legend gates whether that
 * survives, since a type whose nodes are ALL at the root is flat).
 */
export function subKeyOf(n: GraphNode): string | null {
  if (n.kind === 'placeholder' || n.kind === 'cluster') return null;
  const type = n.type ?? 'other';
  if (type === 'tag') return null;
  if (type === 'task' || type === 'reminder') return n.status ?? null;
  const segs = n.id.split('/');
  if (type === 'inbox') return segs.length >= 3 ? segs[1] : null;
  // Every other doc/file type: the first sub-folder when nested, else the root marker so the legend
  // can distinguish a flat type (all root, not expandable) from a mixed one (root + real folders).
  return segs.length >= 3 ? segs[1] : ROOT_SUB;
}

/** Collision-safe join for a `type + sub` hidden-sub key. Type names and sub-buckets (statuses,
 *  single path segments, the ROOT_SUB marker) never contain a space, so a single-space separator
 *  cannot alias two different pairs. Shared by the render gate (renderView) and the legend build so
 *  the same node maps to the same key on both sides. */
export function hiddenSubKey(type: string, sub: string): string {
  return `${type} ${sub}`;
}
