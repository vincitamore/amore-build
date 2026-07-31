#!/usr/bin/env bun
/**
 * Build the per-OS iris release binary via `bun build --compile`.
 *
 * Output: dist/iris-{os}-{arch}[.exe]
 *   windows-x64 → iris-windows-x64.exe
 *   linux-x64   → iris-linux-x64
 *   darwin-arm64→ iris-darwin-arm64
 *
 * Embeds: CLI verbs + Bun index daemon (+ @arcus/regula).
 * Optional: `--with-dash` also builds dist/iris-dash-{os}-{arch}[.exe]
 * (OpenTUI native surface — proven on windows-x64; see BUILD.md).
 *
 * Usage (from instruments/iris):
 *   bun run scripts/build-compile.ts
 *   bun run scripts/build-compile.ts --with-dash
 *   bun run scripts/build-compile.ts --target bun-windows-x64
 *   bun run scripts/build-compile.ts --outfile path/to/iris.exe
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENTRY = join(ROOT, 'packages/cli/src/standalone.ts');
const DASH_ENTRY = join(ROOT, 'packages/tui/src/dash-standalone.ts');

function hostOsArch(): { os: string; arch: string } {
  const os =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  return { os, arch };
}

function parseArgs(argv: string[]): {
  target?: string;
  outfile?: string;
  withDash: boolean;
  help: boolean;
} {
  const out: { target?: string; outfile?: string; withDash: boolean; help: boolean } = {
    withDash: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--with-dash') out.withDash = true;
    else if (a === '--target' && argv[i + 1]) out.target = argv[++i];
    else if (a.startsWith('--target=')) out.target = a.slice('--target='.length);
    else if (a === '--outfile' && argv[i + 1]) out.outfile = argv[++i];
    else if (a.startsWith('--outfile=')) out.outfile = a.slice('--outfile='.length);
  }
  return out;
}

async function compileOne(entry: string, outfile: string, target?: string): Promise<number> {
  const bunArgs = ['build', '--compile', `--outfile=${outfile}`, entry];
  if (target) bunArgs.splice(2, 0, `--target=${target}`);
  console.log(`[build-compile] bun ${bunArgs.join(' ')}`);
  const proc = Bun.spawn([process.execPath, ...bunArgs], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  return (await proc.exited) ?? 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: bun run scripts/build-compile.ts [options]

Options:
  --with-dash              Also build dist/iris-dash-{os}-{arch}[.exe]
  --target bun-<os>-<arch> Cross-compile target (Bun --target)
  --outfile path           Override multi-tool outfile

Produces dist/iris-{os}-{arch}[.exe] embedding CLI + daemon.
OpenTUI dash is a separate optional artifact (native dll/so/dylib per OS).`);
  process.exit(0);
}

if (!existsSync(ENTRY)) {
  console.error(`missing compile entry: ${ENTRY}`);
  process.exit(1);
}

const { os, arch } = hostOsArch();
const ext = process.platform === 'win32' ? '.exe' : '';
const defaultName = `iris-${os}-${arch}${ext}`;
const distDir = join(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
const outfile = resolve(args.outfile ?? join(distDir, defaultName));

const code = await compileOne(ENTRY, outfile, args.target);
if (code !== 0) {
  console.error(`[build-compile] multi-tool failed exit=${code}`);
  process.exit(code);
}
console.log(`[build-compile] ok → ${outfile}`);
console.log(`[build-compile] try: ${outfile} daemon --port 3854 <org_root>`);
console.log(`[build-compile]      ${outfile} task list --json`);

if (args.withDash) {
  if (!existsSync(DASH_ENTRY)) {
    console.error(`missing dash entry: ${DASH_ENTRY}`);
    process.exit(1);
  }
  const dashOut = join(distDir, `iris-dash-${os}-${arch}${ext}`);
  const dCode = await compileOne(DASH_ENTRY, dashOut, args.target);
  if (dCode !== 0) {
    console.error(`[build-compile] dash failed exit=${dCode}`);
    process.exit(dCode);
  }
  console.log(`[build-compile] dash ok → ${dashOut}`);
  console.log(`[build-compile] dash needs a TTY; set IRIS_DAEMON_BIN=${outfile} for auto-spawn`);
} else {
  console.log(`[build-compile] dash: omit (pass --with-dash) or source: bun packages/tui/src/index.tsx`);
}
