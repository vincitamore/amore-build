// Headless mount smoke: render <GraphView> under a test renderer (no TTY), capture the
// char frame, and assert the graph + status line drew. Run: bun run src/graph-view/smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { GraphView } from './GraphView';
import { ThemeProvider } from '../ThemeProvider';
import { syntheticGraph, syntheticSemanticLinks } from './synthetic';
import { layoutWorld, DEFAULT_GRAPH_CONFIG } from '../render/graph';

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 30 });
const graph = syntheticGraph(3, 8);
const world = layoutWorld(graph, { mode: 'cluster' }).nodes;
const semanticLinks = syntheticSemanticLinks(graph);
const root = createRoot(renderer);
root.render(
  <ThemeProvider initial="horizon">
    <GraphView graph={graph} world={world} mode="cluster" onCycleMode={() => {}} initialSelected="n0" />
  </ThemeProvider>
);

await new Promise((r) => setTimeout(r, 250));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);

const hasGlyph = /[◆●◧◔⬡▣]/.test(frame);
const hasBraille = /[⠀-⣿]/.test(frame);
const hasStatus = /nodes/.test(frame);
const hasSelected = /◉/.test(frame); // the focused node's ring glyph
console.log(`\nnode-glyphs:${hasGlyph}  braille-edges:${hasBraille}  status-line:${hasStatus}  selected-ring:${hasSelected}`);

// Second pass: turn the typed-edge overlay ON (synthetic semantic edges) and re-render in place —
// the overlay is render-only, so this must NOT reflow (same world), and the family legend + `typed N`
// status must appear.
root.render(
  <ThemeProvider initial="horizon">
    <GraphView
      graph={graph}
      world={world}
      semanticLinks={semanticLinks}
      mode="cluster"
      config={{ ...DEFAULT_GRAPH_CONFIG, typedEdges: 'on' }}
      onCycleMode={() => {}}
      initialSelected="n0"
    />
  </ThemeProvider>
);
await new Promise((r) => setTimeout(r, 100));
await renderOnce();
const overlayFrame = captureCharFrame();
console.log(overlayFrame);

const hasTypedStatus = /typed \d/.test(overlayFrame); // status line appended `typed N`
const hasFamilyLegend = /(lattice-structural|abstraction-ladder|lifecycle-lift|task-graph|analogy-tension|knowledge-functional)/.test(overlayFrame);
console.log(`\noverlay → typed-status:${hasTypedStatus}  family-legend:${hasFamilyLegend}  semantic-edges:${semanticLinks.length}`);

renderer.destroy();
const ok = hasGlyph && hasStatus && hasSelected && hasTypedStatus && hasFamilyLegend;
process.exit(ok ? 0 : 1);
