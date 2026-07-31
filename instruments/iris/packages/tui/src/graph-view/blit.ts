import { RGBA } from '@opentui/core';
import { NEUTRAL_CLUSTER, nodeGlyph, type CellGrid, type GraphNode } from '../render/graph';
import { clusterColor, dim, type RGB } from '../render/color';
import type { FamilyStat } from '../render/overlay';
import { hiddenSubKey, ROOT_SUB, subKeyOf } from '../render/subkey';

/** Structural buffer type — only the one method we use, so we don't import OptimizedBuffer. */
export interface DrawBuffer {
  setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes?: number): void;
}

export const GRAPH_BG = RGBA.fromInts(16, 18, 24);
const LEGEND_FG_RGB: RGB = { r: 200, g: 206, b: 214 };
const PARENT_CAP = 14; // at most this many PARENT rows (sub rows expand beneath, uncapped)

// Cache RGBA by packed rgb so we don't allocate one per cell per frame.
const rgbaCache = new Map<number, RGBA>();
function rgba(r: number, g: number, b: number): RGBA {
  const key = (r << 16) | (g << 8) | b;
  let v = rgbaCache.get(key);
  if (!v) {
    v = RGBA.fromInts(r, g, b);
    rgbaCache.set(key, v);
  }
  return v;
}

/** Blit a cell grid into the buffer at (ox, oy), clamped to (w, h) cells. Empty cells are skipped. */
export function blitGrid(
  buffer: DrawBuffer,
  grid: CellGrid | null,
  ox: number,
  oy: number,
  w: number,
  h: number
): void {
  if (!grid) return;
  const rows = Math.min(h, grid.rows);
  const cols = Math.min(w, grid.cols);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cell = grid.cells[cy * grid.cols + cx];
      if (cell) buffer.setCell(ox + cx, oy + cy, cell.char, rgba(cell.fg.r, cell.fg.g, cell.fg.b), GRAPH_BG, cell.attr);
    }
  }
}

// ─── Hierarchical legend model ──────────────────────────────────────────────────────────────────
// Both legends (node-TYPE top-right, edge-FAMILY top-left) are two-level: a parent row per type/family
// and, when expanded, one sub row per subcategory/relation inserted directly beneath it. Draw and
// hit-test share the SAME row geometry (rowPrintWidth / the fixed column layout below), so a click can
// never land on a cell the draw didn't paint. Toggling/expanding is render-time only — none of this
// touches the layout or graphSignature.
export interface LegendEntry {
  glyph: string; // parent: the type/family glyph; sub: its parent's glyph (the sub inherits the color)
  label: string; // parent: the type/family name; sub: the subcategory/relation name
  color: RGB;
  count: number;
  hidden: boolean; // fully toggled off (this type/family/sub) → dim + '○'
  depth: 0 | 1; // 0 parent · 1 sub
  expandable: boolean; // parent has ≥2 subs → a caret is drawn (meaningless for subs)
  expanded: boolean; // parent currently expanded
  partial: boolean; // parent visible but ≥1 of its subs hidden → '◐' in place of the glyph
  parentKey?: string; // sub only: its parent type/family key (so a sub click knows what it drills)
}

/** The "label (count)" text of a row (glyph/caret excluded — those are drawn as their own cells). */
function legendText(e: LegendEntry): string {
  return `${e.label} (${e.count})`;
}

// Fixed column layout, measured from the row's left edge x0 (both legends share it; only x0 differs):
//   parent: [caret]@0 [glyph]@1 ' '@2 [label (count)]@3+       → width = 3 + text
//   sub:    ' '@0 ' '@1 [mark]@2 ' '@3 [label (count)]@4+      → width = 4 + text (one deeper indent)
// The caret ZONE (expand click) is the two leftmost cells of a parent row (caret cell + one slack).
function rowPrintWidth(e: LegendEntry): number {
  return legendText(e).length + (e.depth === 0 ? 3 : 4);
}

/** Width in cells the legend block occupies: the widest visible row + a one-cell right margin. */
export function legendWidth(entries: LegendEntry[]): number {
  return entries.reduce((m, e) => Math.max(m, rowPrintWidth(e)), 0) + 1;
}

/** Left column the (right-aligned) type legend starts at, given the canvas width. */
export function legendX0(entries: LegendEntry[], cols: number): number {
  return Math.max(0, cols - legendWidth(entries));
}

/** Width in cells the (left-aligned) family legend occupies — same row geometry as the type legend. */
export function familyLegendWidth(entries: LegendEntry[]): number {
  return legendWidth(entries);
}

/** Draw one legend row at left edge x0, row y. Parent and sub share the column layout above so the
 *  hit-test (which reads the same geometry) always agrees with what was painted. */
function drawRow(buffer: DrawBuffer, e: LegendEntry, x0: number, y: number, cols: number): void {
  const gc = e.hidden ? dim(e.color, 0.6) : e.color;
  const tc = e.hidden ? dim(LEGEND_FG_RGB, 0.55) : LEGEND_FG_RGB;
  const put = (x: number, ch: string, c: RGB) => {
    if (x >= 0 && x < cols) buffer.setCell(x, y, ch, rgba(c.r, c.g, c.b), GRAPH_BG);
  };
  const text = ` ${legendText(e)}`;
  if (e.depth === 0) {
    const caret = e.expandable ? (e.expanded ? '▾' : '▸') : ' ';
    const mark = e.hidden ? '○' : e.partial ? '◐' : e.glyph; // '◐' = some subs hidden (partial)
    put(x0, caret, tc);
    put(x0 + 1, mark, gc);
    for (let j = 0; j < text.length; j++) put(x0 + 2 + j, text[j], tc);
  } else {
    const mark = e.hidden ? '○' : e.glyph;
    put(x0 + 2, mark, gc); // two-cell indent, then the sub mark under the parent glyph column + 1
    for (let j = 0; j < text.length; j++) put(x0 + 3 + j, text[j], tc);
  }
}

/**
 * Draw the interactive node-type legend in the top-right corner, offset by oy rows. Parent rows are
 * `<caret><glyph> label (count)` in the type's color; expanded parents show their subcategory rows
 * indented beneath. A toggled-off row is dimmed with '○'; a partially-hidden parent shows '◐'.
 * Geometry matches `legendX0` + `legendHitAt` so the view can hit-test clicks exactly.
 */
export function drawLegend(buffer: DrawBuffer, entries: LegendEntry[], cols: number, rows: number, oy = 0): void {
  const x0 = legendX0(entries, cols);
  for (let i = 0; i < entries.length && i < rows; i++) drawRow(buffer, entries[i], x0, oy + i, cols);
}

/**
 * Draw the typed-edge FAMILY legend in the top-LEFT corner (mirror of the top-right type legend so the
 * two don't collide), offset by oy rows. Same two-level rows: a family parent, and when expanded its
 * individual relations beneath. Left-aligned at column 0, so the view hit-tests via `legendHitAt`.
 */
export function drawFamilyLegend(buffer: DrawBuffer, entries: LegendEntry[], cols: number, rows: number, oy = 0): void {
  for (let i = 0; i < entries.length && i < rows; i++) drawRow(buffer, entries[i], 0, oy + i, cols);
}

// ─── Hit-test (shares the row geometry above) ─────────────────────────────────────────────────────
/** A legend click resolves to exactly one of: expand/collapse a parent, toggle a whole parent's
 *  visibility, or toggle a single sub. Discriminated so the view dispatches without re-deriving zones. */
export type LegendHit =
  | { kind: 'expand'; key: string } // parent caret zone → expand/collapse
  | { kind: 'toggle-parent'; key: string } // parent row body → toggle the type/family
  | { kind: 'toggle-sub'; parent: string; sub: string }; // sub row → toggle that sub/relation

/**
 * Map a screen cell to a legend action, or null. `side` selects the block geometry: 'right' →
 * right-aligned at `cols - width` (the type legend); 'left' → column 0 (the family legend). The row
 * clamp (`row >= rows`) mirrors the draw loop exactly, so a click can never resolve to an undrawn row
 * even when expanded subs push later parents off the bottom.
 */
export function legendHitAt(
  entries: LegendEntry[],
  cols: number,
  rows: number,
  oy: number,
  ex: number,
  ey: number,
  side: 'left' | 'right'
): LegendHit | null {
  const row = ey - oy;
  if (row < 0 || row >= entries.length || row >= rows) return null;
  const x0 = side === 'right' ? legendX0(entries, cols) : 0;
  const right = side === 'right' ? cols : familyLegendWidth(entries);
  if (ex < x0 || ex >= right) return null;
  const e = entries[row];
  if (e.depth === 1) return { kind: 'toggle-sub', parent: e.parentKey ?? '', sub: e.label };
  // Parent: the two leftmost cells (caret + one slack) expand/collapse when there are subs to show;
  // everything else on the row toggles the whole type/family.
  if (e.expandable && ex <= x0 + 1) return { kind: 'expand', key: e.label };
  return { kind: 'toggle-parent', key: e.label };
}

// ─── Pure legend builders (tested in blit.test.ts; the view just feeds its render inputs) ─────────
/**
 * Build the hierarchical node-TYPE legend rows. Parents sort by count desc, capped at PARENT_CAP;
 * expanded parents insert their subcategory rows (count desc) directly beneath, NOT counted against
 * the cap. A type is expandable only with ≥2 distinct subs; a type whose nodes are ALL at the root
 * (no real sub-folder) is flat and drops its '(root)' bucket entirely. Sub color = the parent's
 * resolved cluster color (never a parallel palette), the same channel the nodes are painted from.
 */
export function buildTypeLegendRows(
  nodes: GraphNode[],
  clusterById: Map<string, number>,
  neutralCluster: number,
  hiddenTypes: Set<string>,
  hiddenSubs: Set<string>,
  expandedTypes: Set<string>
): LegendEntry[] {
  const counts = new Map<string, number>();
  const repCluster = new Map<string, number>(); // type → a representative node's world cluster
  const subCounts = new Map<string, Map<string, number>>(); // type → sub → count
  for (const nd of nodes) {
    const ty = nd.type ?? 'other';
    counts.set(ty, (counts.get(ty) ?? 0) + 1);
    if (!repCluster.has(ty)) {
      const c = clusterById.get(nd.id);
      if (c !== undefined) repCluster.set(ty, c);
    }
    const sub = subKeyOf(nd);
    if (sub !== null) {
      let m = subCounts.get(ty);
      if (!m) subCounts.set(ty, (m = new Map()));
      m.set(sub, (m.get(sub) ?? 0) + 1);
    }
  }
  const colorFor = (ty: string): RGB => {
    const c = repCluster.get(ty);
    return c === undefined ? clusterColor(0) : c === neutralCluster ? NEUTRAL_CLUSTER : clusterColor(c);
  };
  // The expandable sub-list for a type: drop a '(root)'-only type (flat), keep '(root)' alongside real
  // folders when both exist, sort count desc (name tiebreak for determinism).
  const subsFor = (ty: string): [string, number][] => {
    const m = subCounts.get(ty);
    if (!m) return [];
    if (![...m.keys()].some((s) => s !== ROOT_SUB)) return []; // every node at the root → flat
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const rows: LegendEntry[] = [];
  const parents = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, PARENT_CAP);
  for (const [ty, count] of parents) {
    const color = colorFor(ty);
    const subs = subsFor(ty);
    const expandable = subs.length >= 2;
    const parentHidden = hiddenTypes.has(ty);
    const someSubHidden = subs.some(([s]) => hiddenSubs.has(hiddenSubKey(ty, s)));
    const expanded = expandable && expandedTypes.has(ty);
    rows.push({
      glyph: nodeGlyph(ty),
      label: ty,
      color,
      count,
      hidden: parentHidden,
      depth: 0,
      expandable,
      expanded,
      partial: !parentHidden && expandable && someSubHidden,
    });
    if (expanded) {
      for (const [sub, subCount] of subs) {
        rows.push({
          glyph: nodeGlyph(ty),
          label: sub,
          color,
          count: subCount,
          hidden: parentHidden || hiddenSubs.has(hiddenSubKey(ty, sub)),
          depth: 1,
          expandable: false,
          expanded: false,
          partial: false,
          parentKey: ty,
        });
      }
    }
  }
  return rows;
}

/**
 * Build the hierarchical edge-FAMILY legend rows from the render's own per-family stats (so swatch and
 * edge can't drift). A family is expandable with ≥2 relations present in the data; an expanded family
 * inserts its relation rows (already count-desc from computeOverlay) beneath. Sub color = the family's
 * swatch color. Partial = family visible but ≥1 of its relations hidden.
 */
export function buildFamilyLegendRows(families: FamilyStat[], expandedFamilies: Set<string>): LegendEntry[] {
  const rows: LegendEntry[] = [];
  for (const f of families) {
    const rels = f.relations ?? [];
    const expandable = rels.length >= 2;
    const someRelHidden = rels.some((r) => r.hidden);
    const expanded = expandable && expandedFamilies.has(f.family);
    rows.push({
      glyph: '━',
      label: f.family,
      color: f.color,
      count: f.count,
      hidden: f.hidden,
      depth: 0,
      expandable,
      expanded,
      partial: !f.hidden && expandable && someRelHidden,
    });
    if (expanded) {
      for (const r of rels) {
        rows.push({
          glyph: '━',
          label: r.relation,
          color: f.color,
          count: r.count,
          hidden: f.hidden || r.hidden,
          depth: 1,
          expandable: false,
          expanded: false,
          partial: false,
          parentKey: f.family,
        });
      }
    }
  }
  return rows;
}
