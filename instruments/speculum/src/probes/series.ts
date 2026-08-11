/**
 * Windowed probe series: run registered probes over contiguous time windows
 * so rates can be trended. Each window reuses the existing probe functions
 * with since/until options — no probe logic is reimplemented here.
 */

import type { Db } from "../store/db";
import { runProbe } from "./index";
import type { ProbeOptions } from "./types";

export type SeriesGranularity = "weekly" | "daily";

export interface SeriesWindowPoint {
  /** Inclusive window start (ISO). */
  since: string;
  /** Exclusive window end (ISO). */
  until: string;
  value: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  /** True when the window is not a full period (newest window by construction). */
  partial: boolean;
}

export interface ProbeSeriesResult {
  probe: string;
  granularity: SeriesGranularity;
  windows: SeriesWindowPoint[];
}

export interface SeriesOptions {
  granularity: SeriesGranularity;
  /** Number of windows (caller clamps; default 12, max 52 at the CLI). */
  windows: number;
  project?: string;
  /** Exclusive series end; defaults to now. */
  until?: Date;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface SeriesWindowBounds {
  since: Date;
  until: Date;
  partial: boolean;
}

/** Local calendar day start (00:00:00.000 in the host timezone). */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Add whole local calendar days (DST-safe via Date constructor). */
export function addLocalDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/**
 * Local Monday 00:00 for the week containing `d`.
 * getDay(): 0 Sun … 6 Sat → Monday offset.
 */
export function startOfLocalWeek(d: Date): Date {
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addLocalDays(startOfLocalDay(d), mondayOffset);
}

/**
 * Build contiguous window bounds, oldest first / newest last.
 * Windows align to local-date boundaries (weekly = Monday start).
 * The newest window ends at `until` and is always marked partial.
 */
export function buildSeriesWindows(
  granularity: SeriesGranularity,
  count: number,
  until: Date = new Date(),
): SeriesWindowBounds[] {
  if (count < 1) return [];

  const stepDays = granularity === "weekly" ? 7 : 1;
  const periodStart =
    granularity === "weekly" ? startOfLocalWeek(until) : startOfLocalDay(until);

  // If until lands exactly on a period start, treat it as exclusive end of
  // the previous full period (zero-length open window is useless).
  let newestSince = periodStart;
  let newestUntil = until;
  if (newestUntil.getTime() <= newestSince.getTime()) {
    newestUntil = newestSince;
    newestSince = addLocalDays(newestSince, -stepDays);
  }

  const out: SeriesWindowBounds[] = [];
  for (let i = count - 1; i >= 0; i--) {
    if (i === 0) {
      out.push({
        since: newestSince,
        until: newestUntil,
        partial: true,
      });
    } else {
      const since = addLocalDays(newestSince, -i * stepDays);
      const untilBound = addLocalDays(newestSince, -(i - 1) * stepDays);
      out.push({
        since,
        until: untilBound,
        partial: false,
      });
    }
  }
  return out;
}

/**
 * Run each named probe over the window grid. Probe names must already be
 * known to the registry; unknown names are skipped (CLI validates first).
 */
export function runProbeSeries(
  db: Db,
  probeNames: string[],
  opts: SeriesOptions,
): ProbeSeriesResult[] {
  const until = opts.until ?? opts.now ?? new Date();
  const count = Math.max(0, Math.floor(opts.windows));
  const bounds = buildSeriesWindows(opts.granularity, count, until);

  const results: ProbeSeriesResult[] = [];
  for (const name of probeNames) {
    const windows: SeriesWindowPoint[] = [];
    let unknown = false;
    for (const w of bounds) {
      const probeOpts: ProbeOptions = {
        since: w.since,
        until: w.until,
      };
      if (opts.project) probeOpts.project = opts.project;

      const r = runProbe(db, name, probeOpts);
      if (!r) {
        unknown = true;
        break;
      }
      windows.push({
        since: w.since.toISOString(),
        until: w.until.toISOString(),
        value: r.value,
        ciLow: r.ciLow,
        ciHigh: r.ciHigh,
        n: r.n,
        partial: w.partial,
      });
    }
    if (unknown) continue;
    results.push({
      probe: name,
      granularity: opts.granularity,
      windows,
    });
  }
  return results;
}

/** Format a local YYYY-MM-DD for span labels (no time). */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Fixed-width cell for one window value.
 * n === 0 → en dash; rates in [0,1] as percent; otherwise compact number.
 */
export function formatSeriesCell(value: number, n: number, width = 6): string {
  let text: string;
  if (n === 0) {
    text = "–";
  } else if (value >= 0 && value <= 1) {
    text = `${(value * 100).toFixed(1)}%`;
  } else if (Number.isInteger(value)) {
    text = String(value);
  } else {
    text = value.toFixed(1);
  }
  if (text.length >= width) return text.slice(0, width);
  return text.padStart(width, " ");
}

/** One compact TTY line per probe series. */
export function formatSeriesLine(series: ProbeSeriesResult): string {
  const cells = series.windows.map((w) => formatSeriesCell(w.value, w.n)).join(" ");
  let span = "";
  if (series.windows.length > 0) {
    const first = series.windows[0]!;
    const last = series.windows[series.windows.length - 1]!;
    span = `  [${formatLocalDate(new Date(first.since))} .. ${formatLocalDate(new Date(last.until))}]`;
  }
  const name = series.probe.padEnd(22, " ");
  return `${name} ${cells}${span}`;
}
