import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMITTED_ACTION_KEYS } from "./actions.ts";
import {
  DEFAULT_DAILY_TOKEN_CEILING,
  DEFAULT_DREAMS_RESERVE_TOKENS,
  LIGHT_ACTION_COOLDOWN_MS,
  effectiveCeiling,
} from "./budget.ts";
import {
  ROSTER_ENTRY_FIELDS,
  SHIPPED_BUDGET_DEFAULTS,
  buildCooldownOverridesMs,
  dreamPickSchema,
  plannerSpawnSnapshot,
  resolveBudgetConfig,
} from "./charter.ts";
import { loadConfig } from "./config.ts";

function houseWithCharter(): string {
  const house = mkdtempSync(join(tmpdir(), "lucerna-charter-"));
  mkdirSync(join(house, ".amore", "lucerna"), { recursive: true });
  return house;
}

const CAP_ENVS = [
  "LUCERNA_DAILY_ACTION_CAP",
  "LUCERNA_WEEKLY_EXPENSIVE_CAP",
  "LUCERNA_DAILY_TOKEN_CEILING",
  "LUCERNA_DREAMS_RESERVE_TOKENS",
  "LUCERNA_CYCLE_COOLDOWN_HOURS",
  "LUCERNA_AUTO_COMMIT_COOLDOWN_MINUTES",
] as const;

function withEnv(
  patch: Partial<Record<(typeof CAP_ENVS)[number], string>>,
  fn: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of CAP_ENVS) prev[k] = process.env[k];
  for (const k of CAP_ENVS) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of CAP_ENVS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("ROSTER_ENTRY_FIELDS", () => {
  test("exact equality", () => {
    expect([...ROSTER_ENTRY_FIELDS]).toEqual(["enabled", "minIntervalHours"]);
  });
});

describe("resolveBudgetConfig precedence", () => {
  test("matrix: argv > env > file > shipped, value and source", () => {
    const house = houseWithCharter();
    try {
      writeFileSync(
        join(house, ".amore", "lucerna", "budgets.json"),
        JSON.stringify({
          schemaVersion: 1,
          dailyActionCap: 8,
          dailyTokenCeiling: 250000,
        }),
        "utf-8",
      );
      withEnv(
        { LUCERNA_DAILY_ACTION_CAP: "10", LUCERNA_WEEKLY_EXPENSIVE_CAP: "4" },
        () => {
          const r = resolveBudgetConfig({
            houseRoot: house,
            env: process.env,
            args: ["--daily-action-cap", "11"],
          });
          expect(r.budgets.dailyActionCap).toEqual({
            value: 11,
            source: "argv",
            aboveShipped: false,
          });
          expect(r.budgets.weeklyExpensiveCap).toEqual({
            value: 4,
            source: "env",
            aboveShipped: false,
          });
          expect(r.budgets.dailyTokenCeiling).toEqual({
            value: 250000,
            source: "file",
            aboveShipped: true,
          });
          expect(r.budgets.dreamsReserveTokens).toEqual({
            value: SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens,
            source: "shipped",
            aboveShipped: false,
          });
        },
      );
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("file raise above shipped accepted; aboveShipped true", () => {
    const house = houseWithCharter();
    try {
      writeFileSync(
        join(house, ".amore", "lucerna", "budgets.json"),
        JSON.stringify({
          schemaVersion: 1,
          dailyActionCap: 20,
          dailyTokenCeiling: 400000,
        }),
        "utf-8",
      );
      withEnv({}, () => {
        const r = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
        expect(r.budgets.dailyActionCap.value).toBe(20);
        expect(r.budgets.dailyActionCap.source).toBe("file");
        expect(r.budgets.dailyActionCap.aboveShipped).toBe(true);
        expect(r.budgets.dailyTokenCeiling.value).toBe(400000);
        expect(r.budgets.dailyTokenCeiling.aboveShipped).toBe(true);
        const cfg = loadConfig(["--house", house]);
        expect(cfg.dailyActionCap).toBe(20);
        expect(cfg.dailyTokenCeiling).toBe(400000);
        expect(cfg.charter?.budgets.dailyActionCap.aboveShipped).toBe(true);
      });
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("reserve >= ceiling is invalid; field falls back to shipped 80000", () => {
    const house = houseWithCharter();
    try {
      writeFileSync(
        join(house, ".amore", "lucerna", "budgets.json"),
        JSON.stringify({
          schemaVersion: 1,
          dailyTokenCeiling: 200000,
          dreamsReserveTokens: 200000,
        }),
        "utf-8",
      );
      const r = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
      expect(r.budgets.dreamsReserveTokens.value).toBe(DEFAULT_DREAMS_RESERVE_TOKENS);
      expect(r.budgets.dreamsReserveTokens.source).toBe("shipped");
      expect(r.budgets.warnings.some((w) => /dreamsReserveTokens/.test(w))).toBe(true);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("malformed budgets → shipped + notifyMalformed; unknown schemaVersion ignored", () => {
    const house = houseWithCharter();
    try {
      writeFileSync(join(house, ".amore", "lucerna", "budgets.json"), "{nope", "utf-8");
      const bad = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
      expect(bad.budgets.dailyActionCap.value).toBe(12);
      expect(bad.budgets.notifyMalformed).toBe(true);

      writeFileSync(
        join(house, ".amore", "lucerna", "budgets.json"),
        JSON.stringify({ schemaVersion: 99, dailyActionCap: 3 }),
        "utf-8",
      );
      const newer = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
      expect(newer.budgets.dailyActionCap.value).toBe(12);
      expect(newer.budgets.file.ignored).toBe(true);
      expect(newer.budgets.notifyMalformed).toBe(false);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("roster", () => {
  test("cannot add a key; hostile extra fields leave spawn snapshot byte-identical", () => {
    const house = houseWithCharter();
    try {
      const clean = {
        schemaVersion: 1,
        chores: {
          "survey-org": { enabled: true },
        },
      };
      const hostile = {
        schemaVersion: 1,
        extraTop: true,
        chores: {
          "survey-org": {
            enabled: true,
            model: "evil",
            maxTurns: 99,
            tools: ["web_search"],
            template: "x",
            params: { a: 1 },
          },
          "not-a-real-key": { enabled: true, wallMs: 1 },
          "user:custom": { enabled: true },
        },
      };
      writeFileSync(
        join(house, ".amore", "lucerna", "chores.json"),
        JSON.stringify(clean),
        "utf-8",
      );
      const a = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
      writeFileSync(
        join(house, ".amore", "lucerna", "chores.json"),
        JSON.stringify(hostile),
        "utf-8",
      );
      const b = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
      expect(a.roster.effectiveKeys).toEqual(b.roster.effectiveKeys);
      expect(a.roster.effectiveKeys).toEqual([...ADMITTED_ACTION_KEYS]);
      expect(b.roster.effectiveKeys).not.toContain("not-a-real-key");
      expect(b.roster.unknownKeys).toContain("not-a-real-key");
      expect(plannerSpawnSnapshot(a.roster.effectiveKeys)).toBe(
        plannerSpawnSnapshot(b.roster.effectiveKeys),
      );
      expect(dreamPickSchema(b.roster.effectiveKeys).properties.action.enum).not.toContain(
        "not-a-real-key",
      );
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("unlisted / absent enabled → enabled; disabled is intersection", () => {
    const house = houseWithCharter();
    try {
      writeFileSync(
        join(house, ".amore", "lucerna", "chores.json"),
        JSON.stringify({
          schemaVersion: 1,
          chores: {
            "self-orient": { enabled: false },
          },
        }),
        "utf-8",
      );
      const r = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
      expect(r.roster.effectiveKeys).not.toContain("self-orient");
      expect(r.roster.effectiveKeys).toContain("survey-org");
      expect(r.roster.disabled).toContain("self-orient");
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("malformed chores refuses the cycle", () => {
    const house = houseWithCharter();
    try {
      writeFileSync(join(house, ".amore", "lucerna", "chores.json"), "{nope", "utf-8");
      const r = resolveBudgetConfig({ houseRoot: house, env: {}, args: [] });
      expect(r.roster.refuse).toBe(true);
      expect(r.roster.refuseReason).toMatch(/roster invalid/i);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("lengthen-only: roster 1h on a 24h light action yields 24h", () => {
    const warnings: string[] = [];
    const map = buildCooldownOverridesMs({ "survey-org": 1 }, warnings);
    expect(map["survey-org"]).toBe(LIGHT_ACTION_COOLDOWN_MS);
    expect(map["survey-org"]).toBe(24 * 60 * 60 * 1000);
  });
});

describe("effective ceilings", () => {
  test("drafts refuse at ceiling − reserve; dreams still allowed", () => {
    const ceiling = DEFAULT_DAILY_TOKEN_CEILING;
    const reserve = DEFAULT_DREAMS_RESERVE_TOKENS;
    expect(effectiveCeiling("dreams", ceiling, reserve)).toBe(200000);
    expect(effectiveCeiling("autoCommit", ceiling, reserve)).toBe(120000);
    const tokensToday = 120000;
    expect(tokensToday >= effectiveCeiling("autoCommit", ceiling, reserve)).toBe(true);
    expect(tokensToday >= effectiveCeiling("dreams", ceiling, reserve)).toBe(false);
  });
});
