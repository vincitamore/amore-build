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
import { formatBudgetForPlanner, type BudgetSnapshot } from "./budget.ts";
import { mergeGovernanceLists, loadUserGovernance } from "./governance.ts";
import { StateManager, type DreamCycleOutcome } from "./state.ts";
import { appendNotification } from "./notifications.ts";
import { localFileTimestamp, localTimestamp } from "./time.ts";
import { logPath } from "./paths.ts";

function appendCycleLog(runtimeDir: string, line: string): void {
  mkdirSync(runtimeDir, { recursive: true });
  appendFileSync(logPath(runtimeDir), `${localTimestamp()} ${line}\n`, "utf-8");
}

/** Admitted keys plus the skip option (light + agentic). */
export const DREAM_PICK_ACTIONS = [...ADMITTED_ACTION_KEYS, "skip"] as const;
export type DreamPickAction = (typeof DREAM_PICK_ACTIONS)[number];

export const DREAM_PICK_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...DREAM_PICK_ACTIONS],
    },
    reason: { type: "string" },
  },
  required: ["action", "reason"],
  additionalProperties: false,
} as const;

export interface DreamPick {
  action: DreamPickAction;
  reason: string;
}

export type DreamCycleStatus = "ran" | "skipped" | "refused" | "failed";

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

export function buildPlannerSystemPrompt(): string {
  return `You are Lucerna, the house steward dream planner.

Admitted actions (pick exactly one key, or skip):
${ADMITTED_ACTION_KEYS.join("\n")}
skip

Classes:
- Light (daily budget, model-free or thin shell): survey-org, substrate-health, inbox-age-report, state-cleanup, edges-update
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
export function parseDreamPick(
  structured: unknown,
  text?: string,
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
  if (!(DREAM_PICK_ACTIONS as readonly string[]).includes(action)) return null;
  return { action: action as DreamPickAction, reason: reason.slice(0, 240) };
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
    });
  const notify = opts.notify !== false;
  const headless: HeadlessCaller = opts.headless ?? callAmoreHeadless;

  const finish = (
    result: DreamCycleResult,
    cycleMark: "end" | "end-only" | "none" = "end-only",
  ): DreamCycleResult => {
    if (cycleMark === "end") {
      state.markDreamCycle(false);
    } else if (cycleMark === "end-only") {
      state.markCycleEndedOnly();
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

  // 1. Enablement  -  never bypassed by --force
  if (!config.dreamsEnabled) {
    const r = finish(
      { status: "refused", reason: "dreams disabled (dreamsEnabled is false)" },
      "none",
    );
    return r;
  }

  // 2. Cycle gate (cooldown / daily budget / token ceiling)
  const gate = state.canStartCycle();
  if (!gate.allowed && !opts.force) {
    const r = finish({ status: "refused", reason: gate.reason }, "none");
    if (gate.reason.includes("token ceiling") && notify) {
      appendNotification(config.runtimeDir, {
        level: "warn",
        kind: "budget-token-ceiling",
        message: gate.reason,
      });
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
      return finish(
        {
          status: "refused",
          reason: `daily budget exhausted (${snap.actionsToday}/${snap.dailyCap})`,
        },
        "none",
      );
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
      );
    }
    pick = { action: key as DreamPickAction, reason: `forced action ${key}` };
  } else {
    const snap = gatherHouseSnapshot(config.houseRoot, state);
    const system = buildPlannerSystemPrompt();
    const user = buildPlannerUserPrompt(config.houseRoot, snap);

    let planResult: AmoreHeadlessResult;
    try {
      planResult = await headless({
        cwd: config.houseRoot,
        prompt: { system, user },
        mode: "json",
        jsonSchema: DREAM_PICK_SCHEMA,
        maxTurns: 1,
        noSubagents: true,
        wallMs: 180_000,
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
      return finish({ status: "failed", reason }, "end");
    }

    if (planResult.usage) {
      state.recordTokens(planResult.usage);
    }
    planningTokens =
      typeof planResult.usage?.total_tokens === "number"
        ? planResult.usage.total_tokens
        : undefined;

    pick = parseDreamPick(planResult.structuredOutput, planResult.text);
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
      );
    }
  }

  // 4. skip
  if (pick.action === "skip") {
    return finish(
      {
        status: "skipped",
        reason: pick.reason,
        planningTokens,
        pick,
      },
      "end",
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
      state.recordTokens({ total_tokens: agentic.usageTokens });
    }

    state.recordDreamAction(pick.action, new Date(), tier);
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
