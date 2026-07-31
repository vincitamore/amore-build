// Headless smoke for DocView. Run: DOC=tasks/foo.md bun run src/components/docview-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { DocView } from './DocView';

const path = process.env.DOC ?? 'tasks/vitrum-cli-tui-reskin.md';
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 84, height: 26 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <DocView path={path} />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 350));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);

const hasBorder = /[┌┐└┘]/.test(frame);
const hasBody = frame.replace(/[─│┌┐└┘ ]/g, '').length > 40; // some real content rendered
console.log(`\nborder:${hasBorder}  body:${hasBody}`);
renderer.destroy();
process.exit(hasBorder && hasBody ? 0 : 1);
