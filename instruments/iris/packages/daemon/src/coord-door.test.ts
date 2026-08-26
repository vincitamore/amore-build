import { describe, expect, test } from 'bun:test';
import { resolveLocalTarget, type Envelope } from './coord-door.ts';
import type { PresenceEntry } from './routes/coord.ts';

type Row = PresenceEntry & { socket_token?: string | null };

const rows: Row[] = [
  {
    seat: 'here',
    harness: 'claude-code',
    pid: 11,
    session_id: 'claude-1',
    socket: '\\\\.\\pipe\\cc-msg-abc',
    socket_token: 't1',
  },
  {
    seat: 'here',
    harness: 'amore',
    pid: 22,
    session_id: 'amore-1',
    socket: 'tcp:127.0.0.1:4000',
    socket_token: 't2',
  },
  { seat: 'there', harness: 'amore', pid: 33, session_id: 'remote-1', socket: 'tcp:127.0.0.1:9', socket_token: 't3' },
];

function env(to: Envelope['to']): Envelope {
  return { msgid: 'm', kind: 'message', text: 'x', to };
}

describe('coord door local routing', () => {
  test('session-id address resolves that exact local session', () => {
    const t = resolveLocalTarget(rows, env({ session_id: 'claude-1' }), 'here');
    expect(t?.pid).toBe(11);
  });

  test('seat address defaults to the first live amore session', () => {
    const t = resolveLocalTarget(rows, env({ seat: 'here' }), 'here');
    expect(t?.pid).toBe(22);
  });

  test('seat/harness address reaches a claude session with no TUI open', () => {
    const noTui = rows.filter((r) => r.harness !== 'amore' || r.seat !== 'here');
    const t = resolveLocalTarget(noTui, env({ seat: 'here', harness: 'claude-code' }), 'here');
    expect(t?.pid).toBe(11);
  });

  test('another seat\'s session never resolves as a local target', () => {
    const t = resolveLocalTarget(rows, env({ session_id: 'remote-1' }), 'here');
    expect(t).toBeNull();
  });

  test('no live route is null, not a guess', () => {
    const t = resolveLocalTarget([], env({ seat: 'here' }), 'here');
    expect(t).toBeNull();
  });
});
