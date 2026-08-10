// Headless smoke for the keep-mounted member switching. Members stay mounted and toggle `visible`
// (yoga display:none) instead of unmounting — this guards that switching still shows the right
// member and that a re-visit works from the mounted instance.
//
// Run (org root required — Dashboard resolveOrgRoot):
//   $env:IRIS_ORG_ROOT = "C:\Users\AlexMoyer\Documents\amore"   # or any org root / org cwd
//   bun run src/shell/shell-smoke.tsx
//
// Sessions hop is fixture-free: with no SPECULUM_BIN / no binary on PATH the status strip shows
// the honest not-installed recipe; we assert Sessions chrome (title / stage chips / strip).
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

// S → Sessions (letter key; no digit). Assert member chrome, then hop back with 1 → Dashboard.
keys.typeText('s');
await settle(700);
await renderOnce();
const sessions = captureCharFrame();

keys.typeText('1');
await settle(350);
await renderOnce();
const dash3 = captureCharFrame();

renderer.destroy();

const okDash = /Attention|active tasks|open inbox/.test(dash);
const okForge = /Pipelines|Dreams|Recipes|Proposals/.test(forge);
const okBack = /Attention|active tasks|open inbox/.test(dash2);
const okForge2 = /Pipelines|Dreams|Recipes|Proposals/.test(forge2);
// Sessions: Panel title + Probes/Usage chips, and/or the honest not-installed strip.
const okSessions =
  /Sessions/.test(sessions) &&
  (/Probes|Usage/.test(sessions) || /not installed|speculum|amore init/i.test(sessions));
const okDash3 = /Attention|active tasks|open inbox/.test(dash3);
console.log(
  `dash:${okDash}  forge:${okForge}  backToDash:${okBack}  forgeAgain:${okForge2}  sessions:${okSessions}  dashFromS:${okDash3}`,
);
if (!okSessions) {
  console.error('--- sessions frame ---\n' + sessions);
}
process.exit(okDash && okForge && okBack && okForge2 && okSessions && okDash3 ? 0 : 1);
