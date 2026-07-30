// ─────────────────────────────────────────────────────────────────────────────
// index.ts — the composition root. The ONLY module that imports sibling
// implementation barrels directly (./core, ./graph, ./projects, ./search); every
// route reaches them through injected DaemonDeps. Resolves the org root, builds
// the index, wires deps, and starts the server.
//
// NOTE: until the ./core, ./graph, and ./projects barrels land (built in
// parallel), this file will not typecheck — the import errors are expected and
// resolve when the sibling modules exist. The ./search barrel is present.
//
// Usage:
//   bun src/index.ts [org_root] [--port N] [--help]
//
// Org-root resolution order:
//   1. positional arg
//   2. $DIOPTRA_ORG_ROOT
//   3. walk up from cwd for a dir that holds CLAUDE.md beside a tasks/ dir
//   4. unresolvable → exit 64 (EX_USAGE)
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DaemonConfig, DaemonDeps } from './contract.ts';

// Sibling barrels (contract-guaranteed surfaces). Named to match the *Module
// interfaces in contract.ts.
import { buildIndex, extractBody, serializeDoc, startWatcher } from './core/index.ts';
import { buildGraph, loadTypedEdges } from './graph/index.ts';
import { getProjectFile, getTree, listProjects } from './projects/index.ts';
import { fuzzyMatch, search } from './search/index.ts';

import { startServer } from './server.ts';

const USAGE = `@selene/daemon — Bun index/read daemon

Usage:
  bun src/index.ts [org_root] [--port N]

Options:
  org_root      Path to the org tree (else $DIOPTRA_ORG_ROOT, else walk up from
                cwd for a dir holding AGENTS.md|AGENT.md|CLAUDE.md beside tasks/).
  --port N      Listen port (default 3852).
  --no-watch    Do not start the file watcher (index is boot-frozen).
  --help        Show this help.`;

interface Args {
  orgRoot?: string;
  port: number;
  help: boolean;
  noWatch: boolean;
  allowForeignRoot: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { port: 3852, help: false, noWatch: false, allowForeignRoot: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--no-watch') {
      out.noWatch = true;
    } else if (a === '--allow-foreign-root') {
      out.allowForeignRoot = true;
    } else if (a === '--port') {
      out.port = Number(argv[++i]);
    } else if (a.startsWith('--port=')) {
      out.port = Number(a.slice('--port='.length));
    } else if (!a.startsWith('-') && out.orgRoot === undefined) {
      out.orgRoot = a;
    }
  }
  return out;
}

/** A dir qualifies as an org root when it holds (AGENTS.md|AGENT.md|CLAUDE.md) AND a tasks/ dir. */
function isOrgRoot(dir: string): boolean {
  try {
    const hasOrient =
      existsSync(join(dir, 'AGENTS.md')) ||
      existsSync(join(dir, 'AGENT.md')) ||
      existsSync(join(dir, 'CLAUDE.md'));
    return (
      hasOrient &&
      existsSync(join(dir, 'tasks')) &&
      statSync(join(dir, 'tasks')).isDirectory()
    );
  } catch {
    return false;
  }
}

function walkUpForOrgRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (isOrgRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveOrgRoot(args: Args): string | undefined {
  if (args.orgRoot !== undefined) return resolve(args.orgRoot);
  const env = process.env.DIOPTRA_ORG_ROOT;
  if (env !== undefined && env !== '') return resolve(env);
  const walked = walkUpForOrgRoot(process.cwd());
  return walked !== undefined ? resolve(walked) : undefined;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!Number.isInteger(args.port) || args.port < 0) {
    console.error(`[daemon] invalid --port: ${args.port}`);
    process.exit(64);
  }

  const orgRoot = resolveOrgRoot(args);
  if (orgRoot === undefined) {
    console.error(
      '[daemon] could not resolve org root (pass a path, set $DIOPTRA_ORG_ROOT, ' +
        'or run inside a tree with AGENTS.md|AGENT.md|CLAUDE.md beside tasks/)',
    );
    process.exit(64);
  }

  // House-root guard (2026-07-22): this daemon's source lives inside exactly one
  // house tree. Serving any OTHER org root is almost always an accident — the
  // foreign-root incident: a house bin run from another tree
  // resolved that tree and served it on the house port, silently crossing
  // every downstream surface. Refuse unless explicitly overridden.
  const houseRoot = resolve(import.meta.dir, '../../../../..');
  if (resolve(orgRoot) !== houseRoot && !args.allowForeignRoot) {
    console.error(
      `[daemon] REFUSING foreign org root: ${orgRoot}
` +
        `[daemon] this daemon's house tree is: ${houseRoot}
` +
        `[daemon] run the daemon that lives inside the target tree, or pass --allow-foreign-root to override.`,
    );
    process.exit(78); // EX_CONFIG
  }

  const { index, stats } = buildIndex(orgRoot);
  console.log(
    `[daemon] index: ${stats.files} files, ${stats.parsed} parsed, ` +
      `${stats.parseFailures} failures, ${stats.ms}ms`,
  );

  const config: DaemonConfig = { orgRoot, port: args.port, startedAt: Date.now() };
  const deps: DaemonDeps = {
    config,
    index,
    core: { serializeDoc, extractBody },
    graph: { buildGraph, loadTypedEdges },
    projects: { listProjects, getTree, getProjectFile },
    search: { fuzzyMatch, search },
  };

  startServer(deps);
  console.log(`[daemon] listening on http://127.0.0.1:${config.port} (org root: ${orgRoot})`);

  // First client has repointed to this daemon → the ratified trigger to keep the
  // (formerly boot-frozen) index live. One admission filter: every watcher event
  // routes through the same shouldExclude the walk uses (core/watcher.ts).
  if (!args.noWatch) {
    startWatcher(index, orgRoot);
    console.log(`[daemon] watching ${orgRoot} for changes`);
  }
}

main();
