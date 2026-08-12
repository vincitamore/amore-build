/**
 * Seed a synthetic, documentation-grade session corpus and derive a real
 * index from it through the production ingest path.
 *
 * The corpus is entirely synthetic (no real session content); timestamps are
 * recent so freshness surfaces render in their normal state. The resulting
 * index is written through `openDb` + `ingest`, so schema, annotations,
 * links, and titles all come from the same code paths a live index uses.
 *
 * Usage:
 *   bun run scripts/seed-docs-corpus.ts --db <index.sqlite> [--keep-tree]
 */

import { mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../src/store/db";
import { ingest } from "../src/ingest";
import {
  agentChunk,
  makeUsage,
  recentTs,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  updateLine,
  userChunk,
  writeCorpus,
  type FixtureSession,
} from "../src/test/fixtures";

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const dbPath = argValue("--db");
if (!dbPath) {
  console.error("--db <index.sqlite> is required");
  process.exit(2);
}
const keepTree = argv.includes("--keep-tree");
const treeOut = argValue("--tree-out");

/** Encoded/decoded cwd pairs for three synthetic projects. */
const PROJECTS = [
  { enc: "C--Users-demo-workshop-atelier", dec: "C:\\Users\\demo\\workshop\\atelier" },
  { enc: "C--Users-demo-workshop-lighthouse", dec: "C:\\Users\\demo\\workshop\\lighthouse" },
  { enc: "C--Users-demo-workshop-fieldnotes", dec: "C:\\Users\\demo\\workshop\\fieldnotes" },
] as const;

let counter = 0;
function sid(): string {
  counter += 1;
  const tail = String(counter).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}

interface Blueprint {
  project: (typeof PROJECTS)[number];
  title: string;
  daysAgo: number;
  turns: number;
  user: string;
  agent: string;
  tools: Array<{ title: string; input: unknown; output?: string }>;
  parent?: string;
}

function build(bp: Blueprint): FixtureSession {
  const id = sid();
  const base = bp.daysAgo * 24 * 60;
  const updates: string[] = [];
  let minute = 0;
  const push = (u: Record<string, unknown>) => {
    updates.push(updateLine(id, u, recentTs(base - minute)));
    minute += 2;
  };
  push(userChunk(bp.user));
  push(agentChunk(bp.agent));
  bp.tools.forEach((t, i) => {
    const callId = `call-${id.slice(-4)}-${i}`;
    push(toolCall(callId, t.title, t.input));
    if (t.output !== undefined) {
      push(toolCallUpdate(callId, t.title, t.output));
    }
  });
  for (let t = 0; t < bp.turns; t += 1) {
    push(turnCompleted(makeUsage("grok-4", { numTurns: 1 })));
  }
  return {
    id,
    cwdEnc: bp.project.enc,
    cwdDecoded: bp.project.dec,
    modelId: "grok-4",
    parentSessionId: bp.parent,
    updates,
    summaryExtra: bp.title ? { session_summary: bp.title } : undefined,
  };
}

const atelier = PROJECTS[0];
const lighthouse = PROJECTS[1];
const fieldnotes = PROJECTS[2];

const manifestPath = `${atelier.dec}\\src\\pipeline\\manifest.ts`;
const layoutPath = `${lighthouse.dec}\\src\\views\\layout.tsx`;

const blueprints: Blueprint[] = [
  {
    project: atelier,
    title: "Design The Pipeline Manifest Schema",
    daysAgo: 21,
    turns: 9,
    user: "Plan the manifest schema for the render pipeline before we build the stages.",
    agent: "Planning the schema first: stages, inputs, and provenance fields, then the loader.",
    tools: [
      { title: "Write", input: { file_path: manifestPath, content: "export interface Manifest {}" }, output: "wrote manifest.ts" },
      { title: "Bash", input: { command: "bun test src/pipeline" }, output: "3 pass" },
    ],
  },
  {
    project: atelier,
    title: "Wire The Manifest Loader Into The Renderer",
    daysAgo: 17,
    turns: 14,
    user: "Implement the loader against the manifest schema we designed.",
    agent: "Implementing the loader and wiring the renderer to consume the manifest.",
    tools: [
      { title: "Read", input: { file_path: manifestPath }, output: "export interface Manifest {}" },
      { title: "Edit", input: { file_path: `${atelier.dec}\\src\\pipeline\\loader.ts` }, output: "ok" },
      { title: "Bash", input: { command: "bun test" }, output: "12 pass" },
    ],
  },
  {
    project: atelier,
    title: "Debug The Stage Ordering Regression",
    daysAgo: 9,
    turns: 22,
    user: "The pipeline runs stages out of order after the loader change. Find and fix it.",
    agent: "Debugging: reproducing the ordering failure, then bisecting the loader merge.",
    tools: [
      { title: "Bash", input: { command: "bun test src/pipeline --filter ordering" }, output: "1 fail: stage order" },
      { title: "Read", input: { file_path: manifestPath }, output: "export interface Manifest {}" },
      { title: "Edit", input: { file_path: `${atelier.dec}\\src\\pipeline\\loader.ts` }, output: "ok" },
      { title: "Bash", input: { command: "bun test" }, output: "14 pass" },
    ],
  },
  {
    project: lighthouse,
    title: "Sketch The Dashboard Layout Grid",
    daysAgo: 13,
    turns: 11,
    user: "Design the responsive grid for the status dashboard.",
    agent: "Designing a two-band grid with container queries for the narrow profile.",
    tools: [
      { title: "Write", input: { file_path: layoutPath, content: "export const Grid = () => null;" }, output: "wrote layout.tsx" },
    ],
  },
  {
    project: lighthouse,
    title: "Container Queries For The Narrow Profile",
    daysAgo: 6,
    turns: 16,
    user: "The narrow profile overflows. Move the widgets to container queries.",
    agent: "Implementing container-query breakpoints and verifying the narrow render.",
    tools: [
      { title: "Read", input: { file_path: layoutPath }, output: "export const Grid = () => null;" },
      { title: "Edit", input: { file_path: layoutPath }, output: "ok" },
      { title: "Bash", input: { command: "bun run screenshot-sweep" }, output: "6 profiles rendered" },
    ],
  },
  {
    project: fieldnotes,
    title: "Import The Survey Notes Archive",
    daysAgo: 4,
    turns: 7,
    user: "Ingest the survey notes archive and normalize the entry dates.",
    agent: "Importing the archive and normalizing dates during the parse pass.",
    tools: [
      { title: "Bash", input: { command: "bun run import --archive notes-2026.zip" }, output: "482 entries" },
    ],
  },
  {
    project: fieldnotes,
    title: "Entity Extraction Over The Notes Corpus",
    daysAgo: 2,
    turns: 13,
    user: "Extract the place and person entities from the imported notes.",
    agent: "Running extraction with the gazetteer, then reviewing low-confidence hits.",
    tools: [
      { title: "Bash", input: { command: "bun run extract --kind entities" }, output: "1,240 entities" },
      { title: "Write", input: { file_path: `${fieldnotes.dec}\\out\\entities.json`, content: "[]" }, output: "wrote entities.json" },
    ],
  },
  {
    project: atelier,
    title: "Profile The Render Loop Allocations",
    daysAgo: 0,
    turns: 18,
    user: "The render loop allocates too much per frame. Profile and trim it.",
    agent: "Profiling the loop, then removing the per-frame clone in the hot path.",
    tools: [
      { title: "Bash", input: { command: "bun run profile --frames 500" }, output: "hot: clone in stage 3" },
      { title: "Edit", input: { file_path: `${atelier.dec}\\src\\pipeline\\stage3.ts` }, output: "ok" },
    ],
  },
];

// Subagent children for parentage surfaces.
const sessions: FixtureSession[] = [];
for (const bp of blueprints) {
  sessions.push(build(bp));
}
const parentForSub = sessions[2]!; // the debugging session
sessions.push(
  build({
    project: atelier,
    title: "Explore The Loader Merge History",
    daysAgo: 9,
    turns: 4,
    user: "Trace the loader merge that changed stage ordering.",
    agent: "Walking the history for the ordering change.",
    tools: [{ title: "Bash", input: { command: "git log --oneline src/pipeline" }, output: "12 commits" }],
    parent: parentForSub.id,
  }),
  build({
    project: lighthouse,
    title: "Audit The Widget Overflow Reports",
    daysAgo: 6,
    turns: 3,
    user: "Collect the overflow reports across profiles.",
    agent: "Sweeping the report files per profile.",
    tools: [{ title: "Read", input: { file_path: layoutPath }, output: "grid source" }],
    parent: sessions[4]!.id,
  }),
);

const corpus = writeCorpus(sessions);
try {
  const resolvedDb = dbPath;
  mkdirSync(dirname(resolvedDb), { recursive: true });
  if (existsSync(resolvedDb)) rmSync(resolvedDb);
  const db = openDb(resolvedDb);
  const stats = ingest(db, { sessionsDir: corpus.root, full: true });
  db.close();
  console.log(
    JSON.stringify(
      {
        db: resolvedDb,
        sessions: sessions.length,
        eventsIngested: (stats as Record<string, unknown>).eventsIngested ?? null,
      },
      null,
      2,
    ),
  );
  if (keepTree && treeOut) {
    cpSync(corpus.root, treeOut, { recursive: true });
    console.log(`tree copied to ${treeOut}`);
  }
} finally {
  corpus.cleanup();
}
