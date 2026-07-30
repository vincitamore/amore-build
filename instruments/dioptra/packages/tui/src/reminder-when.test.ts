import { test, expect } from 'bun:test';
import { toLocalIso, WHEN_PRESETS, formatCountdown, parseLocalDateTime } from './reminder-when';

// A fixed reference instant (local): 2026-06-30 14:30.
const REF = new Date(2026, 5, 30, 14, 30, 0, 0).getTime();

test('toLocalIso emits the local YYYY-MM-DDTHH:mm shape (no timezone suffix)', () => {
  expect(toLocalIso(new Date(2026, 5, 30, 9, 5))).toBe('2026-06-30T09:05');
  expect(toLocalIso(new Date(2026, 11, 1, 0, 0))).toBe('2026-12-01T00:00');
});

test('every when-preset resolves to a future instant past the reference', () => {
  for (const p of WHEN_PRESETS) {
    const iso = p.compute(REF);
    expect(new Date(iso).getTime()).toBeGreaterThan(REF);
  }
});

test('hour presets are exact offsets; day presets pin to 9am', () => {
  const at = (label: string) => WHEN_PRESETS.find((p) => p.label === label)!.compute(REF);
  expect(at('in 1 hour')).toBe('2026-06-30T15:30');
  expect(at('in 3 hours')).toBe('2026-06-30T17:30');
  expect(at('this evening (6pm)')).toBe('2026-06-30T18:00');
  expect(at('tomorrow 9am')).toBe('2026-07-01T09:00');
  expect(at('in 3 days')).toBe('2026-07-03T09:00');
  expect(at('next week')).toBe('2026-07-07T09:00');
});

test('formatCountdown reads future as "in …" and past as "… overdue"', () => {
  expect(formatCountdown('2026-06-30T16:30', REF)).toEqual({ text: 'in 2h', overdue: false });
  expect(formatCountdown('2026-07-03T14:30', REF)).toEqual({ text: 'in 3d', overdue: false });
  expect(formatCountdown('2026-06-30T14:45', REF)).toEqual({ text: 'in 15m', overdue: false });
  expect(formatCountdown('2026-06-30T13:30', REF)).toEqual({ text: '1h overdue', overdue: true });
  expect(formatCountdown('2026-06-28T14:30', REF)).toEqual({ text: '2d overdue', overdue: true });
});

test('parseLocalDateTime accepts the org shape, a space separator, date-only, and am/pm', () => {
  expect(parseLocalDateTime('2026-07-15T14:30')).toBe('2026-07-15T14:30');
  expect(parseLocalDateTime('2026-07-15 14:30')).toBe('2026-07-15T14:30');
  expect(parseLocalDateTime('  2026-07-15 14:30  ')).toBe('2026-07-15T14:30'); // trimmed
  expect(parseLocalDateTime('2026-07-15')).toBe('2026-07-15T09:00'); // date-only → 9am
  expect(parseLocalDateTime('2026-7-5 9:05')).toBe('2026-07-05T09:05'); // single-digit fields
  expect(parseLocalDateTime('2026-07-15 2:30pm')).toBe('2026-07-15T14:30');
  expect(parseLocalDateTime('2026-07-15 12:00am')).toBe('2026-07-15T00:00'); // midnight
  expect(parseLocalDateTime('2026-07-15 12:00pm')).toBe('2026-07-15T12:00'); // noon
});

test('parseLocalDateTime rejects garbage, out-of-range, and rolled-over dates', () => {
  expect(parseLocalDateTime('')).toBeNull();
  expect(parseLocalDateTime('next tuesday')).toBeNull();
  expect(parseLocalDateTime('07/15/2026')).toBeNull();
  expect(parseLocalDateTime('2026-13-01')).toBeNull(); // month 13
  expect(parseLocalDateTime('2026-02-30')).toBeNull(); // rolled-over day
  expect(parseLocalDateTime('2026-07-15 25:00')).toBeNull(); // hour 25
  expect(parseLocalDateTime('2026-07-15 14:60')).toBeNull(); // minute 60
  expect(parseLocalDateTime('2026-07-15 13:00pm')).toBeNull(); // 13 with pm
});

test('formatCountdown is empty for missing / unparseable timestamps', () => {
  expect(formatCountdown(null, REF)).toEqual({ text: '', overdue: false });
  expect(formatCountdown(undefined, REF)).toEqual({ text: '', overdue: false });
  expect(formatCountdown('not-a-date', REF)).toEqual({ text: '', overdue: false });
});
