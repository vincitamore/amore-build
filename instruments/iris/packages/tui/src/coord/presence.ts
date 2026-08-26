// Display model for GET /api/coord/presence and /api/coord/messages.
// Display-only: the daemon is the single roster reader (it pulls the mesh
// through the native binary). iris renders what a seat's door answered;
// a registered seat that did not answer renders dark.

export const PRESENCE_UNAVAILABLE = 'presence unavailable';
export const MAIL_UNAVAILABLE = 'mail unavailable';

export interface PresenceEntry {
  seat: string;
  harness: string;
  model?: string | null;
  pid?: number;
  pname?: string | null;
  cwd?: string;
  tree?: string;
  started?: string;
  work_unit?: string | null;
  session_id?: string | null;
  socket?: string | null;
  socket_tailnet?: string | null;
  /** Daemon-tagged: this row was answered live by another seat's door. */
  remote?: boolean;
}

export interface PeerStatus {
  seat: string;
  answered: boolean;
  sessions: number;
  error?: string | null;
  last_answered?: string | null;
}

export interface PresencePayload {
  entries?: PresenceEntry[];
  peers?: PeerStatus[];
  line?: string;
  detail?: string;
  source?: string;
}

export interface CoordMessage {
  msgid?: string;
  kind?: string;
  ts?: string;
  from?: { seat?: string; harness?: string; session_id?: string };
  to?: { seat?: string; harness?: string; session_id?: string };
  text?: string;
}

export function entryIsRemote(e: PresenceEntry): boolean {
  return e.remote === true;
}

/** Coarsen a timestamp to glanceable `Xm ago` / `Xh ago` / `Xd ago`. */
export function formatAgo(ts: string, now = Date.now()): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return ts;
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatPeers(entries: PresenceEntry[], peers: PeerStatus[] = []): string {
  const live = entries.filter((e) => !entryIsRemote(e)).length;
  const remote = entries.filter((e) => entryIsRemote(e)).length;
  const dark = peers.filter((p) => !p.answered).length;
  if (live === 0 && remote === 0 && dark === 0) return '0 LIVE';
  let head = `${live} LIVE`;
  if (remote > 0) head += ` · ${remote} remote`;
  if (dark > 0) head += ` · ${dark} dark`;
  return head;
}

/** One Pulse identity row per seat — locals first, then answered remote
 * seats, then dark seats. Never a jammed one-liner. */
export interface PeerSeatRow {
  seat: string;
  harnesses: string[];
  remote: boolean;
  /** `dark …` for a registered seat that did not answer; null otherwise. */
  caption: string | null;
}

export function peerSeatRows(
  entries: PresenceEntry[],
  peers: PeerStatus[] = [],
  now = Date.now(),
): PeerSeatRow[] {
  const collect = (list: PresenceEntry[], remote: boolean): PeerSeatRow[] => {
    const order: string[] = [];
    const harnesses = new Map<string, string[]>();
    for (const e of list) {
      const seat = (e.seat || '?').trim() || '?';
      if (!harnesses.has(seat)) {
        order.push(seat);
        harnesses.set(seat, []);
      }
      const h = (e.harness || '?').trim() || '?';
      const hs = harnesses.get(seat)!;
      if (!hs.includes(h)) hs.push(h);
    }
    return order.map((seat) => ({
      seat,
      harnesses: harnesses.get(seat) || [],
      remote,
      caption: null,
    }));
  };
  const rows = [
    ...collect(
      entries.filter((e) => !entryIsRemote(e)),
      false,
    ),
    ...collect(
      entries.filter((e) => entryIsRemote(e)),
      true,
    ),
  ];
  for (const p of peers) {
    if (p.answered) continue;
    const when = p.last_answered ? ` · last answered ${formatAgo(p.last_answered, now)}` : '';
    rows.push({
      seat: p.seat,
      harnesses: [],
      remote: true,
      caption: `dark${when}`,
    });
  }
  return rows;
}

export function formatPeerSeatRow(row: PeerSeatRow): string {
  const ids = row.harnesses.join(', ');
  if (row.caption) {
    return ids ? `${row.seat}  ${ids}  ${row.caption}` : `${row.seat}  ${row.caption}`;
  }
  return ids ? `${row.seat}  ${ids}` : row.seat;
}

export function peersFromPayload(j: unknown): {
  line: string;
  detail: string;
  entries: PresenceEntry[];
  peers: PeerStatus[];
} {
  if (!j || typeof j !== 'object') {
    return { line: '0 LIVE', detail: '', entries: [], peers: [] };
  }
  const o = j as PresencePayload;
  const entries = Array.isArray(o.entries) ? o.entries : [];
  const peers = Array.isArray(o.peers) ? o.peers : [];
  if (Array.isArray(o.entries)) {
    return { line: formatPeers(entries, peers), detail: o.detail ?? '', entries, peers };
  }
  return {
    line: typeof o.line === 'string' && o.line.length > 0 ? o.line : '0 LIVE',
    detail: typeof o.detail === 'string' ? o.detail : '',
    entries,
    peers,
  };
}

/** Messages newer than the read cursor. An unset cursor means all unread. */
export function unreadCount(entries: CoordMessage[], readTs: string | null | undefined): number {
  if (!readTs) return entries.length;
  return entries.filter((m) => (m.ts || '') > readTs).length;
}

export function latestMessageTs(entries: CoordMessage[]): string | null {
  let latest: string | null = null;
  for (const m of entries) {
    if (m.ts && (!latest || m.ts > latest)) latest = m.ts;
  }
  return latest;
}

export function mailFromPayload(j: unknown): {
  count: number;
  entries: CoordMessage[];
  lastFrom: string;
  lastText: string;
  lastTs: string | null;
} {
  if (!j || typeof j !== 'object') {
    return { count: 0, entries: [], lastFrom: '', lastText: '', lastTs: null };
  }
  const o = j as { entries?: CoordMessage[] };
  if (!Array.isArray(o.entries) || o.entries.length === 0) {
    return { count: 0, entries: [], lastFrom: '', lastText: '', lastTs: null };
  }
  const last = o.entries[o.entries.length - 1];
  const ident = last?.from
    ? `${last.from.seat || '?'}/${last.from.harness || '?'}`
    : '';
  return {
    count: o.entries.length,
    entries: o.entries,
    lastFrom: ident,
    lastText: last?.text || '',
    lastTs: last?.ts || null,
  };
}
