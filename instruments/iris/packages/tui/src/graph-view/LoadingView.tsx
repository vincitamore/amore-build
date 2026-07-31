import { useEffect, useState } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import { RGBA } from '@opentui/core';
import type { DrawBuffer } from './blit';

const BG = RGBA.fromInts(16, 18, 24);
const TEXT = RGBA.fromInts(150, 205, 245);
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const NODE_GLYPHS = ['◆', '●', '◧', '⬡', '◔'];

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
const glow = (t: number): RGBA => RGBA.fromInts(lerp(48, 120, t), lerp(54, 200, t), lerp(66, 255, t));
const wrapPi = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

/**
 * Animated loading skeleton: a faint ring of placeholder graph-nodes with a glow rotating
 * around it, plus a centered spinner + label. OpenTUI renders on-demand (on state change),
 * NOT every frame — so the animation is driven by a React tick (setInterval), which forces
 * the re-renders that fire `renderAfter`. `e` is animation time derived from the tick.
 */
export function LoadingView({ label = 'Loading knowledge graph' }: { label?: string }) {
  const dims = useTerminalDimensions();
  const W = Math.max(1, dims.width);
  const H = Math.max(1, dims.height);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 60);
    return () => clearInterval(id);
  }, []);
  const e = tick * 0.06; // ~seconds of animation time

  const draw = (buffer: DrawBuffer) => {
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.max(6, Math.min(W / 2 - 4, (H / 2 - 4) * 2)); // radius in cell-x units
    const phase = e * 1.8;
    const N = 14;

    // a faint skeletal ring of placeholder nodes, with the glow rotating around it
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * R);
      const y = Math.round(cy + Math.sin(a) * (R * 0.45)); // *0.45 for ~2:1 cell aspect
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const t = Math.max(0, 1 - Math.abs(wrapPi(a - phase)) / 0.9);
      buffer.setCell(x, y, t > 0.25 ? NODE_GLYPHS[i % NODE_GLYPHS.length] : '·', glow(t), BG);
    }

    // centered spinner + label
    const text = `${SPINNER[Math.floor(e / 0.09) % SPINNER.length]} ${label}${'.'.repeat(Math.floor(e * 2) % 4)}`;
    const tx = Math.max(0, Math.floor(cx - text.length / 2));
    const ty = Math.floor(cy);
    for (let i = 0; i < text.length; i++) {
      const x = tx + i;
      if (x >= 0 && x < W) buffer.setCell(x, ty, text[i], TEXT, BG);
    }
  };

  return <box width={dims.width} height={dims.height} backgroundColor={BG} renderAfter={draw} />;
}
