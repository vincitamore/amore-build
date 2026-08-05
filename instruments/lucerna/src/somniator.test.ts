import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDreamPick,
  runDreamCycle,
  DREAM_PICK_SCHEMA,
  DREAM_PICK_ACTIONS,
  gatherHouseSnapshot,
  buildPlannerSystemPrompt,
  type HeadlessCaller,
} from "./somniator.ts";
import type { LucernaConfig } from "./config.ts";
import { houseRuntimeDir } from "./paths.ts";
import { StateManager } from "./state.ts";
import { readNotifications } from "./notifications.ts";
function syntheticHouse(): string {
  const house = mkdtempSync(join(tmpdir(), "lucerna-dream-house-"));
  mkdirSync(join(house, "tasks"), { recursive: true });
  mkdirSync(join(house, "inbox", "captures"), { recursive: true });
  mkdirSync(join(house, "reminders"), { recursive: true });
  mkdirSync(join(house, "knowledge"), { recursive: true });
  mkdirSync(join(house, "forge"), { recursive: true });
  mkdirSync(join(house, "instruments", "lucerna"), { recursive: true });
  writeFileSync(join(house, "AGENTS.md"), "# agents\n", "utf-8");
  writeFileSync(join(house, "tasks", "t1.md"), "# task\n", "utf-8");
  writeFileSync(join(house, "inbox", "captures", "c1.md"), "# cap\n", "utf-8");
  return house;
}

function makeConfig(house: string, dreamsEnabled: boolean): LucernaConfig {
  const runtimeDir = houseRuntimeDir(house);
  mkdirSync(runtimeDir, { recursive: true });
  return {
    houseRoot: house,
    runtimeDir,
    userConfigDir: join(house, ".user-config"),
    intervalMs: 8000,
    dryRun: true,
    dreamsEnabled,
    autoCommitEnabled: false,
    autoCommitDryRun: true,
    amoreBin: "amore",
    processName: "lucerna",
    version: "0.1.0",
    autoCommitModel: "",
    dreamModel: "",
    dailyActionCap: 12,
    weeklyExpensiveCap: 6,
    cycleCooldownMs: 2 * 60 * 60 * 1000,
    dailyTokenCeiling: 200_000,
    autoCommitCooldownMs: 30 * 60 * 1000,
  };
}

function makeStub(
  pick: unknown,
  opts?: { fail?: boolean; usageTokens?: number; textOnly?: boolean },
): { caller: HeadlessCaller; getCalls: () => number } {
  let calls = 0;
  const caller: HeadlessCaller = async (headOpts) => {
    calls += 1;
    // schema must be present for planner
    expect(headOpts.jsonSchema).toBeDefined();
    if (opts?.fail) throw new Error("stub planner boom");
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: opts?.usageTokens ?? 15,
    };
    if (opts?.textOnly) {
      return {
        text: JSON.stringify(pick),
        structuredOutput: undefined,
        raw: {},
        code: 0,
        stderr: "",
        usage,
      };
    }
    return {
      text: JSON.stringify(pick),
      structuredOutput: pick,
      raw: { structuredOutput: pick },
      code: 0,
      stderr: "",
      usage,
    };
  };
  return { caller, getCalls: () => calls };
}

describe("parseDreamPick", () => {
  test("valid pick from structuredOutput", () => {
    const p = parseDreamPick({ action: "survey-org", reason: "inbox is busy" });
    expect(p).not.toBeNull();
    expect(p!.action).toBe("survey-org");
    expect(p!.reason).toBe("inbox is busy");
  });

  test("skip pick", () => {
    const p = parseDreamPick({ action: "skip", reason: "house is calm" });
    expect(p!.action).toBe("skip");
  });

  test("malformed missing reason", () => {
    expect(parseDreamPick({ action: "survey-org" })).toBeNull();
  });

  test("malformed unknown action", () => {
    expect(parseDreamPick({ action: "not-a-real-key", reason: "nope" })).toBeNull();
  });

  test("agentic keys are valid picks", () => {
    expect(parseDreamPick({ action: "self-orient", reason: "drift" })!.action).toBe(
      "self-orient",
    );
    expect(
      parseDreamPick({ action: "agentic-housekeeping", reason: "tidy" })!.action,
    ).toBe("agentic-housekeeping");
  });

  test("malformed non-object", () => {
    expect(parseDreamPick(null)).toBeNull();
    expect(parseDreamPick("string")).toBeNull();
  });

  test("text fallback JSON", () => {
    const p = parseDreamPick(undefined, '{"action":"state-cleanup","reason":"prune"}');
    expect(p!.action).toBe("state-cleanup");
  });

  test("schema admits all light keys plus skip", () => {
    expect(DREAM_PICK_ACTIONS).toContain("skip");
    expect(DREAM_PICK_ACTIONS).toContain("survey-org");
    expect(DREAM_PICK_SCHEMA.properties.action.enum).toEqual([...DREAM_PICK_ACTIONS]);
  });
});

describe("runDreamCycle enablement", () => {
  test("disabled dreams never invoke model and refuse", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, false);
      const stub = makeStub({ action: "survey-org", reason: "should not run" });
      const result = await runDreamCycle(config, { headless: stub.caller });
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/disabled/i);
      expect(stub.getCalls()).toBe(0);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("--force still refuses when dreams disabled", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, false);
      const stub = makeStub({ action: "survey-org", reason: "no" });
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        force: true,
      });
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/disabled/i);
      expect(stub.getCalls()).toBe(0);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("runDreamCycle budget refusals", () => {
  test("cycle cooldown refuses without model call", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: config.cycleCooldownMs,
        tokenCeiling: 200_000,
      });
      sm.markCycleEndedOnly();
      sm.save();
      const stub = makeStub({ action: "skip", reason: "n/a" });
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        stateManager: sm,
      });
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/cooldown/i);
      expect(stub.getCalls()).toBe(0);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("daily budget exhausted refuses without model call", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      config.dailyActionCap = 2;
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 2,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      sm.recordDreamAction("survey-org");
      sm.recordDreamAction("substrate-health");
      sm.save();
      const stub = makeStub({ action: "skip", reason: "n/a" });
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        stateManager: sm,
        force: true,
      });
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/daily budget exhausted/i);
      expect(stub.getCalls()).toBe(0);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("token ceiling refuses without model call", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      config.dailyTokenCeiling = 100;
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 100,
      });
      sm.recordTokens({ total_tokens: 100 });
      sm.save();
      const stub = makeStub({ action: "skip", reason: "n/a" });
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        stateManager: sm,
        force: true,
      });
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/token ceiling/i);
      expect(stub.getCalls()).toBe(0);
      const notifs = readNotifications(config.runtimeDir);
      expect(notifs.some((n) => n.kind === "budget-token-ceiling")).toBe(true);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("per-action cooldown refuses after planner pick", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      // record survey-org as recently run (24h light cooldown)
      sm.recordDreamAction("survey-org", new Date());
      sm.save();
      const stub = makeStub({ action: "survey-org", reason: "again" });
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        stateManager: sm,
        force: true,
      });
      expect(stub.getCalls()).toBe(1);
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/cooldown/i);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("runDreamCycle happy paths", () => {
  test("skip writes no dream report and records tokens", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      const stub = makeStub(
        { action: "skip", reason: "calm house" },
        { usageTokens: 42 },
      );
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        stateManager: sm,
        force: true,
      });
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("calm house");
      expect(result.artifactPath).toBeUndefined();
      expect(stub.getCalls()).toBe(1);
      expect(sm.get().dream.tokensToday).toBe(42);
      const dreamsDir = join(house, "forge", "dreams");
      if (existsSync(dreamsDir)) {
        expect(readdirSync(dreamsDir).filter((f) => f.endsWith(".md")).length).toBe(0);
      }
      const history = sm.dreamCycleHistory();
      expect(history[0]!.status).toBe("skipped");
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("valid pick executes action, writes forge/dreams report + notify", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      const stub = makeStub({
        action: "survey-org",
        reason: "count the house",
      });
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        stateManager: sm,
        force: true,
      });
      expect(result.status).toBe("ran");
      expect(result.action).toBe("survey-org");
      expect(result.artifactPath).toBeDefined();
      expect(result.artifactPath!.replace(/\\/g, "/")).toContain("forge/dreams/");
      expect(existsSync(result.artifactPath!)).toBe(true);
      const body = readFileSync(result.artifactPath!, "utf-8");
      expect(body).toContain("triggered-by: dream");
      expect(body).toContain("dream-action: survey-org");
      expect(body).toContain("type: forge");
      expect(sm.get().dream.actionsToday).toBe(1);
      const notifs = readNotifications(config.runtimeDir);
      expect(notifs.some((n) => n.kind === "dream-action")).toBe(true);
      const log = readFileSync(join(config.runtimeDir, "log"), "utf-8");
      expect(log).toMatch(/dream-cycle ran/);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("malformed planner pick fails after one model call", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      const stub = makeStub({ not: "a pick" });
      const result = await runDreamCycle(config, {
        headless: stub.caller,
        stateManager: sm,
        force: true,
      });
      expect(result.status).toBe("failed");
      expect(result.reason).toMatch(/malformed/i);
      expect(stub.getCalls()).toBe(1);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("snapshot + prompt", () => {
  test("gatherHouseSnapshot includes survey counts", () => {
    const house = syntheticHouse();
    try {
      const runtimeDir = houseRuntimeDir(house);
      const sm = new StateManager(runtimeDir);
      const snap = gatherHouseSnapshot(house, sm);
      expect(snap.tasksActive).toBeGreaterThanOrEqual(1);
      expect(snap.inboxOpen).toBeGreaterThanOrEqual(1);
      expect(snap.budget.dailyCap).toBe(12);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("system prompt lists admitted keys", () => {
    const p = buildPlannerSystemPrompt();
    expect(p).toContain("survey-org");
    expect(p).toContain("skip");
    expect(p).toContain("Lucerna");
    expect(p).toContain("admitted");
  });
});
