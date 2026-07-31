// Headless smoke for the keep-mounted member switching. Members stay mounted and toggle `visible`
// (yoga display:none) instead of unmounting — this guards that switching still shows the right
// member and that a re-visit works from the mounted instance. Run: bun run src/shell/shell-smoke.tsx
// NOTE: the native teardown segfault this refactor fixes cannot be reproduced headlessly; the
// definitive test is the operator switching screens on-device. This asserts the JS/render path.
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { Shell } from './Shell';

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 120, height: 36 });
const keys = createMockKeys(renderer);
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <Shell />
  </ThemeProvider>,
);

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
await settle(700);
await renderOnce();
const dash = captureCharFrame();

keys.typeText('7'); // → Forge
await settle(450);
await renderOnce();
const forge = captureCharFrame();

keys.typeText('1'); // → Dashboard (Forge stays mounted, hidden)
await settle(350);
await renderOnce();
const dash2 = captureCharFrame();

keys.typeText('7'); // → Forge again, from the mounted instance (no remount)
await settle(350);
await renderOnce();
const forge2 = captureCharFrame();

renderer.destroy();

const okDash = /Attention|active tasks|open inbox/.test(dash);
const okForge = /Pipelines|Dreams|Recipes|Proposals/.test(forge);
const okBack = /Attention|active tasks|open inbox/.test(dash2);
const okForge2 = /Pipelines|Dreams|Recipes|Proposals/.test(forge2);
console.log(`dash:${okDash}  forge:${okForge}  backToDash:${okBack}  forgeAgain:${okForge2}`);
process.exit(okDash && okForge && okBack && okForge2 ? 0 : 1);
