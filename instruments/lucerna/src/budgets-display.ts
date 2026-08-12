/**
 * EffectiveBudgetsDisplay — persisted wire snapshot for renderers.
 * Display only. Enforcement reads config caps, never this object.
 */

import {
  DAILY_ACTION_BUDGET,
  WEEKLY_EXPENSIVE_BUDGET,
  CYCLE_COOLDOWN_MS,
  DEFAULT_DAILY_TOKEN_CEILING,
  DEFAULT_DREAMS_RESERVE_TOKENS,
  effectiveCeiling,
  type BudgetCounters,
  type BudgetSnapshot,
  type TokensTodayBySource,
} from "./budget.ts";
import { ACTION_CATALOG, ADMITTED_ACTION_KEYS } from "./actions.ts";
import type { BudgetCapSource, ResolvedCharter, RosterEntryView } from "./charter.ts";

/** First four keys, this order — display strings for unchanged Object.entries().slice(0, 4). */
export const BUDGETS_COMPAT_KEYS = ["state", "actions", "weekly", "tokens"] as const;

export type BudgetCapabilityState = "ready" | "cooling" | "refusing";

export type BudgetReasonCode =
  | "token-ceiling"
  | "daily-cap"
  | "cooldown"
  | "config-invalid"
  | "roster-empty"
  | "cap-zero"
  | "ok";

export type { BudgetCapSource } from "./charter.ts";

export interface BudgetCapability {
  state: BudgetCapabilityState;
  reasonCode: BudgetReasonCode;
  reason: string;
  resumesAt?: string;
}

export interface BudgetWindow {
  used: number;
  cap: number;
  remaining: number;
  resetsAt?: string;
  readyAt?: string;
  source: BudgetCapSource;
  aboveShipped: boolean;
  over?: number;
  bySource?: TokensTodayBySource;
  maxCallTokens?: number;
  maxCallTokensAt?: string | null;
  reserve?: number;
  autoCommitCeiling?: number;
}

export interface EffectiveBudgetsDisplay {
  state: BudgetCapabilityState;
  actions: string;
  weekly: string;
  tokens: string;
  actionsToday: number;
  dailyCap: number;
  tokensToday: number;
  dailyTokenCeiling: number;
  gate: BudgetReasonCode;
  reasonCode: BudgetReasonCode;
  reason: string;
  resumesAt?: string;
  computedAt: string;
  capability: BudgetCapability;
  windows: {
    daily: BudgetWindow;
    weekly: BudgetWindow;
    tokens: BudgetWindow;
    cycle: BudgetWindow;
  };
  roster: {
    enabledCount: number;
    shippedCount: number;
    disabled: string[];
    entries: Array<{
      key: string;
      class: string;
      tier: string;
      enabled: boolean;
      lastRun: string | null;
    }>;
  };
  charter: {
    budgetsFileMtimeMs: number;
    choresFileMtimeMs: number;
    readAt: string;
    pending: Record<string, number>;
  };
  warnings: string[];
}

export interface BuildEffectiveBudgetsArgs {
  snapshot: BudgetSnapshot;
  counters?: Pick<
    BudgetCounters,
    "tokensTodayBySource" | "maxCallTokens" | "maxCallTokensAt"
  >;
  now?: Date;
  cooldownMs?: number;
  env?: NodeJS.ProcessEnv;
  recentActions?: Record<string, string>;
  charter?: ResolvedCharter;
  reasonCodeOverride?: BudgetReasonCode;
  dreamsReserveTokens?: number;
}

const STRICT_UINT_RE = /^\d+$/;

function toLocalOffsetISO(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const oh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
  const om = String(Math.abs(offsetMin) % 60).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${oh}:${om}`;
}

function nextLocalMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

/** Next Monday 00:00 local (ISO week boundary). */
function nextIsoWeekStart(now: Date): Date {
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysUntilMonday,
    0,
    0,
    0,
    0,
  );
}

/** Abbreviate counts ≥ 10,000 with K; exact below. */
export function formatBudgetTokenCount(n: number): string {
  if (n >= 10_000 || n <= -10_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function envUintSetAndValid(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return STRICT_UINT_RE.test(raw.trim());
}

function envHoursSetAndValid(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  return Number.isFinite(parseFloat(raw));
}

function sourceFromEnv(
  env: NodeJS.ProcessEnv,
  key: "daily" | "weekly" | "tokens" | "cycle",
): BudgetCapSource {
  if (key === "daily") {
    return envUintSetAndValid(env.LUCERNA_DAILY_ACTION_CAP) ? "env" : "shipped";
  }
  if (key === "weekly") {
    return envUintSetAndValid(env.LUCERNA_WEEKLY_EXPENSIVE_CAP) ? "env" : "shipped";
  }
  if (key === "tokens") {
    return envUintSetAndValid(env.LUCERNA_DAILY_TOKEN_CEILING) ? "env" : "shipped";
  }
  return envHoursSetAndValid(env.LUCERNA_CYCLE_COOLDOWN_HOURS) ? "env" : "shipped";
}

export function reasonCodeFromSnapshot(snap: BudgetSnapshot): BudgetReasonCode {
  if (snap.tokenCeilingReached) return "token-ceiling";
  if (snap.remainingDaily <= 0) {
    return snap.dailyCap === 0 ? "cap-zero" : "daily-cap";
  }
  if (!snap.cycleCooldownElapsed) return "cooldown";
  return "ok";
}

export function capabilityStateForReason(
  code: BudgetReasonCode,
): BudgetCapabilityState {
  if (code === "ok") return "ready";
  if (code === "cooldown") return "cooling";
  return "refusing";
}

/**
 * Build the persisted/status wire object.
 * First four keys are display strings in compat order (do not reorder).
 */
export function buildEffectiveBudgetsDisplay(
  args: BuildEffectiveBudgetsArgs,
): EffectiveBudgetsDisplay {
  const now = args.now ?? new Date();
  const snap = args.snapshot;
  const cooldownMs = args.cooldownMs ?? CYCLE_COOLDOWN_MS;
  const env = args.env ?? process.env;
  const computedAt = toLocalOffsetISO(now);
  const midnight = toLocalOffsetISO(nextLocalMidnight(now));
  const weekStart = toLocalOffsetISO(nextIsoWeekStart(now));

  const reasonCode = args.reasonCodeOverride ?? reasonCodeFromSnapshot(snap);
  const state = capabilityStateForReason(reasonCode);
  const reason = snap.reason;

  let resumesAt: string | undefined;
  if (reasonCode === "token-ceiling" || reasonCode === "daily-cap") {
    resumesAt = midnight;
  } else if (reasonCode === "cooldown" && snap.lastCycleEnded) {
    const ended = Date.parse(snap.lastCycleEnded);
    if (!Number.isNaN(ended)) {
      resumesAt = toLocalOffsetISO(new Date(ended + cooldownMs));
    }
  }

  const resolved = args.charter?.budgets;
  const dailySource = resolved?.dailyActionCap.source ?? sourceFromEnv(env, "daily");
  const weeklySource = resolved?.weeklyExpensiveCap.source ?? sourceFromEnv(env, "weekly");
  const tokensSource = resolved?.dailyTokenCeiling.source ?? sourceFromEnv(env, "tokens");
  const cycleSource = resolved?.cycleCooldownMinutes.source ?? sourceFromEnv(env, "cycle");
  const reserve = args.dreamsReserveTokens
    ?? resolved?.dreamsReserveTokens.value
    ?? DEFAULT_DREAMS_RESERVE_TOKENS;
  const autoCommitCeiling = effectiveCeiling(
    "autoCommit",
    snap.dailyTokenCeiling,
    reserve,
  );
  const warnings = [
    ...(resolved?.warnings ?? []),
    ...(args.charter?.roster.warnings ?? []),
  ];

  const tokensOver =
    snap.tokensToday > snap.dailyTokenCeiling
      ? snap.tokensToday - snap.dailyTokenCeiling
      : undefined;

  let cycleReadyAt = computedAt;
  if (snap.lastCycleEnded) {
    const ended = Date.parse(snap.lastCycleEnded);
    if (!Number.isNaN(ended)) {
      cycleReadyAt = toLocalOffsetISO(new Date(ended + cooldownMs));
    }
  }
  const cycleElapsedMs = snap.lastCycleEnded
    ? Math.max(0, cooldownMs - snap.cycleCooldownRemainingMs)
    : 0;

  const shippedCount = ADMITTED_ACTION_KEYS.length;
  const capability: BudgetCapability = {
    state,
    reasonCode,
    reason,
    ...(resumesAt ? { resumesAt } : {}),
  };

  // Compat keys first — Object.keys(budgets).slice(0, 4) is a published pin.
  return {
    state,
    actions:
      snap.dailyCap === 0
        ? "disabled (cap 0)"
        : `${snap.actionsToday}/${snap.dailyCap}`,
    weekly: `${snap.actionsThisWeek}/${snap.weeklyCap}`,
    tokens: `${formatBudgetTokenCount(snap.tokensToday)}/${formatBudgetTokenCount(snap.dailyTokenCeiling)}`,
    actionsToday: snap.actionsToday,
    dailyCap: snap.dailyCap,
    tokensToday: snap.tokensToday,
    dailyTokenCeiling: snap.dailyTokenCeiling,
    gate: reasonCode,
    reasonCode,
    reason,
    ...(resumesAt ? { resumesAt } : {}),
    computedAt,
    capability,
    windows: {
      daily: {
        used: snap.actionsToday,
        cap: snap.dailyCap,
        remaining: snap.remainingDaily,
        resetsAt: midnight,
        source: dailySource,
        aboveShipped: resolved?.dailyActionCap.aboveShipped
          ?? snap.dailyCap > DAILY_ACTION_BUDGET,
      },
      weekly: {
        used: snap.actionsThisWeek,
        cap: snap.weeklyCap,
        remaining: snap.remainingWeekly,
        resetsAt: weekStart,
        source: weeklySource,
        aboveShipped: resolved?.weeklyExpensiveCap.aboveShipped
          ?? snap.weeklyCap > WEEKLY_EXPENSIVE_BUDGET,
      },
      tokens: {
        used: snap.tokensToday,
        cap: snap.dailyTokenCeiling,
        remaining: Math.max(0, snap.dailyTokenCeiling - snap.tokensToday),
        resetsAt: midnight,
        source: tokensSource,
        aboveShipped: resolved?.dailyTokenCeiling.aboveShipped
          ?? snap.dailyTokenCeiling > DEFAULT_DAILY_TOKEN_CEILING,
        ...(tokensOver !== undefined ? { over: tokensOver } : {}),
        bySource: args.counters?.tokensTodayBySource ?? {},
        maxCallTokens: args.counters?.maxCallTokens ?? 0,
        maxCallTokensAt: args.counters?.maxCallTokensAt ?? null,
        reserve,
        autoCommitCeiling,
      },
      cycle: {
        used: cycleElapsedMs,
        cap: cooldownMs,
        remaining: snap.cycleCooldownRemainingMs,
        readyAt: cycleReadyAt,
        source: cycleSource,
        aboveShipped: resolved?.cycleCooldownMinutes.aboveShipped
          ?? cooldownMs < CYCLE_COOLDOWN_MS,
      },
    },
    roster: buildRosterBlock(args, shippedCount),
    charter: {
      budgetsFileMtimeMs: args.charter?.budgets.file.mtimeMs ?? 0,
      choresFileMtimeMs: args.charter?.roster.file.mtimeMs ?? 0,
      readAt: computedAt,
      pending: {},
    },
    warnings,
  };
}

function buildRosterBlock(
  args: BuildEffectiveBudgetsArgs,
  shippedCount: number,
): EffectiveBudgetsDisplay["roster"] {
  const roster = args.charter?.roster;
  if (!roster) {
    return {
      enabledCount: shippedCount,
      shippedCount,
      disabled: [],
      entries: ACTION_CATALOG.filter((e) => e.admitted).map((e) => ({
        key: e.key,
        class: e.class,
        tier: e.budgetTier,
        enabled: true,
        lastRun: args.recentActions?.[e.key] ?? null,
      })),
    };
  }
  const entries = roster.entries.map((e: RosterEntryView) => ({
    key: e.unknown ? `??:${e.key}` : e.key,
    class: e.class,
    tier: e.tier,
    enabled: e.enabled,
    lastRun: args.recentActions?.[e.key] ?? e.lastRun,
  }));
  return {
    enabledCount: roster.effectiveKeys.length,
    shippedCount,
    disabled: roster.disabled.map((k) =>
      roster.unknownKeys.includes(k) ? `??:${k}` : k,
    ),
    entries,
  };
}

/** Fields added onto `lucerna status --json` `budget` (existing keys kept). */
export function statusBudgetAdditions(display: EffectiveBudgetsDisplay): {
  resetsAt: {
    daily: string | undefined;
    weekly: string | undefined;
    tokens: string | undefined;
    cycle: string | undefined;
  };
  capSource: {
    daily: BudgetCapSource;
    weekly: BudgetCapSource;
    tokens: BudgetCapSource;
    cycle: BudgetCapSource;
  };
  aboveShipped: {
    daily: boolean;
    weekly: boolean;
    tokens: boolean;
    cycle: boolean;
  };
} {
  return {
    resetsAt: {
      daily: display.windows.daily.resetsAt,
      weekly: display.windows.weekly.resetsAt,
      tokens: display.windows.tokens.resetsAt,
      cycle: display.windows.cycle.readyAt,
    },
    capSource: {
      daily: display.windows.daily.source,
      weekly: display.windows.weekly.source,
      tokens: display.windows.tokens.source,
      cycle: display.windows.cycle.source,
    },
    aboveShipped: {
      daily: display.windows.daily.aboveShipped,
      weekly: display.windows.weekly.aboveShipped,
      tokens: display.windows.tokens.aboveShipped,
      cycle: display.windows.cycle.aboveShipped,
    },
  };
}
