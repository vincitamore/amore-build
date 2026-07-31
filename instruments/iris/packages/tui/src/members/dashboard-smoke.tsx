// Headless smoke for the Dashboard member. Run: bun run src/members/dashboard-smoke.tsx
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { Dashboard } from './Dashboard';

const W = Number(process.env.SMOKE_W ?? 120);
const H = Number(process.env.SMOKE_H ?? 32);
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: W, height: H });
createRoot(renderer).render(
  <ThemeProvider initial="horizon">
    <Dashboard daemonUrl={null} />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 400)); // regula reads the real tree
await renderOnce();
const frame = captureCharFrame();
console.log(frame);

// Panel TITLES garble in the headless char-capture (border-title overlap), so assert on the
// content each panel renders: the Agenda title survives, the narrative shows date headers, and
// the commits show relative dates ("… ago").
const hasTasks = /active tasks/.test(frame);
const hasRail = /AGENDA|REVIEW|BLOCKED ON YOU|TO REVIEW|DECISIONS|nothing needs you/.test(frame); // Attention-rail sections
const hasNarrative = /20\d\d-\d\d-\d\d/.test(frame); // a Recent-Changes date section
const hasCommits = /\bago\b/.test(frame); // a Recent-Commits relative date
const noTagBox = !/Top Tags/.test(frame); // removed — was squished noise on the ops console
const hasBorders = /[┌┐└┘─│]/.test(frame);
console.log(`\nstats:${hasTasks}  rail:${hasRail}  narrative:${hasNarrative}  commits:${hasCommits}  noTagBox:${noTagBox}  borders:${hasBorders}`);

renderer.destroy();
process.exit(hasTasks && hasRail && hasNarrative && hasCommits && noTagBox && hasBorders ? 0 : 1);
