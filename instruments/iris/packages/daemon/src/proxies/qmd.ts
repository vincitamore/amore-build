// proxies/qmd.ts — managed @tobilu/qmd companion under ~/.amore/instruments/qmd/.
//
// Layout:
//   runtime/                     pinned npm install of @tobilu/qmd
//   houses/<house-id>/index.yml  collection config
//   houses/<house-id>/index.sqlite
//   models/                      shared GGUF cache (via XDG_CACHE_HOME parent)
//   manifest.json                pin + install metadata
//
// Spawn discipline: always `node <abs>/dist/cli/qmd.js` (Windows npm shims are
// unreliable). Isolation: QMD_CONFIG_DIR + INDEX_PATH + XDG_CACHE_HOME.
// Never starts qmd MCP HTTP. Loopback iris daemon only; no new port.

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

/** Exact managed package pin. */
export const QMD_PIN = '2.1.0';

/** npm package name for the managed install. */
export const QMD_PACKAGE = '@tobilu/qmd';

/** Default refresh debounce (ms) — order of minutes. */
export const DEFAULT_REFRESH_DEBOUNCE_MS = 120_000;

/** Minimum interval between refresh runs (ms). */
export const DEFAULT_REFRESH_MIN_INTERVAL_MS = 300_000;

/** Org sections bootstrapped as qmd collections. */
export const ORG_COLLECTIONS: ReadonlyArray<{
  name: string;
  rel: string;
  context: string;
}> = [
  {
    name: 'knowledge',
    rel: 'knowledge',
    context: 'Distilled long-form knowledge notes for the house.',
  },
  {
    name: 'tasks',
    rel: 'tasks',
    context: 'Task documents and lifecycle status notes.',
  },
  {
    name: 'inbox',
    rel: 'inbox',
    context: 'Incoming items awaiting triage or resolution.',
  },
  {
    name: 'forge',
    rel: 'forge',
    context: 'Pipeline sessions, dreams, and forge artifacts.',
  },
  {
    name: 'context',
    rel: 'context',
    context: 'House orientation, voice, and standing context files.',
  },
  {
    name: 'reminders',
    rel: 'reminders',
    context: 'Time-bound reminders and scheduled notes.',
  },
];

/** Hybrid model ladder (defaults from qmd llm.js). */
export const QMD_MODELS = [
  {
    role: 'embedding' as const,
    uri: 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf',
    file: 'hf_ggml-org_embeddinggemma-300M-Q8_0.gguf',
    sizeLabel: '313 MB',
    host: 'huggingface.co',
  },
  {
    role: 'rerank' as const,
    uri: 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',
    file: 'hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf',
    sizeLabel: '610 MB',
    host: 'huggingface.co',
  },
  {
    role: 'expansion' as const,
    uri: 'hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf',
    file: 'hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf',
    sizeLabel: '1223 MB',
    host: 'huggingface.co',
  },
] as const;

export type QmdSearchMode = 'lex' | 'vec' | 'query';
export type QmdState =
  | 'not-installed'
  | 'ready-lex'
  | 'ready-semantic'
  | 'embedding'
  | 'error';

export interface QmdSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface QmdRunOpts {
  orgRoot: string;
  houseId?: string;
  instrumentHome?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/** Injectable child runner (tests stub this — no real network/models/npm). */
export type QmdRunner = (
  argv: string[],
  opts: QmdRunOpts & { env: NodeJS.ProcessEnv },
) => Promise<QmdSpawnResult>;

/** Injectable npm installer for managed runtime. */
export type NpmInstaller = (opts: {
  prefix: string;
  packageSpec: string;
  nodeBin: string;
  npmBin: string | null;
}) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>;

export interface QmdPaths {
  instrumentHome: string;
  runtimeDir: string;
  modelsDir: string;
  housesDir: string;
  houseDir: string;
  configYml: string;
  indexSqlite: string;
  manifestPath: string;
  houseId: string;
  orgRoot: string;
}

export interface QmdResolve {
  kind: 'managed' | 'env' | 'global' | 'missing';
  qmdJs: string | null;
  nodeBin: string | null;
  pin?: string;
  reason?: string;
}

export interface QmdSearchHit {
  path: string;
  title: string;
  score?: number;
  snippet?: string;
}

export interface QmdSearchResult {
  available: boolean;
  reason?: string;
  backend: 'qmd';
  mode: QmdSearchMode;
  query: string;
  items: QmdSearchHit[];
}

export interface QmdStatusBlock {
  state: QmdState;
  available: boolean;
  reason?: string;
  pin?: string;
  resolvedPin?: string;
  resolveKind?: QmdResolve['kind'];
  houseId?: string;
  docs?: number;
  vectors?: number;
  pending?: number;
  models?: {
    embedding: boolean;
    rerank: boolean;
    expansion: boolean;
  };
  lastRefreshAt?: string | null;
  pendingChanges?: number;
  refreshRunning?: boolean;
  lastRefreshError?: string | null;
  runtimePath?: string | null;
  indexPath?: string | null;
}

export interface QmdManifest {
  pin: string;
  package: string;
  installedAt: string;
  source: 'npm' | 'global';
  qmdJs?: string;
}

// ── paths ────────────────────────────────────────────────────────────────────

export function qmdInstrumentHome(override?: string): string {
  if (override) return resolve(override);
  const env = process.env.IRIS_QMD_HOME;
  if (env && env.trim()) return resolve(env.trim());
  return join(homedir(), '.amore', 'instruments', 'qmd');
}

/** Stable filesystem-safe house id derived from the absolute house root. */
export function deriveHouseId(orgRoot: string): string {
  let abs = resolve(orgRoot).replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(abs)) {
    abs = abs[0]!.toUpperCase() + abs.slice(1);
  }
  const hash = createHash('sha256').update(abs.toLowerCase()).digest('hex').slice(0, 12);
  const base =
    basename(abs)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'house';
  return `${base}-${hash}`;
}

export function resolveQmdPaths(
  orgRoot: string,
  opts?: { instrumentHome?: string; houseId?: string },
): QmdPaths {
  const instrumentHome = qmdInstrumentHome(opts?.instrumentHome);
  const houseId = opts?.houseId ?? deriveHouseId(orgRoot);
  const houseDir = join(instrumentHome, 'houses', houseId);
  return {
    instrumentHome,
    runtimeDir: join(instrumentHome, 'runtime'),
    modelsDir: join(instrumentHome, 'models'),
    housesDir: join(instrumentHome, 'houses'),
    houseDir,
    configYml: join(houseDir, 'index.yml'),
    indexSqlite: join(houseDir, 'index.sqlite'),
    manifestPath: join(instrumentHome, 'manifest.json'),
    houseId,
    orgRoot: resolve(orgRoot),
  };
}

/** XDG_CACHE_HOME parent so qmd stores models at <instrumentHome>/models. */
export function xdgCacheHomeForInstrument(instrumentHome: string): string {
  // llm.js: join(XDG_CACHE_HOME, "qmd", "models")
  // store.js: join(XDG_CACHE_HOME, "qmd", "index.sqlite")
  // We want models at instrumentHome/models → XDG_CACHE_HOME = dirname(instrumentHome)
  // when instrumentHome ends with /qmd. Always dirname so instrumentHome/qmd/... is avoided
  // if the home itself is already .../qmd.
  return dirname(instrumentHome);
}

export function buildQmdEnv(paths: QmdPaths, extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QMD_CONFIG_DIR: paths.houseDir,
    INDEX_PATH: paths.indexSqlite,
    // models → <instrumentHome>/models via XDG_CACHE_HOME/qmd/models
    XDG_CACHE_HOME: xdgCacheHomeForInstrument(paths.instrumentHome),
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

// ── resolve node / qmd.js ────────────────────────────────────────────────────

function whichOnPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const tries =
      process.platform === 'win32'
        ? exts.flatMap((ext) => [join(dir, name + ext), join(dir, name)])
        : [join(dir, name)];
    for (const t of tries) {
      try {
        if (existsSync(t)) return t;
      } catch {
        // continue
      }
    }
  }
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0 && r.stdout) {
      const line = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (line && existsSync(line)) return line;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Prefer node >= 22, else bun on PATH. */
export function resolveJsRuntime(): { kind: 'node' | 'bun'; bin: string } | null {
  const node =
    process.env.IRIS_NODE_BIN && existsSync(process.env.IRIS_NODE_BIN)
      ? process.env.IRIS_NODE_BIN
      : whichOnPath('node');
  if (node) {
    try {
      const r = spawnSync(node, ['-p', 'process.versions.node'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (r.status === 0) {
        const ver = (r.stdout ?? '').trim();
        const major = Number(ver.split('.')[0]);
        if (Number.isFinite(major) && major >= 22) return { kind: 'node', bin: node };
        // Accept node anyway if bun absent — setup will report version note
        if (Number.isFinite(major) && major >= 18) {
          const bun = whichOnPath('bun');
          if (!bun) return { kind: 'node', bin: node };
        } else {
          // too old — fall through to bun
        }
      } else {
        return { kind: 'node', bin: node };
      }
    } catch {
      return { kind: 'node', bin: node };
    }
  }
  const bun =
    process.env.IRIS_BUN_BIN && existsSync(process.env.IRIS_BUN_BIN)
      ? process.env.IRIS_BUN_BIN
      : whichOnPath('bun');
  if (bun) return { kind: 'bun', bin: bun };
  if (node) return { kind: 'node', bin: node };
  return null;
}

export function managedQmdJs(runtimeDir: string): string {
  return join(runtimeDir, 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
}

export function detectGlobalQmdJs(): string | null {
  // Common global npm locations
  const candidates: string[] = [];
  if (process.env.IRIS_QMD_BIN) candidates.push(process.env.IRIS_QMD_BIN);
  if (process.env.QMD_BIN) candidates.push(process.env.QMD_BIN);

  // node dir / node_modules/@tobilu/qmd
  const node = whichOnPath('node');
  if (node) {
    const nodeDir = dirname(node);
    candidates.push(join(nodeDir, 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js'));
    // Windows: node is in .../nodejs/, modules alongside
    candidates.push(join(nodeDir, '..', 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js'));
  }
  // npm root -g
  try {
    const npm = whichOnPath('npm');
    if (npm) {
      const r = spawnSync(npm, ['root', '-g'], { encoding: 'utf8', timeout: 8000 });
      if (r.status === 0 && r.stdout?.trim()) {
        candidates.push(join(r.stdout.trim(), '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js'));
      }
    }
  } catch {
    // ignore
  }

  for (const c of candidates) {
    try {
      const abs = resolve(c);
      if (existsSync(abs) && abs.endsWith('qmd.js')) return abs;
      // allow pointing at package root
      const asCli = join(abs, 'dist', 'cli', 'qmd.js');
      if (existsSync(asCli)) return asCli;
    } catch {
      // continue
    }
  }
  return null;
}

export function resolveQmd(
  paths: QmdPaths,
  opts?: { allowGlobal?: boolean; detectGlobal?: () => string | null },
): QmdResolve {
  const envBin = process.env.IRIS_QMD_BIN || process.env.QMD_BIN;
  if (envBin) {
    const abs = resolve(envBin);
    const qmdJs = existsSync(abs)
      ? abs.endsWith('qmd.js')
        ? abs
        : existsSync(join(abs, 'dist', 'cli', 'qmd.js'))
          ? join(abs, 'dist', 'cli', 'qmd.js')
          : null
      : null;
    if (qmdJs) {
      const rt = resolveJsRuntime();
      return {
        kind: 'env',
        qmdJs,
        nodeBin: rt?.bin ?? null,
        pin: readManifest(paths)?.pin,
      };
    }
  }

  const managed = managedQmdJs(paths.runtimeDir);
  if (existsSync(managed)) {
    const rt = resolveJsRuntime();
    return {
      kind: 'managed',
      qmdJs: managed,
      nodeBin: rt?.bin ?? null,
      pin: readManifest(paths)?.pin ?? QMD_PIN,
    };
  }

  const allowGlobal =
    opts?.allowGlobal !== false && process.env.IRIS_QMD_NO_GLOBAL !== '1';
  if (allowGlobal) {
    const globalJs = (opts?.detectGlobal ?? detectGlobalQmdJs)();
    if (globalJs) {
      const rt = resolveJsRuntime();
      return {
        kind: 'global',
        qmdJs: globalJs,
        nodeBin: rt?.bin ?? null,
        reason: 'using-global-escape-hatch',
      };
    }
  }

  const rt = resolveJsRuntime();
  return {
    kind: 'missing',
    qmdJs: null,
    nodeBin: rt?.bin ?? null,
    reason: rt
      ? 'qmd runtime not installed — run iris qmd setup'
      : 'node (>=22) or bun required on PATH for qmd',
  };
}

// ── manifest ─────────────────────────────────────────────────────────────────

export function readManifest(paths: QmdPaths): QmdManifest | null {
  try {
    if (!existsSync(paths.manifestPath)) return null;
    const j = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as QmdManifest;
    if (!j || typeof j.pin !== 'string') return null;
    return j;
  } catch {
    return null;
  }
}

export function writeManifest(paths: QmdPaths, m: QmdManifest): void {
  mkdirSync(paths.instrumentHome, { recursive: true });
  writeFileSync(paths.manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

// ── models ───────────────────────────────────────────────────────────────────

export function modelsPresent(paths: QmdPaths): {
  embedding: boolean;
  rerank: boolean;
  expansion: boolean;
} {
  // qmd may also cache under ~/.cache/qmd/models when XDG not set historically
  const dirs = [
    paths.modelsDir,
    join(xdgCacheHomeForInstrument(paths.instrumentHome), 'qmd', 'models'),
    join(homedir(), '.cache', 'qmd', 'models'),
  ];
  const has = (file: string): boolean => {
    for (const d of dirs) {
      try {
        if (existsSync(join(d, file))) return true;
      } catch {
        // continue
      }
    }
    return false;
  };
  return {
    embedding: has(QMD_MODELS[0].file),
    rerank: has(QMD_MODELS[1].file),
    expansion: has(QMD_MODELS[2].file),
  };
}

export function allHybridModelsPresent(paths: QmdPaths): boolean {
  const m = modelsPresent(paths);
  return m.embedding && m.rerank && m.expansion;
}

// ── config bootstrap ─────────────────────────────────────────────────────────

/** Build house index.yml body for the six org collections. */
export function buildIndexYml(orgRoot: string): string {
  const root = resolve(orgRoot).replace(/\\/g, '/');
  const lines: string[] = ['collections:'];
  for (const c of ORG_COLLECTIONS) {
    const p = join(orgRoot, c.rel).replace(/\\/g, '/');
    lines.push(`  ${c.name}:`);
    lines.push(`    path: ${JSON.stringify(p)}`);
    lines.push(`    pattern: "**/*.md"`);
    lines.push(`    context:`);
    lines.push(`      "/": ${JSON.stringify(c.context)}`);
  }
  lines.push(`# house-root: ${root}`);
  lines.push('');
  return lines.join('\n');
}

export function ensureHouseLayout(paths: QmdPaths): void {
  mkdirSync(paths.houseDir, { recursive: true });
  mkdirSync(paths.modelsDir, { recursive: true });
  mkdirSync(paths.runtimeDir, { recursive: true });
  if (!existsSync(paths.configYml)) {
    writeFileSync(paths.configYml, buildIndexYml(paths.orgRoot), 'utf8');
  }
}

// ── default spawn ────────────────────────────────────────────────────────────

export async function defaultQmdRunner(
  argv: string[],
  opts: QmdRunOpts & { env: NodeJS.ProcessEnv; allowGlobal?: boolean },
): Promise<QmdSpawnResult> {
  const paths = resolveQmdPaths(opts.orgRoot, {
    instrumentHome: opts.instrumentHome,
    houseId: opts.houseId,
  });
  const resolved = resolveQmd(paths, { allowGlobal: opts.allowGlobal });
  if (!resolved.qmdJs || !resolved.nodeBin) {
    return {
      code: 69,
      stdout: '',
      stderr: resolved.reason ?? 'qmd runtime not available',
    };
  }
  const timeoutMs = opts.timeoutMs ?? 600_000;
  return new Promise((resolvePromise) => {
    const child = nodeSpawn(resolved.nodeBin!, [resolved.qmdJs!, ...argv], {
      env: opts.env,
      cwd: opts.cwd ?? paths.orgRoot,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolvePromise({ code: 124, stdout, stderr: stderr + '\n[qmd timeout]' });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 2, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Resolve npm's JS entry beside the node binary.
 * Standard layout: <dir of node>/node_modules/npm/bin/npm-cli.js
 * (Windows Program Files nodejs install and typical unix node trees).
 * Also try ../lib/node_modules (prefix layout on some unix installs).
 */
export function resolveNpmCliJs(nodeBin: string): string | null {
  if (!nodeBin) return null;
  const dir = dirname(resolve(nodeBin));
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return resolve(c);
    } catch {
      // continue
    }
  }
  return null;
}

/** Quote one argv token for cmd.exe /c (double quotes doubled). */
export function quoteCmdArg(s: string): string {
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export type NpmInstallSpawnKind = 'node-cli' | 'cmd-shell' | 'npm-direct' | 'bun' | 'missing';

export interface NpmInstallSpawnPlan {
  kind: NpmInstallSpawnKind;
  command: string;
  args: string[];
}

/**
 * Pure spawn plan for managed npm install.
 * Prefer node + absolute npm-cli.js (never trust Windows npm.cmd without a shell).
 * When npm-cli.js is absent: shell-safe .cmd on win32, direct spawn elsewhere.
 * Last tool fallback: bun add.
 */
export function planNpmInstallSpawn(opts: {
  prefix: string;
  packageSpec: string;
  nodeBin: string;
  npmBin: string | null;
  /** Override resolution (tests). Pass null to force missing. */
  npmCliJs?: string | null;
  bunBin?: string | null;
  platform?: NodeJS.Platform;
}): NpmInstallSpawnPlan {
  const installArgs = ['install', '--prefix', opts.prefix, opts.packageSpec, '--no-fund', '--no-audit'];
  const npmCli =
    opts.npmCliJs !== undefined ? opts.npmCliJs : resolveNpmCliJs(opts.nodeBin);

  if (npmCli) {
    return {
      kind: 'node-cli',
      command: opts.nodeBin,
      args: [npmCli, ...installArgs],
    };
  }

  if (opts.npmBin) {
    const platform = opts.platform ?? process.platform;
    const isWinShim =
      platform === 'win32' || /\.(cmd|bat)$/i.test(opts.npmBin);
    if (isWinShim) {
      // Node 20.12+/22 refuses spawn(.cmd) without a shell (EINVAL).
      // Fixed argv + local prefix: cmd.exe /d /s /c with quoted tokens.
      const line = [quoteCmdArg(opts.npmBin), ...installArgs.map(quoteCmdArg)].join(' ');
      const comspec =
        process.env.ComSpec && process.env.ComSpec.length > 0
          ? process.env.ComSpec
          : 'cmd.exe';
      return {
        kind: 'cmd-shell',
        command: comspec,
        args: ['/d', '/s', '/c', line],
      };
    }
    return {
      kind: 'npm-direct',
      command: opts.npmBin,
      args: installArgs,
    };
  }

  const bun =
    opts.bunBin !== undefined
      ? opts.bunBin
      : whichOnPath('bun');
  if (bun) {
    return {
      kind: 'bun',
      command: bun,
      args: ['add', opts.packageSpec, '--cwd', opts.prefix],
    };
  }

  return { kind: 'missing', command: '', args: [] };
}

function runSpawnPlan(
  plan: NpmInstallSpawnPlan,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  if (plan.kind === 'missing' || !plan.command) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: 'npm or bun required to install the managed qmd package',
      code: 69,
    });
  }
  return new Promise((resolvePromise) => {
    const child = nodeSpawn(plan.command, plan.args, {
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      resolvePromise({ ok: false, stdout, stderr: String(err), code: 2 });
    });
    child.on('close', (code) => {
      resolvePromise({
        ok: code === 0,
        stdout,
        stderr,
        code: code ?? 1,
      });
    });
  });
}

/**
 * Install pinned qmd into runtime prefix.
 * Primary: node <abs>/npm-cli.js install … (Windows-safe; no .cmd spawn).
 * Fallback: shell-safe npm.cmd, then bun, then fail (caller may use global qmd).
 */
export const defaultNpmInstaller: NpmInstaller = async ({
  prefix,
  packageSpec,
  npmBin,
  nodeBin,
}) => {
  mkdirSync(prefix, { recursive: true });
  const plan = planNpmInstallSpawn({
    prefix,
    packageSpec,
    nodeBin,
    npmBin,
  });
  return runSpawnPlan(plan);
};

// ── high-level ops ───────────────────────────────────────────────────────────

export interface QmdDeps {
  runner?: QmdRunner;
  npmInstall?: NpmInstaller;
  instrumentHome?: string;
  now?: () => number;
  log?: (line: string) => void;
  /** When false, skip global-install detection (tests). Default true. */
  allowGlobal?: boolean;
  /** Override global detection (tests). */
  detectGlobal?: () => string | null;
}

function logLine(deps: QmdDeps, line: string): void {
  (deps.log ?? ((s: string) => process.stderr.write(s + '\n')))(line);
}

export async function runQmd(
  argv: string[],
  orgRoot: string,
  deps: QmdDeps = {},
  runOpts: Partial<QmdRunOpts> = {},
): Promise<QmdSpawnResult> {
  const paths = resolveQmdPaths(orgRoot, {
    instrumentHome: deps.instrumentHome ?? runOpts.instrumentHome,
    houseId: runOpts.houseId,
  });
  const env = buildQmdEnv(paths, runOpts.env);
  const runner = deps.runner ?? defaultQmdRunner;
  return runner(argv, {
    orgRoot: paths.orgRoot,
    houseId: paths.houseId,
    instrumentHome: paths.instrumentHome,
    cwd: runOpts.cwd ?? paths.orgRoot,
    timeoutMs: runOpts.timeoutMs,
    env,
    allowGlobal: deps.allowGlobal,
  });
}

export interface SetupOptions {
  noModels?: boolean;
  useGlobal?: boolean;
  onProgress?: (line: string) => void;
}

export interface SetupResult {
  ok: boolean;
  code: number;
  pin: string;
  houseId: string;
  resolveKind: QmdResolve['kind'];
  qmdJs: string | null;
  collections: string[];
  models: ReturnType<typeof modelsPresent>;
  steps: string[];
  error?: string;
}

export async function qmdSetup(
  orgRoot: string,
  opts: SetupOptions = {},
  deps: QmdDeps = {},
): Promise<SetupResult> {
  const paths = resolveQmdPaths(orgRoot, { instrumentHome: deps.instrumentHome });
  const steps: string[] = [];
  const progress = (line: string) => {
    steps.push(line);
    (opts.onProgress ?? ((s) => logLine(deps, s)))(line);
  };

  const rt = resolveJsRuntime();
  if (!rt) {
    return {
      ok: false,
      code: 69,
      pin: QMD_PIN,
      houseId: paths.houseId,
      resolveKind: 'missing',
      qmdJs: null,
      collections: [],
      models: modelsPresent(paths),
      steps,
      error: 'node (>=22) or bun required on PATH for qmd setup',
    };
  }

  ensureHouseLayout(paths);
  // Always rewrite collections to current house root (paths can move).
  writeFileSync(paths.configYml, buildIndexYml(paths.orgRoot), 'utf8');
  steps.push(`wrote collections config → ${paths.configYml}`);

  const preferGlobal = opts.useGlobal === true;
  const allowGlobal = deps.allowGlobal !== false;
  const findGlobal = deps.detectGlobal ?? detectGlobalQmdJs;
  let resolved = resolveQmd(paths, {
    allowGlobal: allowGlobal && preferGlobal,
    detectGlobal: findGlobal,
  });

  // Prefer managed pin. Use global only with --use-global, or as escape after npm fails.
  if (preferGlobal && allowGlobal) {
    const g = findGlobal();
    if (g) {
      writeManifest(paths, {
        pin: 'global',
        package: QMD_PACKAGE,
        installedAt: new Date().toISOString(),
        source: 'global',
        qmdJs: g,
      });
      progress(`using global qmd at ${g}`);
      resolved = resolveQmd(paths, { allowGlobal: true, detectGlobal: findGlobal });
    }
  }

  if (resolved.kind !== 'managed' && resolved.kind !== 'env' && !preferGlobal) {
    if (!existsSync(managedQmdJs(paths.runtimeDir))) {
      progress(`installing ${QMD_PACKAGE}@${QMD_PIN} into ${paths.runtimeDir}`);
      const npmBin = whichOnPath('npm');
      const installer = deps.npmInstall ?? defaultNpmInstaller;
      const inst = await installer({
        prefix: paths.runtimeDir,
        packageSpec: `${QMD_PACKAGE}@${QMD_PIN}`,
        nodeBin: rt.bin,
        npmBin,
      });
      if (!inst.ok) {
        const g = allowGlobal ? findGlobal() : null;
        if (g) {
          writeManifest(paths, {
            pin: 'global',
            package: QMD_PACKAGE,
            installedAt: new Date().toISOString(),
            source: 'global',
            qmdJs: g,
          });
          progress(`npm install failed; using global qmd at ${g}`);
        } else {
          return {
            ok: false,
            code: inst.code || 2,
            pin: QMD_PIN,
            houseId: paths.houseId,
            resolveKind: 'missing',
            qmdJs: null,
            collections: ORG_COLLECTIONS.map((c) => c.name),
            models: modelsPresent(paths),
            steps,
            error: inst.stderr || inst.stdout || 'npm install failed',
          };
        }
      } else {
        writeManifest(paths, {
          pin: QMD_PIN,
          package: QMD_PACKAGE,
          installedAt: new Date().toISOString(),
          source: 'npm',
          qmdJs: managedQmdJs(paths.runtimeDir),
        });
        progress(`installed ${QMD_PACKAGE}@${QMD_PIN}`);
      }
    } else {
      writeManifest(paths, {
        pin: QMD_PIN,
        package: QMD_PACKAGE,
        installedAt: new Date().toISOString(),
        source: 'npm',
        qmdJs: managedQmdJs(paths.runtimeDir),
      });
    }
    resolved = resolveQmd(paths, { allowGlobal, detectGlobal: findGlobal });
  }

  if (!resolved.qmdJs || !resolved.nodeBin) {
    return {
      ok: false,
      code: 69,
      pin: QMD_PIN,
      houseId: paths.houseId,
      resolveKind: resolved.kind,
      qmdJs: null,
      collections: ORG_COLLECTIONS.map((c) => c.name),
      models: modelsPresent(paths),
      steps,
      error: resolved.reason ?? 'qmd runtime not available',
    };
  }

  // First index
  progress('running qmd update (first index)…');
  const upd = await runQmd(['update'], orgRoot, deps);
  steps.push(`qmd update exit=${upd.code}`);
  if (upd.code !== 0) {
    return {
      ok: false,
      code: upd.code,
      pin: readManifest(paths)?.pin ?? QMD_PIN,
      houseId: paths.houseId,
      resolveKind: resolved.kind,
      qmdJs: resolved.qmdJs,
      collections: ORG_COLLECTIONS.map((c) => c.name),
      models: modelsPresent(paths),
      steps,
      error: upd.stderr || upd.stdout || 'qmd update failed',
    };
  }

  if (!opts.noModels) {
    for (const m of QMD_MODELS) {
      progress(`model ${m.role}: ${m.file} (~${m.sizeLabel}) from ${m.host}`);
    }
    progress('running qmd embed (embedding model)…');
    const emb = await runQmd(['embed'], orgRoot, deps, { timeoutMs: 1_800_000 });
    steps.push(`qmd embed exit=${emb.code}`);
    // Hybrid warmup pulls expansion + rerank on first query
    progress('running hybrid warmup query (expansion + rerank models)…');
    const warm = await runQmd(
      ['query', 'house orientation', '-n', '1', '--json'],
      orgRoot,
      deps,
      { timeoutMs: 1_800_000 },
    );
    steps.push(`qmd query warmup exit=${warm.code}`);
  } else {
    progress('skipping model downloads (--no-models)');
  }

  const models = modelsPresent(paths);
  return {
    ok: true,
    code: 0,
    pin: readManifest(paths)?.pin ?? QMD_PIN,
    houseId: paths.houseId,
    resolveKind: resolveQmd(paths).kind,
    qmdJs: resolveQmd(paths).qmdJs,
    collections: ORG_COLLECTIONS.map((c) => c.name),
    models,
    steps,
  };
}

export async function qmdUpdate(
  orgRoot: string,
  opts: { embed?: boolean } = {},
  deps: QmdDeps = {},
): Promise<{
  ok: boolean;
  code: number;
  error?: string;
  update?: QmdSpawnResult;
  embed?: QmdSpawnResult;
  embedSkipped?: string;
}> {
  const paths = resolveQmdPaths(orgRoot, { instrumentHome: deps.instrumentHome });
  if (!existsSync(paths.configYml)) {
    return {
      ok: false,
      code: 69,
      error: 'house index not bootstrapped — run iris qmd setup',
    };
  }
  const resolved = resolveQmd(paths, {
    allowGlobal: deps.allowGlobal,
    detectGlobal: deps.detectGlobal,
  });
  if (!resolved.qmdJs) {
    return {
      ok: false,
      code: 69,
      error: resolved.reason ?? 'qmd not set up for this house — run iris qmd setup',
    };
  }
  const update = await runQmd(['update'], orgRoot, deps);
  if (update.code !== 0) {
    return {
      ok: false,
      code: update.code,
      error: update.stderr || update.stdout || 'qmd update failed',
      update,
    };
  }
  if (opts.embed) {
    const m = modelsPresent(paths);
    if (!m.embedding) {
      return {
        ok: true,
        code: 0,
        update,
        embedSkipped: 'embedding model not present — run iris qmd setup without --no-models',
      };
    }
    const embed = await runQmd(['embed'], orgRoot, deps, { timeoutMs: 1_800_000 });
    if (embed.code !== 0) {
      return {
        ok: false,
        code: embed.code,
        error: embed.stderr || embed.stdout || 'qmd embed failed',
        update,
        embed,
      };
    }
    return { ok: true, code: 0, update, embed };
  }
  return { ok: true, code: 0, update };
}

function parseStatusText(stdout: string): { docs?: number; vectors?: number; pending?: number } {
  const docs = /Total:\s+(\d+)/i.exec(stdout);
  const vectors = /Vectors:\s+(\d+)/i.exec(stdout);
  const pending = /Pending:\s+(\d+)/i.exec(stdout);
  return {
    docs: docs ? Number(docs[1]) : undefined,
    vectors: vectors ? Number(vectors[1]) : undefined,
    pending: pending ? Number(pending[1]) : undefined,
  };
}

export async function qmdStatus(
  orgRoot: string,
  deps: QmdDeps = {},
  refresh?: QmdRefreshController | null,
): Promise<QmdStatusBlock & Record<string, unknown>> {
  const paths = resolveQmdPaths(orgRoot, { instrumentHome: deps.instrumentHome });
  const resolveOpts = {
    allowGlobal: deps.allowGlobal,
    detectGlobal: deps.detectGlobal,
  };
  const resolved = resolveQmd(paths, resolveOpts);
  const models = modelsPresent(paths);
  const refreshSnap = refresh?.snapshot() ?? {
    lastRefreshAt: null,
    pendingChanges: 0,
    running: false,
    lastError: null,
  };

  if (!existsSync(paths.configYml) && !existsSync(paths.indexSqlite)) {
    return {
      state: 'not-installed',
      available: false,
      reason: resolved.qmdJs
        ? 'house index not bootstrapped — run iris qmd setup'
        : (resolved.reason ?? 'not-installed'),
      pin: QMD_PIN,
      resolveKind: resolved.kind,
      houseId: paths.houseId,
      models,
      lastRefreshAt: refreshSnap.lastRefreshAt,
      pendingChanges: refreshSnap.pendingChanges,
      refreshRunning: refreshSnap.running,
      lastRefreshError: refreshSnap.lastError,
      runtimePath: resolved.qmdJs,
      indexPath: null,
    };
  }

  if (!resolved.qmdJs) {
    return {
      state: 'not-installed',
      available: false,
      reason: resolved.reason ?? 'not-installed',
      pin: QMD_PIN,
      resolveKind: resolved.kind,
      houseId: paths.houseId,
      models,
      lastRefreshAt: refreshSnap.lastRefreshAt,
      pendingChanges: refreshSnap.pendingChanges,
      refreshRunning: refreshSnap.running,
      lastRefreshError: refreshSnap.lastError,
      runtimePath: null,
      indexPath: existsSync(paths.indexSqlite) ? paths.indexSqlite : null,
    };
  }

  if (refreshSnap.running) {
    return {
      state: 'embedding',
      available: true,
      pin: readManifest(paths)?.pin ?? QMD_PIN,
      resolveKind: resolved.kind,
      houseId: paths.houseId,
      models,
      lastRefreshAt: refreshSnap.lastRefreshAt,
      pendingChanges: refreshSnap.pendingChanges,
      refreshRunning: true,
      lastRefreshError: refreshSnap.lastError,
      runtimePath: resolved.qmdJs,
      indexPath: paths.indexSqlite,
    };
  }

  const st = await runQmd(['status'], orgRoot, deps, { timeoutMs: 30_000 });
  const counts = parseStatusText(st.stdout);
  if (st.code !== 0 && !counts.docs) {
    return {
      state: 'error',
      available: false,
      reason: st.stderr || st.stdout || 'qmd status failed',
      pin: readManifest(paths)?.pin ?? QMD_PIN,
      resolveKind: resolved.kind,
      houseId: paths.houseId,
      models,
      lastRefreshAt: refreshSnap.lastRefreshAt,
      pendingChanges: refreshSnap.pendingChanges,
      refreshRunning: false,
      lastRefreshError: refreshSnap.lastError,
      runtimePath: resolved.qmdJs,
      indexPath: paths.indexSqlite,
    };
  }

  const semantic = models.embedding; // vec needs embed; hybrid needs all three
  const state: QmdState = semantic ? 'ready-semantic' : 'ready-lex';

  return {
    state,
    available: true,
    pin: QMD_PIN,
    resolvedPin: readManifest(paths)?.pin ?? resolved.pin,
    resolveKind: resolved.kind,
    houseId: paths.houseId,
    docs: counts.docs,
    vectors: counts.vectors,
    pending: counts.pending,
    models,
    lastRefreshAt: refreshSnap.lastRefreshAt,
    pendingChanges: refreshSnap.pendingChanges,
    refreshRunning: false,
    lastRefreshError: refreshSnap.lastError,
    runtimePath: resolved.qmdJs,
    indexPath: paths.indexSqlite,
  };
}

// ── search ───────────────────────────────────────────────────────────────────

function qmdCmdForMode(mode: QmdSearchMode): string {
  if (mode === 'lex') return 'search';
  if (mode === 'vec') return 'vsearch';
  return 'query';
}

/** Map qmd:// file URIs to org-relative forward-slash paths. */
export function mapQmdFileToOrgPath(file: string, orgRoot: string): string {
  let s = file.trim();
  if (s.startsWith('qmd://')) s = s.slice('qmd://'.length);
  s = s.replace(/\\/g, '/');
  const root = resolve(orgRoot).replace(/\\/g, '/');
  const rootLower = root.toLowerCase();
  // Absolute path after scheme
  if (/^[a-zA-Z]:\//.test(s) || s.startsWith('/')) {
    const abs = s;
    if (abs.toLowerCase().startsWith(rootLower + '/')) {
      return abs.slice(root.length + 1);
    }
    // strip drive and try to find collection segment
  }
  // collection/rel form
  for (const c of ORG_COLLECTIONS) {
    if (s === c.name || s.startsWith(c.name + '/')) {
      const rest = s === c.name ? '' : s.slice(c.name.length + 1);
      return rest ? `${c.rel}/${rest}` : c.rel;
    }
  }
  // path contains org section
  for (const c of ORG_COLLECTIONS) {
    const idx = s.toLowerCase().indexOf('/' + c.rel + '/');
    if (idx >= 0) return s.slice(idx + 1);
    if (s.toLowerCase().startsWith(c.rel + '/')) return s;
  }
  return s.replace(/^\/+/, '');
}

export function parseQmdSearchJson(
  stdout: string,
  orgRoot: string,
): QmdSearchHit[] {
  const text = stdout.trim();
  if (!text) return [];
  // Find JSON array in output (qmd may print logs before JSON)
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const items: QmdSearchHit[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const file = typeof r.file === 'string' ? r.file : typeof r.path === 'string' ? r.path : '';
    if (!file) continue;
    const path = mapQmdFileToOrgPath(file, orgRoot);
    const title =
      typeof r.title === 'string' && r.title
        ? r.title
        : path.split('/').pop() || path;
    const hit: QmdSearchHit = { path, title };
    if (typeof r.score === 'number') hit.score = r.score;
    if (typeof r.snippet === 'string' && r.snippet) hit.snippet = r.snippet;
    items.push(hit);
  }
  return items;
}

export async function qmdSearch(
  orgRoot: string,
  query: string,
  mode: QmdSearchMode,
  limit: number,
  deps: QmdDeps = {},
): Promise<QmdSearchResult> {
  const paths = resolveQmdPaths(orgRoot, { instrumentHome: deps.instrumentHome });
  if (!existsSync(paths.configYml) && !existsSync(paths.indexSqlite)) {
    return {
      available: false,
      reason: 'house index not bootstrapped — run iris qmd setup',
      backend: 'qmd',
      mode,
      query,
      items: [],
    };
  }
  const resolved = resolveQmd(paths, {
    allowGlobal: deps.allowGlobal,
    detectGlobal: deps.detectGlobal,
  });
  if (!resolved.qmdJs) {
    return {
      available: false,
      reason: resolved.reason ?? 'not-installed',
      backend: 'qmd',
      mode,
      query,
      items: [],
    };
  }

  if (mode === 'vec' || mode === 'query') {
    const m = modelsPresent(paths);
    if (mode === 'vec' && !m.embedding) {
      return {
        available: false,
        reason: 'embedding model not present — run iris qmd setup (without --no-models)',
        backend: 'qmd',
        mode,
        query,
        items: [],
      };
    }
    if (mode === 'query' && !allHybridModelsPresent(paths)) {
      // Still attempt: qmd may find models in default cache; if missing it will fail
      // Prefer honest preflight when none of our known paths have models
      if (!m.embedding && !m.rerank && !m.expansion) {
        return {
          available: false,
          reason: 'hybrid models not present — run iris qmd setup (without --no-models)',
          backend: 'qmd',
          mode,
          query,
          items: [],
        };
      }
    }
  }

  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
  const cmd = qmdCmdForMode(mode);
  const result = await runQmd([cmd, query, '--json', '-n', String(n)], orgRoot, deps, {
    timeoutMs: mode === 'query' ? 600_000 : 120_000,
  });
  if (result.code !== 0) {
    return {
      available: false,
      reason: (result.stderr || result.stdout || 'qmd search failed').trim().slice(0, 400),
      backend: 'qmd',
      mode,
      query,
      items: [],
    };
  }
  const items = parseQmdSearchJson(result.stdout, orgRoot);
  return {
    available: true,
    backend: 'qmd',
    mode,
    query,
    items,
  };
}

// ── automatic freshness ──────────────────────────────────────────────────────

export interface QmdRefreshSnapshot {
  lastRefreshAt: string | null;
  pendingChanges: number;
  running: boolean;
  lastError: string | null;
}

export interface QmdRefreshController {
  notifyChange(relPath?: string): void;
  snapshot(): QmdRefreshSnapshot;
  stop(): void;
  /** Test seam: force flush attempt. */
  flushForTest(): Promise<void>;
}

export interface RefreshOptions {
  debounceMs?: number;
  minIntervalMs?: number;
  /** Injectable timers for tests. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => number;
  /** When false, never call embed (default true when models present). */
  embedWhenReady?: boolean;
}

/**
 * Debounced, throttled, serialized qmd update (+ bounded embed when models exist).
 * Never triggers model downloads. Quiet at steady state (no log on noop).
 */
export function createQmdRefreshController(
  orgRoot: string,
  deps: QmdDeps = {},
  opts: RefreshOptions = {},
): QmdRefreshController {
  const debounceMs = opts.debounceMs ??
    (Number(process.env.IRIS_QMD_REFRESH_DEBOUNCE_MS) > 0
      ? Number(process.env.IRIS_QMD_REFRESH_DEBOUNCE_MS)
      : DEFAULT_REFRESH_DEBOUNCE_MS);
  const minIntervalMs = opts.minIntervalMs ??
    (Number(process.env.IRIS_QMD_REFRESH_MIN_INTERVAL_MS) > 0
      ? Number(process.env.IRIS_QMD_REFRESH_MIN_INTERVAL_MS)
      : DEFAULT_REFRESH_MIN_INTERVAL_MS);
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const now = opts.now ?? deps.now ?? Date.now;

  let pendingChanges = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastRefreshAt: string | null = null;
  let lastRefreshMs = 0;
  let lastError: string | null = null;
  let stopped = false;
  let queued = false;

  async function runOnce(): Promise<void> {
    if (stopped) return;
    const paths = resolveQmdPaths(orgRoot, { instrumentHome: deps.instrumentHome });
    const resolved = resolveQmd(paths, {
      allowGlobal: deps.allowGlobal,
      detectGlobal: deps.detectGlobal,
    });
    if (!resolved.qmdJs || !existsSync(paths.configYml)) {
      // Guard: never install or download from refresh
      pendingChanges = 0;
      return;
    }
    const elapsed = now() - lastRefreshMs;
    if (lastRefreshMs > 0 && elapsed < minIntervalMs) {
      // Re-arm after remaining floor
      const wait = minIntervalMs - elapsed;
      timer = setT(() => {
        timer = null;
        void flush();
      }, wait) as ReturnType<typeof setTimeout>;
      return;
    }

    running = true;
    const changeCount = pendingChanges;
    pendingChanges = 0;
    try {
      const embed = opts.embedWhenReady !== false && modelsPresent(paths).embedding;
      const r = await qmdUpdate(orgRoot, { embed }, deps);
      lastRefreshMs = now();
      lastRefreshAt = new Date(lastRefreshMs).toISOString();
      if (!r.ok) {
        lastError = r.error ?? 'refresh failed';
        // Quiet: only note in status, one log line
        logLine(deps, `[qmd] refresh failed (${changeCount} pending): ${lastError}`);
      } else {
        lastError = r.embedSkipped ? r.embedSkipped : null;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logLine(deps, `[qmd] refresh error: ${lastError}`);
    } finally {
      running = false;
      if (queued && !stopped) {
        queued = false;
        void flush();
      }
    }
  }

  async function flush(): Promise<void> {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    if (pendingChanges === 0 && lastRefreshMs > 0) return;
    await runOnce();
  }

  function schedule(): void {
    if (stopped) return;
    if (timer !== null) clearT(timer);
    timer = setT(() => {
      timer = null;
      void flush();
    }, debounceMs) as ReturnType<typeof setTimeout>;
  }

  return {
    notifyChange(_relPath?: string) {
      if (stopped) return;
      pendingChanges += 1;
      schedule();
    },
    snapshot() {
      return {
        lastRefreshAt,
        pendingChanges,
        running,
        lastError,
      };
    },
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
    async flushForTest() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      await flush();
    },
  };
}

/**
 * Own fs.watch with long debounce for qmd freshness. Independent of the iris
 * index watcher (which stays at sub-second debounce). Guarded: no-ops when
 * runtime/index missing.
 */
export function startQmdRefreshWatch(
  orgRoot: string,
  deps: QmdDeps = {},
  opts: RefreshOptions = {},
): QmdRefreshController & { stop(): void } {
  const controller = createQmdRefreshController(orgRoot, deps, opts);
  let watcher: { close(): void } | null = null;
  try {
    watcher = watch(orgRoot, { recursive: true }, (_event: string, filename: string | null) => {
      if (!filename) {
        controller.notifyChange();
        return;
      }
      const rel = String(filename).replace(/\\/g, '/');
      if (!rel.endsWith('.md')) return;
      // Only org sections we index
      if (!ORG_COLLECTIONS.some((c) => rel === c.rel || rel.startsWith(c.rel + '/'))) return;
      controller.notifyChange(rel);
    });
  } catch {
    // watch unavailable — controller still usable via notifyChange
  }
  const origStop = controller.stop.bind(controller);
  return {
    ...controller,
    stop() {
      origStop();
      try {
        watcher?.close();
      } catch {
        // ignore
      }
    },
  };
}

// ── module surface for DaemonDeps ────────────────────────────────────────────

export interface QmdModule {
  search(
    orgRoot: string,
    query: string,
    mode: QmdSearchMode,
    limit: number,
  ): Promise<QmdSearchResult>;
  status(orgRoot: string): Promise<QmdStatusBlock & Record<string, unknown>>;
  refresh: QmdRefreshController | null;
}

export function createQmdModule(
  deps: QmdDeps = {},
  refresh: QmdRefreshController | null = null,
): QmdModule {
  return {
    search: (orgRoot, query, mode, limit) => qmdSearch(orgRoot, query, mode, limit, deps),
    status: (orgRoot) => qmdStatus(orgRoot, deps, refresh),
    refresh,
  };
}

/** List house ids under instrument home (debug/doctor). */
export function listHouseIds(instrumentHome?: string): string[] {
  const home = qmdInstrumentHome(instrumentHome);
  const dir = join(home, 'houses');
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
