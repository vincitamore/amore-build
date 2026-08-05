// Headless integration smoke: LucernaMember with daemonUrl=null (not-installed /
// daemon-down path). Run: bun run src/members/lucerna-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { LucernaMember } from './LucernaMember';

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <LucernaMember inputActive daemonUrl={null} />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 200));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);
const hasTitle = /Lucerna/.test(frame);
const hasDaemonDown = /daemon is down|proxy is unreachable/i.test(frame);
console.log(`\ntitle:${hasTitle} daemonDown:${hasDaemonDown}`);
renderer.destroy();
process.exit(hasTitle && hasDaemonDown ? 0 : 1);
