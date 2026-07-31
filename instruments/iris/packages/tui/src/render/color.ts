export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** HSL (h in degrees, s/l in [0,1]) → RGB [0,255]. */
export function hsl(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** A distinct hue per cluster index — golden-angle stepping spreads well at any count. */
export function clusterColor(index: number): RGB {
  return hsl((index * 137.508) % 360, 0.62, 0.62);
}

/** The dim slate the edge web is drawn in, so colored nodes pop out of it. */
export const EDGE_DIM: RGB = { r: 74, g: 82, b: 96 };

/** A dimmer slate for the wiki edge web when the typed-edge overlay is on — the wiki web recedes so
 *  the colored typed edges read on top (still visible as context, not gone). */
export const EDGE_OVERLAY_DIM: RGB = { r: 50, g: 56, b: 66 };

/** Lerp a color toward a dark gray (t=1 → fully dimmed). For de-emphasizing off-focus nodes. */
export function dim(c: RGB, t: number): RGB {
  const base = 46;
  const f = (v: number) => Math.round(v + (base - v) * t);
  return { r: f(c.r), g: f(c.g), b: f(c.b) };
}

/** Lerp a color toward white (t=1 → white). For lifting attention-worthy nodes above the field. */
export function lighten(c: RGB, t: number): RGB {
  const f = (v: number) => Math.round(v + (255 - v) * t);
  return { r: f(c.r), g: f(c.g), b: f(c.b) };
}

/**
 * Modulate a node's cluster color by its attention tier, keeping hue as the cluster channel and
 * lightness as the attention channel. Tier 1 is identity, so a node with no status signal keeps
 * its exact cluster hue; dormant work sinks toward the slate ground, hot work is lifted brighter
 * (still hued — distinct from the near-white selected marker).
 */
export function attentionShade(c: RGB, tier: number): RGB {
  if (tier <= 0) return dim(c, 0.5); // dormant → halfway to the edge slate
  if (tier === 1) return c; // neutral → unchanged
  if (tier === 2) return lighten(c, 0.14); // active → gently lifted
  return lighten(c, 0.3); // hot → clearly brighter
}

/** The selected node — bright near-white. */
export const HIGHLIGHT: RGB = { r: 240, g: 244, b: 250 };
/** Edges incident to the selected node — warm amber, pops over the dim web. */
export const HOT_EDGE: RGB = { r: 236, g: 198, b: 120 };
/** Non-incident edges when a node is focused — barely visible. */
export const EDGE_FAINT: RGB = { r: 40, g: 44, b: 52 };
