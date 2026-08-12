/**
 * Somniator  -  dream planner for lucerna (light + agentic).
 *
 * One dream cycle gathers a compact house snapshot, then makes one
 * amore-headless call with --json-schema to pick at most one admitted
 * action (or skip). Agentic picks spawn a multi-turn amore loop under
 * wall-timeout + web-off + governance after-check.
 * Model-agnostic: the only LLM path is the amore binary.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { LucernaConfig } from "./config.ts";
import {
  callAmoreHeadless,
  type AmoreHeadlessResult,
  type CallAmoreHeadlessOptions,
} from "./engine/amore-headless.ts";
import {
  ADMITTED_ACTION_KEYS,
  actionBudgetTier,
  actionCooldownClass,
  executeLightAction,
  isAdmittedAction,
  isAgenticCatalogAction,
  surveyOrg,
} from "./actions.ts";
import {
  isFullAgenticKey,
  runAgenticAction,
  type AgenticHeadlessCaller,
  type GovernanceBreach,
} from "./agentic.ts";
import {
  formatBudgetForPlanner,
  isSingleCallSpend,
  PLANNER_RESERVE,
  SHORT_CYCLE_COOLDOWN_MS,
  sumTokenUsage,
  type BudgetSnapshot,
} from "./budget.ts";
import {
  applyCharterToConfig,
  budgetsDeletedWhileRunning,
  choresDeletedWhileRunning,
  shouldApplyShippedBudgets,
  dreamPickSchema,
  isRosterKeyEnabled,
  PLANNER_SPAWN_OPTIONS,
  resolveBudgetConfig,
  type ResolvedCharter,
} from "./charter.ts";
import {
  readEnablementForHouse,
  resolveStartFlags,
  type EnablementRead,
} from "./enablement.ts";
import { mergeGovernanceLists, loadUserGovernance } from "./governance.ts";
import { StateManager, type DreamCycleOutcome } from "./state.ts";
import { appendNotification } from "./notifications.ts";
import { localFileTimestamp, localTimestamp } from "./time.ts";
import { logPath } from "./paths.ts";

export interface CycleEnablementFlags {
  dreamsEnabled: boolean;
  autoCommitEnabled: boolean;
  autoCommitLive: boolean;
  ioError?: string;
}

/**
 * Apply one enablement read. IO error keeps previous flags; absent or
 * malformed file yields defaults (env/argv may still turn a knob on).
 */
export function flagsFromEnablementRead(
  read: EnablementRead,
  previous: {
    dreamsEnabled: boolean;
    autoCommitEnabled: boolean;
    autoCommitLive: boolean;
  },
  sources: {
    envDreams?: string;
    envAutoCommit?: string;
    envAutoCommitLive?: string;
    args?: string[];
  } = {},
): CycleEnablementFlags {
  if (read.error && !/malformed/i.test(read.error)) {
    return { ...previous, ioError: read.error };
  }
  const flags = resolveStartFlags({
    enablement: read.enablement,
    envDreams: sources.envDreams,
    envAutoCommit: sources.envAutoCommit,
    envAutoCommitLive: sources.envAutoCommitLive,
    args: sources.args,
  });
  return {
    dreamsEnabled: flags.dreamsEnabled,
    autoCommitEnabled: flags.autoCommitEnabled,
    autoCommitLive: flags.autoCommitLive,
  };
}

/**
 * Re-read enablement at a unit boundary. File edit/delete stops the next
 * cycle; only halt/stop interrupt work already running.
 */
export function resolveCycleEnablement(
  houseRoot: string,
  previous: {
    dreamsEnabled: boolean;
    autoCommitEnabled: boolean;
    autoCommitLive: boolean;
  },
  sources?: {
    envDreams?: string;
    envAutoCommit?: string;
    envAutoCommitLive?: string;
    args?: string[];
  },
): CycleEnablementFlags {
  const read = readEnablementForHouse(houseRoot);
  return flagsFromEnablementRead(read, previous, {
    envDreams: sources?.envDreams ?? process.env.LUCERNA_DREAMS_ENABLED,
    envAutoCommit: sources?.envAutoCommit ?? process.env.LUCERNA_AUTO_COMMIT,
    envAutoCommitLive:
      sources?.envAutoCommitLive ?? process.env.LUCERNA_AUTO_COMMIT_LIVE,
    args: sources?.args ?? process.argv.slice(2),
  });
}

function applyCycleEnablement(
  config: LucernaConfig,
  sources?: {
    envDreams?: string;
    envAutoCommit?: string;
    envAutoCommitLive?: string;
    args?: string[];
  },
): CycleEnablementFlags {
  const previous = {
    dreamsEnabled: config.dreamsEnabled,
    autoCommitEnabled: config.autoCommitEnabled,
    autoCommitLive: !config.autoCommitDryRun,
  };
  const next = resolveCycleEnablement(config.houseRoot, previous, sources);
  if (next.ioError) {
    appendCycleLog(
      config.runtimeDir,
      `enablement read error: ${next.ioError} (keeping previous flags)`,
    );
    return next;
  }
  config.dreamsEnabled = next.dreamsEnabled;
  config.autoCommitEnabled = next.autoCommitEnabled;
  config.autoCommitDryRun = !next.autoCommitLive || !next.autoCommitEnabled;
  return next;
}

function appendCycleLog(runtimeDir: string, line: string): void {
  mkdirSync(runtimeDir, { recursive: true });
  appendFileSync(logPath(runtimeDir), `${localTimestamp()} ${line}\n`, "utf-8");
}

/** Admitted keys plus the skip option (light + agentic). */
export const DREAM_PICK_ACTIONS = [...ADMITTED_ACTION_KEYS, "skip"] as const;
export type DreamPickAction = (typeof DREAM_PICK_ACTIONS)[number];

export const DREAM_PICK_SCHEMA = dreamPickSchema(ADMITTED_ACTION_KEYS);

export { dreamPickSchema };

export interface DreamPick {
  action: DreamPickAction;
  reason: string;
}

export type DreamCycleStatus = "ran" | "skipped" | "refused" | "failed" | "idle";

export interface DreamCycleResult {
  status: DreamCycleStatus;
  reason: string;
  action?: string;
  artifactPath?: string;
  manifestPath?: string;
  proposalPaths?: string[];
  breaches?: GovernanceBreach[];
  planningTokens?: number;
  agenticTokens?: number;
  pick?: DreamPick | null;
  agentic?: boolean;
}

export type HeadlessCaller = (
  opts: CallAmoreHeadlessOptions,
) => Promise<AmoreHeadlessResult>;

export interface HouseSnapshot {
  inboxOpen: number;
  tasksActive: number;
  tasksCompleted: number;
  reminders: number;
  forgeReports: number;
  recentActions: string[];
  budget: BudgetSnapshot;
}

export function gatherHouseSnapshot(
  houseRoot: string,
  state: StateManager,
): HouseSnapshot {
  const survey = surveyOrg(houseRoot);
  const st = state.get();
  const recent = (st.lastActionResults ?? []).slice(0, 8).map(
    (r) => `${r.key}:${r.ok ? "ok" : "fail"}`,
  );
  return {
    inboxOpen: survey.inboxOpen,
    tasksActive: survey.tasksActive,
    tasksCompleted: survey.tasksCompleted,
    reminders: survey.reminders,
    forgeReports: survey.forgeReports,
    recentActions: recent,
    budget: state.budgetSnapshot(),
  };
}

export function buildPlannerSystemPrompt(
  keys: readonly string[] = ADMITTED_ACTION_KEYS,
): string {
  return `You are Lucerna, the house steward dream planner.

Admitted actions (pick exactly one key, or skip):
${keys.join("\n")}
skip

Classes:
- Light (daily budget, model-free or thin shell): survey-org, substrate-health, inbox-age-report, state-cleanup, edges-update, qmd-refresh
- Expensive agentic (weekly budget, multi-turn model): self-orient, agentic-housekeeping, edges-densify

Rules:
- Pick at most one action key from the admitted list, or "skip".
- Prefer skip when the house is calm or budgets are tight.
- Prefer light maintenance when a cheap scan is enough.
- Prefer expensive agentic only when weekly budget remains and orientation or deep tidy is warranted.
- Never invent keys outside the admitted list.
- Output JSON matching the schema only: { "action": "<key|skip>", "reason": "<one line>" }.`;
}

export function buildPlannerUserPrompt(
  houseRoot: string,
  snap: HouseSnapshot,
): string {
  const budgetBlock = formatBudgetForPlanner(snap.budget);
  return [
    `House root: ${houseRoot}`,
    `Local time: ${localTimestamp()}`,
    `Survey: inboxOpen=${snap.inboxOpen} tasksActive=${snap.tasksActive} tasksCompleted=${snap.tasksCompleted} reminders=${snap.reminders} forgeReports=${snap.forgeReports}`,
    `Recent actions: ${snap.recentActions.length ? snap.recentActions.join(", ") : "(none)"}`,
    "",
    budgetBlock,
    "",
    "Pick one admitted action or skip. Reason must be one short line.",
  ].join("\n");
}

/**
 * Parse a planner pick from structuredOutput (preferred) or text fallback.
 * Returns null when the payload is missing or malformed.
 */
export function isDegeneratePlannerReason(reason: string): boolean {
  return reason.trim().toLowerCase() === "placeholder";
}

export function parseDreamPick(
  structured: unknown,
  text?: string,
  allowed: readonly string[] = DREAM_PICK_ACTIONS,
): DreamPick | null {
  let obj: { action?: unknown; reason?: unknown } | null = null;

  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    obj = structured as { action?: unknown; reason?: unknown };
  } else if (typeof text === "string" && text.trim()) {
    try {
      obj = JSON.parse(text.trim()) as { action?: unknown; reason?: unknown };
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          obj = JSON.parse(text.slice(start, end + 1)) as {
            action?: unknown;
            reason?: unknown;
          };
        } catch {
          return null;
        }
      }
    }
  }

  if (!obj) return null;
  if (typeof obj.action !== "string" || typeof obj.reason !== "string") return null;
  const action = obj.action.trim();
  const reason = obj.reason.replace(/\s+/g, " ").trim();
  if (!reason) return null;
  if (!(allowed as readonly string[]).includes(action)) return null;
  return { action: action as DreamPickAction, reason: reason.slice(0, 240) };
}

function applyCycleCharter(
  config: LucernaConfig,
  state: StateManager,
  sources?: { env?: NodeJS.ProcessEnv; args?: string[] },
): ResolvedCharter {
  const previous = config.charter;
  const next = resolveBudgetConfig({
    houseRoot: config.houseRoot,
    env: sources?.env ?? process.env,
    args: sources?.args ?? process.argv.slice(2),
    previous,
    recentActions: state.get().dream.recentActions,
  });
  if (next.budgets.file.ioError) {
    appendCycleLog(
      config.runtimeDir,
      `budgets.json read error: ${next.budgets.file.ioError} (keeping previous knobs)`,
    );
  }
  if (next.roster.file.ioError) {
    appendCycleLog(
      config.runtimeDir,
      `chores.json read error: ${next.roster.file.ioError} (keeping previous roster)`,
    );
  }
  const presence = state.getCharterPresence();
  const budgetsDeleted = budgetsDeletedWhileRunning(presence.budgets, next.budgets);
  applyCharterToConfig(config, next, {
    applyShipped: shouldApplyShippedBudgets(next.budgets, budgetsDeleted),
  });
  config.charter = next;

  if (budgetsDeleted) {
    appendNotification(config.runtimeDir, {
      level: "warn",
      kind: "config-removed",
      message: "budgets.json removed; applying shipped defaults",
    });
  }
  if (choresDeletedWhileRunning(presence.chores, next.roster)) {
    appendNotification(config.runtimeDir, {
      level: "warn",
      kind: "config-removed",
      message: "chores.json removed; all admitted chores enabled",
    });
  }
  if (next.budgets.notifyMalformed) {
    appendNotification(config.runtimeDir, {
      level: "warn",
      kind: "charter-malformed",
      message: next.budgets.warnings.find((w) => /malformed/i.test(w))
        ?? "budgets.json malformed; using shipped defaults",
    });
  }
  if (state.hasClockSkew()) {
    appendNotification(config.runtimeDir, {
      level: "warn",
      kind: "clock-skew",
      message: "stored date key is after today; keeping counters",
    });
  }

  let reasonOverride: import("./budgets-display.ts").BudgetReasonCode | undefined;
  if (next.roster.refuse) reasonOverride = "config-invalid";
  else if (next.budgets.dailyActionCap.value === 0) reasonOverride = "cap-zero";
  else if (next.roster.effectiveKeys.length === 0) reasonOverride = "roster-empty";
  state.applyCharter(
    next,
    reasonOverride,
    shouldApplyShippedBudgets(next.budgets, budgetsDeleted),
  );
  return next;
}

function maybeNotifySingleCallSpend(
  runtimeDir: string,
  usage: { total_tokens?: number } | undefined | null,
  dailyTokenCeiling: number,
): void {
  const add = sumTokenUsage(usage);
  if (!isSingleCallSpend(add, dailyTokenCeiling)) return;
  appendNotification(runtimeDir, {
    level: "warn",
    kind: "single-call-spend",
    message: `single envelope ${add} exceeds 25% of daily ceiling ${dailyTokenCeiling}`,
  });
}

function maybeNotifyIdleTransition(
  state: StateManager,
  runtimeDir: string,
  kind: "roster-empty" | "cap-zero",
  message: string,
): void {
  if (state.lastIdleNotify() === kind) return;
  appendNotification(runtimeDir, { level: "info", kind: `budget-${kind}`, message });
  state.setLastIdleNotify(kind);
}

export function lightDreamRelPath(actionKey: string, fileTs?: string): string {
  const ts = fileTs ?? localFileTimestamp();
  return `forge/dreams/${ts}-${actionKey}.md`;
}

export interface RunDreamCycleOptions {
  /** Override schedule (cycle cooldown) only. Never bypasses enablement. */
  force?: boolean;
  /**
   * Run this action directly (skip planner). Still honors enablement + budgets.
   * Used by `lucerna dream-cycle --action <key>`.
   */
  forceAction?: string;
  /** Inject headless caller for tests (planner + agentic). */
  headless?: HeadlessCaller;
  /** Inject state manager (tests / shared daemon state). */
  stateManager?: StateManager;
  /** When false, skip writing notifications (rare). Default true. */
  notify?: boolean;
  /** Env/argv snap for enablement reload (defaults to the process). */
  enablementSources?: {
    envDreams?: string;
    envAutoCommitLive?: string;
    args?: string[];
  };
  /** Env/argv snap for charter reload (defaults to the process). */
  charterSources?: {
    env?: NodeJS.ProcessEnv;
    args?: string[];
  };
}

/**
 * Run one dream cycle: enablement + budgets, optional planner, optional action.
 */
export async function runDreamCycle(
  config: LucernaConfig,
  opts: RunDreamCycleOptions = {},
): Promise<DreamCycleResult> {
  const state =
    opts.stateManager ??
    new StateManager(config.runtimeDir, {
      dailyCap: config.dailyActionCap,
      weeklyCap: config.weeklyExpensiveCap,
      cooldownMs: config.cycleCooldownMs,
      tokenCeiling: config.dailyTokenCeiling,
      dreamsReserveTokens: config.dreamsReserveTokens,
      charter: config.charter,
    });
  const notify = opts.notify !== false;
  const headless: HeadlessCaller = opts.headless ?? callAmoreHeadless;

  const finish = (
    result: DreamCycleResult,
    cycleMark: "end" | "end-only" | "none" = "end-only",
    cooldownMs?: number,
  ): DreamCycleResult => {
    if (cycleMark === "end") {
      state.markDreamCycle(false, cooldownMs);
    } else if (cycleMark === "end-only") {
      state.markCycleEndedOnly(cooldownMs);
    }
    const outcome: DreamCycleOutcome = {
      at: localTimestamp(),
      status: result.status,
      reason: result.reason,
      action: result.action,
      artifactPath: result.artifactPath,
    };
    state.pushDreamCycleOutcome(outcome);
    state.setActivity("dream-cycle", `${result.status}: ${result.reason}`);
    state.save();
    appendCycleLog(
      config.runtimeDir,
      `dream-cycle ${result.status}: ${result.reason}${result.action ? ` action=${result.action}` : ""}${result.agentic ? " agentic" : ""}`,
    );
    return result;
  };

  // 1. Enablement  -  never bypassed by --force.
  // File edit/delete stops the next cycle; only halt/stop interrupt work already running.
  applyCycleEnablement(config, opts.enablementSources);
  const charter = applyCycleCharter(config, state, opts.charterSources);
  const effectiveKeys = charter.roster.effectiveKeys;
  const pickAllowed = [...effectiveKeys, "skip"];

  if (!config.dreamsEnabled) {
    const r = finish(
      { status: "refused", reason: "dreams disabled (dreamsEnabled is false)" },
      "none",
    );
    return r;
  }

  if (charter.roster.refuse) {
    state.setReasonCodeOverride("config-invalid");
    return finish(
      {
        status: "refused",
        reason: charter.roster.refuseReason ?? "roster invalid — dreams paused",
      },
      "none",
    );
  }

  if (config.dailyActionCap === 0) {
    maybeNotifyIdleTransition(
      state,
      config.runtimeDir,
      "cap-zero",
      "daily action cap is 0 (disabled)",
    );
    state.setReasonCodeOverride("cap-zero");
    return finish(
      { status: "idle", reason: "daily action cap is 0 (disabled)" },
      "end-only",
      SHORT_CYCLE_COOLDOWN_MS,
    );
  }

  if (effectiveKeys.length === 0) {
    maybeNotifyIdleTransition(
      state,
      config.runtimeDir,
      "roster-empty",
      "roster empty — no chores enabled",
    );
    state.setReasonCodeOverride("roster-empty");
    return finish(
      { status: "idle", reason: "roster empty — no chores enabled" },
      "end-only",
      SHORT_CYCLE_COOLDOWN_MS,
    );
  }

  if (opts.forceAction) {
    const key = opts.forceAction.trim();
    if (isAdmittedAction(key) && !isRosterKeyEnabled(charter.roster, key)) {
      return finish(
        {
          status: "refused",
          reason: `action disabled by roster: ${key}`,
          action: key,
        },
        "none",
      );
    }
  }

  // 2. Cycle gate (cooldown / daily budget / token ceiling)
  const gate = state.canStartCycle();
  if (!gate.allowed && !opts.force) {
    const r = finish({ status: "refused", reason: gate.reason }, "none");
    if (notify) {
      if (gate.reason.includes("token ceiling")) {
        appendNotification(config.runtimeDir, {
          level: "warn",
          kind: "budget-token-ceiling",
          message: gate.reason,
        });
      } else if (gate.reason.includes("daily budget exhausted")) {
        appendNotification(config.runtimeDir, {
          level: "info",
          kind: "budget-daily-exhausted",
          message: gate.reason,
        });
      }
    }
    return r;
  }

  // Even with --force, refuse when daily action budget or token ceiling is exhausted
  if (opts.force) {
    const snap = state.budgetSnapshot();
    if (snap.tokenCeilingReached) {
      const reason = `daily token ceiling reached (${snap.tokensToday}/${snap.dailyTokenCeiling})`;
      const r = finish({ status: "refused", reason }, "none");
      if (notify) {
        appendNotification(config.runtimeDir, {
          level: "warn",
          kind: "budget-token-ceiling",
          message: reason,
        });
      }
      return r;
    }
    if (snap.remainingDaily <= 0) {
      const reason = `daily budget exhausted (${snap.actionsToday}/${snap.dailyCap})`;
      const r = finish({ status: "refused", reason }, "none");
      if (notify) {
        appendNotification(config.runtimeDir, {
          level: "info",
          kind: "budget-daily-exhausted",
          message: reason,
        });
      }
      return r;
    }
  }

  // 3. Snapshot + planner call (or forced action)
  state.markDreamCycle(true);
  state.save();

  let pick: DreamPick | null = null;
  let planningTokens: number | undefined;

  if (opts.forceAction) {
    const key = opts.forceAction.trim();
    if (!isAdmittedAction(key)) {
      return finish(
        {
          status: "refused",
          reason: `action not admitted: ${key}`,
          action: key,
        },
        "end",
        SHORT_CYCLE_COOLDOWN_MS,
      );
    }
    pick = { action: key as DreamPickAction, reason: `forced action ${key}` };
  } else {
    const tokensNow = state.budgetSnapshot().tokensToday;
    const ceiling = config.dailyTokenCeiling;
    if (tokensNow + PLANNER_RESERVE > ceiling) {
      return finish(
        {
          status: "refused",
          reason: `planner reservation: tokensToday ${tokensNow} + ${PLANNER_RESERVE} exceeds ceiling ${ceiling}`,
        },
        "end-only",
        SHORT_CYCLE_COOLDOWN_MS,
      );
    }

    const snap = gatherHouseSnapshot(config.houseRoot, state);
    const system = buildPlannerSystemPrompt(effectiveKeys);
    const user = buildPlannerUserPrompt(config.houseRoot, snap);

    let planResult: AmoreHeadlessResult;
    try {
      planResult = await headless({
        cwd: config.houseRoot,
        prompt: { system, user },
        ...PLANNER_SPAWN_OPTIONS,
        jsonSchema: dreamPickSchema(effectiveKeys),
        model: config.dreamModel?.trim() || undefined,
        amoreBin: config.amoreBin,
      });
    } catch (err) {
      const reason = `planner call failed: ${err instanceof Error ? err.message : String(err)}`;
      if (notify) {
        appendNotification(config.runtimeDir, {
          level: "error",
          kind: "dream-planner-fail",
          message: reason,
        });
      }
      return finish({ status: "failed", reason }, "end", SHORT_CYCLE_COOLDOWN_MS);
    }

    if (planResult.usage) {
      state.recordTokens(planResult.usage, "planner");
      if (notify) {
        maybeNotifySingleCallSpend(
          config.runtimeDir,
          planResult.usage,
          config.dailyTokenCeiling,
        );
      }
    }
    planningTokens =
      typeof planResult.usage?.total_tokens === "number"
        ? planResult.usage.total_tokens
        : undefined;

    pick = parseDreamPick(
      planResult.structuredOutput,
      planResult.text,
      pickAllowed,
    );
    if (!pick) {
      const reason = "planner returned malformed or empty pick";
      if (notify) {
        appendNotification(config.runtimeDir, {
          level: "warn",
          kind: "dream-planner-malformed",
          message: reason,
        });
      }
      return finish(
        { status: "failed", reason, planningTokens, pick: null },
        "end",
        SHORT_CYCLE_COOLDOWN_MS,
      );
    }
  }

  // 4. skip
  if (pick.action === "skip") {
    if (notify && isDegeneratePlannerReason(pick.reason)) {
      appendNotification(config.runtimeDir, {
        level: "warn",
        kind: "dream-planner-degenerate",
        message: `planner reason is degenerate: ${pick.reason}`,
      });
    }
    return finish(
      {
        status: "skipped",
        reason: pick.reason,
        planningTokens,
        pick,
      },
      "end",
      SHORT_CYCLE_COOLDOWN_MS,
    );
  }

  // 5. Admitted action gate + execute
  if (!isAdmittedAction(pick.action)) {
    return finish(
      {
        status: "refused",
        reason: `planner picked non-admitted action: ${pick.action}`,
        planningTokens,
        pick,
      },
      "end",
      SHORT_CYCLE_COOLDOWN_MS,
    );
  }

  if (!effectiveKeys.includes(pick.action)) {
    return finish(
      {
        status: "refused",
        reason: `action disabled by roster: ${pick.action}`,
        action: pick.action,
        planningTokens,
        pick,
      },
      "end",
      SHORT_CYCLE_COOLDOWN_MS,
    );
  }

  const tier = actionBudgetTier(pick.action);
  const cd = actionCooldownClass(pick.action);
  const actionGate = state.canRunAction(pick.action, tier, cd);
  if (!actionGate.allowed) {
    return finish(
      {
        status: "refused",
        reason: actionGate.reason,
        action: pick.action,
        planningTokens,
        pick,
      },
      "end",
      SHORT_CYCLE_COOLDOWN_MS,
    );
  }

  const dreamsDir = join(config.houseRoot, "forge", "dreams");
  if (!existsSync(dreamsDir)) {
    mkdirSync(dreamsDir, { recursive: true });
  }

  const lists = mergeGovernanceLists(loadUserGovernance(config.houseRoot));

  // Full agentic loop
  if (isFullAgenticKey(pick.action)) {
    const agentic = await runAgenticAction({
      config,
      actionKey: pick.action,
      reason: pick.reason,
      lists,
      headless: headless as AgenticHeadlessCaller,
    });

    if (agentic.usageTokens) {
      state.recordTokens({ total_tokens: agentic.usageTokens }, "agentic");
      if (notify) {
        maybeNotifySingleCallSpend(
          config.runtimeDir,
          { total_tokens: agentic.usageTokens },
          config.dailyTokenCeiling,
        );
      }
    }

    // Pre-spawn failures (ENOENT / missing binary) must not consume cooldown
    // or daily/weekly action budgets — those bound model spend after launch.
    if (agentic.spawnStarted) {
      state.recordDreamAction(pick.action, new Date(), tier);
    }
    state.pushActionResult(pick.action, agentic.ok, agentic.detail);

    let ref: string | undefined;
    if (agentic.manifestPath) {
      try {
        ref = relative(config.houseRoot, agentic.manifestPath).replace(/\\/g, "/");
      } catch {
        ref = agentic.manifestPath;
      }
    }

    if (agentic.breaches && agentic.breaches.length > 0 && notify) {
      appendNotification(config.runtimeDir, {
        level: "error",
        kind: "governance-breach",
        message: `agentic ${pick.action}: ${agentic.detail}`,
        ref,
      });
    } else if (notify && agentic.ok) {
      appendNotification(config.runtimeDir, {
        level: "info",
        kind: "dream-action",
        message: `agentic ${pick.action}: ${pick.reason}`,
        ref,
      });
    } else if (notify && !agentic.ok) {
      appendNotification(config.runtimeDir, {
        level: "error",
        kind: "dream-action-fail",
        message: `agentic ${pick.action} failed: ${agentic.detail}`,
        ref,
      });
    }

    return finish(
      {
        status: agentic.ok ? "ran" : "failed",
        reason: agentic.ok ? pick.reason : agentic.detail,
        action: pick.action,
        artifactPath: agentic.artifactPath,
        manifestPath: agentic.manifestPath,
        proposalPaths: agentic.proposalPaths,
        breaches: agentic.breaches,
        planningTokens,
        agenticTokens: agentic.usageTokens,
        pick,
        agentic: true,
      },
      "end",
    );
  }

  // Light / shell actions (including edges-update and edges-densify)
  const exec = executeLightAction(pick.action, config.houseRoot, lists);
  if (!exec) {
    return finish(
      {
        status: "failed",
        reason: `no runner for ${pick.action}`,
        action: pick.action,
        planningTokens,
        pick,
      },
      "end",
    );
  }

  state.recordDreamAction(pick.action, new Date(), tier);
  state.pushActionResult(pick.action, exec.ok, exec.detail);

  let ref: string | undefined;
  if (exec.artifactPath) {
    try {
      ref = relative(config.houseRoot, exec.artifactPath).replace(/\\/g, "/");
    } catch {
      ref = exec.artifactPath;
    }
  }

  if (notify && exec.ok) {
    appendNotification(config.runtimeDir, {
      level: "info",
      kind: "dream-action",
      message: `executed ${pick.action}: ${pick.reason}`,
      ref,
    });
  } else if (notify && !exec.ok) {
    appendNotification(config.runtimeDir, {
      level: "error",
      kind: "dream-action-fail",
      message: `action ${pick.action} failed: ${exec.detail}`,
      ref,
    });
  }

  return finish(
    {
      status: exec.ok ? "ran" : "failed",
      reason: exec.ok ? pick.reason : exec.detail,
      action: pick.action,
      artifactPath: exec.artifactPath,
      planningTokens,
      pick,
      agentic: isAgenticCatalogAction(pick.action),
    },
    "end",
  );
}
