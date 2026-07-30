// Headless smoke for the loading skeleton — verifies it ANIMATES (two frames differ).
// Run: bun run src/graph-view/loading-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { LoadingView } from './LoadingView';

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24 });
createRoot(renderer).render(<LoadingView label="Loading knowledge graph" />);

const settle = async (ms: number) => {
  await new Promise((r) => setTimeout(r, ms));
  await renderOnce();
};

await settle(120);
const f1 = captureCharFrame();
await settle(320); // several animation ticks later
const f2 = captureCharFrame();
console.log(f2);

const animated = f1 !== f2; // the frame must change over time
const hasSpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(f2);
const hasLabel = /Loading/.test(f2);
console.log(`\nanimated:${animated}  spinner:${hasSpinner}  label:${hasLabel}`);

renderer.destroy();
process.exit(animated && hasSpinner && hasLabel ? 0 : 1);
