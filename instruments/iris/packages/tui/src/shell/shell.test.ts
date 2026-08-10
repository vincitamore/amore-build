import { describe, expect, test } from 'bun:test';
import { resolveInitialMemberIndex } from './Shell';
import { memberBarIsNarrow, memberChipLabel, MEMBER_BAR_NARROW_COLS } from './MemberBar';

describe('resolveInitialMemberIndex', () => {
  test('--member Sessions → index 9 (10th slot)', () => {
    expect(resolveInitialMemberIndex(['--member', 'Sessions'], {})).toBe(9);
  });

  test('env IRIS_MEMBER=Sessions → 9', () => {
    expect(resolveInitialMemberIndex([], { IRIS_MEMBER: 'Sessions' })).toBe(9);
  });

  test('--member=session case-insensitive → 9', () => {
    expect(resolveInitialMemberIndex(['--member=session'], {})).toBe(9);
  });

  test('unknown member → 0 (Dashboard)', () => {
    expect(resolveInitialMemberIndex(['--member', 'NoSuchMember'], {})).toBe(0);
  });

  test('digits 1-9 still map to first nine members (Sessions has no digit)', () => {
    // resolveInitialMemberIndex is name-based; digit nav is shell keyboard — assert slot order.
    expect(resolveInitialMemberIndex(['--member', 'Dashboard'], {})).toBe(0);
    expect(resolveInitialMemberIndex(['--member', 'Graph'], {})).toBe(8);
    expect(resolveInitialMemberIndex(['--member', 'Sessions'], {})).toBe(9);
  });
});

describe('MemberBar narrow mode', () => {
  test(`threshold is ${MEMBER_BAR_NARROW_COLS}: below → narrow, at/above → wide`, () => {
    expect(memberBarIsNarrow(MEMBER_BAR_NARROW_COLS - 1)).toBe(true);
    expect(memberBarIsNarrow(MEMBER_BAR_NARROW_COLS)).toBe(false);
    expect(memberBarIsNarrow(120)).toBe(false);
  });

  test('narrow chips: 1..9 digits + S for Sessions; 1-9 semantics unchanged', () => {
    const names = [
      'Dashboard',
      'Tasks',
      'Inbox',
      'Reminders',
      'Knowledge',
      'Files',
      'Forge',
      'Lucerna',
      'Graph',
      'Sessions',
    ];
    for (let i = 0; i < 9; i++) {
      expect(memberChipLabel(i, names[i]!, true)).toBe(String(i + 1));
    }
    expect(memberChipLabel(9, 'Sessions', true)).toBe('S');
  });

  test('wide chips: numbered names; Sessions is letter-keyed `S Sessions`', () => {
    expect(memberChipLabel(0, 'Dashboard', false)).toBe('1 Dashboard');
    expect(memberChipLabel(8, 'Graph', false)).toBe('9 Graph');
    expect(memberChipLabel(9, 'Sessions', false)).toBe('S Sessions');
  });
});
