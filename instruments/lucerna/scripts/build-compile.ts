#!/usr/bin/env bun
/**
 * Build the per-OS lucerna release binary via `bun build --compile`.
 *
 * Output: dist/lucerna-{os}-{arch}[.exe]
 *   windows-x64  → lucerna-windows-x64.exe
 *   linux-x64    → lucerna-linux-x64
 *   darwin-arm64 → lucerna-darwin-arm64
 *
 * Usage (from instruments/lucerna):
 *   bun run scripts/build-compile.ts
 *   bun run scripts/build-compile.ts --target bun-windows-x64
 *   bun run scripts/build-compile.ts --outfile path/to/lucerna.exe
 */
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENTRY = join(ROOT, "src", "cli.ts");
const PKG_JSON = join(ROOT, "package.json");

/** Stamp for --define: release sets GROK_VERSION; otherwise package.json. */
function companionVersion(): string {
  const fromEnv = process.env.GROK_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(PKG_JSON, "utf-8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

function hostOsArch(): { os: string; arch: string } {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : process.platform;
  const arch =
    process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return { os, arch };
}

function parseArgs(argv: string[]): {
  target?: string;
  outfile?: string;
  help: boolean;
} {
  const out: { target?: string; outfile?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--target" && argv[i + 1]) out.target = argv[++i];
    else if (a.startsWith("--target=")) out.target = a.slice("--target=".length);
    else if (a === "--outfile" && argv[i + 1]) out.outfile = argv[++i];
    else if (a.startsWith("--outfile=")) out.outfile = a.slice("--outfile=".length);
  }
  return out;
}

async function compileOne(entry: string, outfile: string, target?: string): Promise<number> {
  const version = companionVersion();
  // Bun wants `--define KEY=VALUE` as two argv slots (not esbuild's `--define:K=V`).
  const bunArgs = [
    "build",
    "--compile",
    "--define",
    `__COMPANION_VERSION__=${JSON.stringify(version)}`,
    `--outfile=${outfile}`,
    entry,
  ];
  if (target) bunArgs.splice(2, 0, `--target=${target}`);
  console.log(`[build-compile] bun ${bunArgs.join(" ")}`);
  console.log(`[build-compile] __COMPANION_VERSION__=${version}`);
  const proc = Bun.spawn([process.execPath, ...bunArgs], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return (await proc.exited) ?? 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: bun run scripts/build-compile.ts [options]

Options:
  --target bun-<os>-<arch> Cross-compile target (Bun --target)
  --outfile path           Override outfile

Produces dist/lucerna-{os}-{arch}[.exe] embedding the lucerna CLI.`);
  process.exit(0);
}

if (!existsSync(ENTRY)) {
  console.error(`missing compile entry: ${ENTRY}`);
  process.exit(1);
}

const { os, arch } = hostOsArch();
const ext = process.platform === "win32" ? ".exe" : "";
const defaultName = `lucerna-${os}-${arch}${ext}`;
const distDir = join(ROOT, "dist");
mkdirSync(distDir, { recursive: true });
const outfile = resolve(args.outfile ?? join(distDir, defaultName));

const code = await compileOne(ENTRY, outfile, args.target);
if (code !== 0) {
  console.error(`[build-compile] failed exit=${code}`);
  process.exit(code);
}
console.log(`[build-compile] ok → ${outfile}`);
console.log(`[build-compile] try: ${outfile} status --house <house>`);
console.log(`[build-compile]      ${outfile} --help`);
