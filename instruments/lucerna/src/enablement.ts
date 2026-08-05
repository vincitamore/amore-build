/**
 * Durable standing enablement for lucerna dreams and live auto-commit.
 *
 * File: <house>/instruments/lucerna/lucerna.enable.json
 * Schema: { "dreamsEnabled": boolean, "autoCommitLive": boolean }
 * Absent or malformed file → both false (safe defaults).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_FILES } from "./paths.ts";

export const ENABLE_FILE_NAME = RUNTIME_FILES.enable;

export interface LucernaEnablement {
  /** Autonomous dream schedule (default OFF). */
  dreamsEnabled: boolean;
  /** Live git commit for auto-commit (default OFF → dry-run). */
  autoCommitLive: boolean;
}

export const DEFAULT_ENABLEMENT: LucernaEnablement = {
  dreamsEnabled: false,
  autoCommitLive: false,
};

/** Parse enablement JSON text. Invalid or empty → safe defaults (both false). */
export function parseEnablementJson(raw: string): LucernaEnablement {
  const out: LucernaEnablement = { ...DEFAULT_ENABLEMENT };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j && typeof j === "object") {
      if (j.dreamsEnabled === true) out.dreamsEnabled = true;
      if (j.autoCommitLive === true) out.autoCommitLive = true;
    }
  } catch {
    // malformed → safe defaults
  }
  return out;
}

/**
 * Read lucerna.enable.json under runtimeDir.
 * Absent → both false. Parse/IO errors → both false (caller may log).
 */
export function readEnablementFile(
  runtimeDir: string,
): { enablement: LucernaEnablement; error?: string } {
  const path = resolve(runtimeDir, ENABLE_FILE_NAME);
  if (!existsSync(path)) {
    return { enablement: { ...DEFAULT_ENABLEMENT } };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    try {
      JSON.parse(raw);
    } catch (e) {
      return {
        enablement: { ...DEFAULT_ENABLEMENT },
        error: `malformed enablement JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { enablement: parseEnablementJson(raw) };
  } catch (e) {
    return {
      enablement: { ...DEFAULT_ENABLEMENT },
      error: `enablement read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface StartFlagSources {
  enablement?: LucernaEnablement;
  envDreams?: string | undefined;
  envAutoCommitLive?: string | undefined;
  args?: string[];
}

export interface ResolvedStartFlags {
  dreamsEnabled: boolean;
  autoCommitLive: boolean;
  argvFlags: string[];
}

/**
 * Resolve dreams/LIVE enablement from durable file + env + argv.
 * Any truthy source turns the knob ON (OR). Defaults OFF when all absent.
 */
export function resolveStartFlags(sources: StartFlagSources = {}): ResolvedStartFlags {
  const en = sources.enablement ?? DEFAULT_ENABLEMENT;
  const args = sources.args ?? [];
  const dreamsEnabled =
    en.dreamsEnabled ||
    sources.envDreams === "1" ||
    args.includes("--dreams-enabled");
  const autoCommitLive =
    en.autoCommitLive ||
    sources.envAutoCommitLive === "1" ||
    args.includes("--auto-commit-live");

  const argvFlags: string[] = [];
  if (dreamsEnabled) argvFlags.push("--dreams-enabled");
  if (autoCommitLive) argvFlags.push("--auto-commit-live");

  return { dreamsEnabled, autoCommitLive, argvFlags };
}

export function enablementPath(runtimeDir: string): string {
  return resolve(runtimeDir, ENABLE_FILE_NAME);
}
