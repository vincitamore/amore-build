// ─────────────────────────────────────────────────────────────────────────────
// pidfile.ts — iris daemon process identity on disk.
//
// Runtime dir is the iris instrument home (resolveIrisHome → ~/.amore/instruments/iris
// or $IRIS_HOME). Pidfile name is iris.pid. Mirrors lucerna's write/clear/read/alive
// quartet; filename and home placement follow iris conventions (not house-local —
// org trees often contain instruments/iris source).
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveIrisHome } from '@amore/regula';

export const PID_FILE_NAME = 'iris.pid';

/** Runtime directory for the iris daemon pidfile (instrument home). */
export function irisRuntimeDir(home?: string): string {
  return home ?? resolveIrisHome();
}

export function pidFilePath(runtimeDir: string): string {
  return join(runtimeDir, PID_FILE_NAME);
}

export function writePidFile(runtimeDir: string, pid: number): void {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(pidFilePath(runtimeDir), `${pid}\n`, 'utf-8');
}

export function clearPidFile(runtimeDir: string): void {
  const p = pidFilePath(runtimeDir);
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
  } catch {
    /* ignore races / already gone */
  }
}

export function readPidFile(runtimeDir: string): number | null {
  const p = pidFilePath(runtimeDir);
  if (!existsSync(p)) return null;
  try {
    const n = parseInt(readFileSync(p, 'utf-8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** True when `process.kill(pid, 0)` succeeds (pid exists and is signalable). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
