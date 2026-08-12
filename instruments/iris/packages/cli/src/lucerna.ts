// Thin Lucerna CLI helpers — HTTP clients over the iris daemon's /api/lucerna/*
// state-file proxy. Verbs live in commands.ts; this module holds shared shapes,
// /status projections, and the write-exit helper.

import { EXIT } from './contract';
import { daemonGet, daemonPost } from './daemon';

/** Lucerna write verbs return `{ok:boolean, …}`; false is actionable (exit 1). */
export function lucernaWriteExit(p: Record<string, unknown>): number {
  return p.ok === false ? EXIT.ACTIONABLE : EXIT.OK;
}

export async function lucernaStatus(): Promise<Record<string, unknown>> {
  const [health, status] = await Promise.all([
    daemonGet('/api/lucerna/health'),
    daemonGet('/api/lucerna/status'),
  ]);
  return { health, status };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function lucernaStatusPayload(): Promise<Record<string, unknown>> {
  const raw = await daemonGet('/api/lucerna/status');
  return isRecord(raw) ? raw : { available: false };
}

export interface LucernaChoreEntry {
  key: string;
  class: string;
  tier: string;
  enabled: boolean;
  lastRun: string | null;
}

function asChoreEntry(raw: unknown): LucernaChoreEntry | null {
  if (!isRecord(raw) || typeof raw.key !== 'string') return null;
  return {
    key: raw.key,
    class: typeof raw.class === 'string' ? raw.class : '',
    tier: typeof raw.tier === 'string' ? raw.tier : '',
    enabled: raw.enabled === true,
    lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : null,
  };
}

function rosterEntriesFromStatus(status: Record<string, unknown>): LucernaChoreEntry[] {
  if (!isRecord(status.budgets)) return [];
  const roster = status.budgets.roster;
  if (!isRecord(roster) || !Array.isArray(roster.entries)) return [];
  const out: LucernaChoreEntry[] = [];
  for (const row of roster.entries) {
    const entry = asChoreEntry(row);
    if (entry) out.push(entry);
  }
  return out;
}

function capabilityFromStatus(status: Record<string, unknown>): unknown {
  if (status.capability !== undefined) return status.capability;
  if (isRecord(status.budgets) && status.budgets.capability !== undefined) {
    return status.budgets.capability;
  }
  return null;
}

/** `{available, budgets, capability}` from GET /api/lucerna/status. No dedicated route. */
export function projectLucernaBudgets(status: Record<string, unknown>): Record<string, unknown> {
  const available = status.available === true;
  const payload: Record<string, unknown> = {
    available,
    budgets: status.budgets ?? null,
    capability: capabilityFromStatus(status),
  };
  if (!available && status.reason !== undefined) payload.reason = status.reason;
  return payload;
}

export function projectLucernaChoresList(
  status: Record<string, unknown>,
  disabledOnly = false,
): Record<string, unknown> {
  const available = status.available === true;
  let entries = rosterEntriesFromStatus(status);
  if (disabledOnly) entries = entries.filter((e) => !e.enabled);
  const payload: Record<string, unknown> = {
    available,
    count: entries.length,
    entries,
  };
  if (!available && status.reason !== undefined) payload.reason = status.reason;
  return payload;
}

export function projectLucernaChoresShow(
  status: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const available = status.available === true;
  const entry = rosterEntriesFromStatus(status).find((e) => e.key === key);
  if (!entry) return { available, found: false };
  return { available, found: true, ...entry };
}

export async function lucernaBudgets(): Promise<Record<string, unknown>> {
  return projectLucernaBudgets(await lucernaStatusPayload());
}

export async function lucernaChoresList(disabledOnly = false): Promise<Record<string, unknown>> {
  return projectLucernaChoresList(await lucernaStatusPayload(), disabledOnly);
}

export async function lucernaChoresShow(key: string): Promise<Record<string, unknown>> {
  return projectLucernaChoresShow(await lucernaStatusPayload(), key);
}

export async function lucernaLog(n: number, filter?: string): Promise<Record<string, unknown>> {
  const raw = (await daemonGet(`/api/lucerna/log?n=${n}`)) as {
    available?: boolean;
    reason?: string;
    lines?: string[];
    total?: number;
  };
  let lines = raw.lines ?? [];
  if (filter) {
    const f = filter.toLowerCase();
    lines = lines.filter((line) => line.toLowerCase().includes(f));
  }
  return {
    available: raw.available,
    reason: raw.reason,
    total: raw.total ?? 0,
    count: lines.length,
    lines,
  };
}

export async function lucernaNotifications(n: number = 20): Promise<Record<string, unknown>> {
  return daemonGet(`/api/lucerna/notifications?n=${n}`) as Promise<Record<string, unknown>>;
}

export function lucernaHalt(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/halt') as Promise<Record<string, unknown>>;
}

export function lucernaWake(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/wake') as Promise<Record<string, unknown>>;
}

export function lucernaSleep(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/sleep') as Promise<Record<string, unknown>>;
}

export function lucernaStart(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/start') as Promise<Record<string, unknown>>;
}

export function lucernaStop(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/stop') as Promise<Record<string, unknown>>;
}

/**
 * Set durable enablement flags via the daemon proxy.
 * flag: "dreams" (on|off) | "auto-commit" (off|dry-run|live) |
 *       "auto-commit-live" (on|off — live vs dry-run, keeps drafting on).
 */
export function lucernaEnable(
  flag: string,
  value: string,
): Promise<Record<string, unknown>> {
  const raw = value.toLowerCase();
  if (flag === 'auto-commit' || flag === 'autoCommit') {
    if (raw === 'off' || raw === 'false' || raw === '0') {
      return daemonPost('/api/lucerna/enable', {
        autoCommitEnabled: false,
        autoCommitLive: false,
      }) as Promise<Record<string, unknown>>;
    }
    if (raw === 'dry-run' || raw === 'dryrun') {
      return daemonPost('/api/lucerna/enable', {
        autoCommitEnabled: true,
        autoCommitLive: false,
      }) as Promise<Record<string, unknown>>;
    }
    if (raw === 'live') {
      return daemonPost('/api/lucerna/enable', {
        autoCommitEnabled: true,
        autoCommitLive: true,
      }) as Promise<Record<string, unknown>>;
    }
    throw new Error(`auto-commit value must be off|dry-run|live (got '${value}')`);
  }
  const on = raw === 'on' || raw === 'true' || raw === '1';
  const off = raw === 'off' || raw === 'false' || raw === '0';
  if (!on && !off) {
    throw new Error(`enable value must be on|off (got '${value}')`);
  }
  const bool = on;
  if (flag === 'dreams') {
    return daemonPost('/api/lucerna/enable', { dreamsEnabled: bool }) as Promise<
      Record<string, unknown>
    >;
  }
  if (flag === 'auto-commit-live' || flag === 'autoCommitLive') {
    return daemonPost('/api/lucerna/enable', {
      autoCommitEnabled: true,
      autoCommitLive: bool,
    }) as Promise<Record<string, unknown>>;
  }
  throw new Error(`enable flag must be dreams|auto-commit|auto-commit-live (got '${flag}')`);
}

const BUDGET_CAP_ALIASES: Record<string, { knob: string; hours?: boolean }> = {
  'actions-per-day': { knob: 'dailyActionCap' },
  actions: { knob: 'dailyActionCap' },
  'expensive-per-week': { knob: 'weeklyExpensiveCap' },
  expensive: { knob: 'weeklyExpensiveCap' },
  'tokens-per-day': { knob: 'dailyTokenCeiling' },
  tokens: { knob: 'dailyTokenCeiling' },
  'cycle-cooldown-hours': { knob: 'cycleCooldownMinutes', hours: true },
  cooldown: { knob: 'cycleCooldownMinutes', hours: true },
  'dreams-reserve': { knob: 'dreamsReserveTokens' },
  reserve: { knob: 'dreamsReserveTokens' },
  'auto-commit-cooldown-minutes': { knob: 'autoCommitCooldownMinutes' },
  'auto-commit': { knob: 'autoCommitCooldownMinutes' },
};

const STRICT_UINT = /^\d+$/;

/** Resolve `iris lucerna budgets set <cap> <value>` into a file-knob patch. */
export function parseBudgetSetArgs(
  cap: string,
  value: string,
): { knob: string; n: number } {
  const spec = BUDGET_CAP_ALIASES[cap];
  if (!spec) {
    throw new Error(
      `unknown cap '${cap}' (actions|expensive|tokens|cooldown|reserve|auto-commit)`,
    );
  }
  if (spec.hours) {
    const t = value.trim();
    if (!/^\d+(\.\d+)?$/.test(t)) {
      throw new Error('cooldown must be hours ≥ 0.5');
    }
    const h = Number(t);
    if (!Number.isFinite(h) || h < 0.5) throw new Error('cooldown must be hours ≥ 0.5');
    const mins = h * 60;
    if (!Number.isInteger(mins)) throw new Error('cooldown must land on a whole minute');
    return { knob: spec.knob, n: mins };
  }
  const t = value.trim();
  if (!STRICT_UINT.test(t)) {
    throw new Error(`${cap} must be a non-negative integer`);
  }
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${cap} must be a non-negative integer`);
  }
  return { knob: spec.knob, n };
}

export function lucernaBudgetsSet(
  cap: string,
  value: string,
): Promise<Record<string, unknown>> {
  const { knob, n } = parseBudgetSetArgs(cap, value);
  return daemonPost('/api/lucerna/budgets', { [knob]: n }) as Promise<Record<string, unknown>>;
}

export function lucernaChoresEnable(key: string): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/chores', { key, enabled: true }) as Promise<
    Record<string, unknown>
  >;
}

export function lucernaChoresDisable(key: string): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/chores', { key, enabled: false }) as Promise<
    Record<string, unknown>
  >;
}

export function lucernaChoresInterval(
  key: string,
  hours: string,
): Promise<Record<string, unknown>> {
  const t = hours.trim();
  if (!STRICT_UINT.test(t)) {
    throw new Error('interval hours must be a non-negative integer');
  }
  const n = Number(t);
  if (n > 8760) throw new Error('interval hours must be 0–8760');
  return daemonPost('/api/lucerna/chores', { key, minIntervalHours: n }) as Promise<
    Record<string, unknown>
  >;
}

// ── dreams + proposals review (house forge artifacts via daemon proxy) ────────

export async function lucernaDreamsList(pendingOnly = false): Promise<Record<string, unknown>> {
  const q = pendingOnly ? '?pending=1' : '';
  return daemonGet(`/api/lucerna/dreams${q}`) as Promise<Record<string, unknown>>;
}

export async function lucernaDreamShow(id: string): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({ id });
  return daemonGet(`/api/lucerna/dream?${q}`) as Promise<Record<string, unknown>>;
}

export function lucernaDreamReview(id: string): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/dreams/review', { id }) as Promise<Record<string, unknown>>;
}

export async function lucernaProposalsList(pendingOnly = false): Promise<Record<string, unknown>> {
  const q = pendingOnly ? '?pending=1' : '';
  return daemonGet(`/api/lucerna/proposals${q}`) as Promise<Record<string, unknown>>;
}

export async function lucernaProposalShow(id: string): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({ id });
  return daemonGet(`/api/lucerna/proposal?${q}`) as Promise<Record<string, unknown>>;
}

export function lucernaProposalApply(id: string): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/proposals/apply', { id }) as Promise<Record<string, unknown>>;
}

export function lucernaProposalClose(id: string): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/proposals/close', { id }) as Promise<Record<string, unknown>>;
}
