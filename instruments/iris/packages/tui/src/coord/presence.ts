// Seat roster reader for the Dashboard Pulse. Same schema as the house
// presence files (~/.house/coord/presence/). Filter-only; writers reap.

import { homedir } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PresenceEntry {
  seat: string;
  harness: string;
  model?: string | null;
  pid: number;
  tree?: string;
  started?: string;
  work_unit?: string | null;
}

function presenceDir(): string {
  const over = process.env.HOUSE_COORD_DIR;
  if (over && over.length > 0) return over;
  return join(homedir(), '.house', 'coord', 'presence');
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readRoster(): PresenceEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(presenceDir());
  } catch {
    return [];
  }
  const entries: PresenceEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(presenceDir(), name), 'utf8')) as PresenceEntry;
      if (typeof e.pid === 'number' && pidAlive(e.pid)) entries.push(e);
    } catch {
      // leave unreadable files for the writer-side reaper
    }
  }
  entries.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
  return entries;
}

export function formatPeers(entries: PresenceEntry[]): string {
  if (entries.length === 0) return '0 LIVE';
  const parts = entries.map((e) => {
    const ident = `${e.model || e.harness}@${e.seat || '?'}/${e.harness}`;
    const bits = [`pid ${e.pid}`];
    if (e.tree) bits.push(e.tree);
    if (e.work_unit) bits.push(`unit ${e.work_unit}`);
    return `${ident} (${bits.join(', ')})`;
  });
  return `${entries.length} LIVE — ${parts.join(' · ')}`;
}

function coordRoot(): string {
  const over = process.env.HOUSE_COORD_DIR;
  if (over && over.length > 0) return join(over, '..');
  return join(homedir(), '.house', 'coord');
}

export function readMessages(limit = 20): { from?: { seat?: string; harness?: string }; text?: string; ts?: string }[] {
  const dir = join(coordRoot(), 'log');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const all: { from?: { seat?: string; harness?: string }; text?: string; ts?: string }[] = [];
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    try {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          all.push(JSON.parse(line));
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  return all.slice(-limit);
}

export function formatMessages(
  entries: { from?: { seat?: string; harness?: string }; text?: string }[],
): string {
  if (entries.length === 0) return 'none';
  const last = entries[entries.length - 1];
  const ident = last?.from ? `${last.from.seat || '?'}/${last.from.harness || '?'}` : '?';
  return `${entries.length} · last ${ident}: ${(last?.text || '').slice(0, 40)}`;
}
