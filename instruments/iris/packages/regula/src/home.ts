// ─────────────────────────────────────────────────────────────────────────────
// home.ts — single resolution point for the iris instrument home.
//
// Default home: ~/.amore/instruments/iris/
// Override: IRIS_HOME (absolute or ~-relative path).
// Legacy: ~/.iris — migrated once automatically on first resolution after
// upgrade (copy + verify + markers; old home is never deleted here).
//
// Resolution order:
//   1. IRIS_HOME env
//   2. new home already present
//   3. legacy present → migrate, then new home (or legacy on failure)
//   4. create new home fresh
// ─────────────────────────────────────────────────────────────────────────────

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const IRIS_HOME_ENV = 'IRIS_HOME';
export const INSTRUMENT_NAME = 'iris';
export const LEGACY_DIR_NAME = '.iris';
export const MIGRATED_FROM_MARKER = 'migrated-from.json';
export const MOVED_POINTER = 'MOVED.md';
/** Exclusive lock file under ~/.amore/instruments/ during migration. */
export const MIGRATION_LOCK_NAME = '.iris-home-migration.lock';
/** Staging directory name next to the final instrument home. */
export const MIGRATION_STAGING_SUFFIX = '.migrating';

export type IrisHomeSource = 'env' | 'new' | 'migrated' | 'legacy-fallback' | 'fresh';

export interface IrisHomeOptions {
  /** Override process.env (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override os.homedir() — locates ~/.iris and ~/.amore (tests). */
  userHome?: string;
  /**
   * When true, never create directories or migrate; only compute the path that
   * would be chosen given current disk state. Used by pure path helpers.
   */
  readonly?: boolean;
  /** Injected logger (default: stderr). Tests capture messages. */
  log?: (line: string) => void;
}

export interface IrisHomeResolution {
  path: string;
  source: IrisHomeSource;
  /** Absolute path of the legacy home when it was considered. */
  legacyPath?: string;
  /** Absolute path of the default new home (ignoring IRIS_HOME). */
  defaultNewPath: string;
  migrated?: boolean;
  /** Set when migration was attempted and failed; path is legacy fallback. */
  migrationError?: string;
  /** Human-readable status note (migration success, fallback, etc.). */
  note?: string;
}

let cached: IrisHomeResolution | undefined;

/** Clear the process-level resolution cache (tests). */
export function resetIrisHomeCache(): void {
  cached = undefined;
}

/** Last resolution from a non-optioned resolveIrisHome call, if any. */
export function irisHomeStatus(): IrisHomeResolution | undefined {
  return cached;
}

/** Amore root: $AMORE_HOME or ~/.amore. */
export function amoreHome(userHome: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AMORE_HOME?.trim();
  if (override) return resolve(expandHome(override, userHome));
  return join(userHome, '.amore');
}

/** Default instrument home (no env override, no migration): ~/.amore/instruments/iris. */
export function defaultIrisHome(userHome: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return join(amoreHome(userHome, env), 'instruments', INSTRUMENT_NAME);
}

/** Legacy home path: ~/.iris. */
export function legacyIrisHome(userHome: string = homedir()): string {
  return join(userHome, LEGACY_DIR_NAME);
}

/**
 * Resolve the active iris instrument home. Caches the first unscoped call per
 * process so concurrent consumers share one migration attempt.
 */
export function resolveIrisHome(opts?: IrisHomeOptions): string {
  return resolveIrisHomeDetailed(opts).path;
}

export function resolveIrisHomeDetailed(opts?: IrisHomeOptions): IrisHomeResolution {
  if (!opts && cached) return cached;
  const result = doResolve(opts ?? {});
  if (!opts) cached = result;
  return result;
}

function defaultLog(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // ignore broken stderr
  }
}

function expandHome(p: string, userHome: string): string {
  if (p === '~') return userHome;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(userHome, p.slice(2));
  return p;
}

function dirExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function doResolve(opts: IrisHomeOptions): IrisHomeResolution {
  const env = opts.env ?? process.env;
  const userHome = opts.userHome ?? homedir();
  const log = opts.log ?? defaultLog;
  const readonly = opts.readonly === true;
  const defaultNewPath = defaultIrisHome(userHome, env);
  const legacyPath = legacyIrisHome(userHome);

  const envRaw = env[IRIS_HOME_ENV]?.trim();
  if (envRaw) {
    const path = resolve(expandHome(envRaw, userHome));
    if (!readonly) {
      try {
        mkdirSync(path, { recursive: true });
      } catch (e) {
        log(`[iris] IRIS_HOME is set but could not create ${path}: ${errMsg(e)}`);
      }
    }
    return {
      path,
      source: 'env',
      legacyPath,
      defaultNewPath,
      note: `using ${IRIS_HOME_ENV}=${path}`,
    };
  }

  if (dirExists(defaultNewPath)) {
    // Half-migrated staging left behind: re-verify / finish if legacy still there.
    if (!readonly) {
      const staging = defaultNewPath + MIGRATION_STAGING_SUFFIX;
      if (dirExists(staging) && dirExists(legacyPath)) {
        tryCompleteOrCleanStaging(legacyPath, defaultNewPath, staging, log);
      }
    }
    return {
      path: defaultNewPath,
      source: 'new',
      legacyPath,
      defaultNewPath,
      migrated: existsSync(join(defaultNewPath, MIGRATED_FROM_MARKER)),
      note: existsSync(join(defaultNewPath, MIGRATED_FROM_MARKER))
        ? 'using instrument home (already migrated from legacy)'
        : 'using instrument home',
    };
  }

  if (dirExists(legacyPath)) {
    if (readonly) {
      return {
        path: legacyPath,
        source: 'legacy-fallback',
        legacyPath,
        defaultNewPath,
        note: 'readonly: legacy present, migration not attempted',
      };
    }
    const mig = migrateLegacyHome(legacyPath, defaultNewPath, log);
    if (mig.ok) {
      return {
        path: defaultNewPath,
        source: 'migrated',
        legacyPath,
        defaultNewPath,
        migrated: true,
        note: mig.note,
      };
    }
    log(
      `[iris] home migration failed (${mig.error}); using legacy home ${legacyPath} for this run — fix permissions/disk and restart to retry; data stays in one place`,
    );
    return {
      path: legacyPath,
      source: 'legacy-fallback',
      legacyPath,
      defaultNewPath,
      migrated: false,
      migrationError: mig.error,
      note: `migration failed; legacy home in use: ${mig.error}`,
    };
  }

  if (!readonly) {
    try {
      mkdirSync(defaultNewPath, { recursive: true });
    } catch (e) {
      log(`[iris] could not create instrument home ${defaultNewPath}: ${errMsg(e)}`);
      // Last resort: try legacy path as writable location
      try {
        mkdirSync(legacyPath, { recursive: true });
        return {
          path: legacyPath,
          source: 'legacy-fallback',
          legacyPath,
          defaultNewPath,
          migrationError: errMsg(e),
          note: `could not create ${defaultNewPath}; fell back to legacy path`,
        };
      } catch {
        // return the intended path even if unwritable — callers mkdir best-effort
      }
    }
  }
  return {
    path: defaultNewPath,
    source: 'fresh',
    legacyPath,
    defaultNewPath,
    note: 'created fresh instrument home',
  };
}

interface MigrateResult {
  ok: boolean;
  error?: string;
  note?: string;
}

/**
 * Copy legacy → new home with verify + markers.
 *
 * Concurrent-start safety: exclusive create of
 * `~/.amore/instruments/.iris-home-migration.lock` (open wx). The loser waits
 * briefly for the winner's home to appear, then re-checks; it never interleaves
 * file copies. Staging directory `iris.migrating` receives the copy; only after
 * verify is it renamed into place. A leftover staging dir is re-verified or
 * discarded, never trusted as the live home.
 */
export function migrateLegacyHome(
  legacyPath: string,
  newPath: string,
  log: (line: string) => void = defaultLog,
): MigrateResult {
  if (dirExists(newPath) && existsSync(join(newPath, MIGRATED_FROM_MARKER))) {
    return { ok: true, note: 'already migrated' };
  }
  if (dirExists(newPath)) {
    // New home exists without marker (manual or partial) — do not overwrite.
    return { ok: true, note: 'instrument home already present' };
  }

  const instrumentsDir = dirname(newPath);
  const lockPath = join(instrumentsDir, MIGRATION_LOCK_NAME);
  const staging = newPath + MIGRATION_STAGING_SUFFIX;

  try {
    mkdirSync(instrumentsDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `cannot create instruments dir: ${errMsg(e)}` };
  }

  let lockFd: number | undefined;
  try {
    lockFd = openSync(lockPath, 'wx');
    writeFileSync(lockFd, `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`);
  } catch {
    // Another process holds the lock — wait for winner.
    const appeared = waitForDir(newPath, 40, 50);
    if (appeared) {
      return { ok: true, note: 'migration completed by concurrent process' };
    }
    // Winner may have fallen back to legacy; check again.
    if (dirExists(newPath)) {
      return { ok: true, note: 'instrument home appeared during wait' };
    }
    return {
      ok: false,
      error: 'migration lock held by another process and instrument home did not appear',
    };
  }

  try {
    // Double-check under lock.
    if (dirExists(newPath)) {
      return { ok: true, note: 'instrument home already present under lock' };
    }

    // Discard half-written staging from a prior crash.
    if (dirExists(staging)) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch (e) {
        return { ok: false, error: `cannot clear staging: ${errMsg(e)}` };
      }
    }

    mkdirSync(staging, { recursive: true });
    copyTree(legacyPath, staging, {
      // Do not re-copy a pointer from a previous attempt if someone recreated legacy content.
      skipNames: new Set([MOVED_POINTER, MIGRATION_LOCK_NAME]),
    });

    const srcStats = treeStats(legacyPath, { skipNames: new Set([MOVED_POINTER]) });
    const dstStats = treeStats(staging, {
      skipNames: new Set([MOVED_POINTER, MIGRATED_FROM_MARKER]),
    });
    if (srcStats.files !== dstStats.files || srcStats.bytes !== dstStats.bytes) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        error: `verify failed: source files=${srcStats.files} bytes=${srcStats.bytes}, staging files=${dstStats.files} bytes=${dstStats.bytes}`,
      };
    }

    const marker = {
      from: resolve(legacyPath),
      to: resolve(newPath),
      at: new Date().toISOString(),
      files: srcStats.files,
      bytes: srcStats.bytes,
    };
    writeFileSync(join(staging, MIGRATED_FROM_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');

    try {
      renameSync(staging, newPath);
    } catch (e) {
      // Windows: rename fails if target exists (race). Prefer existing target.
      if (dirExists(newPath)) {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        return { ok: true, note: 'instrument home created by concurrent process' };
      }
      return { ok: false, error: `rename staging to home failed: ${errMsg(e)}` };
    }

    // Pointer in the old home — never delete legacy contents.
    const pointer = [
      '# Iris home moved',
      '',
      'This directory is no longer the active iris state home.',
      '',
      `Active home: \`${newPath}\``,
      '',
      'Contents were copied on first run after the instrument-home layout change.',
      'This folder was intentionally left in place so nothing is destroyed during upgrade.',
      'You may remove it manually once you confirm the new home is correct.',
      '',
      `Migrated at: ${marker.at}`,
      `Files copied: ${marker.files}`,
      `Bytes copied: ${marker.bytes}`,
      '',
    ].join('\n');
    try {
      writeFileSync(join(legacyPath, MOVED_POINTER), pointer, 'utf-8');
    } catch (e) {
      // Migration of data succeeded; pointer is best-effort.
      log(`[iris] home migrated but could not write ${MOVED_POINTER} in legacy home: ${errMsg(e)}`);
    }

    log(
      `[iris] home migrated: ${legacyPath} → ${newPath} (${marker.files} files, ${marker.bytes} bytes); legacy left in place with ${MOVED_POINTER}`,
    );
    return {
      ok: true,
      note: `migrated ${marker.files} files (${marker.bytes} bytes) from ${legacyPath}`,
    };
  } catch (e) {
    try {
      if (dirExists(staging)) rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: errMsg(e) };
  } finally {
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch {
        /* ignore */
      }
    }
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

function tryCompleteOrCleanStaging(
  _legacyPath: string,
  newPath: string,
  staging: string,
  log: (line: string) => void,
): void {
  // Live home already exists; staging is leftover junk from a prior attempt.
  if (dirExists(newPath)) {
    try {
      rmSync(staging, { recursive: true, force: true });
      log(`[iris] removed leftover migration staging at ${staging}`);
    } catch {
      /* ignore */
    }
  }
}

function waitForDir(path: string, attempts: number, delayMs: number): boolean {
  for (let i = 0; i < attempts; i++) {
    if (dirExists(path)) return true;
    const end = Date.now() + delayMs;
    while (Date.now() < end) {
      /* spin briefly — avoid async sleep dependency in sync resolve path */
    }
  }
  return dirExists(path);
}

interface CopyOpts {
  skipNames?: Set<string>;
}

function copyTree(src: string, dst: string, opts: CopyOpts = {}): void {
  mkdirSync(dst, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    if (opts.skipNames?.has(ent.name)) continue;
    const from = join(src, ent.name);
    const to = join(dst, ent.name);
    if (ent.isDirectory()) {
      copyTree(from, to, opts);
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      copyFileSync(from, to);
    }
  }
}

interface TreeStats {
  files: number;
  bytes: number;
}

function treeStats(root: string, opts: CopyOpts = {}): TreeStats {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (opts.skipNames?.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        files += 1;
        try {
          bytes += statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return { files, bytes };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Display form of the default instrument home for user-facing messages
 * (tilde style, not an absolute path).
 */
export function irisHomeDisplay(): string {
  return `~/.amore/instruments/${INSTRUMENT_NAME}`;
}

/**
 * Display form for the allowed-roots file under the instrument home.
 */
export function allowedRootsDisplay(): string {
  return `${irisHomeDisplay()}/allowed-roots.json`;
}

/** Ensure the resolved home exists (mkdir). Returns the path. */
export function ensureIrisHome(opts?: IrisHomeOptions): string {
  const path = resolveIrisHome(opts);
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    /* callers often best-effort */
  }
  return path;
}

