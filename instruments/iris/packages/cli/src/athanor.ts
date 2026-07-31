// ─────────────────────────────────────────────────────────────────────────────
// athanor.ts — the CLI's athanor pipeline surface (examen athanor_* successors).
//
// SUBSTRATE (mirrors examen/src/index.ts, which absorbed instruments/athanor/mcp):
// athanor has NO daemon route and is NOT a regula concern — a CLI verb wraps the
// SAME linkage examen used:
//   • run     → a DETACHED `bun run instruments/athanor/src/index.ts …` subprocess
//               (examen handleAthanorRun:1644). Fresh child, unref'd; run state
//               lives on disk (the manifest), never in-process.
//   • list    → read forge/sessions/*.manifest.md   (handleAthanorList:1869)
//   • status  → read forge/sessions/<name>.manifest.md + forge/.tmp/<name>.log
//               (handleAthanorStatus:1722, minus the MCP-lived in-memory run map —
//                a fresh CLI process reconstructs from disk only)
//   • results → read forge/handles|output/<name>/    (handleAthanorResults:1798)
//   • recipes → READ THE REAL REGISTRY (the REQUIRED FIX). examen returned a
//               hardcoded 12-item literal (handleAthanorRecipes:1909) already known
//               to drift; here we enumerate the authoritative registered set from
//               instruments/athanor/src/recipe/registry.ts (its import list is the
//               source of what is registered — same technique the lineage registry's
//               governance.ts validateRecipeAlignment uses) and enrich each from
//               its recipe definition file. Adding a recipe = an import + a register
//               call, so this can never fall out of sync.
//
// Pure helpers (buildRunPlan / previewRun / parseRecipeRegistry / listPipelines /
// pipelineStatus / pipelineResults) are unit-tested against fixture trees; the only
// side-effecting function is dispatchRun (the actual spawn), called by the `run`
// verb ONLY when --preview is absent.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RegulaError, slugify } from '@arcus/regula';

// ── paths ──────────────────────────────────────────────────────────────────────

export interface AthanorPaths {
  entry: string; // instruments/athanor/src/index.ts
  recipeDir: string; // instruments/athanor/src/recipe
  registry: string; // …/recipe/registry.ts
  sessionsDir: string; // forge/sessions
  handlesDir: string; // forge/handles
  outputDir: string; // forge/output
  tmpDir: string; // forge/.tmp
}

export function athanorPaths(orgRoot: string): AthanorPaths {
  const recipeDir = join(orgRoot, 'instruments', 'athanor', 'src', 'recipe');
  return {
    entry: join(orgRoot, 'instruments', 'athanor', 'src', 'index.ts'),
    recipeDir,
    registry: join(recipeDir, 'registry.ts'),
    sessionsDir: join(orgRoot, 'forge', 'sessions'),
    handlesDir: join(orgRoot, 'forge', 'handles'),
    outputDir: join(orgRoot, 'forge', 'output'),
    tmpDir: join(orgRoot, 'forge', '.tmp'),
  };
}

// ── manifest frontmatter parse (examen's line-split approach, self-contained) ────

function parseManifestFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return fm;
  for (const line of m[1].split(/\r?\n/)) {
    const [key, ...rest] = line.split(': ');
    if (key && rest.length > 0) fm[key.trim()] = rest.join(': ').replace(/^'|'$/g, '');
  }
  return fm;
}

// ── recipes — read the REAL registry (the required fix) ──────────────────────────

export interface RecipeInfo {
  name: string;
  description?: string;
  layers?: number;
}

export interface RecipeListResult {
  recipes: RecipeInfo[];
  total: number;
  /** Provenance: the authoritative registry the names were enumerated from. */
  source: string;
}

/** Extract a (possibly `+`-concatenated) double-quoted string literal value for `field`. */
function extractStringField(src: string, field: string): string | undefined {
  const re = new RegExp(`${field}:\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*\\+?\\s*)+)`);
  const m = src.match(re);
  if (!m) return undefined;
  const segments = m[1].match(/"(?:[^"\\]|\\.)*"/g);
  if (!segments) return undefined;
  try {
    return segments.map((s) => JSON.parse(s) as string).join('');
  } catch {
    return undefined;
  }
}

/**
 * Enumerate the registered recipes from athanor's registry SOURCE (not a hardcoded
 * literal). The registry's `import { … } from "./<name>"` lines are the authoritative
 * set of what is registered (the file basename equals the recipe key, per athanor's
 * CLAUDE.md); each recipe file is then read for its `name`/`description`/layer count.
 */
export function parseRecipeRegistry(orgRoot: string): RecipeListResult {
  const p = athanorPaths(orgRoot);
  if (!existsSync(p.registry)) {
    throw new RegulaError('NOT_FOUND', `athanor recipe registry not found at instruments/athanor/src/recipe/registry.ts`);
  }
  const registrySrc = readFileSync(p.registry, 'utf-8');
  const moduleNames: string[] = [];
  for (const m of registrySrc.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
    const mod = m[1];
    if (mod !== 'types' && !moduleNames.includes(mod)) moduleNames.push(mod);
  }

  const recipes: RecipeInfo[] = moduleNames.map((mod) => {
    const file = join(p.recipeDir, `${mod}.ts`);
    if (!existsSync(file)) return { name: mod };
    let src: string;
    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      return { name: mod };
    }
    const name = extractStringField(src, 'name') ?? mod;
    const description = extractStringField(src, 'description');
    // Only a LayerSpec carries an `index: <n>` field, so counting those (whether written
    // `{ index: 0` inline or on its own line) is a robust layer count without
    // importing/executing the module.
    const layerMatches = src.match(/\bindex:\s*\d+/g);
    const layers = layerMatches ? layerMatches.length : undefined;
    return { name, ...(description ? { description } : {}), ...(layers !== undefined ? { layers } : {}) };
  });

  return { recipes, total: recipes.length, source: 'instruments/athanor/src/recipe/registry.ts' };
}

// ── list ─────────────────────────────────────────────────────────────────────

export interface PipelineSummary {
  name: string;
  status: string;
  recipe: string;
  goal: string;
  started: string | null;
  completed: string | null;
  agents: number;
}

/** List pipeline manifests under forge/sessions/, newest-first (examen handleAthanorList). */
export function listPipelines(orgRoot: string, limit = 10): { pipelines: PipelineSummary[]; total: number } {
  const { sessionsDir } = athanorPaths(orgRoot);
  if (!existsSync(sessionsDir)) return { pipelines: [], total: 0 };
  const manifests = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.manifest.md'))
    .sort()
    .reverse();
  const pipelines = manifests.slice(0, limit).map((f) => {
    const fm = parseManifestFrontmatter(readFileSync(join(sessionsDir, f), 'utf-8'));
    return {
      name: f.replace('.manifest.md', ''),
      status: fm.status ?? 'unknown',
      recipe: fm.recipe ?? 'unknown',
      goal: fm.goal ?? '',
      started: fm.started ?? null,
      completed: fm.completed ?? null,
      agents: Number.parseInt(fm['total-agents'] ?? '0', 10),
    };
  });
  return { pipelines, total: manifests.length };
}

// ── status ───────────────────────────────────────────────────────────────────

/**
 * Reconstruct a pipeline's status from disk (examen handleAthanorStatus, minus the
 * MCP-process-lived run map). A fresh CLI process has no in-memory run state, so:
 *   manifest present            → parse it (status/recipe/goal/shape/recent events)
 *   no manifest + non-empty log → the child crashed before writing one → 'failed'
 *   no manifest + empty log     → dispatched, manifest not yet written → 'starting'
 *   neither                     → NOT_FOUND
 */
export function pipelineStatus(orgRoot: string, name: string): Record<string, unknown> {
  const p = athanorPaths(orgRoot);
  const manifestPath = join(p.sessionsDir, `${name}.manifest.md`);
  const logPath = join(p.tmpDir, `${name}.log`);

  if (!existsSync(manifestPath)) {
    let errorLog = '';
    if (existsSync(logPath)) errorLog = readFileSync(logPath, 'utf-8').trim();
    if (errorLog) {
      return {
        name,
        status: 'failed',
        error: errorLog.slice(-2000),
        message: 'Pipeline process crashed before writing a manifest. See error field.',
      };
    }
    if (existsSync(logPath)) {
      return { name, status: 'starting', message: 'Pipeline dispatched; manifest not yet written.' };
    }
    throw new RegulaError('NOT_FOUND', `No pipeline found: "${name}". Use \`iris athanor list\` to see available pipelines.`);
  }

  const content = readFileSync(manifestPath, 'utf-8');
  const fm = parseManifestFrontmatter(content);

  const logMatch = content.match(/## Execution Log\r?\n<!-- .*? -->\r?\n([\s\S]*?)(?=\r?\n## |$)/);
  const logLines = logMatch ? logMatch[1].trim().split(/\r?\n/).filter((l) => l.startsWith('- ')) : [];
  const outcomeMatch = content.match(/## Outcome\r?\n([\s\S]*?)$/);

  return {
    name,
    status: fm.status ?? 'unknown',
    recipe: fm.recipe ?? null,
    goal: fm.goal ?? null,
    started: fm.started ?? null,
    completed: fm.completed ?? null,
    depth: Number.parseInt(fm.depth ?? '0', 10),
    width: Number.parseInt(fm.width ?? '0', 10),
    totalAgents: Number.parseInt(fm['total-agents'] ?? '0', 10),
    recentEvents: logLines.slice(-5),
    totalEvents: logLines.length,
    outcome: outcomeMatch ? outcomeMatch[1].trim() : null,
  };
}

// ── results ──────────────────────────────────────────────────────────────────

/** Read a pipeline's layer handles (+ optional full outputs) — examen handleAthanorResults. */
export function pipelineResults(
  orgRoot: string,
  name: string,
  opts: { layer?: number; full?: boolean } = {},
): Record<string, unknown> {
  const p = athanorPaths(orgRoot);
  const manifestPath = join(p.sessionsDir, `${name}.manifest.md`);
  if (!existsSync(manifestPath)) {
    throw new RegulaError('NOT_FOUND', `No pipeline found: "${name}"`);
  }
  const content = readFileSync(manifestPath, 'utf-8');
  const statusMatch = content.match(/status:\s*(\w+)/);
  const status = statusMatch ? statusMatch[1] : 'unknown';
  if (status !== 'complete' && status !== 'partial') {
    return { name, status, message: `Pipeline is ${status}; results not yet available. Use \`iris athanor status\`.` };
  }

  const nsHandles = join(p.handlesDir, name);
  const nsOutput = join(p.outputDir, name);
  const handlesDir = existsSync(nsHandles) ? nsHandles : p.handlesDir;
  const outputDir = existsSync(nsOutput) ? nsOutput : p.outputDir;

  const handleFiles = existsSync(handlesDir) ? readdirSync(handlesDir).filter((f) => f.endsWith('.md')) : [];
  const outputFiles = existsSync(outputDir) ? readdirSync(outputDir).filter((f) => f.endsWith('.md')) : [];

  const layerNums = handleFiles
    .map((f) => {
      const m = f.match(/^layer(\d+)-/);
      return m ? Number.parseInt(m[1], 10) : -1;
    })
    .filter((n) => n >= 0);
  const targetLayer = opts.layer ?? Math.max(...layerNums, 0);

  const layerHandles = handleFiles.filter((f) => f.startsWith(`layer${targetLayer}-`)).sort();
  const layerOutputs = outputFiles.filter((f) => f.startsWith(`layer${targetLayer}-`)).sort();

  const results: Record<string, { handle: string; output?: string }> = {};
  for (const hFile of layerHandles) {
    const concern = hFile.replace(`layer${targetLayer}-`, '').replace('.md', '');
    const handle = readFileSync(join(handlesDir, hFile), 'utf-8');
    let output: string | undefined;
    if (opts.full) {
      const oFile = layerOutputs.find((f) => f === hFile);
      if (oFile) output = readFileSync(join(outputDir, oFile), 'utf-8');
    }
    results[concern] = { handle, ...(output ? { output } : {}) };
  }

  return { name, status, layer: targetLayer, files: layerHandles.length, results };
}

// ── run (write) — plan / preview / dispatch ──────────────────────────────────

/** Recipes whose named layers require concerns (examen RECIPE_REQUIRED_CONCERNS:1638). */
export const RECIPE_REQUIRED_CONCERNS: Record<string, number[]> = {
  assay: [1],
  'deep-review': [1],
  copia: [1],
};

export interface RunInput {
  recipe: string;
  goal: string;
  sources: string[];
  /** Parsed layer→concerns map (from --concerns JSON or a read --concerns-file). */
  concerns?: Record<string, string[]>;
  /** An existing concerns file to pass through verbatim (org-relative or absolute). */
  concernsFile?: string;
  name?: string;
  clean?: boolean;
}

export interface RunPlan {
  command: 'bun';
  args: string[];
  cwd: string;
  name: string;
  recipe: string;
  goal: string;
  sources: string[];
  logPath: string;
  concerns?: Record<string, string[]>;
  /** When set, dispatch writes `concerns` here (JSON) before spawning. */
  concernsFileToWrite?: string;
}

/**
 * Validate inputs and build the exact spawn plan — the pure core shared by preview
 * and dispatch. Always passes `--name <pipelineName>` (a climb over examen, which
 * passed it only when explicit and so could return a name that didn't match the
 * manifest athanor auto-generated) so the returned name is authoritative for a
 * follow-up `iris athanor status`.
 */
export function buildRunPlan(orgRoot: string, input: RunInput, now: number = Date.now()): RunPlan {
  const p = athanorPaths(orgRoot);
  if (!existsSync(p.entry)) {
    throw new RegulaError('NOT_FOUND', `athanor entry not found at instruments/athanor/src/index.ts (is the athanor instrument present?)`);
  }
  const recipe = input.recipe?.trim();
  const goal = input.goal?.trim();
  if (!recipe) throw new RegulaError('USAGE', 'athanor run requires --recipe');
  if (!goal) throw new RegulaError('USAGE', 'athanor run requires --goal');
  const sources = (input.sources ?? []).map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) throw new RegulaError('USAGE', 'athanor run requires --sources (comma-separated, org-relative)');

  const requiredLayers = RECIPE_REQUIRED_CONCERNS[recipe];
  if (requiredLayers) {
    // When concerns arrived via --concerns-file (not the inline object), read the file so
    // the required-layer precondition can still be checked here rather than only failing
    // downstream in the detached child. A malformed/absent file just skips the pre-check.
    let effective = input.concerns;
    if (effective === undefined && input.concernsFile) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(resolve(orgRoot, input.concernsFile), 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          effective = parsed as Record<string, string[]>;
        }
      } catch {
        /* athanor itself validates; skip the pre-check */
      }
    }
    for (const layer of requiredLayers) {
      const c = effective?.[String(layer)];
      if (!c || c.length === 0) {
        throw new RegulaError(
          'USAGE',
          `Recipe "${recipe}" requires concerns for layer ${layer}. Pass --concerns '{"${layer}":["concern-a","concern-b"]}'`,
        );
      }
    }
  }

  const name = input.name?.trim() || slugify(goal).slice(0, 60);
  const logPath = join(p.tmpDir, `${name}.log`);
  const args = [
    'run',
    p.entry,
    '--recipe', recipe,
    '--goal', goal,
    '--sources', sources.join(','),
    '--org-root', orgRoot,
    '--name', name,
  ];
  if (input.clean) args.push('--clean');

  let concernsFileToWrite: string | undefined;
  if (input.concernsFile) {
    args.push('--concerns-file', resolve(orgRoot, input.concernsFile));
  } else if (input.concerns) {
    concernsFileToWrite = join(p.tmpDir, `concerns-${now}.json`);
    args.push('--concerns-file', concernsFileToWrite);
  }

  return {
    command: 'bun',
    args,
    cwd: orgRoot,
    name,
    recipe,
    goal,
    sources,
    logPath,
    ...(input.concerns ? { concerns: input.concerns } : {}),
    ...(concernsFileToWrite ? { concernsFileToWrite } : {}),
  };
}

/** The --preview payload: exactly what dispatch WOULD run, with nothing written/spawned. */
export function previewRun(plan: RunPlan): Record<string, unknown> {
  return {
    preview: true,
    dispatched: false,
    name: plan.name,
    recipe: plan.recipe,
    goal: plan.goal,
    sources: plan.sources,
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    logPath: plan.logPath,
    ...(plan.concernsFileToWrite ? { concernsFileToWrite: plan.concernsFileToWrite, concerns: plan.concerns } : {}),
  };
}

/** Dispatch the pipeline: write concerns (if any), spawn a detached, unref'd `bun` child. */
export function dispatchRun(plan: RunPlan): Record<string, unknown> {
  mkdirSync(join(plan.cwd, 'forge', '.tmp'), { recursive: true });
  if (plan.concernsFileToWrite && plan.concerns) {
    writeFileSync(plan.concernsFileToWrite, JSON.stringify(plan.concerns), 'utf-8');
  }
  const logFd = openSync(plan.logPath, 'w');
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd);

  return {
    dispatched: true,
    name: plan.name,
    recipe: plan.recipe,
    goal: plan.goal,
    sources: plan.sources,
    pid: child.pid ?? null,
    logPath: plan.logPath,
    message: `Pipeline "${plan.name}" dispatched. Monitor with \`iris athanor status ${plan.name}\`.`,
  };
}
