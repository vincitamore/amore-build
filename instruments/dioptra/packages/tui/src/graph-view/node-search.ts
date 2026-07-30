// Pure node search for the graph's search-to-focus overlay: fuzzy-match nodes by label/path so a
// specific known node can be jumped to without visually hunting. No positions, no color, no OpenTUI —
// unit-tested in isolation.
//
// Ranking is a two-key sort: first the match TIER (how the query hit the node), then a within-tier
// order (link-count desc, then label). The tiers, best-first:
//   0  label prefix   — the node's label starts with the term
//   1  label substring — the term appears anywhere in the label
//   2  id substring    — the term appears in the id (path) but not the label
// A node not matching a term at any tier is excluded.

import type { GraphNode } from '../render/graph';

const TIER_LABEL_PREFIX = 0;
const TIER_LABEL_SUBSTR = 1;
const TIER_ID_SUBSTR = 2;
const TIER_NONE = 3; // sentinel: term did not match this node at all

/** The best (lowest) tier a single already-lowercased term achieves against one node's label/id. */
function termTier(labelLower: string, idLower: string, term: string): number {
  if (labelLower.startsWith(term)) return TIER_LABEL_PREFIX;
  if (labelLower.includes(term)) return TIER_LABEL_SUBSTR;
  if (idLower.includes(term)) return TIER_ID_SUBSTR;
  return TIER_NONE;
}

/**
 * Match `nodes` against `query`, best first, capped at `limit`. Case-insensitive; an empty or
 * whitespace-only query yields no results. Multi-word queries are AND: every space-separated term
 * must match the label OR the id, and the node's rank is the BEST single-term tier it achieved.
 * `cluster`-kind nodes (mode-synthetic, not real documents) are excluded; placeholders and files are
 * included (jumping to a placeholder to see what references it is a legitimate drill-down).
 * The default cap is generous — the overlay scrolls a fixed-height window over the results, so the
 * cap bounds memory/sort cost, not what is reachable.
 */
export function matchNodes(nodes: GraphNode[], query: string, limit = 100): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: { node: GraphNode; tier: number }[] = [];
  for (const node of nodes) {
    if (node.kind === 'cluster') continue;
    const labelLower = (node.label ?? node.id).toLowerCase();
    const idLower = node.id.toLowerCase();
    let best = TIER_NONE;
    let matchedAll = true;
    for (const term of terms) {
      const tier = termTier(labelLower, idLower, term);
      if (tier === TIER_NONE) {
        matchedAll = false;
        break;
      }
      if (tier < best) best = tier;
    }
    if (!matchedAll) continue;
    scored.push({ node, tier: best });
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const la = a.node.linkCount ?? 0;
    const lb = b.node.linkCount ?? 0;
    if (la !== lb) return lb - la; // higher link-count first
    const na = (a.node.label ?? a.node.id).toLowerCase();
    const nb = (b.node.label ?? b.node.id).toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0; // label lexicographic tie-break
  });

  return scored.slice(0, limit).map((s) => s.node);
}

/**
 * Scroll-window start for a fixed-height list: keep `selected` visible inside a `visible`-row window
 * over `total` items, moving the previous start (`prevStart`) as little as possible — the window only
 * shifts when the selection walks off an edge (classic follow-selection clamp). Always returns a
 * start within [0, max(0, total - visible)], so a shrunken result set snaps back into range.
 */
export function windowBounds(selected: number, total: number, visible: number, prevStart = 0): number {
  const maxStart = Math.max(0, total - visible);
  let start = Math.min(Math.max(0, prevStart), maxStart);
  if (selected < start) start = selected;
  else if (selected >= start + visible) start = selected - visible + 1;
  return Math.min(Math.max(0, start), maxStart);
}

// ── Row composition ──────────────────────────────────────────────────────────────────────────────
// OpenTUI <text> WRAPS within its box rather than clipping, so any overlay row whose content can
// exceed the inner width must be truncated in the STRING, before render. These composers budget a
// result row / the hint row to EXACTLY `inner` columns, so a slot can never spill onto a second
// physical line (which desyncs rows from results and squashes garbage into neighboring rows).

const HEAD_COLS = 4; // selection prefix (2) + glyph (1) + space (1)
const MIN_LABEL = 20; // the label always shows at least this much before the path column yields
const MAX_PATH = 32; // path column cap (right-aligned, tail-kept)

/** Truncate `s` to `max` columns with a trailing ellipsis (labels — the head is the distinctive part). */
function truncEnd(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Truncate `s` to `max` columns with a LEADING ellipsis, keeping the tail (paths — head-slicing a
 *  path keeps the useless shared prefix and kills the distinctive tail). */
function truncStart(s: string, max: number): string {
  if (max <= 0) return '';
  return s.length <= max ? s : `…${s.slice(-(max - 1))}`;
}

/**
 * Compose one result row for the search overlay as two single-line segments: `head` (selection
 * prefix + glyph + label, padded through the middle gap) and `tail` (the path column, right-aligned,
 * tail-kept). INVARIANT: `head.length + tail.length === inner` exactly — truncate-then-pad, so the
 * row occupies precisely one physical line. The path column is a fixed width (≤ MAX_PATH, ≤ 40% of
 * `inner`) and is DROPPED entirely when it would squeeze the label below MIN_LABEL — a narrow modal
 * shows only labels rather than two useless fragments.
 */
export function composeResultRow(label: string, path: string, glyph: string, selected: boolean, inner: number): { head: string; tail: string } {
  const prefix = selected ? '› ' : '  ';
  let pathCol = Math.min(MAX_PATH, Math.floor(inner * 0.4));
  if (inner - HEAD_COLS - 1 - pathCol < MIN_LABEL) pathCol = 0; // narrow → drop the path column
  const labelBudget = Math.max(0, pathCol > 0 ? inner - HEAD_COLS - 1 - pathCol : inner - HEAD_COLS);
  const labelShown = truncEnd(label, labelBudget);
  const headWidth = Math.max(0, inner - pathCol);
  const head = `${prefix}${glyph} ${labelShown}`.slice(0, headWidth).padEnd(headWidth);
  const tail = pathCol > 0 ? truncStart(path, pathCol).padStart(pathCol) : '';
  return { head, tail };
}

/**
 * Compose the hint row as ONE string of exactly `inner` columns: hint text left, `counter`
 * right-aligned (empty counter → just the hint, padded). Same wrap-proofing as the result rows.
 */
export function composeHintRow(hint: string, counter: string, inner: number): string {
  if (inner <= 0) return '';
  if (!counter) return truncEnd(hint, inner).padEnd(inner);
  const hintBudget = Math.max(0, inner - counter.length - 1);
  const h = truncEnd(hint, hintBudget);
  const pad = Math.max(1, inner - h.length - counter.length);
  return (h + ' '.repeat(pad) + counter).slice(0, inner);
}
