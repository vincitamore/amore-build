/**
 * House and path resolution for lucerna.
 *
 * Charter (operator intent) lives under: <house>/.amore/lucerna/
 * Runtime state lives under the house: <house>/instruments/lucerna/
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const INSTRUMENT_DIR_NAME = "lucerna";

/** Runtime basenames. enable / governanceUser are legacy names under the runtime dir. */
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
  notifications: "notifications.jsonl",
} as const;

/** Charter basenames under houseCharterDir. */
export const CHARTER_FILES = {
  enable: "enable.json",
  governanceUser: "governance.user.toml",
} as const;

/** House-local runtime directory for state, health, logs, sentinels. */
export function houseRuntimeDir(houseRoot: string): string {
  return resolve(houseRoot, "instruments", INSTRUMENT_DIR_NAME);
}

/** House-local charter directory: what the daemon may do. */
export function houseCharterDir(houseRoot: string): string {
  return resolve(houseRoot, ".amore", INSTRUMENT_DIR_NAME);
}

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

/** Charter enablement path (new location). */
export function enablementPath(houseRoot: string): string {
  return join(houseCharterDir(houseRoot), CHARTER_FILES.enable);
}

/** Charter user-governance path (new location). */
export function governanceUserPath(houseRoot: string): string {
  return join(houseCharterDir(houseRoot), CHARTER_FILES.governanceUser);
}

export function legacyEnablementPath(houseRoot: string): string {
  return join(houseRuntimeDir(houseRoot), RUNTIME_FILES.enable);
}

export function legacyGovernanceUserPath(houseRoot: string): string {
  return join(houseRuntimeDir(houseRoot), RUNTIME_FILES.governanceUser);
}
