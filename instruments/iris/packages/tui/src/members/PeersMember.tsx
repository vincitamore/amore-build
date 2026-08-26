import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { readConfig, writeConfig } from '../config';
import { useRefreshOnActive } from '../use-refresh-on-active';
import {
  MAIL_UNAVAILABLE,
  PRESENCE_UNAVAILABLE,
  formatAgo,
  latestMessageTs,
  mailFromPayload,
  peersFromPayload,
  unreadCount,
  type CoordMessage,
  type PeerStatus,
  type PresenceEntry,
} from '../coord/presence';

/**
 * Peers member — the first-class surface for the coord mesh: the live seat
 * roster (this seat's sessions, every answered peer seat's sessions, dark
 * seats with their last answer) and the full message log with unread
 * tracking. Display-only: sends stay `amore coord send`; the daemon is the
 * single reader and this member renders what it answers.
 */
export function PeersMember({
  inputActive,
  daemonUrl,
}: {
  inputActive?: boolean;
  onCapture?: (b: boolean) => void;
  daemonUrl?: string | null;
}) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const [entries, setEntries] = useState<PresenceEntry[]>([]);
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [peersLine, setPeersLine] = useState(daemonUrl ? '…' : PRESENCE_UNAVAILABLE);
  const [source, setSource] = useState<string>('');
  const [messages, setMessages] = useState<CoordMessage[]>([]);
  const [mailOk, setMailOk] = useState(true);
  const [nonce, setNonce] = useState(0);
  // The unread divider holds at the cursor as it stood when the member was
  // opened; viewing advances the stored cursor for the NEXT visit.
  const cursorAtOpen = useRef<string | null | undefined>(undefined);
  if (cursorAtOpen.current === undefined) {
    cursorAtOpen.current = readConfig().coordReadTs ?? null;
  }

  useEffect(() => {
    if (!daemonUrl) {
      setPeersLine(PRESENCE_UNAVAILABLE);
      setEntries([]);
      setPeers([]);
      setMessages([]);
      setMailOk(false);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${daemonUrl}/api/coord/presence`);
        if (!alive) return;
        if (r.ok) {
          const body = (await r.json()) as { source?: string };
          const p = peersFromPayload(body);
          setPeersLine(p.line);
          setEntries(p.entries);
          setPeers(p.peers);
          setSource(typeof body.source === 'string' ? body.source : '');
        } else {
          setPeersLine(PRESENCE_UNAVAILABLE);
          setEntries([]);
          setPeers([]);
        }
      } catch {
        if (alive) {
          setPeersLine(PRESENCE_UNAVAILABLE);
          setEntries([]);
          setPeers([]);
        }
      }
      try {
        const r = await fetch(`${daemonUrl}/api/coord/messages`);
        if (!alive) return;
        if (r.ok) {
          const mail = mailFromPayload(await r.json());
          setMessages(mail.entries);
          setMailOk(true);
        } else {
          setMessages([]);
          setMailOk(false);
        }
      } catch {
        if (alive) {
          setMessages([]);
          setMailOk(false);
        }
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [daemonUrl, nonce]);

  useRefreshOnActive(inputActive, () => setNonce((x) => x + 1));

  // Viewing marks read: while the member is active, the newest visible ts
  // becomes the stored cursor (the in-view divider keeps the open-time one).
  useEffect(() => {
    if (!inputActive || messages.length === 0) return;
    const latest = latestMessageTs(messages);
    if (!latest) return;
    const cfg = readConfig();
    if ((cfg.coordReadTs ?? '') < latest) {
      writeConfig({ ...cfg, coordReadTs: latest });
    }
  }, [inputActive, messages]);

  useKeyboard((key: { name?: string }) => {
    if (!inputActive) return;
    if ((key.name ?? '').toLowerCase() === 'r') setNonce((x) => x + 1);
  });

  const wide = dims.width >= 96;
  const seatsW = wide ? Math.min(52, Math.max(36, Math.floor(dims.width * 0.4))) : dims.width - 2;
  const msgInnerW = Math.max(
    20,
    (wide ? dims.width - 2 - seatsW - 1 : dims.width - 2) - 5,
  );
  const seatsInnerW = Math.max(20, seatsW - 4);

  const seatBlocks = useMemo(() => buildSeatBlocks(entries, peers), [entries, peers]);
  const newest = [...messages].reverse();
  const unread = unreadCount(messages, cursorAtOpen.current ?? null);

  const seatsPanel = (
    <Panel
      title="Seats"
      headerRight={peersLine}
      flexGrow={wide ? undefined : 0}
      flexShrink={0}
      width={wide ? seatsW : undefined}
    >
      <scrollbox scrollY flexGrow={1} minHeight={0}>
        {seatBlocks.length === 0 ? (
          <text fg={t.muted}>{peersLine === '…' ? 'querying the mesh…' : 'no sessions'}</text>
        ) : (
          seatBlocks.map((b) => (
            <box key={b.seat} flexDirection="column" marginBottom={1}>
              <text fg={b.dark ? t.muted : b.remote ? t.info : t.success} wrapMode="none">
                {`${b.dark ? '○' : '●'} ${b.seat}${b.tagline ? ` — ${b.tagline}` : ''}`}
              </text>
              {b.rows.map((row, i) => (
                <text key={i} fg={row.dim ? t.muted : t.foreground} wrapMode="none">
                  {truncate(`  ${row.text}`, seatsInnerW)}
                </text>
              ))}
            </box>
          ))
        )}
      </scrollbox>
    </Panel>
  );

  const messagesPanel = (
    <Panel
      title="Messages"
      headerRight={
        mailOk
          ? unread > 0
            ? `${messages.length} · ${unread} new`
            : `${messages.length}`
          : MAIL_UNAVAILABLE
      }
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      marginTop={wide ? undefined : 1}
    >
      <scrollbox scrollY flexGrow={1} minHeight={0}>
        {newest.length === 0 ? (
          <text fg={t.muted}>{mailOk ? 'no messages in the coord log' : MAIL_UNAVAILABLE}</text>
        ) : (
          newest.map((m, i) => {
            const isNew = (m.ts || '') > (cursorAtOpen.current ?? '');
            const from = m.from ? `${m.from.seat || '?'}/${m.from.harness || '?'}` : '?';
            const to = m.to ? `${m.to.seat || '?'}/${m.to.harness || '?'}` : '';
            const kind = m.kind && m.kind !== 'message' ? ` [${m.kind}]` : '';
            const when = m.ts ? `${formatAgo(m.ts)} · ${shortStamp(m.ts)}` : '';
            const head = `${isNew ? '● ' : '  '}${when}  ${from}${to ? ` → ${to}` : ''}${kind}`;
            return (
              <box key={m.msgid || i} flexDirection="column" marginBottom={1}>
                <text fg={isNew ? t.warning : t.muted} wrapMode="none">
                  {truncate(head, msgInnerW)}
                </text>
                {wrapText(m.text || '', msgInnerW - 2).map((ln, li) => (
                  <text key={li} fg={t.foreground} wrapMode="none">
                    {`  ${ln}`}
                  </text>
                ))}
              </box>
            );
          })
        )}
      </scrollbox>
    </Panel>
  );

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box
        flexDirection={wide ? 'row' : 'column'}
        flexGrow={1}
        minHeight={0}
      >
        {seatsPanel}
        {wide ? <box width={1} /> : null}
        {messagesPanel}
      </box>
      <box flexShrink={0} paddingLeft={1}>
        <text fg={t.muted} wrapMode="none">
          {truncate(
            `r refresh${source ? ` · source: ${source}` : ''} · send: amore coord send <seat|seat/harness|session> <text>`,
            Math.max(20, dims.width - 4),
          )}
        </text>
      </box>
    </box>
  );
}

interface SeatBlock {
  seat: string;
  remote: boolean;
  dark: boolean;
  tagline: string | null;
  rows: Array<{ text: string; dim: boolean }>;
}

function buildSeatBlocks(entries: PresenceEntry[], peers: PeerStatus[]): SeatBlock[] {
  const blocks: SeatBlock[] = [];
  const bySeat = new Map<string, PresenceEntry[]>();
  const order: string[] = [];
  for (const e of entries) {
    const seat = (e.seat || '?').trim() || '?';
    if (!bySeat.has(seat)) {
      bySeat.set(seat, []);
      order.push(seat);
    }
    bySeat.get(seat)!.push(e);
  }
  // Locals first, then answered remotes (roster order), then dark seats.
  const locals = order.filter((s) => !bySeat.get(s)![0]?.remote);
  const remotes = order.filter((s) => bySeat.get(s)![0]?.remote);
  for (const seat of [...locals, ...remotes]) {
    const list = bySeat.get(seat)!;
    const remote = list[0]?.remote === true;
    blocks.push({
      seat,
      remote,
      dark: false,
      tagline: remote ? 'remote' : 'this seat',
      rows: list.map((e) => ({ text: sessionRow(e), dim: false })),
    });
  }
  for (const p of peers) {
    if (p.answered) {
      // A seat that answered with zero sessions is up, not invisible.
      if (p.sessions === 0) {
        blocks.push({ seat: p.seat, remote: true, dark: false, tagline: 'up · no sessions', rows: [] });
      }
      continue;
    }
    blocks.push({
      seat: p.seat,
      remote: true,
      dark: true,
      tagline: p.last_answered
        ? `dark · last answered ${formatAgo(p.last_answered)}`
        : 'dark',
      rows: p.error ? [{ text: p.error, dim: true }] : [],
    });
  }
  return blocks;
}

function sessionRow(e: PresenceEntry): string {
  const who = e.model ? `${e.harness} · ${e.model}` : e.harness;
  const bits = [`pid ${e.pid ?? '?'}`];
  if (e.tree) bits.push(e.tree);
  if (e.work_unit) bits.push(`unit ${e.work_unit}`);
  if (e.started && e.started.length >= 16) bits.push(`since ${e.started.slice(11, 16)}Z`);
  if (e.socket_tailnet) bits.push('door');
  return `${who}  ${bits.join(' · ')}`;
}

function shortStamp(ts: string): string {
  return ts.length >= 16 ? `${ts.slice(5, 10)} ${ts.slice(11, 16)}Z` : ts;
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return width > 1 ? `${s.slice(0, width - 1)}…` : s.slice(0, width);
}

function wrapText(s: string, width: number): string[] {
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const raw of s.split('\n')) {
    let line = raw;
    while (line.length > w) {
      let cut = line.lastIndexOf(' ', w);
      if (cut < w * 0.5) cut = w;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out.length ? out : [''];
}
