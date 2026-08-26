// GET /api/coord/presence — live seat roster.
//
// Presence is pulled, never pushed: the native binary dials each registered
// seat's door (tailnet TLS, pinned + house token) and answers for the whole
// mesh, so the daemon spawns `amore coord roster --json` (one protocol
// implementation) behind a short cache. When the binary is unavailable the
// route degrades to reading the local presence dir (PID-probed local rows
// only — remote state never lives on disk here). A registered seat that did
// not answer is reported dark with its last successful answer.

import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
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
  socket?: string | null;
  socket_tailnet?: string | null;
  /** Tagged here: this row was answered live by another seat's door. */
  remote?: boolean;
}

export interface PeerStatus {
  seat: string;
  answered: boolean;
  sessions: number;
  error?: string | null;
  last_answered?: string | null;
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

export function coordRoot(): string {
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

/** Local presence files only: PID-probed; registered-peer-seat rows are
 * pushed-era artifacts and are skipped (the native reader reaps them). */
export function readLocalRoster(dir = presenceDir()): PresenceEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: PresenceEntry[] = [];
  const peers = loadPeerSeats();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const e = JSON.parse(readFileSync(path, 'utf8')) as PresenceEntry;
      if (typeof e.pid !== 'number') continue;
      const seat = (e.seat || '').trim().toLowerCase();
      if (seat && peers.has(seat)) continue;
      if (pidAlive(e.pid)) entries.push(e);
    } catch {
      // unreadable: leave for the writer-side reaper
    }
  }
  entries.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
  return dedup(entries);
}

interface RosterReport {
  entries: PresenceEntry[];
  peers: PeerStatus[];
}

const PULL_CACHE_MS = 10_000;
let pullCache: { ts: number; report: RosterReport } | null = null;

/** Live mesh pull via the native binary. Null when unavailable. */
function pullRoster(): RosterReport | null {
  // An explicit HOUSE_COORD_DIR is an isolated roster (tests, overlays):
  // never dial the real mesh from it.
  if (process.env.HOUSE_COORD_DIR) return null;
  const now = Date.now();
  if (pullCache && now - pullCache.ts < PULL_CACHE_MS) return pullCache.report;
  try {
    const r = spawnSync('amore', ['coord', 'roster', '--json'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    const v = JSON.parse(r.stdout) as Partial<RosterReport>;
    if (!Array.isArray(v.entries)) return null;
    const report: RosterReport = {
      entries: v.entries,
      peers: Array.isArray(v.peers) ? v.peers : [],
    };
    pullCache = { ts: now, report };
    return report;
  } catch {
    return null;
  }
}

function tagRemote(entries: PresenceEntry[], me: string): PresenceEntry[] {
  return entries.map((e) => ({
    ...e,
    remote: (e.seat || '').trim().toLowerCase() !== me,
  }));
}

// Every entry is LIVE — local rows PID-probed here, remote rows PID-probed
// by their own seat's door seconds ago. Dark seats' sessions are not counted.
export function formatPeers(entries: PresenceEntry[], peers: PeerStatus[] = []): string {
  const live = entries.length;
  const dark = peers.filter((p) => !p.answered).length;
  if (live === 0 && dark === 0) return '0 LIVE';
  let head = `${live} LIVE`;
  if (dark > 0) head += ` · ${dark} dark`;
  return head;
}

function shortWhen(ts: string): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return ts;
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function groupSeatIdents(entries: PresenceEntry[]): string[] {
  const order: string[] = [];
  const harnesses = new Map<string, string[]>();
  for (const e of entries) {
    const seat = (e.seat || '?').trim() || '?';
    if (!harnesses.has(seat)) {
      order.push(seat);
      harnesses.set(seat, []);
    }
    const h = (e.harness || '?').trim() || '?';
    const list = harnesses.get(seat)!;
    if (!list.includes(h)) list.push(h);
  }
  return order.map((seat) => `${seat} ${(harnesses.get(seat) || []).join(', ')}`);
}

export function formatPeersDetail(entries: PresenceEntry[], peers: PeerStatus[] = []): string {
  const locals = entries.filter((e) => !e.remote);
  const remotes = entries.filter((e) => e.remote);
  const parts = [...groupSeatIdents(locals), ...groupSeatIdents(remotes)];
  for (const p of peers) {
    if (p.answered) {
      if (p.sessions === 0) parts.push(`${p.seat}: up, no sessions`);
      continue;
    }
    const when = p.last_answered ? ` (last answered ${shortWhen(p.last_answered)})` : '';
    parts.push(`${p.seat}: dark${when}`);
  }
  return parts.join(' · ');
}

export interface CoordMessage {
  msgid: string;
  kind: string;
  ts?: string;
  from?: { seat?: string; harness?: string; session_id?: string };
  to?: { seat?: string; harness?: string; session_id?: string };
  text?: string;
}

export function readMessages(limit = 100): CoordMessage[] {
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
  const me = localSeat();
  const pulled = pullRoster();
  if (pulled) {
    const entries = tagRemote(pulled.entries, me);
    return json({
      entries,
      peers: pulled.peers,
      line: formatPeers(entries, pulled.peers),
      detail: formatPeersDetail(entries, pulled.peers),
      source: 'pull',
    });
  }
  const entries = tagRemote(readLocalRoster(), me);
  return json({
    entries,
    peers: [],
    line: formatPeers(entries),
    detail: formatPeersDetail(entries),
    source: 'files',
  });
}

export function coordMessages(): Response {
  const entries = readMessages();
  return json({ entries, line: formatMessages(entries) });
}
