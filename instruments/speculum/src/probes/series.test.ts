/**
 * Series window arithmetic + per-window probe correctness on synthetic data.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../store/db";
import { ingest } from "../ingest";
import {
  agentChunk,
  makeUsage,
  turnCompleted,
  updateLine,
  userChunk,
  writeCorpus,
  type FixtureSession,
} from "../test/fixtures";
import {
  addLocalDays,
  buildSeriesWindows,
  formatSeriesCell,
  runProbeSeries,
  startOfLocalDay,
  startOfLocalWeek,
} from "./series";
import { rageRate } from "./rage-rate";
import { wilson95 } from "../stats";

describe("series window boundaries", () => {
  test("daily windows align to local midnight, newest-last, newest partial", () => {
    // Wednesday afternoon local — newest window is partial through mid-day.
    const until = new Date(2026, 7, 5, 15, 30, 0); // Aug 5 2026 local
    const wins = buildSeriesWindows("daily", 3, until);
    expect(wins).toHaveLength(3);

    const d0 = startOfLocalDay(until); // Aug 5 00:00
    expect(wins[0]!.since.getTime()).toBe(addLocalDays(d0, -2).getTime());
    expect(wins[0]!.until.getTime()).toBe(addLocalDays(d0, -1).getTime());
    expect(wins[0]!.partial).toBe(false);

    expect(wins[1]!.since.getTime()).toBe(addLocalDays(d0, -1).getTime());
    expect(wins[1]!.until.getTime()).toBe(d0.getTime());
    expect(wins[1]!.partial).toBe(false);

    expect(wins[2]!.since.getTime()).toBe(d0.getTime());
    expect(wins[2]!.until.getTime()).toBe(until.getTime());
    expect(wins[2]!.partial).toBe(true);
  });

  test("weekly windows align to Monday start", () => {
    // Wednesday 2026-08-05 local → week starts Monday 2026-08-03
    const until = new Date(2026, 7, 5, 12, 0, 0);
    const wins = buildSeriesWindows("weekly", 4, until);
    expect(wins).toHaveLength(4);

    const weekStart = startOfLocalWeek(until);
    expect(weekStart.getDay()).toBe(1); // Monday
    expect(weekStart.getDate()).toBe(3);
    expect(weekStart.getMonth()).toBe(7);

    // Oldest: Mon Jul 13 .. Mon Jul 20
    expect(wins[0]!.since.getTime()).toBe(addLocalDays(weekStart, -21).getTime());
    expect(wins[0]!.until.getTime()).toBe(addLocalDays(weekStart, -14).getTime());
    expect(wins[0]!.partial).toBe(false);

    // Newest: Mon Aug 3 .. until (partial)
    expect(wins[3]!.since.getTime()).toBe(weekStart.getTime());
    expect(wins[3]!.until.getTime()).toBe(until.getTime());
    expect(wins[3]!.partial).toBe(true);

    // Contiguous
    for (let i = 0; i < wins.length - 1; i++) {
      expect(wins[i]!.until.getTime()).toBe(wins[i + 1]!.since.getTime());
    }
  });

  test("weekly Monday alignment from Sunday and Monday anchors", () => {
    // Sunday 2026-08-09 → week still starts Mon Aug 3
    const sun = new Date(2026, 7, 9, 10, 0, 0);
    expect(startOfLocalWeek(sun).getTime()).toBe(
      new Date(2026, 7, 3, 0, 0, 0).getTime(),
    );

    // Monday exactly → until on boundary backs up one full week as newest
    const mon = new Date(2026, 7, 10, 0, 0, 0);
    const wins = buildSeriesWindows("weekly", 2, mon);
    expect(wins).toHaveLength(2);
    // newest ends at Mon Aug 10, starts Mon Aug 3
    expect(wins[1]!.since.getTime()).toBe(new Date(2026, 7, 3, 0, 0, 0).getTime());
    expect(wins[1]!.until.getTime()).toBe(mon.getTime());
    expect(wins[1]!.partial).toBe(true);
    // previous full week
    expect(wins[0]!.since.getTime()).toBe(new Date(2026, 6, 27, 0, 0, 0).getTime());
    expect(wins[0]!.until.getTime()).toBe(new Date(2026, 7, 3, 0, 0, 0).getTime());
  });

  test("windows count zero yields empty", () => {
    expect(buildSeriesWindows("daily", 0, new Date())).toEqual([]);
  });
});

describe("formatSeriesCell", () => {
  test("empty n is en dash", () => {
    expect(formatSeriesCell(0.5, 0)).toContain("–");
  });
  test("rate as percent", () => {
    expect(formatSeriesCell(0.123, 10).trim()).toBe("12.3%");
  });
});

/**
 * Build a 3-day corpus with known rage hits for hand-checked window rates.
 * Day layout (local dates relative to `base` = start of day D0):
 *   D0 (oldest complete): 4 user msgs, 1 rage  → rate 0.25
 *   D1: 2 user msgs, 0 rage                     → rate 0
 *   D2 (newest, partial through afternoon): 2 user msgs, 1 rage → rate 0.5
 */
function writeRageWindowCorpus(base: Date) {
  const sessions: FixtureSession[] = [];

  function dayTs(dayOffset: number, hour: number): string {
    const d = addLocalDays(base, dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }

  // Session spanning D0
  const id0 = "aaaaaaaa-0001-4000-8000-000000000001";
  sessions.push({
    id: id0,
    cwdEnc: "enc_proj",
    cwdDecoded: "C:\\work\\proj",
    updates: [
      updateLine(id0, userChunk("please list files"), dayTs(0, 9)),
      updateLine(id0, agentChunk("here"), dayTs(0, 9)),
      updateLine(id0, userChunk("this is fucking broken"), dayTs(0, 10)),
      updateLine(id0, agentChunk("sorry"), dayTs(0, 10)),
      updateLine(id0, userChunk("try again"), dayTs(0, 11)),
      updateLine(id0, agentChunk("ok"), dayTs(0, 11)),
      updateLine(id0, userChunk("looks fine now"), dayTs(0, 12)),
      updateLine(id0, turnCompleted(makeUsage()), dayTs(0, 12)),
    ],
  });

  // Session on D1 — clean
  const id1 = "aaaaaaaa-0002-4000-8000-000000000002";
  sessions.push({
    id: id1,
    cwdEnc: "enc_proj",
    cwdDecoded: "C:\\work\\proj",
    updates: [
      updateLine(id1, userChunk("hello"), dayTs(1, 9)),
      updateLine(id1, agentChunk("hi"), dayTs(1, 9)),
      updateLine(id1, userChunk("continue please"), dayTs(1, 10)),
      updateLine(id1, turnCompleted(makeUsage()), dayTs(1, 10)),
    ],
  });

  // Session on D2 — one rage of two
  const id2 = "aaaaaaaa-0003-4000-8000-000000000003";
  sessions.push({
    id: id2,
    cwdEnc: "enc_proj",
    cwdDecoded: "C:\\work\\proj",
    updates: [
      updateLine(id2, userChunk("what the fuck"), dayTs(2, 9)),
      updateLine(id2, agentChunk("apologies"), dayTs(2, 9)),
      updateLine(id2, userChunk("ok go on"), dayTs(2, 10)),
      updateLine(id2, turnCompleted(makeUsage()), dayTs(2, 11)),
    ],
  });

  return writeCorpus(sessions);
}

describe("runProbeSeries per-window correctness", () => {
  test("daily rage-rate matches hand-computed fixtures", () => {
    // Anchor "now" to D2 afternoon so newest window is partial D2.
    const d2Noon = new Date(2026, 5, 12, 14, 0, 0); // Jun 12 2026 local
    const base = startOfLocalDay(addLocalDays(d2Noon, -2)); // D0 = Jun 10

    const corpus = writeRageWindowCorpus(base);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const series = runProbeSeries(db, ["rage-rate"], {
        granularity: "daily",
        windows: 3,
        until: d2Noon,
      });
      expect(series).toHaveLength(1);
      const s = series[0]!;
      expect(s.probe).toBe("rage-rate");
      expect(s.granularity).toBe("daily");
      expect(s.windows).toHaveLength(3);

      // Hand-check each window against the probe itself + Wilson.
      const expected = [
        { k: 1, n: 4 }, // D0
        { k: 0, n: 2 }, // D1
        { k: 1, n: 2 }, // D2 partial
      ];
      for (let i = 0; i < 3; i++) {
        const w = s.windows[i]!;
        const direct = rageRate(db, {
          since: new Date(w.since),
          until: new Date(w.until),
        });
        expect(w.n).toBe(direct.n);
        expect(w.value).toBeCloseTo(direct.value, 10);
        expect(w.ciLow).toBeCloseTo(direct.ciLow, 10);
        expect(w.ciHigh).toBeCloseTo(direct.ciHigh, 10);

        const { k, n } = expected[i]!;
        expect(w.n).toBe(n);
        expect(w.value).toBeCloseTo(n === 0 ? 0 : k / n, 10);
        const ci = wilson95(k, n);
        expect(w.ciLow).toBeCloseTo(ci.lower, 10);
        expect(w.ciHigh).toBeCloseTo(ci.upper, 10);
      }

      expect(s.windows[0]!.partial).toBe(false);
      expect(s.windows[1]!.partial).toBe(false);
      expect(s.windows[2]!.partial).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("newest window is always partial", () => {
    const corpus = writeRageWindowCorpus(startOfLocalDay(new Date(2026, 5, 10)));
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const series = runProbeSeries(db, ["rage-rate"], {
        granularity: "weekly",
        windows: 4,
        until: new Date(2026, 5, 12, 14, 0, 0),
      });
      const wins = series[0]!.windows;
      expect(wins[wins.length - 1]!.partial).toBe(true);
      for (let i = 0; i < wins.length - 1; i++) {
        expect(wins[i]!.partial).toBe(false);
      }
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("project filter is forwarded", () => {
    const base = startOfLocalDay(new Date(2026, 5, 10));
    const corpus = writeRageWindowCorpus(base);
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const until = new Date(2026, 5, 12, 14, 0, 0);
      const hit = runProbeSeries(db, ["rage-rate"], {
        granularity: "daily",
        windows: 3,
        until,
        project: "C:\\work\\proj",
      });
      const miss = runProbeSeries(db, ["rage-rate"], {
        granularity: "daily",
        windows: 3,
        until,
        project: "C:\\other\\nowhere",
      });
      expect(hit[0]!.windows.some((w) => w.n > 0)).toBe(true);
      expect(miss[0]!.windows.every((w) => w.n === 0)).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
