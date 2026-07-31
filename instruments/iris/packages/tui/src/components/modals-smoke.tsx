// Headless render check for the modals. Run: MODAL=resolve bun run src/components/modals-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { ConfirmModal, PickModal, ResolveModal } from './Modal';

const which = process.env.MODAL ?? 'resolve';
const node =
  which === 'pick' ? (
    <PickModal
      title="Triage to"
      options={[
        { label: 'Ideas', value: 'ideas' },
        { label: 'Decisions', value: 'decisions' },
      ]}
      onPick={() => {}}
      onCancel={() => {}}
    />
  ) : which === 'confirm' ? (
    <ConfirmModal message="Delete this?" onConfirm={() => {}} onCancel={() => {}} />
  ) : (
    <ResolveModal onConfirm={() => {}} onCancel={() => {}} />
  );

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 64, height: 16 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <box flexGrow={1} />
    {node}
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 150));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);
const ok = /[╭╮╰╯]/.test(frame);
console.log(`\nmodal:${which}  renders:${ok}`);
renderer.destroy();
process.exit(ok ? 0 : 1);
