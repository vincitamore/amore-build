// Headless smoke for the list members. Run: MEMBER=Tasks bun run src/members/list-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { TasksMember } from './TasksMember';
import { InboxMember } from './InboxMember';
import { RemindersMember } from './RemindersMember';
import { KnowledgeMember } from './KnowledgeMember';
import { FilesMember } from './FilesMember';

const which = process.env.MEMBER ?? 'Tasks';
const M =
  which === 'Inbox'
    ? InboxMember
    : which === 'Reminders'
      ? RemindersMember
      : which === 'Knowledge'
        ? KnowledgeMember
        : which === 'Files'
          ? FilesMember
          : TasksMember;

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 90, height: 26 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <M inputActive />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 450)); // regula reads the real tree
await renderOnce();
const frame = captureCharFrame();
console.log(frame);

const hasTitle = new RegExp(which).test(frame);
const hasBorders = /[┌┐└┘─│]/.test(frame);
const hasCursor = /›/.test(frame);
console.log(`\n${which}  title:${hasTitle}  borders:${hasBorders}  cursor:${hasCursor}`);

renderer.destroy();
process.exit(hasTitle && hasBorders ? 0 : 1);
