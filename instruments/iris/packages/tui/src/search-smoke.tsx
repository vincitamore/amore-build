// Headless render check for the search overlay chrome + a resize-burst regression guard.
// Run: bun run src/search-smoke.tsx
// NOTE: a true native segfault (the phone-SSH resize crash) cannot be reproduced headlessly —
// the headless renderer doesn't reallocate the native buffer the same way. This guards the
// JS-level path: a burst of resizes through the coalescer + fixed-slot rows must not throw and
// must still render the chrome. The definitive test is the operator resizing on-device.
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from './ThemeProvider';
import { SearchOverlay } from './SearchOverlay';

const { renderer, renderOnce, captureCharFrame, resize } = await createTestRenderer({ width: 90, height: 24 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <box flexGrow={1} />
    <SearchOverlay daemonUrl={null} defaultType="task" onPick={() => {}} onClose={() => {}} />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 150));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);
const chromeOk = /Search/.test(frame) && /index/.test(frame) && /hybrid/.test(frame);

// Simulate a phone-SSH resize BURST: many resize events in a few ms (keyboard slide-in,
// orientation, pane reflow), then a settle. Must not throw; chrome survives.
let resizeOk = true;
try {
  for (const [w, h] of [[60, 18], [100, 30], [50, 14], [120, 40], [70, 20], [90, 24]] as const) {
    resize(w, h);
    await renderOnce();
  }
  await new Promise((r) => setTimeout(r, 200)); // past the 110ms coalescer settle
  await renderOnce();
  resizeOk = /Search/.test(captureCharFrame());
} catch (e) {
  resizeOk = false;
  console.error('resize burst threw:', e);
}

console.log(`\nsearch-chrome:${chromeOk}`);
console.log(`search-resize-burst:${resizeOk}`);
renderer.destroy();
process.exit(chromeOk && resizeOk ? 0 : 1);
