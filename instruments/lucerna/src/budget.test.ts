import { describe, expect, test } from "bun:test";
import {
  DAILY_ACTION_BUDGET,
  WEEKLY_EXPENSIVE_BUDGET,
  CYCLE_COOLDOWN_MS,
  DEFAULT_DAILY_TOKEN_CEILING,
  rollDailyBudget,
  rollWeeklyBudget,
  getRemainingDailyBudget,
  getRemainingWeeklyBudget,
  hasActionBudget,
  isCycleCooldownElapsed,
  canStartCycle,
  canRunAction,
  recordAction,
  recordTokenUsage,
  sumTokenUsage,
  isTokenCeilingReached,
  budgetSnapshot,
  localDateFromDate,
  isoWeekKey,
  isActionOnCooldown,
} from "./budget.ts";

describe("daily budget rollover", () => {
  test("same day keeps actionsToday", () => {
    const now = new Date(2026, 6, 9, 15, 0, 0);
    const day = localDateFromDate(now);
    const rolled = rollDailyBudget({ actionsToday: 5, lastActionDate: day }, now);
    expect(rolled.rolled).toBe(false);
    expect(rolled.actionsToday).toBe(5);
    expect(getRemainingDailyBudget({ actionsToday: 5, lastActionDate: day }, now)).toBe(
      DAILY_ACTION_BUDGET - 5,
    );
  });

  test("new day resets actionsToday to 0", () => {
    const now = new Date(2026, 6, 10, 1, 0, 0);
    const yesterday = localDateFromDate(new Date(2026, 6, 9, 12, 0, 0));
    const rolled = rollDailyBudget({ actionsToday: 12, lastActionDate: yesterday }, now);
    expect(rolled.rolled).toBe(true);
    expect(rolled.actionsToday).toBe(0);
    expect(hasActionBudget({ actionsToday: 12, lastActionDate: yesterday }, now)).toBe(true);
  });
});

describe("weekly expensive budget", () => {
  test("same ISO week keeps actionsThisWeek", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const week = isoWeekKey(now);
    const rolled = rollWeeklyBudget({ actionsThisWeek: 3, lastActionWeek: week }, now);
    expect(rolled.rolled).toBe(false);
    expect(getRemainingWeeklyBudget({ actionsThisWeek: 3, lastActionWeek: week }, now)).toBe(
      WEEKLY_EXPENSIVE_BUDGET - 3,
    );
  });

  test("new week resets expensive counter", () => {
    const now = new Date(2026, 6, 13, 12, 0, 0);
    const oldWeek = isoWeekKey(new Date(2026, 6, 9, 12, 0, 0));
    const rolled = rollWeeklyBudget({ actionsThisWeek: 6, lastActionWeek: oldWeek }, now);
    expect(rolled.rolled).toBe(true);
    expect(rolled.actionsThisWeek).toBe(0);
  });

  test("weekly tier blocks when week cap exhausted", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const week = isoWeekKey(now);
    const gate = canRunAction(
      {
        actionsToday: 2,
        lastActionDate: day,
        actionsThisWeek: WEEKLY_EXPENSIVE_BUDGET,
        lastActionWeek: week,
        lastCycleEnded: null,
        cycleActive: false,
      },
      { tier: "weekly", cooldownClass: "recipe", actionKey: "agentic-x", now },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/weekly expensive/);
  });

  test("daily light action does not consume weekly", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const week = isoWeekKey(now);
    const next = recordAction(
      {
        actionsToday: 1,
        lastActionDate: day,
        actionsThisWeek: 2,
        lastActionWeek: week,
        lastCycleEnded: null,
        cycleActive: false,
      },
      { tier: "daily", now },
    );
    expect(next.actionsToday).toBe(2);
    expect(next.actionsThisWeek).toBe(2);
  });

  test("weekly action increments both counters", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const week = isoWeekKey(now);
    const next = recordAction(
      {
        actionsToday: 1,
        lastActionDate: day,
        actionsThisWeek: 2,
        lastActionWeek: week,
        lastCycleEnded: null,
        cycleActive: false,
      },
      { tier: "weekly", now },
    );
    expect(next.actionsToday).toBe(2);
    expect(next.actionsThisWeek).toBe(3);
  });
});

describe("cooldowns", () => {
  test("cycle cooldown blocks re-plan", () => {
    const now = new Date(2026, 6, 9, 14, 0, 0);
    const ended = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    expect(isCycleCooldownElapsed(ended, now.getTime(), CYCLE_COOLDOWN_MS)).toBe(false);
    const day = localDateFromDate(now);
    const gate = canStartCycle(
      {
        actionsToday: 0,
        lastActionDate: day,
        lastCycleEnded: ended,
        cycleActive: false,
      },
      now,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/cooldown/);
  });

  test("per-action cooldown", () => {
    const now = Date.now();
    const recent = { "survey-org": new Date(now - 60_000).toISOString() };
    expect(isActionOnCooldown(recent, "survey-org", "light", now)).toBe(true);
    expect(isActionOnCooldown(recent, "inbox-age-report", "light", now)).toBe(false);
  });
});

describe("token ceiling", () => {
  test("sumTokenUsage prefers total_tokens", () => {
    expect(
      sumTokenUsage({
        total_tokens: 100,
        input_tokens: 40,
        output_tokens: 10,
      }),
    ).toBe(100);
    expect(sumTokenUsage({ input_tokens: 3, output_tokens: 2 })).toBe(5);
  });

  test("recordTokenUsage accumulates and rolls daily", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const a = recordTokenUsage(
      {
        actionsToday: 0,
        lastActionDate: day,
        lastCycleEnded: null,
        cycleActive: false,
        tokensToday: 10,
        lastTokenDate: day,
      },
      { total_tokens: 25 },
      now,
    );
    expect(a.tokensToday).toBe(35);

    const nextDay = new Date(2026, 6, 10, 12, 0, 0);
    const b = recordTokenUsage(
      {
        actionsToday: 0,
        lastActionDate: day,
        lastCycleEnded: null,
        cycleActive: false,
        tokensToday: 35,
        lastTokenDate: day,
      },
      { total_tokens: 5 },
      nextDay,
    );
    expect(b.tokensToday).toBe(5);
  });

  test("token ceiling blocks canRunAction and canStartCycle", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const counters = {
      actionsToday: 0,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: DEFAULT_DAILY_TOKEN_CEILING,
      lastTokenDate: day,
    };
    expect(isTokenCeilingReached(counters, now)).toBe(true);
    const run = canRunAction(counters, {
      tier: "daily",
      cooldownClass: "light",
      actionKey: "survey-org",
      now,
    });
    expect(run.allowed).toBe(false);
    expect(run.reason).toMatch(/token ceiling/);
    const cycle = canStartCycle(counters, now);
    expect(cycle.allowed).toBe(false);
    expect(cycle.reason).toMatch(/token ceiling/);
  });

  test("budgetSnapshot includes token fields", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const snap = budgetSnapshot(
      {
        actionsToday: 1,
        lastActionDate: day,
        lastCycleEnded: null,
        cycleActive: false,
        tokensToday: 1000,
        lastTokenDate: day,
      },
      now,
    );
    expect(snap.tokensToday).toBe(1000);
    expect(snap.dailyTokenCeiling).toBe(DEFAULT_DAILY_TOKEN_CEILING);
    expect(snap.tokenCeilingReached).toBe(false);
  });
});
