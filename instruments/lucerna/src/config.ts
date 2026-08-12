/**
 * Lucerna configuration  -  house root, enablement, budget caps, binary pins.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { readEnablementFile, resolveStartFlags } from "./enablement.ts";
import { houseRuntimeDir, userConfigDir } from "./paths.ts";
import {
  DAILY_ACTION_BUDGET,
  WEEKLY_EXPENSIVE_BUDGET,
  DEFAULT_DAILY_TOKEN_CEILING,
} from "./budget.ts";
import { resolveBudgetConfig, type ResolvedCharter } from "./charter.ts";
import { resolveAmoreBin } from "./engine/amore-headless.ts";
// Embed package.json so unstamped compiles and source runs ship a real version.
import packageJson from "../package.json";

/** Default auto-commit draft cooldown (decoupled from heartbeat). */
export const DEFAULT_AUTO_COMMIT_COOLDOWN_MS = 30 * 60 * 1000;

/** Process name printed by CLI status and version lines. */
export const PROCESS_NAME = "lucerna";

/**
 * Package version. Release builds inject via
 * `bun build --define:__COMPANION_VERSION__=…` (from GROK_VERSION);
 * otherwise package.json.
 */
declare const __COMPANION_VERSION__: string | undefined;

export const VERSION: string =
  (typeof __COMPANION_VERSION__ !== "undefined" && __COMPANION_VERSION__) ||
  (typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "0.0.0");

export interface LucernaConfig {
  houseRoot: string;
  runtimeDir: string;
  userConfigDir: string;
  intervalMs: number;
  dryRun: boolean;
  dreamsEnabled: boolean;
  autoCommitEnabled: boolean;
  /** true = dry-run (never commit). false only when autoCommitLive enablement is on. */
  autoCommitDryRun: boolean;
  amoreBin: string;
  processName: string;
  version: string;
  /** Optional model entry name for auto-commit (empty → harness default). */
  autoCommitModel: string;
  /** Optional model entry name for dreams (empty → harness default). */
  dreamModel: string;
  dailyActionCap: number;
  weeklyExpensiveCap: number;
  cycleCooldownMs: number;
  dailyTokenCeiling: number;
  /** Tokens held back from auto-commit. Optional so existing fixtures keep compiling. */
  dreamsReserveTokens?: number;
  /** Last resolved charter, held for the unit. */
  charter?: ResolvedCharter;
  /**
   * Minimum interval between auto-commit draft attempts (model calls).
   * Decoupled from the heartbeat tick; default 30 minutes.
   */
  autoCommitCooldownMs: number;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const STRICT_UINT_RE = /^\d+$/;

/**
 * Whole-string non-negative integer after trim. Sign, exponent, underscore,
 * empty, or trailing junk → shipped default (stderr warn).
 */
function parseEnvUint(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!STRICT_UINT_RE.test(trimmed)) {
    console.error(
      `[lucerna] ${name} is not a non-negative integer; using shipped default ${fallback}`,
    );
    return fallback;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    console.error(
      `[lucerna] ${name} is not a non-negative integer; using shipped default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

/** Walk up from a start path looking for AGENTS.md or .amore/ as house markers. */
export function findHouseRoot(start: string = process.cwd()): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(resolve(cur, "AGENTS.md")) ||
      existsSync(resolve(cur, ".amore")) ||
      existsSync(resolve(cur, "instruments"))
    ) {
      return cur;
    }
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function defaultHouseRoot(): string {
  return (
    process.env.LUCERNA_HOUSE_ROOT ??
    process.env.AMORE_HOUSE_ROOT ??
    findHouseRoot() ??
    process.cwd()
  );
}

export function loadConfig(args: string[] = process.argv.slice(2)): LucernaConfig {
  const houseRoot = resolve(
    getArg(args, "--house") ??
      getArg(args, "--org-root") ??
      defaultHouseRoot(),
  );
  const runtimeDir = houseRuntimeDir(houseRoot);
  if (!existsSync(runtimeDir)) {
    mkdirSync(runtimeDir, { recursive: true });
  }

  const { enablement, error: enError } = readEnablementFile(runtimeDir);
  if (enError) {
    console.error(`[lucerna] ${enError} (using safe defaults: both false)`);
  }

  const flags = resolveStartFlags({
    enablement,
    envDreams: process.env.LUCERNA_DREAMS_ENABLED,
    envAutoCommitLive: process.env.LUCERNA_AUTO_COMMIT_LIVE,
    args,
  });

  const intervalSec = parseInt(getArg(args, "--interval") ?? "8", 10);
  const dryRun = args.includes("--dry-run");
  const autoCommitEnabled =
    !args.includes("--no-auto-commit") && process.env.LUCERNA_AUTO_COMMIT !== "0";

  const modelFlag = getArg(args, "--model");
  const autoCommitModel =
    modelFlag ??
    process.env.LUCERNA_AUTO_COMMIT_MODEL ??
    process.env.LUCERNA_MODEL ??
    "";
  const dreamModel =
    getArg(args, "--dream-model") ??
    process.env.LUCERNA_DREAM_MODEL ??
    process.env.LUCERNA_MODEL ??
    "";

  const charter = resolveBudgetConfig({
    houseRoot,
    env: process.env,
    args,
  });
  for (const w of [...charter.budgets.warnings, ...charter.roster.warnings]) {
    console.error(`[lucerna] ${w}`);
  }

  // Keep parseEnvUint on the integer envs so 1e9 / 200_000 still warn + shipped.
  parseEnvUint(
    process.env.LUCERNA_DAILY_ACTION_CAP,
    DAILY_ACTION_BUDGET,
    "LUCERNA_DAILY_ACTION_CAP",
  );
  parseEnvUint(
    process.env.LUCERNA_WEEKLY_EXPENSIVE_CAP,
    WEEKLY_EXPENSIVE_BUDGET,
    "LUCERNA_WEEKLY_EXPENSIVE_CAP",
  );
  parseEnvUint(
    process.env.LUCERNA_DAILY_TOKEN_CEILING,
    DEFAULT_DAILY_TOKEN_CEILING,
    "LUCERNA_DAILY_TOKEN_CEILING",
  );

  const dailyActionCap = charter.budgets.dailyActionCap.value;
  const weeklyExpensiveCap = charter.budgets.weeklyExpensiveCap.value;
  const dailyTokenCeiling = charter.budgets.dailyTokenCeiling.value;
  const dreamsReserveTokens = charter.budgets.dreamsReserveTokens.value;
  const cycleCooldownMs = charter.budgets.cycleCooldownMs;
  const autoCommitCooldownMs = charter.budgets.autoCommitCooldownMs;

  // Optional user config dir ensure
  const ucd = userConfigDir();
  try {
    if (!existsSync(ucd)) mkdirSync(ucd, { recursive: true });
  } catch {
    /* ignore */
  }

  return {
    houseRoot,
    runtimeDir,
    userConfigDir: ucd,
    intervalMs: Math.max(1, intervalSec) * 1000,
    dryRun,
    dreamsEnabled: flags.dreamsEnabled,
    autoCommitEnabled,
    autoCommitDryRun: !flags.autoCommitLive,
    // Full chain: LUCERNA_AMORE_BIN → AMORE_BIN → amore on PATH
    amoreBin: resolveAmoreBin(),
    processName: PROCESS_NAME,
    version: VERSION,
    autoCommitModel,
    dreamModel,
    dailyActionCap,
    weeklyExpensiveCap,
    cycleCooldownMs,
    dailyTokenCeiling,
    dreamsReserveTokens,
    autoCommitCooldownMs,
    charter,
  };
}

/** Package version (embedded from package.json for source and compiled binary). */
export function packageVersion(): string {
  return VERSION;
}

/** One-line version string for CLI `--version` / `version`. */
export function formatVersionLine(): string {
  return `${PROCESS_NAME} ${packageVersion()}`;
}
