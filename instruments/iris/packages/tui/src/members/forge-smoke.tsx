// Headless integration smoke: ForgeMember over the REAL org forge tree (regula listForge →
// buildForgeData → flattenForge → fixed-slot render). Run: bun run src/members/forge-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { ForgeMember } from './ForgeMember';

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 120, height: 34 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <ForgeMember inputActive daemonUrl={null} />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 500)); // listForge reads ~400 files
await renderOnce();
const frame = captureCharFrame();
console.log(frame);
const tabs = ['Pipelines', 'Dreams', 'Recipes', 'Proposals'].every((s) => frame.includes(s));
const hasPanel = /Forge · Pipelines/.test(frame);
const hasRows = /[▸▾]/.test(frame); // at least one collapsible pipeline/group row
console.log(`\ntabs:${tabs} panel:${hasPanel} rows:${hasRows}`);
renderer.destroy();
process.exit(tabs && hasPanel && hasRows ? 0 : 1);
