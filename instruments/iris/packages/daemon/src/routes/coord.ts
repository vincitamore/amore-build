// GET /api/coord/presence — seat roster under ~/.house/coord/presence/.
// House-neutral JSON files, one per live session, shared across harnesses
// on the seat. Filter by PID probe; writers reap. Fail-soft empty list.

import { homedir } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json } from './http.ts';

export interface PresenceEntry {
  seat: string;
  harness: string;
  model?: string | null;
  pid: number;
  pname?: string | null;
  cwd?: string;
  tree?: string;
  started?: string;
  work_unit?: string | null;
  session_id?: string | null;
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

export function readRoster(dir = presenceDir()): PresenceEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: PresenceEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PresenceEntry;
      if (typeof e.pid === 'number' && pidAlive(e.pid)) entries.push(e);
    } catch {
      // unreadable: leave for the writer-side reaper
    }
  }
  entries.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
  return entries;
}

export function formatPeers(entries: PresenceEntry[]): string {
  if (entries.length === 0) return 'Peers: 0 LIVE';
  const parts = entries.map((e) => {
    const ident = `${e.model || e.harness}@${e.seat}/${e.harness}`;
    const bits = [`pid ${e.pid}`];
    if (e.tree) bits.push(e.tree);
    if (e.work_unit) bits.push(`unit ${e.work_unit}`);
    return `${ident} (${bits.join(', ')})`;
  });
  return `Peers: ${entries.length} LIVE — ${parts.join(' · ')}`;
}

export interface CoordMessage {
  msgid: string;
  kind: string;
  ts?: string;
  from?: { seat?: string; harness?: string; session_id?: string };
  text?: string;
}

function coordRoot(): string {
  const over = process.env.HOUSE_COORD_DIR;
  if (over && over.length > 0) return join(over, '..');
  return join(homedir(), '.house', 'coord');
}

export function readMessages(limit = 20): CoordMessage[] {
  const dir = join(coordRoot(), 'log');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const all: CoordMessage[] = [];
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    try {
      const body = readFileSync(join(dir, name), 'utf8');
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        try {
          all.push(JSON.parse(line) as CoordMessage);
        } catch {
          // skip bad line
        }
      }
    } catch {
      // skip unreadable log
    }
  }
  all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  return all.slice(-limit);
}

export function formatMessages(entries: CoordMessage[]): string {
  if (entries.length === 0) return 'none';
  const last = entries[entries.length - 1];
  const ident = last?.from
    ? `${last.from.seat || '?'}/${last.from.harness || '?'}`
    : '?';
  const body = (last?.text || '').slice(0, 48);
  return `${entries.length} · last ${ident}: ${body}`;
}

export function coordPresence(): Response {
  const entries = readRoster();
  return json({ entries, line: formatPeers(entries) });
}

export function coordMessages(): Response {
  const entries = readMessages();
  return json({ entries, line: formatMessages(entries) });
}
