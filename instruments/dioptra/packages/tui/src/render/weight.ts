import type { GraphNode } from './graph';

// Attention weighting: turn a node's (type, status, degree) into a prominence signal so the
// graph surfaces what wants action. Status is the primary axis (blocked/review work and open
// decisions rank high; done/paused/resolved rank to zero); node degree breaks ties within a
// tier so hubs sort ahead of leaves. Pure classification — no color/layout knowledge here.

export type AttentionTier = 0 | 1 | 2 | 3;

/**
 * Attention tier for a node, 0 (dormant) → 3 (hot). Driven by frontmatter status per doc type;
 * a node with no status carries no attention signal and stays neutral (tier 1), so recoloring
 * never invents urgency the data doesn't state. Placeholders (unresolved links) are dormant.
 */
export function attentionTier(n: GraphNode): AttentionTier {
  if (n.kind === 'placeholder') return 0;
  const s = n.status;
  if (!s) return 1; // no status → neutral (knowledge, files, untyped)
  switch (n.type) {
    case 'task':
      if (s === 'blocked' || s === 'review') return 3; // gating you / needs a decision
      if (s === 'active') return 2;
      if (s === 'backlog' || s === 'incubating') return 1;
      return 0; // paused, complete
    case 'inbox':
      return s === 'open' ? 2 : 0; // resolved / dropped / superseded → dormant
    case 'reminder':
      if (s === 'completed' || s === 'dismissed') return 0;
      return 2; // pending / ongoing / snoozed
    case 'forge':
      return s === 'complete' ? 0 : 1; // pipelines settle to dormant when done
    case 'ticket':
      return s === 'closed' || s === 'resolved' ? 0 : 2;
    default:
      return 1;
  }
}

const DEGREE_CAP = 24; // beyond this, extra links stop adding rank (avoids one mega-hub dominating)

/**
 * Continuous attention weight = tier + a sub-unit degree bonus. Tier always dominates (a hot
 * leaf outranks a dormant hub), and within a tier a better-connected node ranks inward. Used by
 * the radial layout to place high-attention nodes toward the center.
 */
export function attentionWeight(n: GraphNode, degree = 0): number {
  return attentionTier(n) + (Math.min(degree, DEGREE_CAP) / DEGREE_CAP) * 0.95;
}
