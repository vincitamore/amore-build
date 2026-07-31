/**
 * Reminder timing helpers — shared by the Reminders member's snooze picker, the create
 * modal, and the row countdowns. The org stores `remind-at` / `snoozed-until` as local
 * `YYYY-MM-DDTHH:mm` strings (no timezone suffix), so all formatting round-trips that shape.
 */

/** Format a Date to the local `YYYY-MM-DDTHH:mm` shape the org uses for reminder timestamps. */
export function toLocalIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const HOUR = 3_600_000;

function plus(now: number, ms: number): string {
  return toLocalIso(new Date(now + ms));
}

/** A future instant `addDays` from `now`, pinned to a wall-clock `hour:min`. */
function atHour(now: number, addDays: number, hour: number, min = 0): string {
  const d = new Date(now);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, min, 0, 0);
  return toLocalIso(d);
}

export interface WhenPreset {
  label: string;
  compute: (now: number) => string;
}

/** Relative-time presets offered by both the snooze picker and the create modal. */
export const WHEN_PRESETS: WhenPreset[] = [
  { label: 'in 1 hour', compute: (n) => plus(n, HOUR) },
  { label: 'in 3 hours', compute: (n) => plus(n, 3 * HOUR) },
  { label: 'this evening (6pm)', compute: (n) => atHour(n, 0, 18) },
  { label: 'tomorrow 9am', compute: (n) => atHour(n, 1, 9) },
  { label: 'in 3 days', compute: (n) => atHour(n, 3, 9) },
  { label: 'next week', compute: (n) => atHour(n, 7, 9) },
];

/**
 * Parse a hand-typed local date/time into the org's `YYYY-MM-DDTHH:mm` shape, or null if it
 * isn't a real instant. Accepts `YYYY-MM-DD` (defaults to 09:00), `YYYY-MM-DD HH:mm`, the `T`
 * separator, and an optional `am`/`pm` suffix — e.g. `2026-07-15`, `2026-07-15 14:30`,
 * `2026-07-15 2:30pm`. Rolled-over dates (2026-02-30) are rejected, not silently normalized.
 */
export function parseLocalDateTime(input: string): string | null {
  const s = input.trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ tT]+(\d{1,2}):(\d{2})\s*([ap]m)?)?$/i);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ap] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  let h = hs ? Number(hs) : 9;
  const mi = mis ? Number(mis) : 0;
  if (ap) {
    if (h < 1 || h > 12) return null;
    const meridiem = ap.toLowerCase();
    if (meridiem === 'pm' && h !== 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  // Reject inputs the Date constructor would roll over (e.g. Feb 30 → Mar 2).
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return toLocalIso(dt);
}

/**
 * Relative countdown for a target instant: `in 2h`, `in 3d`, `45m overdue`. Returns the
 * `overdue` flag so the caller can tone the row (red) and pin it to the top of its group.
 */
export function formatCountdown(targetIso: string | null | undefined, now: number): { text: string; overdue: boolean } {
  if (!targetIso) return { text: '', overdue: false };
  const ts = new Date(targetIso).getTime();
  if (Number.isNaN(ts)) return { text: '', overdue: false };
  const diff = ts - now;
  const overdue = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60_000);
  let body: string;
  if (mins < 60) body = `${Math.max(1, mins)}m`;
  else if (mins < 1440) body = `${Math.round(mins / 60)}h`;
  else body = `${Math.round(mins / 1440)}d`;
  return { text: overdue ? `${body} overdue` : `in ${body}`, overdue };
}
