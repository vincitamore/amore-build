/**
 * Lucerna state persistence (atomic tmp+rename) + budget helpers.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { localTimestamp } from "./time.ts";
import {
  DAILY_ACTION_BUDGET,
  WEEKLY_EXPENSIVE_BUDGET,
  CYCLE_COOLDOWN_MS,
  DEFAULT_DAILY_TOKEN_CEILING,
  getRemainingDailyBudget,
  getRemainingWeeklyBudget,
  hasActionBudget,
  isCycleCooldownElapsed,
  canStartCycle,
  canRunAction,
  recordAction,
  recordTokenUsage,
  budgetSnapshot,
  type BudgetSnapshot,
  type BudgetTier,
  type ActionCooldownClass,
  type TokenUsage,
  type BudgetCounters,
} from "./budget.ts";
import { RUNTIME_FILES } from "./paths.ts";

export interface DreamState {
  pipelineRunning: boolean;
  pipelineStarted: string | null;
  totalDreams: number;
  cycleActive: boolean;
  cycleStarted: string | null;
  lastCycleEnded: string | null;
  actionsToday: number;
  lastActionDate: string | null;
  actionsThisWeek: number;
  lastActionWeek: string | null;
  recentActions?: Record<string, string>;
  tokensToday: number;
  lastTokenDate: string | null;
}

export interface AutoCommitDraft {
  subject: string;
  body: string;
  files: string[];
  createdAt: string;
  dryRun: boolean;
}

export interface LucernaState {
  version: 1;
  lastSaved: string;
  dream: DreamState;
  lastActivity: { type: string; detail: string; timestamp: string } | null;
  lastActionResults: Array<{ key: string; ok: boolean; detail: string; at: string }>;
  queryEngine: "amore-headless";
  heartbeat?: { phase: string; intervalMs: number; bpm: number };
  autoCommitDraft?: AutoCommitDraft | null;
}

function emptyState(): LucernaState {
  return {
    version: 1,
    lastSaved: localTimestamp(),
    dream: {
      pipelineRunning: false,
      pipelineStarted: null,
      totalDreams: 0,
      cycleActive: false,
      cycleStarted: null,
      lastCycleEnded: null,
      actionsToday: 0,
      lastActionDate: null,
      actionsThisWeek: 0,
      lastActionWeek: null,
      recentActions: {},
      tokensToday: 0,
      lastTokenDate: null,
    },
    lastActivity: null,
    lastActionResults: [],
    queryEngine: "amore-headless",
    autoCommitDraft: null,
  };
}

export class StateManager {
  private path: string;
  private tmpPath: string;
  private state: LucernaState;
  private dailyCap: number;
  private weeklyCap: number;
  private cooldownMs: number;
  private tokenCeiling: number;

  constructor(
    runtimeDir: string,
    opts?: {
      dailyCap?: number;
      weeklyCap?: number;
      cooldownMs?: number;
      tokenCeiling?: number;
    },
  ) {
    mkdirSync(runtimeDir, { recursive: true });
    this.path = join(runtimeDir, RUNTIME_FILES.state);
    this.tmpPath = this.path + ".tmp";
    this.dailyCap = opts?.dailyCap ?? DAILY_ACTION_BUDGET;
    this.weeklyCap = opts?.weeklyCap ?? WEEKLY_EXPENSIVE_BUDGET;
    this.cooldownMs = opts?.cooldownMs ?? CYCLE_COOLDOWN_MS;
    this.tokenCeiling = opts?.tokenCeiling ?? DEFAULT_DAILY_TOKEN_CEILING;
    this.state = this.load();
  }

  private load(): LucernaState {
    if (!existsSync(this.path)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      return {
        ...emptyState(),
        ...raw,
        version: 1,
        queryEngine: "amore-headless",
        dream: {
          ...emptyState().dream,
          ...(raw.dream ?? {}),
          actionsThisWeek: raw.dream?.actionsThisWeek ?? 0,
          lastActionWeek: raw.dream?.lastActionWeek ?? null,
          tokensToday: raw.dream?.tokensToday ?? 0,
          lastTokenDate: raw.dream?.lastTokenDate ?? null,
          recentActions: {
            ...(emptyState().dream.recentActions ?? {}),
            ...(raw.dream?.recentActions ?? {}),
          },
        },
        lastActionResults: Array.isArray(raw.lastActionResults) ? raw.lastActionResults : [],
      };
    } catch {
      return emptyState();
    }
  }

  get(): LucernaState {
    return this.state;
  }

  /** Budget counters view for pure budget helpers. */
  asCounters(): BudgetCounters {
    return {
      actionsToday: this.state.dream.actionsToday,
      lastActionDate: this.state.dream.lastActionDate,
      actionsThisWeek: this.state.dream.actionsThisWeek,
      lastActionWeek: this.state.dream.lastActionWeek,
      lastCycleEnded: this.state.dream.lastCycleEnded,
      cycleActive: this.state.dream.cycleActive,
      recentActions: this.state.dream.recentActions,
      tokensToday: this.state.dream.tokensToday,
      lastTokenDate: this.state.dream.lastTokenDate,
    };
  }

  save(): void {
    this.state.lastSaved = localTimestamp();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.tmpPath, JSON.stringify(this.state, null, 2), "utf-8");
    renameSync(this.tmpPath, this.path);
  }

  setHeartbeat(phase: string, intervalMs: number, bpm: number): void {
    this.state.heartbeat = { phase, intervalMs, bpm };
  }

  setActivity(type: string, detail: string): void {
    this.state.lastActivity = { type, detail, timestamp: localTimestamp() };
  }

  pushActionResult(key: string, ok: boolean, detail: string): void {
    this.state.lastActionResults = [
      { key, ok, detail, at: localTimestamp() },
      ...this.state.lastActionResults,
    ].slice(0, 20);
  }

  setAutoCommitDraft(draft: AutoCommitDraft | null): void {
    this.state.autoCommitDraft = draft;
  }

  markDreamCycle(active: boolean): void {
    this.state.dream.cycleActive = active;
    if (active) {
      this.state.dream.cycleStarted = localTimestamp();
    } else {
      this.state.dream.lastCycleEnded = localTimestamp();
      this.state.dream.totalDreams += 1;
    }
  }

  markCycleEndedOnly(): void {
    this.state.dream.cycleActive = false;
    this.state.dream.lastCycleEnded = localTimestamp();
  }

  getRemainingBudget(now: Date = new Date()): number {
    return getRemainingDailyBudget(this.state.dream, now, this.dailyCap);
  }

  getRemainingWeeklyBudget(now: Date = new Date()): number {
    return getRemainingWeeklyBudget(this.state.dream, now, this.weeklyCap);
  }

  hasActionBudget(now: Date = new Date()): boolean {
    return hasActionBudget(this.state.dream, now, this.dailyCap);
  }

  isCycleCooldownElapsed(nowMs: number = Date.now()): boolean {
    return isCycleCooldownElapsed(this.state.dream.lastCycleEnded, nowMs, this.cooldownMs);
  }

  canStartCycle(now: Date = new Date()): {
    allowed: boolean;
    reason: string;
    remaining: number;
    remainingWeekly: number;
  } {
    return canStartCycle(this.asCounters(), now, {
      dailyCap: this.dailyCap,
      cooldownMs: this.cooldownMs,
      tokenCeiling: this.tokenCeiling,
    });
  }

  canRunAction(
    actionKey: string,
    tier: BudgetTier,
    cooldownClass: ActionCooldownClass,
    now: Date = new Date(),
  ): { allowed: boolean; reason: string } {
    return canRunAction(this.asCounters(), {
      tier,
      cooldownClass,
      actionKey,
      now,
      dailyCap: this.dailyCap,
      weeklyCap: this.weeklyCap,
      tokenCeiling: this.tokenCeiling,
    });
  }

  budgetSnapshot(now: Date = new Date()): BudgetSnapshot {
    return budgetSnapshot(this.asCounters(), now, {
      dailyCap: this.dailyCap,
      weeklyCap: this.weeklyCap,
      cooldownMs: this.cooldownMs,
      tokenCeiling: this.tokenCeiling,
    });
  }

  recordDreamAction(
    actionKey?: string,
    now: Date = new Date(),
    tier: BudgetTier = "daily",
  ): void {
    const next = recordAction(this.asCounters(), { tier, now });
    this.state.dream.actionsToday = next.actionsToday;
    this.state.dream.lastActionDate = next.lastActionDate;
    this.state.dream.actionsThisWeek = next.actionsThisWeek;
    this.state.dream.lastActionWeek = next.lastActionWeek;
    if (actionKey) {
      this.state.dream.recentActions = {
        ...(this.state.dream.recentActions ?? {}),
        [actionKey]: now.toISOString(),
      };
    }
  }

  recordTokens(usage: TokenUsage | undefined | null, now: Date = new Date()): void {
    const next = recordTokenUsage(this.asCounters(), usage, now);
    this.state.dream.tokensToday = next.tokensToday;
    this.state.dream.lastTokenDate = next.lastTokenDate;
  }
}
