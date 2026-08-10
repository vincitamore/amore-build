/**
 * Small pure time-reference helper for --since/--until style filters.
 * Relative phrases + ISO / YYYY-MM-DD absolutes. No Allen relations engine.
 */

export interface TimeReference {
  /** Inclusive lower bound (start of resolved window). */
  start: Date;
  /** Exclusive upper bound when the phrase names a range; omit for instants. */
  end?: Date;
  /** Normalized label for the phrase that matched. */
  label: string;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function startOfUtcWeek(d: Date): Date {
  // ISO-ish: Monday = start. getUTCDay: 0 Sun .. 6 Sat
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addUtcDays(startOfUtcDay(d), mondayOffset);
}

/**
 * Resolve a relative or absolute time phrase into a filterable time reference.
 * @param phrase operator input (e.g. "3 days ago", "yesterday", "2026-08-01")
 * @param now reference clock (injectable for tests); defaults to Date.now()
 */
export function resolveTimeReference(
  phrase: string,
  now: Date = new Date(),
): TimeReference | null {
  const raw = phrase.trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();

  if (lower === "just now" || lower === "now") {
    const t = new Date(now.getTime());
    return { start: t, label: "just now" };
  }

  if (lower === "today") {
    const start = startOfUtcDay(now);
    return { start, end: addUtcDays(start, 1), label: "today" };
  }

  if (lower === "yesterday") {
    const start = addUtcDays(startOfUtcDay(now), -1);
    return { start, end: addUtcDays(start, 1), label: "yesterday" };
  }

  if (lower === "last week") {
    const thisWeek = startOfUtcWeek(now);
    const start = addUtcDays(thisWeek, -7);
    return { start, end: thisWeek, label: "last week" };
  }

  if (lower === "last month") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    return { start, end, label: "last month" };
  }

  const daysAgo = /^(\d+)\s+days?\s+ago$/.exec(lower);
  if (daysAgo) {
    const n = Number(daysAgo[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const start = addUtcDays(startOfUtcDay(now), -n);
    return { start, end: addUtcDays(start, 1), label: `${n} days ago` };
  }

  const hoursAgo = /^(\d+)\s+hours?\s+ago$/.exec(lower);
  if (hoursAgo) {
    const n = Number(hoursAgo[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const start = new Date(now.getTime() - n * 3_600_000);
    return { start, label: `${n} hours ago` };
  }

  // YYYY-MM-DD → full UTC calendar day
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const start = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) return null;
    return { start, end: addUtcDays(start, 1), label: raw };
  }

  // Full ISO / Date-parseable absolute
  const abs = new Date(raw);
  if (!Number.isNaN(abs.getTime())) {
    return { start: abs, label: raw };
  }

  return null;
}

/** Convenience: resolve to a single Date (window start), or null. */
export function resolveToDate(phrase: string, now: Date = new Date()): Date | null {
  const ref = resolveTimeReference(phrase, now);
  return ref ? ref.start : null;
}
