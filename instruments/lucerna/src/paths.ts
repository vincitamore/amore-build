/**
 * House and config path resolution for lucerna.
 *
 * Runtime state lives under the house: <house>/instruments/lucerna/
 * Durable instrument config lives under: ~/.amore/instruments/lucerna/
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const INSTRUMENT_DIR_NAME = "lucerna";

export const RUNTIME_FILES = {
  health: "health.json",
  state: "state.json",
  log: "log",
  halt: "halt",
  wake: "wake",
  sleep: "sleep",
  enable: "lucerna.enable.json",
  governanceUser: "governance.user.toml",
  pid: "daemon.pid",
} as const;

/** House-local runtime directory for state, health, logs, sentinels, enablement. */
export function houseRuntimeDir(houseRoot: string): string {
  return resolve(houseRoot, "instruments", INSTRUMENT_DIR_NAME);
}

/** User-level config directory under ~/.amore/instruments/lucerna/. */
export function userConfigDir(home: string = homedir()): string {
  return resolve(home, ".amore", "instruments", INSTRUMENT_DIR_NAME);
}

export function healthPath(runtimeDir: string): string {
  return join(runtimeDir, RUNTIME_FILES.health);
}

export function statePath(runtimeDir: string): string {
  return join(runtimeDir, RUNTIME_FILES.state);
}

export function logPath(runtimeDir: string): string {
  return join(runtimeDir, RUNTIME_FILES.log);
}

export function sentinelPath(
  runtimeDir: string,
  kind: "halt" | "wake" | "sleep",
): string {
  return join(runtimeDir, RUNTIME_FILES[kind]);
}

export function enablementPath(runtimeDir: string): string {
  return join(runtimeDir, RUNTIME_FILES.enable);
}

/** User governance additions: house-local next to runtime, or under house root. */
export function governanceUserPath(houseRoot: string): string {
  return join(houseRuntimeDir(houseRoot), RUNTIME_FILES.governanceUser);
}
