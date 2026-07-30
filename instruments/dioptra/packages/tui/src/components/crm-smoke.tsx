// Interactive smoke: CreateReminderModal — type a title, arrow down into "custom date/time…",
// type an exact instant, submit, and assert onConfirm receives the parsed remind-at.
// Run: bun run src/components/crm-smoke.tsx
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { CreateReminderModal } from './CreateReminderModal';

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 26 });
const keys = createMockKeys(renderer);

let got: { title: string; remindAt: string } | null = null;
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <CreateReminderModal onConfirm={(title, remindAt) => (got = { title, remindAt })} onCancel={() => {}} />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 120));
await renderOnce();

// Title input is focused on open.
await keys.typeText('Dentist appointment');
// Move from "tomorrow 9am" (idx 3) down to "custom date/time…" (idx 6 = WHEN_PRESETS.length).
await keys.pressKeys(['ARROW_DOWN', 'ARROW_DOWN', 'ARROW_DOWN']);
await new Promise((r) => setTimeout(r, 60));
await renderOnce();
const frame = captureCharFrame();
const customShown = /custom date\/time/.test(frame) && /YYYY-MM-DD/.test(frame);

// Custom field is now focused → type an exact instant, then submit.
await keys.typeText('2026-07-15 14:30');
await keys.pressKeys(['RETURN']);
await new Promise((r) => setTimeout(r, 60));

console.log(frame);
const g = got as { title: string; remindAt: string } | null;
const ok = customShown && !!g && g.title === 'Dentist appointment' && g.remindAt === '2026-07-15T14:30';
console.log(`\ncustomShown:${customShown} confirmed:${JSON.stringify(g)} ok:${ok}`);
renderer.destroy();
process.exit(ok ? 0 : 1);
