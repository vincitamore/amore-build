// Headless integration smoke: RemindersMember over the REAL org reminders/ tree (regula
// listReminders → grouped-by-status render with live countdowns). Run: bun run src/members/reminders-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { RemindersMember } from './RemindersMember';

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <RemindersMember inputActive daemonUrl={null} />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 300));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);
const hasPanel = /Reminders/.test(frame);
const hasGroups = /(PENDING|SNOOZED|ONGOING|COMPLETED|DISMISSED)/.test(frame);
const hasActions = /complete|new reminder/.test(frame);
console.log(`\npanel:${hasPanel} groups:${hasGroups} actions:${hasActions}`);
renderer.destroy();
process.exit(hasPanel && hasGroups && hasActions ? 0 : 1);
