/**
 * Tiered action budgets, per-action cooldowns, cycle cooldown, and soft token ceiling.
 *
 * Defaults: 12 actions/day, 6 expensive/week, 2h cycle cooldown.
 * Token spend is recorded from amore-headless envelopes; a soft daily ceiling
 * halts dreaming when crossed.
 */

/** Max actions per calendar day (all tiers). */
export const DAILY_ACTION_BUDGET = 12;

/** Max expensive (agentic / recipe) actions per ISO week. */
export const WEEKLY_EXPENSIVE_BUDGET = 6;

/** Minimum cooldown between dream cycles. */
export const CYCLE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Short cooldown when a cycle ends with zero completed actions. */
export const SHORT_CYCLE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Per-action cooldown: light actions. */
export const LIGHT_ACTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Per-action cooldown: recipe / agentic. */
export const RECIPE_ACTION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Soft daily token ceiling. When tokensToday meets or exceeds this,
 * dreaming is halted until the next calendar day rolls over.
 */
export const DEFAULT_DAILY_TOKEN_CEILING = 200_000;

export type BudgetTier = "daily" | "weekly";
export type ActionCooldownClass = "light" | "recipe";

export interface BudgetCounters {
  actionsToday: number;
  lastActionDate: string | null;
  actionsThisWeek?: number;
  lastActionWeek?: string | null;
  lastCycleEnded: string | null;
  cycleActive: boolean;
  recentActions?: Record<string, string>;
  /** Total tokens recorded today from driver envelopes. */
  tokensToday?: number;
  lastTokenDate?: string | null;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface BudgetSnapshot {
  actionsToday: number;
  remainingDaily: number;
  dailyCap: number;
  actionsThisWeek: number;
  remainingWeekly: number;
  weeklyCap: number;
  lastActionDate: string | null;
  lastActionWeek: string | null;
  cycleCooldownElapsed: boolean;
  cycleCooldownRemainingMs: number;
  lastCycleEnded: string | null;
  allowedToStartCycle: boolean;
  reason: string;
  tokensToday: number;
  dailyTokenCeiling: number;
  tokenCeilingReached: boolean;
  remaining: number;
}

export function localDateFromDate(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** ISO week key: YYYY-Www (Monday-based week, ISO-8601). */
export function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const y = d.getUTCFullYear();
  return `${y}-W${String(weekNo).padStart(2, "0")}`;
}

export function rollDailyBudget(
  counters: Pick<BudgetCounters, "actionsToday" | "lastActionDate">,
  now: Date = new Date(),
): { actionsToday: number; lastActionDate: string; rolled: boolean } {
  const today = localDateFromDate(now);
  if (counters.lastActionDate !== today) {
    return { actionsToday: 0, lastActionDate: today, rolled: true };
  }
  return {
    actionsToday: counters.actionsToday,
    lastActionDate: counters.lastActionDate ?? today,
    rolled: false,
  };
}

export function rollWeeklyBudget(
  counters: Pick<BudgetCounters, "actionsThisWeek" | "lastActionWeek">,
  now: Date = new Date(),
): { actionsThisWeek: number; lastActionWeek: string; rolled: boolean } {
  const week = isoWeekKey(now);
  if (counters.lastActionWeek !== week) {
    return { actionsThisWeek: 0, lastActionWeek: week, rolled: true };
  }
  return {
    actionsThisWeek: counters.actionsThisWeek ?? 0,
    lastActionWeek: counters.lastActionWeek ?? week,
    rolled: false,
  };
}

export function rollTokenBudget(
  counters: Pick<BudgetCounters, "tokensToday" | "lastTokenDate">,
  now: Date = new Date(),
): { tokensToday: number; lastTokenDate: string; rolled: boolean } {
  const today = localDateFromDate(now);
  if (counters.lastTokenDate !== today) {
    return { tokensToday: 0, lastTokenDate: today, rolled: true };
  }
  return {
    tokensToday: counters.tokensToday ?? 0,
    lastTokenDate: counters.lastTokenDate ?? today,
    rolled: false,
  };
}

export function getRemainingDailyBudget(
  counters: Pick<BudgetCounters, "actionsToday" | "lastActionDate">,
  now: Date = new Date(),
  dailyCap: number = DAILY_ACTION_BUDGET,
): number {
  const rolled = rollDailyBudget(counters, now);
  return Math.max(0, dailyCap - rolled.actionsToday);
}

export function getRemainingWeeklyBudget(
  counters: Pick<BudgetCounters, "actionsThisWeek" | "lastActionWeek">,
  now: Date = new Date(),
  weeklyCap: number = WEEKLY_EXPENSIVE_BUDGET,
): number {
  const rolled = rollWeeklyBudget(counters, now);
  return Math.max(0, weeklyCap - rolled.actionsThisWeek);
}

export function hasActionBudget(
  counters: Pick<BudgetCounters, "actionsToday" | "lastActionDate">,
  now: Date = new Date(),
  dailyCap: number = DAILY_ACTION_BUDGET,
): boolean {
  return getRemainingDailyBudget(counters, now, dailyCap) > 0;
}

/** Sum tokens from a usage object; prefer total_tokens when present. */
export function sumTokenUsage(usage: TokenUsage | undefined | null): number {
  if (!usage) return 0;
  if (typeof usage.total_tokens === "number" && usage.total_tokens > 0) {
    return usage.total_tokens;
  }
  let n = 0;
  if (typeof usage.input_tokens === "number") n += usage.input_tokens;
  if (typeof usage.output_tokens === "number") n += usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") n += usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") n += usage.cache_creation_input_tokens;
  if (typeof usage.reasoning_tokens === "number") n += usage.reasoning_tokens;
  return n;
}

export function recordTokenUsage(
  counters: BudgetCounters,
  usage: TokenUsage | undefined | null,
  now: Date = new Date(),
): { tokensToday: number; lastTokenDate: string } {
  const rolled = rollTokenBudget(counters, now);
  const add = sumTokenUsage(usage);
  return {
    tokensToday: rolled.tokensToday + add,
    lastTokenDate: rolled.lastTokenDate,
  };
}

export function isTokenCeilingReached(
  counters: Pick<BudgetCounters, "tokensToday" | "lastTokenDate">,
  now: Date = new Date(),
  ceiling: number = DEFAULT_DAILY_TOKEN_CEILING,
): boolean {
  const rolled = rollTokenBudget(counters, now);
  return rolled.tokensToday >= ceiling;
}

export function isCycleCooldownElapsed(
  lastCycleEnded: string | null,
  nowMs: number = Date.now(),
  cooldownMs: number = CYCLE_COOLDOWN_MS,
): boolean {
  if (!lastCycleEnded) return true;
  const ended = Date.parse(lastCycleEnded);
  if (Number.isNaN(ended)) return true;
  return nowMs - ended >= cooldownMs;
}

export function cycleCooldownRemainingMs(
  lastCycleEnded: string | null,
  nowMs: number = Date.now(),
  cooldownMs: number = CYCLE_COOLDOWN_MS,
): number {
  if (!lastCycleEnded) return 0;
  const ended = Date.parse(lastCycleEnded);
  if (Number.isNaN(ended)) return 0;
  return Math.max(0, cooldownMs - (nowMs - ended));
}

export function actionCooldownMs(cls: ActionCooldownClass): number {
  return cls === "light" ? LIGHT_ACTION_COOLDOWN_MS : RECIPE_ACTION_COOLDOWN_MS;
}

export function isActionOnCooldown(
  recentActions: Record<string, string> | undefined,
  actionKey: string,
  cls: ActionCooldownClass,
  nowMs: number = Date.now(),
  overridesMs?: Record<string, number>,
): boolean {
  const recent = recentActions?.[actionKey];
  if (!recent) return false;
  const started = Date.parse(recent);
  if (Number.isNaN(started)) return false;
  const ms = overridesMs?.[actionKey] ?? actionCooldownMs(cls);
  return nowMs - started < ms;
}

export function canRunAction(
  counters: BudgetCounters,
  opts: {
    tier: BudgetTier;
    cooldownClass: ActionCooldownClass;
    actionKey: string;
    now?: Date;
    dailyCap?: number;
    weeklyCap?: number;
    tokenCeiling?: number;
    cooldownOverridesMs?: Record<string, number>;
  },
): { allowed: boolean; reason: string } {
  const now = opts.now ?? new Date();
  const dailyCap = opts.dailyCap ?? DAILY_ACTION_BUDGET;
  const weeklyCap = opts.weeklyCap ?? WEEKLY_EXPENSIVE_BUDGET;
  const tokenCeiling = opts.tokenCeiling ?? DEFAULT_DAILY_TOKEN_CEILING;

  if (isTokenCeilingReached(counters, now, tokenCeiling)) {
    return {
      allowed: false,
      reason: `daily token ceiling reached (${rollTokenBudget(counters, now).tokensToday}/${tokenCeiling})`,
    };
  }

  const dailyRem = getRemainingDailyBudget(counters, now, dailyCap);
  if (dailyRem <= 0) {
    return {
      allowed: false,
      reason: `daily budget exhausted (${rollDailyBudget(counters, now).actionsToday}/${dailyCap})`,
    };
  }

  if (opts.tier === "weekly") {
    const weekRem = getRemainingWeeklyBudget(counters, now, weeklyCap);
    if (weekRem <= 0) {
      return {
        allowed: false,
        reason: `weekly expensive budget exhausted (${rollWeeklyBudget(counters, now).actionsThisWeek}/${weeklyCap})`,
      };
    }
  }

  if (
    isActionOnCooldown(
      counters.recentActions,
      opts.actionKey,
      opts.cooldownClass,
      now.getTime(),
      opts.cooldownOverridesMs,
    )
  ) {
    return { allowed: false, reason: `action on cooldown: ${opts.actionKey}` };
  }

  return { allowed: true, reason: "ok" };
}

export function canStartCycle(
  counters: BudgetCounters,
  now: Date = new Date(),
  opts?: { dailyCap?: number; cooldownMs?: number; tokenCeiling?: number },
): { allowed: boolean; reason: string; remaining: number; remainingWeekly: number } {
  const dailyCap = opts?.dailyCap ?? DAILY_ACTION_BUDGET;
  const cooldownMs = opts?.cooldownMs ?? CYCLE_COOLDOWN_MS;
  const tokenCeiling = opts?.tokenCeiling ?? DEFAULT_DAILY_TOKEN_CEILING;
  const remaining = getRemainingDailyBudget(counters, now, dailyCap);
  const remainingWeekly = getRemainingWeeklyBudget(counters, now);

  if (isTokenCeilingReached(counters, now, tokenCeiling)) {
    return {
      allowed: false,
      reason: `daily token ceiling reached (${rollTokenBudget(counters, now).tokensToday}/${tokenCeiling})`,
      remaining,
      remainingWeekly,
    };
  }
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `daily budget exhausted (${rollDailyBudget(counters, now).actionsToday}/${dailyCap})`,
      remaining: 0,
      remainingWeekly,
    };
  }
  if (!isCycleCooldownElapsed(counters.lastCycleEnded, now.getTime(), cooldownMs)) {
    const rem = cycleCooldownRemainingMs(counters.lastCycleEnded, now.getTime(), cooldownMs);
    return {
      allowed: false,
      reason: `cycle cooldown active (${Math.ceil(rem / 60_000)}m remaining)`,
      remaining,
      remainingWeekly,
    };
  }
  return { allowed: true, reason: "ok", remaining, remainingWeekly };
}

export function recordAction(
  counters: BudgetCounters,
  opts?: { tier?: BudgetTier; now?: Date },
): {
  actionsToday: number;
  lastActionDate: string;
  actionsThisWeek: number;
  lastActionWeek: string;
} {
  const now = opts?.now ?? new Date();
  const daily = rollDailyBudget(counters, now);
  const weekly = rollWeeklyBudget(counters, now);
  const tier = opts?.tier ?? "daily";
  return {
    actionsToday: daily.actionsToday + 1,
    lastActionDate: daily.lastActionDate,
    actionsThisWeek: weekly.actionsThisWeek + (tier === "weekly" ? 1 : 0),
    lastActionWeek: weekly.lastActionWeek,
  };
}

/** Compact multi-line budget block for planner prompts. */
export function formatBudgetForPlanner(snapshot: BudgetSnapshot): string {
  return [
    `BUDGET_DAILY: ${snapshot.remainingDaily} actions remaining today (max ${snapshot.dailyCap}/day).`,
    `BUDGET_WEEKLY: ${snapshot.remainingWeekly} expensive actions remaining this week (max ${snapshot.weeklyCap}/week).`,
    `CYCLE_COOLDOWN: ${snapshot.cycleCooldownElapsed ? "elapsed (may start)" : `active (${Math.ceil(snapshot.cycleCooldownRemainingMs / 60_000)}m remaining)`}.`,
    `TOKENS: ${snapshot.tokensToday}/${snapshot.dailyTokenCeiling} today${snapshot.tokenCeilingReached ? " (ceiling reached)" : ""}.`,
    `actionsToday: ${snapshot.actionsToday}; actionsThisWeek(expensive): ${snapshot.actionsThisWeek}`,
  ].join("\n");
}

export function budgetSnapshot(
  counters: BudgetCounters,
  now: Date = new Date(),
  opts?: {
    dailyCap?: number;
    weeklyCap?: number;
    cooldownMs?: number;
    tokenCeiling?: number;
  },
): BudgetSnapshot {
  const dailyCap = opts?.dailyCap ?? DAILY_ACTION_BUDGET;
  const weeklyCap = opts?.weeklyCap ?? WEEKLY_EXPENSIVE_BUDGET;
  const cooldownMs = opts?.cooldownMs ?? CYCLE_COOLDOWN_MS;
  const tokenCeiling = opts?.tokenCeiling ?? DEFAULT_DAILY_TOKEN_CEILING;
  const daily = rollDailyBudget(counters, now);
  const weekly = rollWeeklyBudget(counters, now);
  const tokens = rollTokenBudget(counters, now);
  const remainingDaily = Math.max(0, dailyCap - daily.actionsToday);
  const remainingWeekly = Math.max(0, weeklyCap - weekly.actionsThisWeek);
  const tokenCeilingReached = tokens.tokensToday >= tokenCeiling;
  const gate = canStartCycle(
    {
      ...counters,
      actionsToday: daily.actionsToday,
      lastActionDate: daily.lastActionDate,
      actionsThisWeek: weekly.actionsThisWeek,
      lastActionWeek: weekly.lastActionWeek,
      tokensToday: tokens.tokensToday,
      lastTokenDate: tokens.lastTokenDate,
    },
    now,
    { dailyCap, cooldownMs, tokenCeiling },
  );
  return {
    actionsToday: daily.actionsToday,
    remainingDaily,
    remaining: remainingDaily,
    dailyCap,
    actionsThisWeek: weekly.actionsThisWeek,
    remainingWeekly,
    weeklyCap,
    lastActionDate: daily.lastActionDate,
    lastActionWeek: weekly.lastActionWeek,
    cycleCooldownElapsed: isCycleCooldownElapsed(
      counters.lastCycleEnded,
      now.getTime(),
      cooldownMs,
    ),
    cycleCooldownRemainingMs: cycleCooldownRemainingMs(
      counters.lastCycleEnded,
      now.getTime(),
      cooldownMs,
    ),
    lastCycleEnded: counters.lastCycleEnded,
    allowedToStartCycle: gate.allowed,
    reason: gate.reason,
    tokensToday: tokens.tokensToday,
    dailyTokenCeiling: tokenCeiling,
    tokenCeilingReached,
  };
}
