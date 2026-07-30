// Headless width smoke for the search-to-focus overlay: mount <NodeSearchModal> under the test
// renderer at several terminal widths, TYPE a query through the mock keyboard (the real input →
// onInput → matcher path), and assert the row/hint structure of the char frame. Guards the
// one-physical-line-per-slot invariant: overlong labels/paths must truncate in the string, never
// wrap — a wrapped row steals a slot (glyph-row count drops) and squashes fragments into the hint.
// Run: bun run src/graph-view/search-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { NodeSearchModal } from './NodeSearchModal';
import { ThemeProvider } from '../ThemeProvider';
import type { GraphNode } from '../render/graph';

// 30 task nodes with deliberately overlong labels + paths (both overflow every width tested).
const nodes: GraphNode[] = Array.from({ length: 30 }, (_, i) => ({
  id: `tasks/completed/vitrum-search-overlay-window-improvement-round-${i}.md`,
  label: `Vitrum search overlay improvement ${i}: confirm path and knowledge substrate alignment`,
  type: 'task',
  kind: 'doc',
  linkCount: i,
}));

// width → whether the path column should render (drops below ~60 inner; at 44 cols the modal is 40
// wide → inner 36 → dropped).
const CASES: { cols: number; pathShown: boolean }[] = [
  { cols: 100, pathShown: true },
  { cols: 70, pathShown: true },
  { cols: 44, pathShown: false },
];

let failures = 0;
for (const { cols, pathShown } of CASES) {
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({ width: cols, height: 24 });
  const root = createRoot(renderer);
  root.render(
    <ThemeProvider initial="horizon">
      <NodeSearchModal active nodes={nodes} onPick={() => {}} onClose={() => {}} />
    </ThemeProvider>
  );
  await new Promise((r) => setTimeout(r, 150));
  await renderOnce();
  await mockInput.typeText('vitrum');
  await new Promise((r) => setTimeout(r, 150));
  await renderOnce();
  const frame = captureCharFrame();
  const lines = frame.split('\n');

  // One glyph per result row → exactly 12 slots visible; a wrapped row would displace a slot.
  const glyphRows = lines.filter((l) => l.includes('◆'));
  // Exactly one selection marker line (the selected row intact on one physical line, label leading).
  const selRows = lines.filter((l) => l.includes('›'));
  // (label START must lead the row — truncation may cut mid-word at narrow widths)
  const selShowsLabel = selRows.length === 1 && /› ◆ Vitrum search overlay/.test(selRows[0]);
  // Hint line intact — wrap squashes fragments into it (the garbled-hint defect).
  const hintClean = lines.some((l) => /↑↓ move · ⏎ focus · esc close/.test(l));
  // Overflow counter present (30 results > 12 slots must never truncate silently).
  const counter = lines.some((l) => /1\/30/.test(l));
  // Path column: tail-kept (…ends with the filename) when shown; absent entirely when dropped.
  const pathRows = lines.filter((l) => /…[\w-]*round-\d+\.md/.test(l));
  const pathOk = pathShown ? pathRows.length === glyphRows.length : pathRows.length === 0;

  const ok = glyphRows.length === 12 && selShowsLabel && hintClean && counter && pathOk;
  console.log(
    `${cols} cols → glyph-rows:${glyphRows.length}/12 sel-label:${selShowsLabel} hint:${hintClean} counter:${counter} path(${pathShown ? 'shown' : 'dropped'}):${pathOk} ${ok ? 'OK' : 'FAIL'}`
  );
  if (!ok) {
    failures++;
    console.log(frame);
  }
  renderer.destroy();
}
process.exit(failures ? 1 : 0);
