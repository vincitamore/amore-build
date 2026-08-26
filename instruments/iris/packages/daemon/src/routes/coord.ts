// GET /api/coord/presence — seat roster under ~/.house/coord/presence/.
// House-neutral JSON files, one per live session, shared across harnesses
// on the seat. PID-probe local rows only; keep remote (hide, never unlink).
// Read-only: writers reap. Fail-soft empty list.

import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { json } from './http.ts';

export const REMOTE_STALE_HOURS = 12;

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
  remote?: boolean;
  stale?: boolean;
  ageHours?: number;
  mtimeMs?: number;
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

function coordRoot(): string {
  const over = process.env.HOUSE_COORD_DIR;
  if (over && over.length > 0) return join(over, '..');
  return join(homedir(), '.house', 'coord');
}

function firstLabel(raw: string): string {
  return raw.trim().replace(/^\.+|\.+$/g, '').split('.')[0]?.trim().toLowerCase() ?? '';
}

function readSeatFile(): string {
  try {
    return readFileSync(join(coordRoot(), 'seat'), 'utf8').trim().toLowerCase();
  } catch {
    return '';
  }
}

// Success-only: a failed probe is not stored, so a tailscaled blip cannot pin
// the hostname fallback for the process lifetime.
let cachedMagicDns: string | null = null;

function tailscaleMagicDnsLabel(): string | null {
  if (cachedMagicDns !== null) return cachedMagicDns;
  try {
    const r = spawnSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    const v = JSON.parse(r.stdout) as { Self?: { DNSName?: unknown } };
    const dns = typeof v.Self?.DNSName === 'string' ? v.Self.DNSName : '';
    const label = firstLabel(dns);
    if (!label) return null;
    cachedMagicDns = label;
    return label;
  } catch {
    return null;
  }
}

function hostnameLabel(): string {
  return firstLabel(hostname()) || 'unknown';
}

// HOUSE_SEAT > ~/.house/coord/seat > MagicDNS first label > hostname first label.
// Never empty. Never writes the seat file (hostname fallback must not persist).
export function localSeat(opts?: { tailscale?: () => string | null }): string {
  const env = (process.env.HOUSE_SEAT || '').trim().toLowerCase();
  if (env) return env;
  const fromFile = readSeatFile();
  if (fromFile) return fromFile;
  const probe = opts?.tailscale ?? tailscaleMagicDnsLabel;
  const ts = probe();
  if (ts) return ts;
  return hostnameLabel();
}

function loadPeerSeats(): Set<string> {
  const names = new Set<string>();
  try {
    const text = readFileSync(join(coordRoot(), 'seats'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const name = t.split(/\s+/)[0]?.trim().toLowerCase();
      if (name) names.add(name);
    }
  } catch {
    // missing seats file: no registered peers
  }
  return names;
}

function isRemote(e: PresenceEntry, me: string, peers: Set<string>): boolean {
  const seat = (e.seat || '').trim().toLowerCase();
  if (!seat || seat === me) return false;
  return peers.has(seat);
}

function formatRemoteAge(ageHours: number): string {
  let h = ageHours;
  if (!Number.isFinite(h) || h < 0) h = 0;
  const minutes = Math.floor(h * 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ageRemote(path: string, now: number): { ageHours: number; stale: boolean; mtimeMs: number } {
  let mtimeMs = now;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // unstatable: treat as now
  }
  const ageHours = Math.round(Math.max(0, (now - mtimeMs) / 3_600_000) * 10) / 10;
  return { ageHours, stale: ageHours > REMOTE_STALE_HOURS, mtimeMs };
}

function dedup(entries: PresenceEntry[]): PresenceEntry[] {
  const best = new Map<string, PresenceEntry>();
  for (const e of entries) {
    const k = `${(e.seat || '').toLowerCase()}|${e.pid}`;
    const prev = best.get(k);
    if (!prev || (e.harness === 'amore' && prev.harness !== 'amore')) {
      best.set(k, e);
    }
  }
  return [...best.values()];
}

export function readRoster(dir = presenceDir()): PresenceEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: PresenceEntry[] = [];
  const me = localSeat();
  const peers = loadPeerSeats();
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const e = JSON.parse(readFileSync(path, 'utf8')) as PresenceEntry;
      if (typeof e.pid !== 'number') continue;
      if (isRemote(e, me, peers)) {
        const age = ageRemote(path, now);
        e.remote = true;
        e.ageHours = age.ageHours;
        e.stale = age.stale;
        e.mtimeMs = age.mtimeMs;
        entries.push(e);
        continue;
      }
      if (pidAlive(e.pid)) entries.push(e);
    } catch {
      // unreadable: leave for the writer-side reaper
    }
  }
  entries.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
  return dedup(entries);
}

export function formatPeers(entries: PresenceEntry[]): string {
  const live = entries.filter((e) => !e.remote && !e.stale).length;
  const remote = entries.filter((e) => e.remote).length;
  if (live === 0 && remote === 0) return '0 LIVE';
  if (remote === 0) return `${live} LIVE`;
  return `${live} LIVE · ${remote} remote-reported`;
}

function groupSeatIdents(entries: PresenceEntry[], remote: boolean): string[] {
  const order: string[] = [];
  const harnesses = new Map<string, string[]>();
  const cap = new Map<string, string>();
  for (const e of entries) {
    const seat = (e.seat || '?').trim() || '?';
    if (!harnesses.has(seat)) {
      order.push(seat);
      harnesses.set(seat, []);
    }
    const h = (e.harness || '?').trim() || '?';
    const list = harnesses.get(seat)!;
    if (!list.includes(h)) list.push(h);
    if (remote) {
      const age = formatRemoteAge(e.ageHours ?? 0);
      cap.set(seat, e.stale ? `seen ${age}` : `as of ${age}`);
    }
  }
  return order.map((seat) => {
    const ids = (harnesses.get(seat) || []).join(', ');
    const c = cap.get(seat);
    return c ? `${seat} ${ids} (${c})` : `${seat} ${ids}`;
  });
}

export function formatPeersDetail(entries: PresenceEntry[]): string {
  if (entries.length === 0) return '';
  const locals = entries.filter((e) => !e.remote);
  const remotes = entries.filter((e) => e.remote);
  return [...groupSeatIdents(locals, false), ...groupSeatIdents(remotes, true)].join(' · ');
}

export interface CoordMessage {
  msgid: string;
  kind: string;
  ts?: string;
  from?: { seat?: string; harness?: string; session_id?: string };
  text?: string;
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
  return json({
    entries,
    line: formatPeers(entries),
    detail: formatPeersDetail(entries),
  });
}

export function coordMessages(): Response {
  const entries = readMessages();
  return json({ entries, line: formatMessages(entries) });
}
