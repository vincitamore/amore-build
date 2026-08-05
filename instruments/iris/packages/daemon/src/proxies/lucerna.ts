// proxies/lucerna.ts — state-file proxy for the Lucerna agency runtime under
// <orgRoot>/instruments/lucerna/. Reads health/state/log/enablement; writes
// halt/wake/sleep sentinels (create-file = request; Lucerna deletes on consume).
//
// File map:
//   health.json          → readHealth (pid, startedAt, lastBeat, version)
//   state.json           → readStatus (activity, lastActions, budgets)
//   lucerna.enable.json  → enablement (dreamsEnabled, autoCommitLive; absent = both false)
//   log                  → readLog (plaintext tail)
//   halt / wake / sleep  ← write sentinels
//
// Absent runtime dir → available:false, reason:"not-installed".
// Stale lastBeat (> 2 heartbeat intervals; default interval 60s, overridable via
// health.heartbeatIntervalSec or LUCERNA_HEARTBEAT_INTERVAL_SEC) → stale:true.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;
const STALE_MULTIPLIER = 2;

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

/** Resolve heartbeat interval (seconds). Env overrides health field; default 60. */
export function resolveHeartbeatIntervalSec(healthField?: unknown): number {
  const env = process.env.LUCERNA_HEARTBEAT_INTERVAL_SEC;
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromHealth = numOrU(healthField);
  if (fromHealth !== undefined && fromHealth > 0) return fromHealth;
  return DEFAULT_HEARTBEAT_INTERVAL_SEC;
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
  return beatAgeSec > intervalSec * STALE_MULTIPLIER;
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
}

const NOT_INSTALLED = { available: false as const, reason: 'not-installed' as const };

export function readHealth(orgRoot: string, nowMs: number = Date.now()): LucernaHealthWire {
  if (!isInstalled(orgRoot)) return { ...NOT_INSTALLED };

  const path = join(lucernaDir(orgRoot), 'health.json');
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    // Dir present, no health → installed but not running (no beat to age).
    return {
      available: true,
      stale: false,
      beatAgeSec: null,
      heartbeatIntervalSec: resolveHeartbeatIntervalSec(),
    };
  }

  let h: unknown;
  try {
    h = JSON.parse(content);
  } catch {
    return {
      available: true,
      stale: true,
      beatAgeSec: null,
      heartbeatIntervalSec: resolveHeartbeatIntervalSec(),
    };
  }
  if (!isObj(h)) {
    return {
      available: true,
      stale: true,
      beatAgeSec: null,
      heartbeatIntervalSec: resolveHeartbeatIntervalSec(),
    };
  }

  const intervalSec = resolveHeartbeatIntervalSec(h.heartbeatIntervalSec);
  const beatAgeSec = computeBeatAgeSec(h.lastBeat, nowMs);
  const stale = isStaleBeat(beatAgeSec, intervalSec);

  return {
    available: true,
    stale,
    pid: numOrU(h.pid),
    startedAt: strOrU(h.startedAt),
    lastBeat: strOrU(h.lastBeat),
    version: strOrU(h.version),
    beatAgeSec,
    heartbeatIntervalSec: intervalSec,
  };
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
  enablement: LucernaEnablement;
}

export function readStatus(orgRoot: string, nowMs: number = Date.now()): LucernaStatusWire {
  if (!isInstalled(orgRoot)) {
    return { ...NOT_INSTALLED, enablement: { dreamsEnabled: false, autoCommitLive: false } };
  }

  const health = readHealth(orgRoot, nowMs);
  const enablement = readEnablement(orgRoot);

  let activity: unknown;
  let lastActions: unknown;
  let budgets: unknown;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(lucernaDir(orgRoot), 'state.json'), 'utf8'));
    if (isObj(raw)) {
      activity = raw.activity;
      lastActions = raw.lastActions;
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
