// coord-door.ts — the seat door, held by the daemon when no amore session
// holds it (operator ruling 2026-08-26).
//
// A seat must be answerable whenever any session on it is live — a machine
// full of other-harness sessions and no TUI is not "0 LIVE". The door is the
// tailnet TLS listener on the coord port; amore sessions and this daemon
// both keep trying to bind it (30s retry), first binder wins, and takeover
// on the holder's exit is automatic. Both present the SAME persisted leaf
// (`~/.house/coord/tls/cert.der` + `key.der`), so peers' TOFU pins hold no
// matter who answers.
//
// Wire protocol (line-JSON, mirrors the native door in coord/socket.rs):
//   {"type":"auth","token":…}            house token, first line
//   {"type":"roster"}                    → {"ok":true,"roster":[…]}  (local
//                                          sessions, loopback tokens stripped)
//   {"type":"send","envelope":…}         → forward to the addressed LOCAL
//                                          session's loopback socket; the
//                                          daemon never self-injects — with
//                                          no live route it answers an error
//                                          and the sender degrades to inbox.
// Sources are admitted only from this node's own Tailscale IPv4 or a
// seats-file peer's. Never bound off the Tailscale address.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { coordRoot, localSeat, readLocalRoster, type PresenceEntry } from './routes/coord.ts';

export const COORD_PORT = 3856;
const RETRY_MS = 30_000;
const FORWARD_TIMEOUT_MS = 3_000;

interface Party {
  seat?: string;
  harness?: string;
  model?: string | null;
  session_id?: string | null;
}

export interface Envelope {
  msgid?: string;
  kind?: string;
  ts?: string;
  from?: Party;
  to?: Party | null;
  text?: string;
}

interface WireIn {
  type?: string;
  token?: string;
  envelope?: Envelope;
}

function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function readTlsMaterial(): { cert: string; key: string; token: string } | null {
  try {
    const root = coordRoot();
    const cert = readFileSync(join(root, 'tls', 'cert.der'));
    const key = readFileSync(join(root, 'tls', 'key.der'));
    const token = readFileSync(join(root, 'tls', 'token'), 'utf8').trim();
    if (!token) return null;
    return {
      cert: derToPem(cert, 'CERTIFICATE'),
      key: derToPem(key, 'PRIVATE KEY'),
      token,
    };
  } catch {
    // The native side mints the leaf + token the first time a session holds
    // the door on this seat; until then the daemon cannot present the pinned
    // identity and must not answer with a different one.
    return null;
  }
}

interface TailnetInfo {
  selfIp: string | null;
  peerIps: Set<string>;
}

function tailnetInfo(): TailnetInfo {
  try {
    const r = spawnSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0 || !r.stdout) return { selfIp: null, peerIps: new Set() };
    const v = JSON.parse(r.stdout) as {
      Self?: { TailscaleIPs?: string[] };
      Peer?: Record<string, { TailscaleIPs?: string[] }>;
    };
    const first4 = (ips?: string[]) => (ips ?? []).find((ip) => ip.includes('.')) ?? null;
    const selfIp = first4(v.Self?.TailscaleIPs);
    const peerIps = new Set<string>();
    for (const p of Object.values(v.Peer ?? {})) {
      const ip = first4(p.TailscaleIPs);
      if (ip) peerIps.add(ip);
    }
    return { selfIp, peerIps };
  } catch {
    return { selfIp: null, peerIps: new Set() };
  }
}

function isCgnat(ip: string): boolean {
  const m = ip.match(/^100\.(\d+)\./);
  if (!m) return false;
  const o = Number(m[1]);
  return o >= 64 && o <= 127;
}

export function rosterAnswer(): PresenceEntry[] {
  return readLocalRoster().map((e) => ({ ...e, socket_token: undefined })) as PresenceEntry[];
}

/** Resolve the addressed LOCAL session for a send. Mirrors the native door:
 * session-id first; else first live session of the addressed harness. */
export function resolveLocalTarget(
  entries: Array<PresenceEntry & { socket_token?: string | null }>,
  env: Envelope,
  me: string,
): (PresenceEntry & { socket_token?: string | null }) | null {
  const to = env.to ?? undefined;
  const locals = entries.filter((e) => (e.seat || '').toLowerCase() === me);
  const sid = to?.session_id;
  if (sid) {
    return locals.find((e) => e.session_id === sid) ?? null;
  }
  const harness = (to?.harness || 'amore').toLowerCase();
  return locals.find((e) => (e.harness || '').toLowerCase() === harness && e.socket) ?? null;
}

function wrapPrompt(env: Envelope): string {
  const fr = env.from;
  const ident = fr
    ? `${fr.seat || '?'}/${fr.harness || '?'}/${fr.session_id || '-'}`
    : '?';
  return `<cross-session-message from="${ident}">\n${env.text ?? ''}\n</cross-session-message>`;
}

function connectLocal(addr: string): net.Socket | null {
  if (addr.startsWith('unix:')) return net.connect(addr.slice('unix:'.length));
  if (addr.startsWith('tcp:')) {
    const hostport = addr.slice('tcp:'.length);
    const idx = hostport.lastIndexOf(':');
    return net.connect(Number(hostport.slice(idx + 1)), hostport.slice(0, idx));
  }
  const pipe = addr.startsWith('pipe:') ? addr.slice('pipe:'.length) : addr;
  if (pipe.startsWith('\\\\.\\pipe\\') || pipe.startsWith('//./pipe/')) {
    return net.connect(pipe);
  }
  return null;
}

/** Forward an envelope to a local session's loopback socket and report the
 * disposition. Amore sessions speak {send, envelope}; other harnesses take
 * the wrapped text frame (their empty reply means enqueued). */
function forwardSend(
  target: PresenceEntry & { socket_token?: string | null },
  env: Envelope,
): Promise<{ ok: boolean; disposition?: string; error?: string }> {
  return new Promise((resolve) => {
    const addr = target.socket;
    const token = target.socket_token;
    if (!addr || !token) {
      resolve({ ok: false, error: `session ${target.session_id ?? target.pid} has no loopback socket` });
      return;
    }
    const sock = connectLocal(addr);
    if (!sock) {
      resolve({ ok: false, error: `unknown socket addr: ${addr}` });
      return;
    }
    // The frame is chosen by target harness: amore speaks {send, envelope};
    // every other harness takes its own user frame — {type:"user", message:
    // {role, content}} (the listener's documented inject contract; a
    // type:"text" frame is silently ignored). Delivery into a session that
    // bypasses permission prompts additionally needs crossSessionInbound:
    // "accept" in that harness's settings.
    const amore = (target.harness || '').toLowerCase() === 'amore';
    const auth = JSON.stringify({ type: 'auth', token });
    const body = amore
      ? JSON.stringify({ type: 'send', envelope: env })
      : JSON.stringify({ type: 'user', message: { role: 'user', content: wrapPrompt(env) } });
    let buf = '';
    let done = false;
    const finish = (r: { ok: boolean; disposition?: string; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => {
      // Text-frame peers often write no reply; a quiet hop is an enqueue.
      finish(amore ? { ok: false, error: 'forward timed out' } : { ok: true, disposition: 'enqueued' });
    }, FORWARD_TIMEOUT_MS);
    sock.on('error', (e) => finish({ ok: false, error: `forward to ${addr}: ${e.message}` }));
    sock.on('connect', () => {
      sock.write(`${auth}\n${body}\n`);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      if (!line) return;
      try {
        const r = JSON.parse(line) as { ok?: boolean; disposition?: string; error?: string; type?: string; data?: string };
        if (typeof r.ok === 'boolean') {
          finish(r.ok ? { ok: true, disposition: r.disposition } : { ok: false, error: r.error ?? 'send failed' });
        } else if (r.type === 'response') {
          finish({ ok: true, disposition: 'enqueued' });
        } else if (r.type === 'error') {
          finish({ ok: false, error: r.data ?? 'peer error' });
        } else {
          finish({ ok: false, error: `unknown peer reply: ${line.slice(0, 80)}` });
        }
      } catch {
        finish({ ok: false, error: `unparseable peer reply: ${line.slice(0, 80)}` });
      }
    });
    sock.on('close', () => {
      finish(amore ? { ok: false, error: 'forward closed without reply' } : { ok: true, disposition: 'enqueued' });
    });
  });
}

function handleConnection(sock: tls.TLSSocket, token: string, admitted: boolean): void {
  let authed = false;
  let buf = '';
  const write = (obj: unknown) => {
    try {
      sock.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* peer gone */
    }
  };
  if (!admitted) {
    write({ ok: false, error: 'source not admitted' });
    sock.end();
    return;
  }
  sock.on('error', () => sock.destroy());
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed: WireIn;
      try {
        parsed = JSON.parse(line) as WireIn;
      } catch {
        continue;
      }
      if (parsed.type === 'auth') {
        authed = parsed.token === token;
        continue;
      }
      if (parsed.type !== 'send' && parsed.type !== 'roster') continue;
      if (!authed) {
        write({ ok: false, error: 'auth required' });
        sock.end();
        return;
      }
      if (parsed.type === 'roster') {
        write({ ok: true, roster: rosterAnswer() });
        sock.end();
        return;
      }
      const env = parsed.envelope;
      if (!env) continue;
      const me = localSeat();
      const target = resolveLocalTarget(
        readLocalRoster() as Array<PresenceEntry & { socket_token?: string | null }>,
        env,
        me,
      );
      if (!target) {
        write({ ok: false, error: 'no live session for that address on this seat' });
        sock.end();
        return;
      }
      void forwardSend(target, env).then((r) => {
        write(r.ok ? { ok: true, disposition: r.disposition ?? 'enqueued' } : { ok: false, error: r.error });
        sock.end();
      });
      return;
    }
  });
}

export interface CoordDoor {
  stop: () => void;
}

/** Keep trying to hold the seat door; an amore session that already holds it
 * wins (EADDRINUSE → retry), and when it exits the daemon takes over within
 * one retry interval. Fail-soft: missing TLS material or no tailnet address
 * just means try again later. */
export function startCoordDoor(log: (msg: string) => void = () => {}): CoordDoor {
  let stopped = false;
  let server: tls.Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let holding = false;

  const attempt = (): void => {
    if (stopped || server) return;
    // Isolated rosters (tests) and scratch daemons (e2e harnesses) must
    // never hold the machine's real door.
    if (process.env.HOUSE_COORD_DIR || process.env.IRIS_NO_COORD_DOOR) return;
    const material = readTlsMaterial();
    const nets = tailnetInfo();
    if (!material || !nets.selfIp) {
      schedule();
      return;
    }
    const selfIp = nets.selfIp;
    const srv = tls.createServer({ cert: material.cert, key: material.key }, (sock) => {
      const remote = sock.remoteAddress?.replace(/^::ffff:/, '') ?? '';
      const admitted =
        remote === selfIp || (isCgnat(remote) && (nets.peerIps.has(remote) || tailnetInfo().peerIps.has(remote)));
      handleConnection(sock, material.token, admitted);
    });
    srv.on('error', (e: NodeJS.ErrnoException) => {
      if (holding) log(`coord door lost: ${e.message}`);
      holding = false;
      server = null;
      try {
        srv.close();
      } catch {
        /* already down */
      }
      schedule();
    });
    srv.listen(COORD_PORT, selfIp, () => {
      holding = true;
      server = srv;
      log(`coord door held on ${selfIp}:${COORD_PORT} (daemon keeper)`);
    });
  };

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      attempt();
    }, RETRY_MS);
  };

  attempt();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        server?.close();
      } catch {
        /* best-effort */
      }
      server = null;
    },
  };
}
