// Coherence gate: run the landed tell-test predicates (member topology, stage
// honesty, Wilson, absence, governance) against the real dashboard config.
// Bun: bun run tools/coherence-gate.ts
import { runCoherenceChecks } from '../instruments/iris/packages/tui/src/speculum/coherence';

// The 10 members exactly as landed in src/shell/Shell.tsx (line 51).
const MEMBERS = ['Dashboard', 'Tasks', 'Inbox', 'Reminders', 'Knowledge', 'Files', 'Forge', 'Lucerna', 'Graph', 'Sessions'] as const;
const LEGACY = ['Dashboard', 'Tasks', 'Inbox', 'Reminders', 'Knowledge', 'Files', 'Forge', 'Lucerna', 'Graph'] as const;

const checks = runCoherenceChecks({
  members: MEMBERS,
  legacyMembers: LEGACY,
  displayedStages: ['Probes', 'Usage', 'Microscope', 'Map', 'Search'],
  implementedStages: ['Probes', 'Usage', 'Microscope', 'Map', 'Search'],
  auditPaths: [], // the dash never writes an audit file; CLI owns the single one
  sideEffectPath: 'src/speculum/speculum-spawn.ts',
  orgSearchQuery: 'org search query', // never receives session bodies (Phase-1 pin)
  forceGraphKind: 'file', // session nodes must not get force edges
  // A real scan fixture row subset (n=0 full-uncertainty + a populated row).
  probes: [
    { n: 0, value: 0, ciLow: 0, ciHigh: 1 },
    { n: 40, value: 0.05, ciLow: 0.014, ciHigh: 0.16 },
  ],
});

let failed = 0;
for (const c of checks) {
  const mark = c.pass ? 'PASS' : 'FAIL';
  if (!c.pass) failed += 1;
  console.log(`${mark} [${c.family}] ${c.id} — ${c.detail}`);
}
console.log(failed === 0 ? `\nCOHERENCE GATE: all ${checks.length} checks green` : `\nCOHERENCE GATE: ${failed} FAILED of ${checks.length}`);
process.exit(failed === 0 ? 0 : 1);