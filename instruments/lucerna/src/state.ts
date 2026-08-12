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
  DEFAULT_DREAMS_RESERVE_TOKENS,
  SHORT_CYCLE_COOLDOWN_MS,
  countersHaveClockSkew,
  effectiveCeiling,
  getRemainingDailyBudget,
  getRemainingWeeklyBudget,
  hasActionBudget,
  isCycleCooldownElapsed,
  canStartCycle,
  canRunAction,
  recordAction,
  recordTokenUsage,
  budgetSnapshot,
  sumTokensBySource,
  TOKEN_SOURCES,
  isTokenSource,
  type BudgetSnapshot,
  type BudgetTier,
  type ActionCooldownClass,
  type TokenUsage,
  type TokenSource,
  type TokensTodayBySource,
  type BudgetCounters,
} from "./budget.ts";
import {
  buildEffectiveBudgetsDisplay,
  type BudgetReasonCode,
  type EffectiveBudgetsDisplay,
} from "./budgets-display.ts";
import type { ResolvedCharter } from "./charter.ts";
import { RUNTIME_FILES } from "./paths.ts";

export interface DreamCycleOutcome {
  at: string;
  status: "ran" | "skipped" | "refused" | "failed" | "idle";
  reason: string;
  action?: string;
  artifactPath?: string;
}

export interface CharterPresence {
  budgets: boolean;
  chores: boolean;
}

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
  tokensTodayBySource?: TokensTodayBySource;
  maxCallTokens?: number;
  maxCallTokensAt?: string | null;
  /** Most recent cycle outcomes (newest first). */
  cycleHistory?: DreamCycleOutcome[];
  lastCycleOutcome?: DreamCycleOutcome | null;
  /** Cooldown applied when the last cycle ended (short vs full). */
  lastCycleCooldownMs?: number | null;
  /** Last pre-planner idle notify, so we fire once on transition. */
  lastIdleNotify?: "roster-empty" | "cap-zero" | null;
  /** Measurement: charter files seen while this process ran. */
  charterPresence?: CharterPresence;
}

export interface AutoCommitDraft {
  subject: string;
  body: string;
  files: string[];
  createdAt: string;
  dryRun: boolean;
}

/** Cadence / dedup metadata for auto-commit drafting (not the draft body). */
export interface AutoCommitMeta {
  /** ISO timestamp of last draft attempt that invoked the driver. */
  lastDraftAt: string | null;
  /** Hash of the porcelain change-set last drafted (or skipped as unchanged). */
  lastChangeHash: string | null;
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
  autoCommitMeta?: AutoCommitMeta;
  /** Display-only snapshot. Enforcement reads config caps, never this block. */
  budgets?: EffectiveBudgetsDisplay;
}

function parseTokensBySource(raw: unknown): TokensTodayBySource | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: TokensTodayBySource = {};
  for (const k of TOKEN_SOURCES) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
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
      maxCallTokens: 0,
      maxCallTokensAt: null,
      cycleHistory: [],
      lastCycleOutcome: null,
      lastCycleCooldownMs: null,
      lastIdleNotify: null,
      charterPresence: { budgets: false, chores: false },
    },
    lastActivity: null,
    lastActionResults: [],
    queryEngine: "amore-headless",
    autoCommitDraft: null,
    autoCommitMeta: {
      lastDraftAt: null,
      lastChangeHash: null,
    },
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
  private dreamsReserveTokens: number;
  private cooldownOverridesMs: Record<string, number>;
  private charter: ResolvedCharter | undefined;
  private reasonCodeOverride: BudgetReasonCode | undefined;
  private runtimeDir: string;

  constructor(
    runtimeDir: string,
    opts?: {
      dailyCap?: number;
      weeklyCap?: number;
      cooldownMs?: number;
      tokenCeiling?: number;
      dreamsReserveTokens?: number;
      cooldownOverridesMs?: Record<string, number>;
      charter?: ResolvedCharter;
    },
  ) {
    mkdirSync(runtimeDir, { recursive: true });
    this.runtimeDir = runtimeDir;
    this.path = join(runtimeDir, RUNTIME_FILES.state);
    this.tmpPath = this.path + ".tmp";
    this.dailyCap = opts?.dailyCap ?? DAILY_ACTION_BUDGET;
    this.weeklyCap = opts?.weeklyCap ?? WEEKLY_EXPENSIVE_BUDGET;
    this.cooldownMs = opts?.cooldownMs ?? CYCLE_COOLDOWN_MS;
    this.tokenCeiling = opts?.tokenCeiling ?? DEFAULT_DAILY_TOKEN_CEILING;
    this.dreamsReserveTokens = opts?.dreamsReserveTokens ?? DEFAULT_DREAMS_RESERVE_TOKENS;
    this.cooldownOverridesMs = opts?.cooldownOverridesMs ?? {};
    this.charter = opts?.charter;
    this.state = this.load();
  }

  applyCharter(
    charter: ResolvedCharter,
    reasonCodeOverride?: BudgetReasonCode,
    applyShippedBudgets = true,
  ): void {
    this.charter = charter;
    const b = charter.budgets;
    const take = (knob: { source: string }) =>
      applyShippedBudgets || knob.source !== "shipped";
    if (take(b.dailyActionCap)) this.dailyCap = b.dailyActionCap.value;
    if (take(b.weeklyExpensiveCap)) this.weeklyCap = b.weeklyExpensiveCap.value;
    if (take(b.cycleCooldownMinutes)) this.cooldownMs = b.cycleCooldownMs;
    if (take(b.dailyTokenCeiling)) this.tokenCeiling = b.dailyTokenCeiling.value;
    if (take(b.dreamsReserveTokens)) {
      this.dreamsReserveTokens = b.dreamsReserveTokens.value;
    }
    this.cooldownOverridesMs = charter.roster.cooldownOverridesMs;
    this.reasonCodeOverride = reasonCodeOverride;
    this.state.dream.charterPresence = {
      budgets: charter.budgets.file.present,
      chores: charter.roster.file.present,
    };
  }

  getCharterPresence(): CharterPresence {
    return (
      this.state.dream.charterPresence ?? { budgets: false, chores: false }
    );
  }

  getDreamsReserveTokens(): number {
    return this.dreamsReserveTokens;
  }

  getCooldownOverridesMs(): Record<string, number> {
    return this.cooldownOverridesMs;
  }

  getCharter(): ResolvedCharter | undefined {
    return this.charter;
  }

  getRuntimeDir(): string {
    return this.runtimeDir;
  }

  setReasonCodeOverride(code: BudgetReasonCode | undefined): void {
    this.reasonCodeOverride = code;
  }

  lastIdleNotify(): "roster-empty" | "cap-zero" | null {
    return this.state.dream.lastIdleNotify ?? null;
  }

  setLastIdleNotify(kind: "roster-empty" | "cap-zero" | null): void {
    this.state.dream.lastIdleNotify = kind;
  }

  applyShortCycleCooldown(): void {
    this.state.dream.lastCycleCooldownMs = SHORT_CYCLE_COOLDOWN_MS;
  }

  applyFullCycleCooldown(): void {
    this.state.dream.lastCycleCooldownMs = this.cooldownMs;
  }

  hasClockSkew(now: Date = new Date()): boolean {
    return countersHaveClockSkew(this.asCounters(), now);
  }

  private load(): LucernaState {
    if (!existsSync(this.path)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      const bySource = Object.prototype.hasOwnProperty.call(
        raw.dream ?? {},
        "tokensTodayBySource",
      )
        ? parseTokensBySource(raw.dream?.tokensTodayBySource)
        : undefined;
      const tokensToday = bySource
        ? sumTokensBySource(bySource)
        : (raw.dream?.tokensToday ?? 0);
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
          tokensToday,
          lastTokenDate: raw.dream?.lastTokenDate ?? null,
          tokensTodayBySource: bySource,
          maxCallTokens:
            typeof raw.dream?.maxCallTokens === "number" &&
            Number.isFinite(raw.dream.maxCallTokens)
              ? raw.dream.maxCallTokens
              : 0,
          maxCallTokensAt:
            typeof raw.dream?.maxCallTokensAt === "string"
              ? raw.dream.maxCallTokensAt
              : null,
          recentActions: {
            ...(emptyState().dream.recentActions ?? {}),
            ...(raw.dream?.recentActions ?? {}),
          },
          cycleHistory: Array.isArray(raw.dream?.cycleHistory)
            ? raw.dream.cycleHistory
            : [],
          lastCycleOutcome: raw.dream?.lastCycleOutcome ?? null,
          lastCycleCooldownMs:
            typeof raw.dream?.lastCycleCooldownMs === "number" &&
            Number.isFinite(raw.dream.lastCycleCooldownMs)
              ? raw.dream.lastCycleCooldownMs
              : null,
          lastIdleNotify:
            raw.dream?.lastIdleNotify === "roster-empty" ||
            raw.dream?.lastIdleNotify === "cap-zero"
              ? raw.dream.lastIdleNotify
              : null,
          charterPresence: {
            budgets: raw.dream?.charterPresence?.budgets === true,
            chores: raw.dream?.charterPresence?.chores === true,
          },
        },
        lastActionResults: Array.isArray(raw.lastActionResults) ? raw.lastActionResults : [],
        autoCommitMeta: {
          lastDraftAt: raw.autoCommitMeta?.lastDraftAt ?? null,
          lastChangeHash: raw.autoCommitMeta?.lastChangeHash ?? null,
        },
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
      tokensTodayBySource: this.state.dream.tokensTodayBySource,
      maxCallTokens: this.state.dream.maxCallTokens,
      maxCallTokensAt: this.state.dream.maxCallTokensAt,
    };
  }

  save(): void {
    this.state.lastSaved = localTimestamp();
    // Heartbeat cycle calls save() each tick, so a running daemon rewrites
    // this block after local-date rollover on the next tick.
    this.state.budgets = buildEffectiveBudgetsDisplay({
      snapshot: this.budgetSnapshot(),
      counters: this.asCounters(),
      cooldownMs: this.activeCooldownMs(),
      recentActions: this.state.dream.recentActions,
      charter: this.charter,
      reasonCodeOverride: this.reasonCodeOverride,
      dreamsReserveTokens: this.dreamsReserveTokens,
    });
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

  getAutoCommitMeta(): AutoCommitMeta {
    return (
      this.state.autoCommitMeta ?? {
        lastDraftAt: null,
        lastChangeHash: null,
      }
    );
  }

  /**
   * Record that a draft driver call completed for this change-set hash.
   * Starts the auto-commit cooldown clock.
   */
  recordAutoCommitDraft(changeHash: string, now: Date = new Date()): void {
    this.state.autoCommitMeta = {
      lastDraftAt: now.toISOString(),
      lastChangeHash: changeHash,
    };
  }

  /** True when enough time has elapsed since the last draft driver call. */
  isAutoCommitCooldownElapsed(
    cooldownMs: number,
    nowMs: number = Date.now(),
  ): boolean {
    const last = this.getAutoCommitMeta().lastDraftAt;
    if (!last) return true;
    const t = Date.parse(last);
    if (Number.isNaN(t)) return true;
    return nowMs - t >= cooldownMs;
  }

  /** Auto-commit ceiling: dailyTokenCeiling − dreamsReserveTokens. */
  isTokenCeilingReached(now: Date = new Date()): boolean {
    const rolled = this.budgetSnapshot(now);
    const ceiling = effectiveCeiling(
      "autoCommit",
      this.tokenCeiling,
      this.dreamsReserveTokens,
    );
    return rolled.tokensToday >= ceiling;
  }

  isDreamsCeilingReached(now: Date = new Date()): boolean {
    return this.budgetSnapshot(now).tokenCeilingReached;
  }

  autoCommitCeiling(): number {
    return effectiveCeiling("autoCommit", this.tokenCeiling, this.dreamsReserveTokens);
  }

  private activeCooldownMs(): number {
    return this.state.dream.lastCycleCooldownMs ?? this.cooldownMs;
  }

  markDreamCycle(active: boolean, cooldownMs?: number): void {
    this.state.dream.cycleActive = active;
    if (active) {
      this.state.dream.cycleStarted = localTimestamp();
    } else {
      this.state.dream.lastCycleEnded = localTimestamp();
      this.state.dream.totalDreams += 1;
      this.state.dream.lastCycleCooldownMs = cooldownMs ?? this.cooldownMs;
    }
  }

  markCycleEndedOnly(cooldownMs?: number): void {
    this.state.dream.cycleActive = false;
    this.state.dream.lastCycleEnded = localTimestamp();
    this.state.dream.lastCycleCooldownMs = cooldownMs ?? this.cooldownMs;
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
    return isCycleCooldownElapsed(
      this.state.dream.lastCycleEnded,
      nowMs,
      this.activeCooldownMs(),
    );
  }

  canStartCycle(now: Date = new Date()): {
    allowed: boolean;
    reason: string;
    remaining: number;
    remainingWeekly: number;
  } {
    return canStartCycle(this.asCounters(), now, {
      dailyCap: this.dailyCap,
      weeklyCap: this.weeklyCap,
      cooldownMs: this.activeCooldownMs(),
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
      cooldownOverridesMs: this.cooldownOverridesMs,
    });
  }

  budgetSnapshot(now: Date = new Date()): BudgetSnapshot {
    return budgetSnapshot(this.asCounters(), now, {
      dailyCap: this.dailyCap,
      weeklyCap: this.weeklyCap,
      cooldownMs: this.activeCooldownMs(),
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

  recordTokens(
    usage: TokenUsage | undefined | null,
    sourceOrNow?: TokenSource | Date,
    now?: Date,
  ): void {
    const source = isTokenSource(sourceOrNow) ? sourceOrNow : undefined;
    const when = isTokenSource(sourceOrNow)
      ? (now ?? new Date())
      : (sourceOrNow ?? now ?? new Date());
    const next = source
      ? recordTokenUsage(this.asCounters(), usage, source, when)
      : recordTokenUsage(this.asCounters(), usage, when);
    this.state.dream.tokensToday = next.tokensToday;
    this.state.dream.lastTokenDate = next.lastTokenDate;
    this.state.dream.tokensTodayBySource = next.tokensTodayBySource;
    this.state.dream.maxCallTokens = next.maxCallTokens;
    this.state.dream.maxCallTokensAt = next.maxCallTokensAt;
  }

  pushDreamCycleOutcome(outcome: DreamCycleOutcome): void {
    this.state.dream.lastCycleOutcome = outcome;
    this.state.dream.cycleHistory = [
      outcome,
      ...(this.state.dream.cycleHistory ?? []),
    ].slice(0, 40);
  }

  dreamCycleHistory(limit = 20): DreamCycleOutcome[] {
    return (this.state.dream.cycleHistory ?? []).slice(0, limit);
  }
}
