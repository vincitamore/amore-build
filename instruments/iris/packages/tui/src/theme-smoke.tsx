// Headless smoke for the theme picker overlay + palette resolution.
// Run: bun run src/theme-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from './ThemeProvider';
import { ThemePicker } from './ThemePicker';
import { THEME_ORDER, toPalette } from './theme';

// Every theme resolves to 13 RGBA slots without throwing.
let resolved = 0;
for (const name of THEME_ORDER) {
  const p = toPalette(name);
  if (p.background && p.primary && p.foreground) resolved += 1;
}

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 60, height: 24 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <box flexGrow={1} />
    <ThemePicker onClose={() => {}} />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 150));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);

const hasTitle = /Theme/.test(frame);
const hasHorizon = /Horizon/.test(frame);
const hasGruvbox = /Gruvbox/.test(frame);
const hasSwatch = /█/.test(frame);
const allResolved = resolved === THEME_ORDER.length;
console.log(`\nthemes-resolved:${resolved}/${THEME_ORDER.length}  picker-title:${hasTitle}  rows:${hasHorizon && hasGruvbox}  swatches:${hasSwatch}`);

renderer.destroy();
process.exit(hasTitle && hasHorizon && hasGruvbox && hasSwatch && allResolved ? 0 : 1);
