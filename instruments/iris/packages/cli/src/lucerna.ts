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

export function lucernaHalt(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/halt') as Promise<Record<string, unknown>>;
}

export function lucernaWake(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/wake') as Promise<Record<string, unknown>>;
}

export function lucernaSleep(): Promise<Record<string, unknown>> {
  return daemonPost('/api/lucerna/sleep') as Promise<Record<string, unknown>>;
}
