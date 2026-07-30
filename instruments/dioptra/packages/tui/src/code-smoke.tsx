// Verify added grammars load + queries are valid. Run: DOC=path/to/file.rs bun run src/code-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from './ThemeProvider';
import { DocView } from './components/DocView';
import { registerCodeGrammars } from './code-grammars';

registerCodeGrammars();
const path = process.env.DOC ?? '';
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 92, height: 20 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <DocView path={path} />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 700)); // give the tree-sitter worker time to highlight
await renderOnce();
console.log(captureCharFrame().split('\n').slice(0, 14).join('\n'));
renderer.destroy();
process.exit(0);
