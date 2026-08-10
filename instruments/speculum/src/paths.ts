/**
 * Resolvable paths for sessions corpus and instrument data home.
 * All defaults stay under the local Amore home; env overrides exist for tests.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Primary Amore home (`~/.amore`), overridable via AMORE_HOME. */
export function amoreHome(): string {
  return process.env.AMORE_HOME?.trim() || join(homedir(), ".amore");
}

/**
 * Root of on-disk agent sessions:
 *   `~/.amore/sessions/<urlencoded-cwd>/<session-uuid>/`
 * Override with SPECULUM_SESSIONS_DIR for fixtures and tests.
 */
export function sessionsRoot(): string {
  return process.env.SPECULUM_SESSIONS_DIR?.trim() || join(amoreHome(), "sessions");
}

/**
 * Instrument data directory (sqlite store, audit log, lens reports):
 *   `~/.amore/instruments/speculum/`
 * Override with SPECULUM_HOME.
 */
export function instrumentHome(): string {
  return process.env.SPECULUM_HOME?.trim() || join(amoreHome(), "instruments", "speculum");
}

/** Default sqlite path under the instrument home. */
export function defaultDbPath(): string {
  return process.env.SPECULUM_DB?.trim() || join(instrumentHome(), "speculum.sqlite");
}

/**
 * Append-only lens audit log (JSONL). Every lens invocation appends one record.
 * Override with SPECULUM_AUDIT_PATH.
 */
export function defaultAuditPath(): string {
  return (
    process.env.SPECULUM_AUDIT_PATH?.trim() ||
    join(instrumentHome(), "lens-audit.jsonl")
  );
}

/**
 * Directory for dated lens markdown reports.
 * Override with SPECULUM_REPORTS_DIR.
 */
export function defaultReportsDir(): string {
  return (
    process.env.SPECULUM_REPORTS_DIR?.trim() ||
    join(instrumentHome(), "lens-reports")
  );
}

/**
 * Append-only forget audit log (JSONL). Sibling of the lens audit so purge
 * records do not pollute lens hygiene metrics.
 * Override with SPECULUM_FORGET_AUDIT_PATH.
 */
export function defaultForgetAuditPath(): string {
  return (
    process.env.SPECULUM_FORGET_AUDIT_PATH?.trim() ||
    join(instrumentHome(), "forget-audit.jsonl")
  );
}
