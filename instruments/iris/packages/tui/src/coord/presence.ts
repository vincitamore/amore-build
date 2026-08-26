// Pulse display for GET /api/coord/presence and /api/coord/messages.
// Display-only: the daemon is the single roster reader. iris hides, never unlinks.

export const PRESENCE_UNAVAILABLE = 'presence unavailable';
export const MAIL_UNAVAILABLE = 'mail unavailable';

/** House roster cutoff: a remote older than this stops counting as LIVE. */
export const REMOTE_STALE_HOURS = 12;

export interface PresenceEntry {
  seat: string;
  harness: string;
  model?: string | null;
  pid?: number;
  tree?: string;
  started?: string;
  work_unit?: string | null;
  session_id?: string | null;
  /** Daemon-tagged: this row is another seat (not PID-probed here). */
  remote?: boolean;
  stale?: boolean;
  ageHours?: number;
  mtime?: number;
  mtimeMs?: number;
  _remote?: boolean;
  _stale?: boolean;
  _age_hours?: number;
}

export interface PresencePayload {
  entries?: PresenceEntry[];
  line?: string;
  detail?: string;
}

export interface CoordMessage {
  msgid?: string;
  kind?: string;
  ts?: string;
  from?: { seat?: string; harness?: string; session_id?: string };
  text?: string;
}

export function entryIsRemote(e: PresenceEntry): boolean {
  return e.remote === true || e._remote === true;
}

export function entryAgeHours(e: PresenceEntry, now = Date.now()): number {
  if (typeof e.ageHours === 'number' && Number.isFinite(e.ageHours)) {
    return Math.max(0, e.ageHours);
  }
  if (typeof e._age_hours === 'number' && Number.isFinite(e._age_hours)) {
    return Math.max(0, e._age_hours);
  }
  const mt = e.mtimeMs ?? e.mtime;
  if (typeof mt === 'number' && Number.isFinite(mt) && mt > 0) {
    return Math.max(0, (now - mt) / 3_600_000);
  }
  return 0;
}

export function entryIsStale(e: PresenceEntry, now = Date.now()): boolean {
  if (e.stale === true || e._stale === true) return true;
  if (!entryIsRemote(e)) return false;
  return entryAgeHours(e, now) > REMOTE_STALE_HOURS;
}

/** Coarsen hours to glanceable `Xm ago` / `Xh ago` / `Xd ago`. */
export function formatRemoteAge(ageHours: number): string {
  let h = ageHours;
  if (!Number.isFinite(h) || h < 0) h = 0;
  const minutes = Math.floor(h * 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** House roster vocabulary: `remote, seen …` past cutoff, else `remote, as of …`. */
export function formatRemoteCaption(e: PresenceEntry, now = Date.now()): string | null {
  if (!entryIsRemote(e)) return null;
  const age = formatRemoteAge(entryAgeHours(e, now));
  return entryIsStale(e, now) ? `remote, seen ${age}` : `remote, as of ${age}`;
}

export function formatPeers(entries: PresenceEntry[], now = Date.now()): string {
  const live = entries.filter((e) => !entryIsRemote(e) && !entryIsStale(e, now)).length;
  const remote = entries.filter((e) => entryIsRemote(e)).length;
  if (live === 0 && remote === 0) return '0 LIVE';
  if (remote === 0) return `${live} LIVE`;
  return `${live} LIVE · ${remote} remote-reported`;
}

export function formatPeersDetail(entries: PresenceEntry[], now = Date.now()): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => {
      const ident = `${e.seat || '?'}/${e.harness || '?'}`;
      const cap = formatRemoteCaption(e, now);
      return cap ? `${ident} (${cap})` : ident;
    })
    .join(' · ');
}

export function peersFromPayload(j: unknown, now = Date.now()): { line: string; detail: string } {
  if (!j || typeof j !== 'object') return { line: '0 LIVE', detail: '' };
  const o = j as PresencePayload;
  if (Array.isArray(o.entries)) {
    return { line: formatPeers(o.entries, now), detail: formatPeersDetail(o.entries, now) };
  }
  return {
    line: typeof o.line === 'string' && o.line.length > 0 ? o.line : '0 LIVE',
    detail: typeof o.detail === 'string' ? o.detail : '',
  };
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

export function messagesFromPayload(j: unknown): string {
  if (!j || typeof j !== 'object') return 'none';
  const o = j as { line?: string; entries?: CoordMessage[] };
  if (typeof o.line === 'string' && o.line.length > 0) return o.line;
  if (Array.isArray(o.entries)) return formatMessages(o.entries);
  return 'none';
}
