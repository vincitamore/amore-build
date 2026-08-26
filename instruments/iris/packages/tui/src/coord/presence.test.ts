import { describe, expect, test } from 'bun:test';
import { formatLucernaDisplayLine } from '../members/lucerna-display';
import {
  MAIL_UNAVAILABLE,
  PRESENCE_UNAVAILABLE,
  REMOTE_STALE_HOURS,
  entryIsStale,
  formatMessages,
  formatPeerSeatRow,
  formatPeers,
  formatPeersDetail,
  formatRemoteAge,
  formatRemoteCaption,
  messagesFromPayload,
  peerSeatRows,
  peersFromPayload,
  type PresenceEntry,
} from './presence';

const NOW = Date.parse('2026-08-25T12:00:00Z');

function local(seat: string, harness: string): PresenceEntry {
  return { seat, harness, pid: 1 };
}

function remote(
  seat: string,
  harness: string,
  hours: number,
  extra: Partial<PresenceEntry> = {},
): PresenceEntry {
  return {
    seat,
    harness,
    pid: 9,
    remote: true,
    ageHours: hours,
    stale: hours > REMOTE_STALE_HOURS,
    ...extra,
  };
}

describe('Pulse presence display', () => {
  test('empty roster is 0 LIVE with blank identities', () => {
    expect(formatPeers([])).toBe('0 LIVE');
    expect(formatPeersDetail([])).toBe('');
  });

  test('untagged entries count as LIVE (legacy daemon payload)', () => {
    const entries = [local('here', 'amore'), local('here', 'claude-code')];
    expect(formatPeers(entries)).toBe('2 LIVE');
    expect(formatPeersDetail(entries)).toBe('here amore, claude-code');
  });

  test('count on the label; identities on the detail line', () => {
    const entries = [
      local('here', 'amore'),
      local('here', 'claude-code'),
      remote('there', 'amore', 0.25),
    ];
    expect(formatPeers(entries, NOW)).toBe('2 LIVE · 1 remote-reported');
    expect(formatPeersDetail(entries, NOW)).toBe(
      'here amore, claude-code · there amore (as of 15m ago)',
    );
  });

  test('stale remote is remote-reported, never LIVE, captioned seen', () => {
    const entries = [remote('there', 'amore', 13)];
    expect(formatPeers(entries, NOW)).toBe('0 LIVE · 1 remote-reported');
    expect(formatRemoteCaption(entries[0]!, NOW)).toBe('remote, seen 13h ago');
    expect(formatPeersDetail(entries, NOW)).toContain('seen 13h ago');
    expect(formatPeersDetail(entries, NOW)).not.toMatch(/^\d+ LIVE/);
  });

  test('fresh remote uses as of, not seen', () => {
    const e = remote('there', 'cursor', 0.5);
    expect(formatRemoteCaption(e, NOW)).toBe('remote, as of 30m ago');
    expect(entryIsStale(e, NOW)).toBe(false);
  });

  test('ageHours past cutoff implies stale without an explicit flag', () => {
    const e: PresenceEntry = { seat: 'there', harness: 'amore', remote: true, ageHours: 12.1 };
    expect(entryIsStale(e, NOW)).toBe(true);
    expect(formatRemoteCaption(e, NOW)).toBe('remote, seen 12h ago');
  });

  test('mtimeMs ages a remote when ageHours is absent', () => {
    const e: PresenceEntry = {
      seat: 'there',
      harness: 'amore',
      remote: true,
      mtimeMs: NOW - 45 * 60_000,
    };
    expect(formatRemoteCaption(e, NOW)).toBe('remote, as of 45m ago');
  });

  test('house-shaped _remote/_stale/_age_hours aliases', () => {
    const e: PresenceEntry = {
      seat: 'there',
      harness: 'amore',
      _remote: true,
      _stale: true,
      _age_hours: 20,
    };
    expect(formatPeers([e], NOW)).toBe('0 LIVE · 1 remote-reported');
    expect(formatRemoteCaption(e, NOW)).toBe('remote, seen 20h ago');
  });

  test('N=4 long identities truncate to panel inner width with ellipsis', () => {
    const entries = [
      local('very-long-seat-alpha', 'claude-code'),
      local('very-long-seat-beta', 'cursor-agent'),
      remote('very-long-seat-gamma', 'amore-session', 0.2),
      remote('very-long-seat-delta', 'claude-code', 14),
    ];
    const detail = formatPeersDetail(entries, NOW);
    expect(detail.split(' · ')).toHaveLength(4);
    expect(detail).not.toContain('\n');
    const inner = 44;
    const cell = formatLucernaDisplayLine(`   ${detail}`, inner, '/tmp');
    expect(cell.length).toBe(inner);
    expect(cell.endsWith('\u2026')).toBe(true);
    expect(cell).not.toContain('very-long-seat-delta');
  });

  test('peersFromPayload prefers entries when present', () => {
    const j = {
      line: '9 LIVE',
      detail: 'ignored',
      entries: [local('here', 'amore'), remote('there', 'amore', 13)],
    };
    expect(peersFromPayload(j, NOW)).toEqual({
      line: '1 LIVE · 1 remote-reported',
      detail: 'here amore · there amore (seen 13h ago)',
    });
  });

  test('peersFromPayload falls back to line/detail without entries', () => {
    expect(peersFromPayload({ line: '3 LIVE', detail: 'a/b · c/d' })).toEqual({
      line: '3 LIVE',
      detail: 'a/b · c/d',
    });
    expect(peersFromPayload(null)).toEqual({ line: '0 LIVE', detail: '' });
  });

  test('unavailable tokens are the loud daemon-down copy', () => {
    expect(PRESENCE_UNAVAILABLE).toBe('presence unavailable');
    expect(MAIL_UNAVAILABLE).toBe('mail unavailable');
  });
});

describe('formatRemoteAge', () => {
  test('coarsens to m/h/d', () => {
    expect(formatRemoteAge(0)).toBe('0m ago');
    expect(formatRemoteAge(0.5)).toBe('30m ago');
    expect(formatRemoteAge(1.5)).toBe('1h ago');
    expect(formatRemoteAge(25)).toBe('1d ago');
  });
});

describe('messagesFromPayload', () => {
  test('uses line when entries missing', () => {
    expect(messagesFromPayload({ line: '2 · last here/amore: hi' })).toBe(
      '2 · last here/amore: hi',
    );
  });

  test('formats entries in full (no 48-char slice)', () => {
    const text = 'x'.repeat(60);
    expect(
      messagesFromPayload({
        line: 'ignored',
        entries: [{ from: { seat: 'here', harness: 'amore' }, text, ts: 't' }],
      }),
    ).toBe(`1 · last here/amore: ${text}`);
    expect(formatMessages([])).toBe('none');
  });
});

describe('peerSeatRows', () => {
  test('locals first, harnesses grouped, remotes captioned', () => {
    const rows = peerSeatRows(
      [
        local('admin-pc', 'amore'),
        local('admin-pc', 'claude-code'),
        remote('amore-dev-laptop', 'amore', 0.2),
      ],
      NOW,
    );
    expect(rows.map((r) => r.seat)).toEqual(['admin-pc', 'amore-dev-laptop']);
    expect(rows[0]?.harnesses).toEqual(['amore', 'claude-code']);
    expect(rows[0]?.remote).toBe(false);
    expect(formatPeerSeatRow(rows[0]!)).toBe('admin-pc  amore, claude-code');
    expect(formatPeerSeatRow(rows[1]!)).toContain('amore-dev-laptop');
    expect(formatPeerSeatRow(rows[1]!)).toContain('as of 12m ago');
  });
});
