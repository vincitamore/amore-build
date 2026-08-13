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
  sumTokensBySource,
  isTokenCeilingReached,
  budgetSnapshot,
  localDateFromDate,
  isoWeekKey,
  isActionOnCooldown,
  countersHaveClockSkew,
  effectiveCeiling,
  DEFAULT_DREAMS_RESERVE_TOKENS,
  PLANNER_RESERVE,
} from "./budget.ts";
import {
  BUDGETS_COMPAT_KEYS,
  buildEffectiveBudgetsDisplay,
  capabilityStateForReason,
  formatBudgetTokenCount,
} from "./budgets-display.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "./state.ts";

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

  test("future date key is clock-skew: keep counters, do not reset", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const tomorrow = localDateFromDate(new Date(2026, 6, 10, 12, 0, 0));
    const rolled = rollDailyBudget(
      { actionsToday: 7, lastActionDate: tomorrow },
      now,
    );
    expect(rolled.clockSkew).toBe(true);
    expect(rolled.rolled).toBe(false);
    expect(rolled.actionsToday).toBe(7);
    expect(
      countersHaveClockSkew({
        actionsToday: 7,
        lastActionDate: tomorrow,
        tokensToday: 40,
        lastTokenDate: tomorrow,
      }, now),
    ).toBe(true);
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

  test("sourced recordTokenUsage pins tokensToday === sum(bySource)", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const counters = {
      actionsToday: 0,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 0,
      lastTokenDate: day,
    };
    const a = recordTokenUsage(counters, { total_tokens: 40 }, "planner", now);
    expect(a.tokensToday).toBe(40);
    expect(a.tokensTodayBySource).toEqual({ planner: 40 });
    expect(a.tokensToday).toBe(sumTokensBySource(a.tokensTodayBySource));
    expect(a.maxCallTokens).toBe(40);

    const b = recordTokenUsage(
      { ...counters, ...a },
      { total_tokens: 15 },
      "agentic",
      now,
    );
    const c = recordTokenUsage(
      { ...counters, ...b },
      { total_tokens: 7 },
      "autoCommit",
      now,
    );
    expect(c.tokensTodayBySource).toEqual({
      planner: 40,
      agentic: 15,
      autoCommit: 7,
    });
    expect(c.tokensToday).toBe(62);
    expect(c.tokensToday).toBe(sumTokensBySource(c.tokensTodayBySource));
    expect(c.maxCallTokens).toBe(40);
    expect(c.maxCallTokensAt).toBeTruthy();
  });

  test("legacy scalar stays until the first sourced increment", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const legacy = {
      actionsToday: 0,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 233457,
      lastTokenDate: day,
    };
    const unsourced = recordTokenUsage(legacy, { total_tokens: 10 }, now);
    expect(unsourced.tokensToday).toBe(233467);
    expect(unsourced.tokensTodayBySource).toBeUndefined();

    const sourced = recordTokenUsage(
      { ...legacy, tokensToday: unsourced.tokensToday },
      { total_tokens: 3 },
      "planner",
      now,
    );
    expect(sourced.tokensTodayBySource).toEqual({ planner: 233470 });
    expect(sourced.tokensToday).toBe(sumTokensBySource(sourced.tokensTodayBySource));
    expect(sourced.tokensToday).toBe(233470);
  });

  test("maxCallTokens tracks the largest envelope today and rolls", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const base = {
      actionsToday: 0,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 0,
      lastTokenDate: day,
    };
    const a = recordTokenUsage(base, { total_tokens: 12 }, "planner", now);
    const b = recordTokenUsage(
      { ...base, ...a },
      { total_tokens: 80 },
      "agentic",
      now,
    );
    expect(b.maxCallTokens).toBe(80);
    const nextDay = new Date(2026, 6, 10, 12, 0, 0);
    const rolled = recordTokenUsage(
      { ...base, ...b },
      { total_tokens: 5 },
      "planner",
      nextDay,
    );
    expect(rolled.tokensToday).toBe(5);
    expect(rolled.tokensTodayBySource).toEqual({ planner: 5 });
    expect(rolled.maxCallTokens).toBe(5);
  });
});

describe("weeklyCap through canStartCycle", () => {
  test("configured weekly cap other than shipped 6 is what canStartCycle reports", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const week = isoWeekKey(now);
    const counters = {
      actionsToday: 0,
      lastActionDate: day,
      actionsThisWeek: 1,
      lastActionWeek: week,
      lastCycleEnded: null,
      cycleActive: false,
    };
    const shipped = canStartCycle(counters, now);
    expect(shipped.remainingWeekly).toBe(WEEKLY_EXPENSIVE_BUDGET - 1);
    const custom = canStartCycle(counters, now, { weeklyCap: 3 });
    expect(custom.remainingWeekly).toBe(2);
    expect(custom.allowed).toBe(true);
  });

  test("StateManager.canStartCycle reports its configured weeklyCap", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-weekly-"));
    try {
      const now = new Date(2026, 6, 9, 12, 0, 0);
      const sm = new StateManager(dir, { weeklyCap: 3, cooldownMs: 0 });
      const gate = sm.canStartCycle(now);
      expect(gate.remainingWeekly).toBe(3);
      expect(gate.remainingWeekly).not.toBe(WEEKLY_EXPENSIVE_BUDGET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tombstone/restart does not reset tokensToday", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-tokkeep-"));
    try {
      const sm = new StateManager(dir);
      sm.recordTokens({ total_tokens: 12345 }, "planner");
      sm.save();
      const kept = sm.get().dream.tokensToday;
      expect(kept).toBe(12345);
      const reloaded = new StateManager(dir);
      expect(reloaded.get().dream.tokensToday).toBe(12345);
      expect(reloaded.get().dream.tokensToday).toBe(
        sumTokensBySource(reloaded.get().dream.tokensTodayBySource),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drafts refuse at ceiling − reserve while dreams still allowed", () => {
    expect(effectiveCeiling("dreams", 200000, 80000)).toBe(200000);
    expect(effectiveCeiling("autoCommit", 200000, 80000)).toBe(120000);
    expect(PLANNER_RESERVE).toBe(10_000);
    expect(DEFAULT_DREAMS_RESERVE_TOKENS).toBe(80_000);
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const counters = {
      actionsToday: 0,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 120000,
      lastTokenDate: day,
    };
    expect(isTokenCeilingReached(counters, now, 120000)).toBe(true);
    expect(isTokenCeilingReached(counters, now, 200000)).toBe(false);
  });

  test("load re-derives tokensToday from bySource when the map is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-tokmap-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify({
          version: 1,
          dream: {
            tokensToday: 999999,
            lastTokenDate: localDateFromDate(new Date()),
            tokensTodayBySource: { planner: 10, agentic: 5, autoCommit: 2 },
          },
        }),
        "utf-8",
      );
      const sm = new StateManager(dir);
      expect(sm.get().dream.tokensToday).toBe(17);
      expect(sm.get().dream.tokensToday).toBe(
        sumTokensBySource(sm.get().dream.tokensTodayBySource),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const PULSE_STATES = ["not-installed", "stopped", "running", "stale"] as const;

describe("effective budgets display wire", () => {
  test("first four keys are display strings in compat order", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const week = isoWeekKey(now);
    const counters = {
      actionsToday: 3,
      lastActionDate: day,
      actionsThisWeek: 1,
      lastActionWeek: week,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 233457,
      lastTokenDate: day,
    };
    const snap = budgetSnapshot(counters, now);
    const display = buildEffectiveBudgetsDisplay({
      snapshot: snap,
      counters,
      now,
      env: {},
    });
    const keys = Object.keys(display).slice(0, 4);
    expect(keys).toEqual([...BUDGETS_COMPAT_KEYS]);
    expect(keys).toEqual(["state", "actions", "weekly", "tokens"]);
    for (const k of keys) {
      expect(typeof display[k as keyof typeof display]).toBe("string");
    }
    expect(display.actions).toBe("3/12");
    expect(display.weekly).toBe("1/6");
    expect(display.tokens).toBe("233K/200K");
  });

  test("reason is verbatim canStartCycle().reason", () => {
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
    const gate = canStartCycle(counters, now);
    const snap = budgetSnapshot(counters, now);
    const display = buildEffectiveBudgetsDisplay({
      snapshot: snap,
      counters,
      now,
      env: {},
    });
    expect(display.reason).toBe(gate.reason);
    expect(display.capability.reason).toBe(gate.reason);
    expect(display.reason).toBe(snap.reason);
  });

  test("over-ceiling tokens string and windows.tokens.over show over, not 100%", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const counters = {
      actionsToday: 3,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 233457,
      lastTokenDate: day,
    };
    const snap = budgetSnapshot(counters, now);
    const display = buildEffectiveBudgetsDisplay({
      snapshot: snap,
      counters,
      now,
      env: {},
    });
    expect(display.tokens).toBe("233K/200K");
    expect(display.windows.tokens.over).toBe(33457);
    expect(display.windows.tokens.reserve).toBe(DEFAULT_DREAMS_RESERVE_TOKENS);
    expect(display.windows.tokens.autoCommitCeiling).toBe(120000);
    expect(display.windows.tokens.used).toBe(233457);
    expect(display.windows.tokens.remaining).toBe(0);
    expect(display.tokens).not.toMatch(/100%/);
    expect(formatBudgetTokenCount(9999)).toBe("9999");
    expect(formatBudgetTokenCount(10_000)).toBe("10K");
    expect(formatBudgetTokenCount(2_000_000)).toBe("2M");
  });

  test("capability.state is never a pulse enum and never disabled", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const week = isoWeekKey(now);
    const cases = [
      {
        tokensToday: 233457,
        actionsToday: 0,
        lastCycleEnded: null as string | null,
      },
      {
        tokensToday: 0,
        actionsToday: DAILY_ACTION_BUDGET,
        lastCycleEnded: null as string | null,
      },
      {
        tokensToday: 0,
        actionsToday: 0,
        lastCycleEnded: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      },
      {
        tokensToday: 0,
        actionsToday: 0,
        lastCycleEnded: null as string | null,
      },
    ];
    for (const c of cases) {
      const counters = {
        actionsToday: c.actionsToday,
        lastActionDate: day,
        actionsThisWeek: 0,
        lastActionWeek: week,
        lastCycleEnded: c.lastCycleEnded,
        cycleActive: false,
        tokensToday: c.tokensToday,
        lastTokenDate: day,
      };
      const snap = budgetSnapshot(counters, now);
      const display = buildEffectiveBudgetsDisplay({
        snapshot: snap,
        counters,
        now,
        env: {},
      });
      expect(["ready", "cooling", "refusing"]).toContain(display.capability.state);
      expect(display.capability.state).not.toBe("disabled");
      for (const pulse of PULSE_STATES) {
        expect(display.capability.state).not.toBe(pulse);
      }
    }
    expect(capabilityStateForReason("ok")).toBe("ready");
    expect(capabilityStateForReason("cooldown")).toBe("cooling");
    expect(capabilityStateForReason("token-ceiling")).toBe("refusing");
    expect(capabilityStateForReason("daily-cap")).toBe("refusing");
    expect(capabilityStateForReason("cap-zero")).toBe("refusing");
    expect(capabilityStateForReason("config-invalid")).toBe("refusing");
    expect(capabilityStateForReason("roster-empty")).toBe("refusing");
  });

  test("after save() + reload, state.budgets is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-budgets-"));
    try {
      const sm = new StateManager(dir);
      sm.save();
      const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as {
        budgets?: Record<string, unknown>;
      };
      expect(raw.budgets).toBeTruthy();
      expect(Object.keys(raw.budgets!).slice(0, 4)).toEqual([
        "state",
        "actions",
        "weekly",
        "tokens",
      ]);
      const reloaded = new StateManager(dir);
      expect(reloaded.get().budgets).toBeTruthy();
      expect(Object.keys(reloaded.get().budgets!).slice(0, 4)).toEqual([
        "state",
        "actions",
        "weekly",
        "tokens",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("env above shipped is representable", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const counters = {
      actionsToday: 0,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 0,
      lastTokenDate: day,
    };
    const snap = budgetSnapshot(counters, now, { dailyCap: 20, tokenCeiling: 400_000 });
    const display = buildEffectiveBudgetsDisplay({
      snapshot: snap,
      counters,
      now,
      env: {
        LUCERNA_DAILY_ACTION_CAP: "20",
        LUCERNA_DAILY_TOKEN_CEILING: "400000",
      },
    });
    expect(display.windows.daily.source).toBe("env");
    expect(display.windows.daily.aboveShipped).toBe(true);
    expect(display.windows.tokens.source).toBe("env");
    expect(display.windows.tokens.aboveShipped).toBe(true);
    expect(display.windows.weekly.source).toBe("shipped");
    expect(display.windows.weekly.aboveShipped).toBe(false);
  });

  test("file source and aboveShipped ride the resolver", () => {
    const now = new Date(2026, 6, 9, 12, 0, 0);
    const day = localDateFromDate(now);
    const counters = {
      actionsToday: 0,
      lastActionDate: day,
      lastCycleEnded: null,
      cycleActive: false,
      tokensToday: 0,
      lastTokenDate: day,
    };
    const snap = budgetSnapshot(counters, now, { dailyCap: 20, tokenCeiling: 400_000 });
    const display = buildEffectiveBudgetsDisplay({
      snapshot: snap,
      counters,
      now,
      env: {},
      charter: {
        budgets: {
          dailyActionCap: { value: 20, source: "file", aboveShipped: true },
          weeklyExpensiveCap: { value: 6, source: "shipped", aboveShipped: false },
          cycleCooldownMinutes: { value: 120, source: "shipped", aboveShipped: false },
          dailyTokenCeiling: { value: 400000, source: "file", aboveShipped: true },
          dreamsReserveTokens: { value: 80000, source: "shipped", aboveShipped: false },
          autoCommitCooldownMinutes: { value: 30, source: "shipped", aboveShipped: false },
          cycleCooldownMs: 7_200_000,
          autoCommitCooldownMs: 1_800_000,
          warnings: [],
          file: { present: true, mtimeMs: 1 },
          notifyMalformed: false,
        },
        roster: {
          effectiveKeys: [],
          disabled: [],
          unknownKeys: [],
          cooldownOverridesMs: {},
          entries: [],
          warnings: [],
          file: { present: false, mtimeMs: 0 },
          refuse: false,
        },
      },
    });
    expect(display.windows.daily.source).toBe("file");
    expect(display.windows.daily.aboveShipped).toBe(true);
    expect(display.windows.tokens.source).toBe("file");
    expect(display.windows.tokens.aboveShipped).toBe(true);
    expect(display.windows.tokens.reserve).toBe(80000);
    expect(display.windows.tokens.autoCommitCeiling).toBe(320000);
  });
});
