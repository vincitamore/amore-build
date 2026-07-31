#!/usr/bin/env bun
/**
 * Standalone / compiled-binary entry for iris.
 *
 * `bun build --compile` produces a single executable that embeds the CLI verbs
 * (`@arcus/regula` write surface + daemon HTTP reads) and the Bun index daemon.
 * Routing is in-process: no sibling `.ts` spawns (those only exist in a source tree).
 *
 * OpenTUI dash is intentionally NOT embedded — see BUILD.md.
 * Bare `iris` / `iris dash` from this binary print the source-build recipe.
 *
 * Source-tree bin remains `iris.ts` (spawns glass / daemon / index via Bun).
 * Build: `bun run scripts/build-compile.ts` → `dist/iris-{os}-{arch}[.exe]`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when running inside a `bun build --compile` executable ($bunfs virtual FS). */
export function isCompiledBinary(): boolean {
  const p = typeof import.meta.path === 'string' ? import.meta.path : '';
  const u = typeof import.meta.url === 'string' ? import.meta.url : '';
  return p.includes('$bunfs') || u.includes('$bunfs');
}

/**
 * Resolve how to spawn the daemon as a detached child (TUI ensureDaemon / future
 * auto-spawn). Compiled binary: re-exec self with `daemon …`. Source: bun + entry.
 */
export function resolveDaemonSpawn(): { cmd: string; baseArgs: string[] } | null {
  if (isCompiledBinary()) {
    return { cmd: process.execPath, baseArgs: ['daemon'] };
  }
  if (process.env.IRIS_DAEMON_BIN && existsSync(process.env.IRIS_DAEMON_BIN)) {
    return { cmd: process.env.IRIS_DAEMON_BIN, baseArgs: [] };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, '..', '..', 'daemon', 'src', 'index.ts');
  if (existsSync(entry)) return { cmd: process.execPath, baseArgs: [entry] };
  return null;
}

const DEFAULT_PORT = 3853;

const DASH_SOURCE_NOTE = [
  'iris dash is a separate compiled artifact (keeps the multi-tool lean).',
  '',
  'Build both:',
  '  cd instruments/iris && bun run scripts/build-compile.ts --with-dash',
  '  # → dist/iris-{os}-{arch}[.exe]       CLI + daemon',
  '  # → dist/iris-dash-{os}-{arch}[.exe]  OpenTUI (TTY required)',
  '',
  'Run dash (place both binaries side-by-side, or set IRIS_DAEMON_BIN):',
  '  ./iris-dash-{os}-{arch}',
  '',
  'Source build (always works, any OS with bun install):',
  '  bun packages/tui/src/index.tsx',
  '  # or: bun packages/cli/src/iris.ts dash',
  '',
  'OpenTUI native: platform package embeds opentui.dll/.so/.dylib via',
  '`import … with { type: "file" }` — bun build --compile embeds it (proved',
  'windows-x64). Extra grammars (tree-sitter-wasms) resolve from node_modules',
  'in source builds; compiled dash ships OpenTUI defaults only.',
  '',
  'See instruments/iris/BUILD.md.',
].join('\n');

function help(): void {
  process.stdout.write(
    [
      'iris — Arcus control surface (compiled binary)',
      '',
      '  iris daemon [--port N] [org_root]  start the index/read daemon',
      '  iris status|task|inbox|…           org verbs (regula + daemon reads)',
      '  iris regula <verb>                 explicit regula passthrough',
      '  iris commands [--json]             capability manifest',
      '  iris --help',
      '',
      'Dash (OpenTUI) is source-build only from this artifact — see BUILD.md.',
      `Daemon default port ${DEFAULT_PORT}. Org root: $IRIS_ORG_ROOT or walk-up markers.`,
      '',
    ].join('\n'),
  );
}

async function runDaemon(args: string[]): Promise<void> {
  // daemon/src/index.ts reads process.argv.slice(2) at module load.
  process.argv = [process.argv[0]!, process.execPath, ...args];
  await import('../../daemon/src/index.ts');
}

async function runCli(args: string[]): Promise<void> {
  // packages/cli/src/index.ts reads process.argv.slice(2) at module load.
  process.argv = [process.argv[0]!, process.execPath, ...args];
  await import('./index.ts');
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === 'dash') {
  // Prefer a sibling compiled dash artifact when present (release layout).
  const { dirname: dn, join: jn } = await import('node:path');
  const execDir = dn(process.execPath);
  const dashCandidates = [
    process.env.IRIS_DASH_BIN,
    jn(execDir, 'iris-dash-windows-x64.exe'),
    jn(execDir, 'iris-dash-linux-x64'),
    jn(execDir, 'iris-dash-darwin-arm64'),
    jn(execDir, 'iris-dash-darwin-x64'),
    jn(execDir, 'iris-dash.exe'),
    jn(execDir, 'iris-dash'),
  ].filter((p): p is string => Boolean(p));
  const dashBin = dashCandidates.find((p) => existsSync(p));
  if (dashBin) {
    const rest = argv[0] === 'dash' ? argv.slice(1) : [];
    if (!process.env.IRIS_DAEMON_BIN) process.env.IRIS_DAEMON_BIN = process.execPath;
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(dashBin, rest, { stdio: 'inherit', env: process.env });
    process.exit(r.status ?? 1);
  }
  process.stderr.write(DASH_SOURCE_NOTE + '\n');
  process.exit(64);
}

if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
  help();
  process.exit(0);
}

if (argv[0] === 'daemon') {
  let port = String(DEFAULT_PORT);
  const out: string[] = [];
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = args[++i]!;
    } else if (args[i]?.startsWith('--port=')) {
      port = args[i]!.slice('--port='.length);
    } else {
      out.push(args[i]!);
    }
  }
  if (!process.env.IRIS_PORT) process.env.IRIS_PORT = port;
  await runDaemon([...out, '--port', port]);
} else {
  if (!process.env.IRIS_PORT) process.env.IRIS_PORT = String(DEFAULT_PORT);
  const regulaArgs = argv[0] === 'regula' ? argv.slice(1) : argv;
  await runCli(regulaArgs);
}
