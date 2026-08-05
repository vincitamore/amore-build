/**
 * Lucerna configuration  -  house root, enablement, budget caps, binary pins.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readEnablementFile, resolveStartFlags } from "./enablement.ts";
import { houseRuntimeDir, userConfigDir } from "./paths.ts";
import {
  DAILY_ACTION_BUDGET,
  WEEKLY_EXPENSIVE_BUDGET,
  CYCLE_COOLDOWN_MS,
  DEFAULT_DAILY_TOKEN_CEILING,
} from "./budget.ts";
import { resolveAmoreBin } from "./engine/amore-headless.ts";

export const VERSION = "0.1.0";
export const PROCESS_NAME = "lucerna";

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
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
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

  const dailyActionCap = parseInt(
    process.env.LUCERNA_DAILY_ACTION_CAP ?? String(DAILY_ACTION_BUDGET),
    10,
  );
  const weeklyExpensiveCap = parseInt(
    process.env.LUCERNA_WEEKLY_EXPENSIVE_CAP ?? String(WEEKLY_EXPENSIVE_BUDGET),
    10,
  );
  const cycleCooldownHours = parseFloat(
    process.env.LUCERNA_CYCLE_COOLDOWN_HOURS ?? String(CYCLE_COOLDOWN_MS / 3_600_000),
  );
  const dailyTokenCeiling = parseInt(
    process.env.LUCERNA_DAILY_TOKEN_CEILING ?? String(DEFAULT_DAILY_TOKEN_CEILING),
    10,
  );

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
    amoreBin: resolveAmoreBin(process.env.LUCERNA_AMORE_BIN),
    processName: PROCESS_NAME,
    version: VERSION,
    autoCommitModel,
    dreamModel,
    dailyActionCap: Number.isFinite(dailyActionCap) ? dailyActionCap : DAILY_ACTION_BUDGET,
    weeklyExpensiveCap: Number.isFinite(weeklyExpensiveCap)
      ? weeklyExpensiveCap
      : WEEKLY_EXPENSIVE_BUDGET,
    cycleCooldownMs: Number.isFinite(cycleCooldownHours)
      ? Math.max(30 * 60 * 1000, cycleCooldownHours * 3_600_000)
      : CYCLE_COOLDOWN_MS,
    dailyTokenCeiling: Number.isFinite(dailyTokenCeiling)
      ? dailyTokenCeiling
      : DEFAULT_DAILY_TOKEN_CEILING,
  };
}

/** Read package version from package.json when available. */
export function packageVersion(fromDir: string = import.meta.dir): string {
  try {
    const pkgPath = resolve(fromDir, "..", "package.json");
    if (existsSync(pkgPath)) {
      const j = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      return j.version ?? VERSION;
    }
  } catch {
    /* ignore */
  }
  return VERSION;
}
