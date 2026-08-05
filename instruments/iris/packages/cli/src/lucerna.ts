// Thin Lucerna CLI helpers — HTTP clients over the iris daemon's /api/lucerna/*
// state-file proxy. Verbs live in commands.ts; this module holds shared shapes
// and the write-exit helper.

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
 * flag: "dreams" | "auto-commit-live"; value: "on" | "off".
 */
export function lucernaEnable(
  flag: string,
  value: string,
): Promise<Record<string, unknown>> {
  const on = value === 'on' || value === 'true' || value === '1';
  const off = value === 'off' || value === 'false' || value === '0';
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
    return daemonPost('/api/lucerna/enable', { autoCommitLive: bool }) as Promise<
      Record<string, unknown>
    >;
  }
  throw new Error(`enable flag must be dreams|auto-commit-live (got '${flag}')`);
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
