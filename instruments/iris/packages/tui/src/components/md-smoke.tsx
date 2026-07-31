// Render smoke: our MarkdownView over a sample doc covering headings, emphasis, code, links,
// lists, a table, a blockquote, a fenced code block, and an image. Run: bun run src/components/md-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { MarkdownView } from './MarkdownView';

const SAMPLE = `# Heading One

Some **bold** and *italic* and \`inline code\` and a [link](http://example.com).

## A list
- alpha
- beta
  - nested gamma

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |

> a wise quote

\`\`\`
const x = 1;
\`\`\`

![a diagram](diagram.png)
`;

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 72, height: 30 });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <box flexDirection="column" width={72} height={28}>
      <MarkdownView body={SAMPLE} inputActive />
    </box>
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 120));
await renderOnce(); // lays out → the box ref gets a size
await new Promise((r) => setTimeout(r, 60));
await renderOnce(); // re-render with the measured slot count
const frame = captureCharFrame();
console.log(frame);

const checks = {
  heading: /Heading One/.test(frame),
  bold: /bold/.test(frame),
  inlineCode: /inline code/.test(frame),
  link: /link/.test(frame),
  listBullet: /•/.test(frame),
  nested: /nested gamma/.test(frame),
  table: /Name/.test(frame) && /Alice/.test(frame),
  tableBorder: /[─┼│]/.test(frame),
  quote: /quote/.test(frame),
  codeBlock: /const x = 1/.test(frame),
  image: /▣/.test(frame) && /diagram/.test(frame),
};
console.log('\n' + JSON.stringify(checks));
const ok = Object.values(checks).every(Boolean);
console.log('ok:' + ok);
renderer.destroy();
process.exit(ok ? 0 : 1);
