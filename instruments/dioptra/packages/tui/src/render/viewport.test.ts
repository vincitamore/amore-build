import { test, expect } from 'bun:test';
import {
  fitViewport,
  worldToScreen,
  screenToWorld,
  panViewport,
  zoomViewport,
  zoomViewportAt,
  anchorViewport,
} from './viewport';

test('fitViewport centers and scales to fit', () => {
  const vp = fitViewport(
    [
      { x: -10, y: -10 },
      { x: 10, y: 10 },
    ],
    100,
    100,
    0
  );
  expect(vp.cx).toBe(0);
  expect(vp.cy).toBe(0);
  expect(vp.scale).toBe(5); // span 20 → 100/20
});

test('worldToScreen maps the viewport center to screen center', () => {
  const vp = { cx: 0, cy: 0, scale: 2 };
  expect(worldToScreen({ x: 0, y: 0 }, vp, 100, 80)).toEqual({ x: 50, y: 40 });
  expect(worldToScreen({ x: 10, y: 0 }, vp, 100, 80)).toEqual({ x: 70, y: 40 });
});

test('screenToWorld inverts worldToScreen', () => {
  const vp = { cx: 3, cy: -2, scale: 1.5 };
  const s = worldToScreen({ x: 7, y: 11 }, vp, 120, 60);
  const back = screenToWorld(s, vp, 120, 60);
  expect(back.x).toBeCloseTo(7);
  expect(back.y).toBeCloseTo(11);
});

test('zoom scales; pan shifts center by cells', () => {
  const vp = { cx: 0, cy: 0, scale: 2 };
  expect(zoomViewport(vp, 2).scale).toBe(4);
  expect(panViewport(vp, 5, 0).cx).toBe(5); // 5 cells × 2 subpx / scale 2 = 5 world
  expect(panViewport(vp, 0, 4).cy).toBe(8); // 4 cells × 4 subpx / scale 2 = 8 world
});

test('zoomViewportAt keeps the cursor point anchored while scaling', () => {
  const vp = { cx: 0, cy: 0, scale: 2 };
  const W = 100;
  const H = 80;
  const sx = 70;
  const sy = 40;
  const worldUnderCursor = screenToWorld({ x: sx, y: sy }, vp, W, H);
  const zoomed = zoomViewportAt(vp, 2, sx, sy, W, H);
  expect(zoomed.scale).toBe(4);
  const after = worldToScreen(worldUnderCursor, zoomed, W, H);
  expect(after.x).toBeCloseTo(sx);
  expect(after.y).toBeCloseTo(sy);
});

test('anchorViewport pins a world point under a screen point (grab-drag)', () => {
  const world = { x: 13, y: -7 };
  const vp = anchorViewport(world, 2, 70, 40, 100, 80);
  expect(vp.scale).toBe(2);
  const back = worldToScreen(world, vp, 100, 80);
  expect(back.x).toBeCloseTo(70);
  expect(back.y).toBeCloseTo(40);
});

test('fitViewport handles empty + single point', () => {
  expect(fitViewport([], 50, 50)).toEqual({ cx: 0, cy: 0, scale: 1 });
  const one = fitViewport([{ x: 5, y: 5 }], 50, 50);
  expect(one.cx).toBe(5);
  expect(one.cy).toBe(5);
});
