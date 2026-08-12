/**
 * Durable standing enablement for lucerna dreams and live auto-commit.
 *
 * File: <house>/.amore/lucerna/enable.json
 * Legacy (read-only): <house>/instruments/lucerna/lucerna.enable.json
 * Schema: { "dreamsEnabled": boolean, "autoCommitLive": boolean }
 * Absent or malformed file → both false (safe defaults).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RUNTIME_FILES,
  enablementPath as charterEnablementPath,
  legacyEnablementPath,
} from "./paths.ts";

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

export interface EnablementRead {
  enablement: LucernaEnablement;
  error?: string;
  /** True when the read used the legacy runtime path. */
  legacyLocation?: boolean;
}

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

function readEnablementAtPath(path: string): EnablementRead {
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

/**
 * Read enablement for a house. New charter path first; if absent and the
 * legacy runtime file exists, read that and set legacyLocation.
 * Absent → both false. Parse/IO errors → both false (caller may log).
 */
export function readEnablementForHouse(houseRoot: string): EnablementRead {
  const primary = charterEnablementPath(houseRoot);
  if (existsSync(primary)) {
    return readEnablementAtPath(primary);
  }
  const legacy = legacyEnablementPath(houseRoot);
  if (existsSync(legacy)) {
    return { ...readEnablementAtPath(legacy), legacyLocation: true };
  }
  return { enablement: { ...DEFAULT_ENABLEMENT } };
}

/**
 * Read enablement given the house runtime dir (`<house>/instruments/lucerna`).
 * House root is derived as the runtime dir's grandparent so existing callers
 * keep working. Prefer readEnablementForHouse when the house root is known.
 */
export function readEnablementFile(runtimeDir: string): EnablementRead {
  const houseRoot = resolve(runtimeDir, "..", "..");
  return readEnablementForHouse(houseRoot);
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

/** Charter enablement path (new location). */
export function enablementPath(houseRoot: string): string {
  return charterEnablementPath(houseRoot);
}
