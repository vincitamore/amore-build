// Viewport: maps world-space layout coordinates → screen sub-pixels, with pan + zoom.
// Layout runs once (expensive force sim → world coords); the viewport is a cheap transform
// re-applied every frame, so pan/zoom never re-runs the simulation.

export interface WorldPoint {
  x: number;
  y: number;
}

export interface Viewport {
  /** World-space point shown at screen center. */
  cx: number;
  cy: number;
  /** Sub-pixels per world unit (zoom). */
  scale: number;
}

/** A viewport that fits all points into width×height sub-pixels with padding. */
export function fitViewport(points: WorldPoint[], width: number, height: number, padding = 4): Viewport {
  if (points.length === 0) return { cx: 0, cy: 0, scale: 1 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale };
}

export function worldToScreen(p: WorldPoint, vp: Viewport, width: number, height: number): WorldPoint {
  return {
    x: width / 2 + (p.x - vp.cx) * vp.scale,
    y: height / 2 + (p.y - vp.cy) * vp.scale,
  };
}

export function screenToWorld(p: WorldPoint, vp: Viewport, width: number, height: number): WorldPoint {
  return {
    x: vp.cx + (p.x - width / 2) / vp.scale,
    y: vp.cy + (p.y - height / 2) / vp.scale,
  };
}

/** Pan by whole terminal cells (a cell is 2 sub-pixels wide × 4 tall). */
export function panViewport(vp: Viewport, dCols: number, dRows: number): Viewport {
  return {
    ...vp,
    cx: vp.cx + (dCols * 2) / vp.scale,
    cy: vp.cy + (dRows * 4) / vp.scale,
  };
}

export function zoomViewport(vp: Viewport, factor: number): Viewport {
  return { ...vp, scale: Math.max(1e-4, vp.scale * factor) };
}

/**
 * Zoom by `factor` while keeping the screen point (sx, sy) anchored over the same world
 * point — i.e. scroll-to-zoom-at-cursor. Solves for the new center so worldToScreen of the
 * point under the cursor is unchanged after the scale change.
 */
export function zoomViewportAt(
  vp: Viewport,
  factor: number,
  sx: number,
  sy: number,
  width: number,
  height: number
): Viewport {
  const world = screenToWorld({ x: sx, y: sy }, vp, width, height);
  const scale = Math.max(1e-4, vp.scale * factor);
  return anchorViewport(world, scale, sx, sy, width, height);
}

/** Place `anchorWorld` under screen point (sx, sy) at a fixed scale — the grab-drag transform. */
export function anchorViewport(
  anchorWorld: WorldPoint,
  scale: number,
  sx: number,
  sy: number,
  width: number,
  height: number
): Viewport {
  return {
    scale,
    cx: anchorWorld.x - (sx - width / 2) / scale,
    cy: anchorWorld.y - (sy - height / 2) / scale,
  };
}
