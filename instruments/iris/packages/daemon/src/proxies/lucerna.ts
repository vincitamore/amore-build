// proxies/lucerna.ts — state-file proxy for the Lucerna agency runtime under
// <orgRoot>/instruments/lucerna/. Reads health/state/log/enablement/notifications;
// writes halt/wake/sleep sentinels; starts/stops the Lucerna process; sets
// enablement atomically (write-temp-rename).
//
// File map:
//   health.json            → readHealth (pid, startedAt, lastBeat, version)
//   state.json             → readStatus (activity, lastActions, budgets)
//   lucerna.enable.json    → enablement (dreamsEnabled, autoCommitLive; absent = both false)
//   log                    → readLog (plaintext tail)
//   notifications.jsonl    → readNotifications (append-only queue; absent = empty)
//   halt / wake / sleep    ← write sentinels
//
// Process control:
//   start  → resolve binary, spawn detached+unref in the house root, poll health
//   stop   → halt sentinel (bounded wait), escalate to pid kill only after verify
//
// Lucerna binary resolution order (start):
//   1. env IRIS_LUCERNA_BIN (absolute path to executable or entry script)
//   2. `lucerna` on PATH
//   3. `bun run` against instruments/lucerna in the house/repo layout
//      (src/cli.ts or package.json start)
//
// Absent runtime dir → available:false, reason:"not-installed".
//
// Heartbeat interval (seconds), first positive win:
//   env LUCERNA_HEARTBEAT_INTERVAL_SEC > health.heartbeatIntervalSec >
//   health.intervalMs / 1000 > default 60.
// Stale bound: max(120, intervalSec * 2.5). A beat past that bound is stale
// only when no work-in-progress window is open and the process is not
// known-dead. Dead pid is stopped, never stale.
// pidAlive is a signal-0 check on health.pid, else the integer in daemon.pid;
// the field is omitted when no pid is known.

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;
const STALE_MULTIPLIER = 2.5;
const STALE_FLOOR_SEC = 120;
const WIP_GRACE_MS = 60_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrU(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function numOrU(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function boolOr(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}

export function lucernaDir(orgRoot: string): string {
  return join(orgRoot, 'instruments', 'lucerna');
}

/** Whether the Lucerna runtime directory exists on disk. */
export function isInstalled(orgRoot: string): boolean {
  try {
    return existsSync(lucernaDir(orgRoot));
  } catch {
    return false;
  }
}

/**
 * Resolve heartbeat interval (seconds).
 * Priority: env LUCERNA_HEARTBEAT_INTERVAL_SEC > heartbeatIntervalSec >
 * intervalMs/1000 > default 60.
 */
export function resolveHeartbeatIntervalSec(
  heartbeatIntervalSec?: unknown,
  intervalMs?: unknown,
): number {
  const env = process.env.LUCERNA_HEARTBEAT_INTERVAL_SEC;
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromSec = numOrU(heartbeatIntervalSec);
  if (fromSec !== undefined && fromSec > 0) return fromSec;
  const fromMs = numOrU(intervalMs);
  if (fromMs !== undefined && fromMs > 0) return fromMs / 1000;
  return DEFAULT_HEARTBEAT_INTERVAL_SEC;
}

/** Stale bound in seconds: max(120, intervalSec * 2.5). */
export function resolveStaleBoundSec(intervalSec: number): number {
  return Math.max(STALE_FLOOR_SEC, intervalSec * STALE_MULTIPLIER);
}

/** Seconds since `ts`, or null if unparseable. Accepts RFC3339 and naive local. */
export function computeBeatAgeSec(ts: unknown, nowMs: number = Date.now()): number | null {
  if (typeof ts !== 'string' || !ts) return null;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    // Naive local "YYYY-MM-DDTHH:MM:SS"
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ts)) {
      const local = new Date(ts).getTime();
      if (!Number.isNaN(local)) return (nowMs - local) / 1000;
    }
    return null;
  }
  return (nowMs - ms) / 1000;
}

export function isStaleBeat(beatAgeSec: number | null, intervalSec: number): boolean {
  if (beatAgeSec === null) return true;
  return beatAgeSec > resolveStaleBoundSec(intervalSec);
}

/** True while writer's workInProgress window is open (wallMs + 60s grace). */
export function isWorkInProgressOpen(raw: unknown, nowMs: number = Date.now()): boolean {
  if (!isObj(raw)) return false;
  const wallMs = numOrU(raw.wallMs);
  if (wallMs === undefined || wallMs < 0) return false;
  let startedMs: number | null = null;
  if (typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt)) {
    startedMs = raw.startedAt;
  } else if (typeof raw.startedAt === 'string' && raw.startedAt) {
    const parsed = Date.parse(raw.startedAt);
    if (!Number.isNaN(parsed)) {
      startedMs = parsed;
    } else {
      const ageSec = computeBeatAgeSec(raw.startedAt, nowMs);
      if (ageSec !== null) startedMs = nowMs - ageSec * 1000;
    }
  }
  if (startedMs === null) return false;
  return nowMs - startedMs < wallMs + WIP_GRACE_MS;
}

function readDaemonPid(runtimeDir: string): number | undefined {
  try {
    const raw = readFileSync(join(runtimeDir, 'daemon.pid'), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* absent or unreadable */
  }
  return undefined;
}

function resolveRuntimePid(healthPid: unknown, runtimeDir: string): number | undefined {
  const fromHealth = numOrU(healthPid);
  if (fromHealth !== undefined && fromHealth > 0) return fromHealth;
  return readDaemonPid(runtimeDir);
}

// ── health ────────────────────────────────────────────────────────────────────

export interface LucernaHealthWire {
  available: boolean;
  reason?: string;
  stale?: boolean;
  pid?: number;
  startedAt?: string;
  lastBeat?: string;
  version?: string;
  beatAgeSec?: number | null;
  heartbeatIntervalSec?: number;
  staleBoundSec?: number;
  pidAlive?: boolean;
  phase?: string;
  bpm?: number;
  dreaming?: boolean;
  intervalMs?: number;
  stopped?: boolean;
  workInProgress?: boolean;
}

/** Optional probes for health reads. Call sites may omit; defaults are live. */
export interface LucernaHealthDeps {
  isPidAlive?: (pid: number) => boolean;
}

const NOT_INSTALLED = { available: false as const, reason: 'not-installed' as const };

function attachPid(
  wire: LucernaHealthWire,
  pid: number | undefined,
  isAlive: (pid: number) => boolean,
): LucernaHealthWire {
  if (pid === undefined) return wire;
  const pidAlive = isAlive(pid);
  return {
    ...wire,
    pid,
    pidAlive,
    stale: pidAlive === false ? false : wire.stale,
  };
}

export function readHealth(
  orgRoot: string,
  nowMs: number = Date.now(),
  deps: LucernaHealthDeps = {},
): LucernaHealthWire {
  if (!isInstalled(orgRoot)) return { ...NOT_INSTALLED };

  const runtimeDir = lucernaDir(orgRoot);
  const isAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const intervalSec = resolveHeartbeatIntervalSec();
  const staleBoundSec = resolveStaleBoundSec(intervalSec);

  const path = join(runtimeDir, 'health.json');
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    // Dir present, no health → installed but not running (no beat to age).
    return attachPid(
      {
        available: true,
        stale: false,
        beatAgeSec: null,
        heartbeatIntervalSec: intervalSec,
        staleBoundSec,
      },
      readDaemonPid(runtimeDir),
      isAlive,
    );
  }

  let h: unknown;
  try {
    h = JSON.parse(content);
  } catch {
    return attachPid(
      {
        available: true,
        stale: true,
        beatAgeSec: null,
        heartbeatIntervalSec: intervalSec,
        staleBoundSec,
      },
      readDaemonPid(runtimeDir),
      isAlive,
    );
  }
  if (!isObj(h)) {
    return attachPid(
      {
        available: true,
        stale: true,
        beatAgeSec: null,
        heartbeatIntervalSec: intervalSec,
        staleBoundSec,
      },
      readDaemonPid(runtimeDir),
      isAlive,
    );
  }

  const resolvedInterval = resolveHeartbeatIntervalSec(h.heartbeatIntervalSec, h.intervalMs);
  const resolvedBound = resolveStaleBoundSec(resolvedInterval);
  const beatAgeSec = computeBeatAgeSec(h.lastBeat, nowMs);
  const beatStale = isStaleBeat(beatAgeSec, resolvedInterval);
  const wipOpen = isWorkInProgressOpen(h.workInProgress, nowMs);
  const stopped = typeof h.stopped === 'boolean' ? h.stopped : undefined;
  const pid = resolveRuntimePid(h.pid, runtimeDir);

  // stale: unparseable (handled above) OR beat past bound with no open WIP
  // and pid not known-dead. attachPid clears stale when pidAlive === false.
  const stale = beatStale && !wipOpen;

  const wire: LucernaHealthWire = {
    available: true,
    stale,
    startedAt: strOrU(h.startedAt),
    lastBeat: strOrU(h.lastBeat),
    version: strOrU(h.version),
    beatAgeSec,
    heartbeatIntervalSec: resolvedInterval,
    staleBoundSec: resolvedBound,
    phase: strOrU(h.phase),
    bpm: numOrU(h.bpm),
    dreaming: typeof h.dreaming === 'boolean' ? h.dreaming : undefined,
    intervalMs: numOrU(h.intervalMs),
    stopped,
    workInProgress: isObj(h.workInProgress) ? wipOpen : undefined,
  };

  return attachPid(wire, pid, isAlive);
}

// ── enablement ────────────────────────────────────────────────────────────────

export interface LucernaEnablement {
  dreamsEnabled: boolean;
  autoCommitLive: boolean;
}

/** Absent enablement file → both false (honest defaults). */
export function readEnablement(orgRoot: string): LucernaEnablement {
  if (!isInstalled(orgRoot)) {
    return { dreamsEnabled: false, autoCommitLive: false };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(join(lucernaDir(orgRoot), 'lucerna.enable.json'), 'utf8'));
    if (!isObj(raw)) return { dreamsEnabled: false, autoCommitLive: false };
    return {
      dreamsEnabled: boolOr(raw.dreamsEnabled, false),
      autoCommitLive: boolOr(raw.autoCommitLive, false),
    };
  } catch {
    return { dreamsEnabled: false, autoCommitLive: false };
  }
}

// ── status ────────────────────────────────────────────────────────────────────

export interface LucernaStatusWire {
  available: boolean;
  reason?: string;
  stale?: boolean;
  version?: string;
  pid?: number;
  activity?: unknown;
  lastActions?: unknown;
  budgets?: unknown;
  phase?: string;
  enablement: LucernaEnablement;
}

export function readStatus(
  orgRoot: string,
  nowMs: number = Date.now(),
  deps: LucernaHealthDeps = {},
): LucernaStatusWire {
  if (!isInstalled(orgRoot)) {
    return { ...NOT_INSTALLED, enablement: { dreamsEnabled: false, autoCommitLive: false } };
  }

  const health = readHealth(orgRoot, nowMs, deps);
  const enablement = readEnablement(orgRoot);

  let activity: unknown;
  let lastActions: unknown;
  let budgets: unknown;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(lucernaDir(orgRoot), 'state.json'), 'utf8'));
    if (isObj(raw)) {
      activity = raw.lastActivity ?? raw.activity;
      lastActions = raw.lastActionResults ?? raw.lastActions;
      budgets = raw.budgets;
    }
  } catch {
    // state missing or malformed — still available if dir exists
  }

  return {
    available: true,
    stale: health.stale,
    version: health.version,
    pid: health.pid,
    activity,
    lastActions,
    budgets,
    phase: health.phase,
    enablement,
  };
}

// ── log ───────────────────────────────────────────────────────────────────────

export interface LucernaLogWire {
  available: boolean;
  reason?: string;
  lines: string[];
  total: number;
}

export function readLog(orgRoot: string, n: number = 50): LucernaLogWire {
  if (!isInstalled(orgRoot)) {
    return { ...NOT_INSTALLED, lines: [], total: 0 };
  }
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
  try {
    const content = readFileSync(join(lucernaDir(orgRoot), 'log'), 'utf8');
    const all = content.split(/\r?\n/).filter((l) => l.length > 0);
    const total = all.length;
    const lines = all.slice(-limit).reverse(); // newest first
    return { available: true, lines, total };
  } catch {
    return { available: true, lines: [], total: 0 };
  }
}

// ── writes ────────────────────────────────────────────────────────────────────

export interface LucernaWriteWire {
  available: boolean;
  reason?: string;
  ok: boolean;
}

function writeSentinel(orgRoot: string, name: 'halt' | 'wake' | 'sleep', payload: string): LucernaWriteWire {
  if (!isInstalled(orgRoot)) {
    return { ...NOT_INSTALLED, ok: false };
  }
  const dir = lucernaDir(orgRoot);
  try {
    // Ensure dir still writable; mkdir is a no-op when present.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), payload);
    return { available: true, ok: true };
  } catch {
    return { available: true, ok: false };
  }
}

export function writeHalt(orgRoot: string): LucernaWriteWire {
  return writeSentinel(orgRoot, 'halt', 'halted from iris');
}

export function writeWake(orgRoot: string): LucernaWriteWire {
  return writeSentinel(orgRoot, 'wake', 'woken from iris');
}

export function writeSleep(orgRoot: string): LucernaWriteWire {
  return writeSentinel(orgRoot, 'sleep', 'sleep requested from iris');
}

// ── enablement write (atomic) ─────────────────────────────────────────────────

export interface LucernaEnableWriteWire extends LucernaWriteWire {
  enablement?: LucernaEnablement;
}

/**
 * Merge patch into durable enablement and write atomically (temp + rename).
 * Absent file is treated as both-false before merge. Always re-readable afterward.
 */
export function writeEnablement(
  orgRoot: string,
  patch: Partial<LucernaEnablement>,
): LucernaEnableWriteWire {
  if (!isInstalled(orgRoot)) {
    return { ...NOT_INSTALLED, ok: false };
  }
  const current = readEnablement(orgRoot);
  const next: LucernaEnablement = {
    dreamsEnabled:
      typeof patch.dreamsEnabled === 'boolean' ? patch.dreamsEnabled : current.dreamsEnabled,
    autoCommitLive:
      typeof patch.autoCommitLive === 'boolean' ? patch.autoCommitLive : current.autoCommitLive,
  };
  const dir = lucernaDir(orgRoot);
  const target = join(dir, 'lucerna.enable.json');
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
    return { available: true, ok: true, enablement: next };
  } catch {
    try {
      // Best-effort temp cleanup
      if (existsSync(tmp)) writeFileSync(tmp, '');
    } catch {
      /* ignore */
    }
    return { available: true, ok: false, enablement: current };
  }
}

// ── notifications (JSONL queue) ───────────────────────────────────────────────

export type LucernaNotificationLevel = 'info' | 'warn' | 'error';

export interface LucernaNotification {
  ts: string;
  level: LucernaNotificationLevel;
  kind: string;
  message: string;
  ref?: string;
}

export interface LucernaNotificationsWire {
  available: boolean;
  reason?: string;
  entries: LucernaNotification[];
  total: number;
  skipped: number;
}

const LEVELS = new Set(['info', 'warn', 'error']);

/** Parse one notifications.jsonl line. Malformed → null (caller counts skips). */
export function parseNotificationLine(line: string): LucernaNotification | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const ts = strOrU(raw.ts);
  const level = strOrU(raw.level);
  const kind = strOrU(raw.kind);
  const message = strOrU(raw.message);
  if (!ts || !level || !kind || !message) return null;
  if (!LEVELS.has(level)) return null;
  const entry: LucernaNotification = {
    ts,
    level: level as LucernaNotificationLevel,
    kind,
    message,
  };
  const ref = strOrU(raw.ref);
  if (ref) entry.ref = ref;
  return entry;
}

/**
 * Parse full notifications.jsonl text. Newest last in file; returned newest-first.
 * Malformed lines are skipped (counted in `skipped`).
 */
export function parseNotificationsJsonl(
  text: string,
  n: number = 50,
): { entries: LucernaNotification[]; total: number; skipped: number } {
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
  const lines = text.split(/\r?\n/);
  const parsed: LucernaNotification[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const e = parseNotificationLine(line);
    if (e) parsed.push(e);
    else skipped += 1;
  }
  const total = parsed.length;
  const entries = parsed.slice(-limit).reverse();
  return { entries, total, skipped };
}

export function readNotifications(orgRoot: string, n: number = 50): LucernaNotificationsWire {
  if (!isInstalled(orgRoot)) {
    return { ...NOT_INSTALLED, entries: [], total: 0, skipped: 0 };
  }
  try {
    const content = readFileSync(join(lucernaDir(orgRoot), 'notifications.jsonl'), 'utf8');
    const { entries, total, skipped } = parseNotificationsJsonl(content, n);
    return { available: true, entries, total, skipped };
  } catch {
    // Absent or unreadable → honest empty (protocol: file may be absent).
    return { available: true, entries: [], total: 0, skipped: 0 };
  }
}

// ── pulse (Dashboard compact row) ─────────────────────────────────────────────

export type LucernaRunState = 'not-installed' | 'stopped' | 'running' | 'stale';

export interface LucernaPulse {
  available: boolean;
  reason?: string;
  state: LucernaRunState;
  beatAgeSec: number | null;
  lastNotification: LucernaNotification | null;
  pid?: number;
  version?: string;
  phase?: string;
  /** Pending dream manifests/light dreams + proposals awaiting operator review. */
  pendingReview?: { dreams: number; proposals: number; total: number };
}

/** Derive a compact pulse shape from health + optional newest notification. */
export function buildLucernaPulse(
  health: LucernaHealthWire,
  lastNotification: LucernaNotification | null = null,
): LucernaPulse {
  if (!health.available) {
    return {
      available: false,
      reason: health.reason ?? 'not-installed',
      state: 'not-installed',
      beatAgeSec: null,
      lastNotification: null,
    };
  }
  // Derivation order: not-installed → stopped tombstone/dead pid →
  // unparseable stale → fresh beat or open WIP → beat past bound → no beat.
  let state: LucernaRunState;
  if (health.stopped === true || health.pidAlive === false) {
    state = 'stopped';
  } else if (health.stale) {
    state = 'stale';
  } else if (health.lastBeat && !health.stale) {
    state = 'running';
  } else if (health.workInProgress) {
    state = 'running';
  } else {
    state = 'stopped';
  }
  return {
    available: true,
    state,
    beatAgeSec: health.beatAgeSec ?? null,
    lastNotification,
    pid: health.pid,
    version: health.version,
    phase: health.phase,
  };
}

export function readPulse(
  orgRoot: string,
  nowMs: number = Date.now(),
  deps: LucernaHealthDeps = {},
): LucernaPulse {
  const health = readHealth(orgRoot, nowMs, deps);
  const notes = readNotifications(orgRoot, 1);
  return buildLucernaPulse(health, notes.entries[0] ?? null);
}

// ── process control (start / stop) ────────────────────────────────────────────

export type LucernaSpawnSource = 'env' | 'path' | 'repo';

export interface LucernaSpawnPlan {
  cmd: string;
  args: string[];
  cwd: string;
  source: LucernaSpawnSource;
}

/** Injectable process/spawn surface for unit tests (both Windows and POSIX paths). */
export interface LucernaProcessDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Path existence probe (default: existsSync). */
  exists?: (p: string) => boolean;
  /** Resolve `lucerna` on PATH; return absolute path or null. */
  findOnPath?: (name: string) => string | null;
  /**
   * Spawn a detached child. Default uses node:child_process.spawn with
   * detached+unref so the daemon survives iris exiting.
   */
  spawnDetached?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
  ) => { pid?: number };
  /** Bounded sleep for poll loops (default: real timer). */
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  /** process.kill(pid, 0) liveness. */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Confirm the pid still names a lucerna process (cmdline contains "lucerna").
   * Never match by process-name kill lists — always pid-scoped.
   */
  isLucernaProcess?: (pid: number) => boolean;
  /** Platform-appropriate kill of a single pid (not by name). */
  killPid?: (pid: number, platform: NodeJS.Platform) => void;
  /** Override start/stop wait budgets in tests. */
  startTimeoutMs?: number;
  startPollMs?: number;
  stopGraceMs?: number;
  stopPollMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_START_POLL_MS = 250;
const DEFAULT_STOP_GRACE_MS = 12_000;
const DEFAULT_STOP_POLL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read process command line; true when it clearly refers to lucerna. */
export function defaultIsLucernaProcess(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    if (platform === 'win32') {
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', timeout: 5_000, windowsHide: true },
      );
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      return /lucerna/i.test(out);
    }
    // Linux: /proc; macOS / other POSIX: ps
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmdline) return /lucerna/i.test(cmdline);
    } catch {
      /* no /proc */
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return /lucerna/i.test(r.stdout ?? '');
  } catch {
    return false;
  }
}

function defaultKillPid(pid: number, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}

function defaultFindOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const pathEnv = env.PATH ?? env.Path ?? '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    if (platform === 'win32') {
      for (const ext of exts) {
        const c = join(dir, name + ext.toLowerCase());
        if (existsSync(c)) return c;
        const c2 = join(dir, name + ext.toUpperCase());
        if (existsSync(c2)) return c2;
        const c3 = join(dir, name + ext);
        if (existsSync(c3)) return c3;
      }
      const bare = join(dir, name);
      if (existsSync(bare)) return bare;
    } else {
      const c = join(dir, name);
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * Default detached spawn used in production. Windows and POSIX both set
 * detached:true and unref so the child outlives the iris daemon process.
 */
export function defaultSpawnDetached(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
): { pid?: number } {
  const child = nodeSpawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: opts.platform === 'win32',
  });
  child.unref();
  return { pid: child.pid };
}

/**
 * Resolve how to launch Lucerna for this house.
 * Order: IRIS_LUCERNA_BIN → PATH `lucerna` → repo instruments/lucerna via bun.
 */
export function resolveLucernaSpawnPlan(
  orgRoot: string,
  deps: LucernaProcessDeps = {},
): LucernaSpawnPlan | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const house = resolve(orgRoot);

  // (a) IRIS_LUCERNA_BIN
  const binEnv = env.IRIS_LUCERNA_BIN;
  if (binEnv && binEnv.trim()) {
    const bin = isAbsolute(binEnv) ? binEnv : resolve(binEnv);
    if (exists(bin)) {
      const isScript = /\.(ts|js|mjs|cjs)$/i.test(bin);
      if (isScript) {
        return {
          cmd: process.execPath,
          args: [bin, 'start', '--house', house],
          cwd: dirname(bin),
          source: 'env',
        };
      }
      return {
        cmd: bin,
        args: ['start', '--house', house],
        cwd: house,
        source: 'env',
      };
    }
  }

  // (b) lucerna on PATH
  const find =
    deps.findOnPath ??
    ((name: string) => defaultFindOnPath(name, env, platform));
  const onPath = find('lucerna');
  if (onPath) {
    return {
      cmd: onPath,
      args: ['start', '--house', house],
      cwd: house,
      source: 'path',
    };
  }

  // (c) instruments/lucerna in repo/house layout via bun
  const pkgDir = join(house, 'instruments', 'lucerna');
  const cliTs = join(pkgDir, 'src', 'cli.ts');
  const pkgJson = join(pkgDir, 'package.json');
  if (exists(cliTs)) {
    return {
      cmd: process.execPath,
      args: [cliTs, 'start', '--house', house],
      cwd: pkgDir,
      source: 'repo',
    };
  }
  if (exists(pkgJson)) {
    return {
      cmd: process.execPath,
      args: ['run', 'src/cli.ts', 'start', '--house', house],
      cwd: pkgDir,
      source: 'repo',
    };
  }
  return null;
}

export type LucernaStartOutcome =
  | 'started'
  | 'already-running'
  | 'not-installed'
  | 'no-binary'
  | 'timeout'
  | 'spawn-failed';

export interface LucernaStartWire {
  available: boolean;
  ok: boolean;
  outcome: LucernaStartOutcome;
  reason?: string;
  pid?: number;
  source?: LucernaSpawnSource;
  plan?: { cmd: string; args: string[]; cwd: string };
}

/**
 * Start/stop control gate. Live when the pid is known-alive, or when the pid
 * is unknown and a lastBeat is present and not past the stale bound.
 * Never live when pidAlive is false or stopped is true.
 */
export function isLiveHealth(h: LucernaHealthWire): boolean {
  if (!h.available || h.stopped === true || h.pidAlive === false) return false;
  if (h.pidAlive === true) return true;
  if (typeof h.lastBeat !== 'string' || !h.lastBeat) return false;
  const interval = h.heartbeatIntervalSec ?? DEFAULT_HEARTBEAT_INTERVAL_SEC;
  const beatStale = isStaleBeat(h.beatAgeSec ?? null, interval);
  return !beatStale;
}

export async function startLucerna(
  orgRoot: string,
  deps: LucernaProcessDeps = {},
): Promise<LucernaStartWire> {
  if (!isInstalled(orgRoot)) {
    return { available: false, ok: false, outcome: 'not-installed', reason: 'not-installed' };
  }

  const nowMs = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const healthDeps: LucernaHealthDeps = { isPidAlive: deps.isPidAlive };
  const health0 = readHealth(orgRoot, nowMs(), healthDeps);
  if (isLiveHealth(health0)) {
    return {
      available: true,
      ok: true,
      outcome: 'already-running',
      pid: health0.pid,
    };
  }

  const plan = resolveLucernaSpawnPlan(orgRoot, deps);
  if (!plan) {
    return {
      available: true,
      ok: false,
      outcome: 'no-binary',
      reason: 'no-binary',
    };
  }

  const platform = deps.platform ?? process.platform;
  const env = { ...(deps.env ?? process.env), LUCERNA_HOUSE_ROOT: resolve(orgRoot) };
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;

  let spawnedPid: number | undefined;
  try {
    const child = spawnDetached(plan.cmd, plan.args, {
      cwd: plan.cwd,
      env,
      platform,
    });
    spawnedPid = child.pid;
  } catch {
    return {
      available: true,
      ok: false,
      outcome: 'spawn-failed',
      reason: 'spawn-failed',
      source: plan.source,
      plan: { cmd: plan.cmd, args: plan.args, cwd: plan.cwd },
    };
  }

  const timeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollMs = deps.startPollMs ?? DEFAULT_START_POLL_MS;
  const deadline = nowMs() + timeoutMs;

  while (nowMs() < deadline) {
    await sleep(pollMs);
    const h = readHealth(orgRoot, nowMs(), healthDeps);
    if (isLiveHealth(h)) {
      return {
        available: true,
        ok: true,
        outcome: 'started',
        pid: h.pid ?? spawnedPid,
        source: plan.source,
        plan: { cmd: plan.cmd, args: plan.args, cwd: plan.cwd },
      };
    }
  }

  return {
    available: true,
    ok: false,
    outcome: 'timeout',
    reason: 'timeout',
    pid: spawnedPid,
    source: plan.source,
    plan: { cmd: plan.cmd, args: plan.args, cwd: plan.cwd },
  };
}

export type LucernaStopOutcome =
  | 'halted'
  | 'killed'
  | 'already-stopped'
  | 'not-installed'
  | 'kill-refused'
  | 'still-running';

export interface LucernaStopWire {
  available: boolean;
  ok: boolean;
  outcome: LucernaStopOutcome;
  reason?: string;
  pid?: number;
  /** Distinct outcomes: graceful halt vs forced kill. */
  graceful?: boolean;
  escalated?: boolean;
}

/**
 * Prefer graceful halt (write sentinel, bounded wait for beat to stop).
 * Escalate to pid kill only on timeout, and only after verifying the health.json
 * pid still names a lucerna process. Never kill by process name.
 */
export async function stopLucerna(
  orgRoot: string,
  deps: LucernaProcessDeps = {},
): Promise<LucernaStopWire> {
  if (!isInstalled(orgRoot)) {
    return { available: false, ok: false, outcome: 'not-installed', reason: 'not-installed' };
  }

  const nowMs = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const isAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const platform = deps.platform ?? process.platform;
  const isLucerna = deps.isLucernaProcess ?? ((pid: number) => defaultIsLucernaProcess(pid, platform));
  const killPid = deps.killPid ?? defaultKillPid;

  const healthDeps: LucernaHealthDeps = { isPidAlive: deps.isPidAlive };
  const health0 = readHealth(orgRoot, nowMs(), healthDeps);
  const pid0 = health0.pid;
  const running = isLiveHealth(health0) || (typeof pid0 === 'number' && isAlive(pid0));
  if (!running) {
    return { available: true, ok: true, outcome: 'already-stopped', graceful: true, escalated: false };
  }

  // Graceful path
  const halt = writeHalt(orgRoot);
  if (!halt.ok) {
    return { available: true, ok: false, outcome: 'still-running', reason: 'halt-write-failed', pid: pid0 };
  }

  const graceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const pollMs = deps.stopPollMs ?? DEFAULT_STOP_POLL_MS;
  const deadline = nowMs() + graceMs;

  while (nowMs() < deadline) {
    await sleep(pollMs);
    const h = readHealth(orgRoot, nowMs(), healthDeps);
    const pid = h.pid ?? pid0;
    const stillLive = isLiveHealth(h) || (typeof pid === 'number' && isAlive(pid));
    if (!stillLive) {
      return {
        available: true,
        ok: true,
        outcome: 'halted',
        pid: pid0,
        graceful: true,
        escalated: false,
      };
    }
  }

  // Escalation: re-read pid from health, verify it is still lucerna, then kill by pid only.
  const health1 = readHealth(orgRoot, nowMs(), healthDeps);
  const pid = health1.pid ?? pid0;
  if (typeof pid !== 'number' || !isAlive(pid)) {
    return {
      available: true,
      ok: true,
      outcome: 'halted',
      pid: pid0,
      graceful: true,
      escalated: false,
    };
  }

  if (!isLucerna(pid)) {
    return {
      available: true,
      ok: false,
      outcome: 'kill-refused',
      reason: 'pid-not-lucerna',
      pid,
      graceful: false,
      escalated: true,
    };
  }

  try {
    killPid(pid, platform);
  } catch {
    return {
      available: true,
      ok: false,
      outcome: 'still-running',
      reason: 'kill-failed',
      pid,
      graceful: false,
      escalated: true,
    };
  }

  // Brief post-kill settle
  const settleDeadline = nowMs() + 3_000;
  while (nowMs() < settleDeadline) {
    await sleep(pollMs);
    if (!isAlive(pid)) {
      return {
        available: true,
        ok: true,
        outcome: 'killed',
        pid,
        graceful: false,
        escalated: true,
      };
    }
  }

  // Final check
  if (!isAlive(pid)) {
    return {
      available: true,
      ok: true,
      outcome: 'killed',
      pid,
      graceful: false,
      escalated: true,
    };
  }

  return {
    available: true,
    ok: false,
    outcome: 'still-running',
    reason: 'still-running-after-kill',
    pid,
    graceful: false,
    escalated: true,
  };
}
