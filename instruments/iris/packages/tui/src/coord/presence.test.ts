import { describe, expect, test } from 'bun:test';
import { formatLucernaDisplayLine } from '../members/lucerna-display';
import {
  MAIL_UNAVAILABLE,
  PRESENCE_UNAVAILABLE,
  formatAgo,
  formatPeerSeatRow,
  formatPeers,
  latestMessageTs,
  mailFromPayload,
  peerSeatRows,
  peersFromPayload,
  unreadCount,
  type PeerStatus,
  type PresenceEntry,
} from './presence';

const NOW = Date.parse('2026-08-25T12:00:00Z');

function local(seat: string, harness: string): PresenceEntry {
  return { seat, harness, pid: 1 };
}

function remote(seat: string, harness: string, extra: Partial<PresenceEntry> = {}): PresenceEntry {
  return { seat, harness, pid: 9, remote: true, ...extra };
}

function dark(seat: string, lastAnsweredMsAgo?: number): PeerStatus {
  return {
    seat,
    answered: false,
    sessions: 0,
    error: 'connect timed out',
    last_answered:
      lastAnsweredMsAgo === undefined ? null : new Date(NOW - lastAnsweredMsAgo).toISOString(),
  };
}

describe('Pulse presence display', () => {
  test('empty roster is 0 LIVE', () => {
    expect(formatPeers([])).toBe('0 LIVE');
    expect(peerSeatRows([])).toEqual([]);
  });

  test('untagged entries count as LIVE (files-mode payload)', () => {
    const entries = [local('here', 'amore'), local('here', 'claude-code')];
    expect(formatPeers(entries)).toBe('2 LIVE');
  });

  test('remote rows were answered live; head counts them as remote', () => {
    const entries = [
      local('here', 'amore'),
      local('here', 'claude-code'),
      remote('there', 'amore'),
    ];
    expect(formatPeers(entries)).toBe('2 LIVE · 1 remote');
  });

  test('dark registered seat shows in the head and as a captioned row', () => {
    const entries = [local('here', 'amore')];
    const peers = [dark('elsewhere', 2 * 3600 * 1000)];
    expect(formatPeers(entries, peers)).toBe('1 LIVE · 1 dark');
    const rows = peerSeatRows(entries, peers, NOW);
    const darkRow = rows.find((r) => r.seat === 'elsewhere');
    expect(darkRow?.caption).toBe('dark · last answered 2h ago');
    expect(formatPeerSeatRow(darkRow!)).toBe('elsewhere  dark · last answered 2h ago');
  });

  test('dark seat with no cached answer still renders', () => {
    const rows = peerSeatRows([], [dark('elsewhere')], NOW);
    expect(rows[0]?.caption).toBe('dark');
  });

  test('N=4 long identities: one row per seat, truncated per row', () => {
    const entries = [
      local('very-long-seat-alpha', 'claude-code'),
      local('very-long-seat-beta', 'cursor-agent'),
      remote('very-long-seat-gamma', 'amore-session'),
      remote('very-long-seat-delta', 'claude-code'),
    ];
    const rows = peerSeatRows(entries, []);
    expect(rows).toHaveLength(4);
    const inner = 44;
    const cell = formatLucernaDisplayLine(
      `   ${formatPeerSeatRow(rows[0]!)}${'x'.repeat(60)}`,
      inner,
      '/tmp',
    );
    expect(cell.length).toBe(inner);
    expect(cell.endsWith('…')).toBe(true);
  });

  test('peersFromPayload recomputes the line from entries + peers', () => {
    const j = {
      line: '9 LIVE',
      detail: 'kept',
      entries: [local('here', 'amore'), remote('there', 'amore')],
      peers: [dark('elsewhere')],
    };
    const p = peersFromPayload(j);
    expect(p.line).toBe('1 LIVE · 1 remote · 1 dark');
    expect(p.entries).toHaveLength(2);
    expect(p.peers).toHaveLength(1);
  });

  test('peersFromPayload falls back to line/detail without entries', () => {
    const p = peersFromPayload({ line: '3 LIVE', detail: 'a/b · c/d' });
    expect(p.line).toBe('3 LIVE');
    expect(p.detail).toBe('a/b · c/d');
    expect(peersFromPayload(null).line).toBe('0 LIVE');
  });

  test('unavailable tokens are the loud daemon-down copy', () => {
    expect(PRESENCE_UNAVAILABLE).toBe('presence unavailable');
    expect(MAIL_UNAVAILABLE).toBe('mail unavailable');
  });
});

describe('formatAgo', () => {
  test('coarsens to m/h/d', () => {
    expect(formatAgo(new Date(NOW).toISOString(), NOW)).toBe('0m ago');
    expect(formatAgo(new Date(NOW - 30 * 60_000).toISOString(), NOW)).toBe('30m ago');
    expect(formatAgo(new Date(NOW - 90 * 60_000).toISOString(), NOW)).toBe('1h ago');
    expect(formatAgo(new Date(NOW - 25 * 3600_000).toISOString(), NOW)).toBe('1d ago');
  });
});

describe('mail payload + unread cursor', () => {
  const entries = [
    { msgid: 'a', ts: '2026-08-25T10:00:00Z', from: { seat: 'x', harness: 'amore' }, text: 'one' },
    { msgid: 'b', ts: '2026-08-25T11:00:00Z', from: { seat: 'y', harness: 'amore' }, text: 'two' },
  ];

  test('mailFromPayload carries full entries and last-message fields', () => {
    const m = mailFromPayload({ entries });
    expect(m.count).toBe(2);
    expect(m.lastFrom).toBe('y/amore');
    expect(m.lastText).toBe('two');
    expect(m.lastTs).toBe('2026-08-25T11:00:00Z');
    expect(m.entries).toHaveLength(2);
  });

  test('unreadCount is cursor-relative; unset cursor means all unread', () => {
    expect(unreadCount(entries, null)).toBe(2);
    expect(unreadCount(entries, '2026-08-25T10:00:00Z')).toBe(1);
    expect(unreadCount(entries, '2026-08-25T11:00:00Z')).toBe(0);
    expect(latestMessageTs(entries)).toBe('2026-08-25T11:00:00Z');
  });
});
