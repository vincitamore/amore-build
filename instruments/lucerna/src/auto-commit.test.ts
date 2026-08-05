import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  dryRunAgainstFixture,
  parsePorcelainStatus,
  parseCommitMessageResponse,
  isDangerousPath,
  filterSafeFiles,
  hashChangeSet,
  AutoCommitter,
  type HeadlessCaller,
} from "./auto-commit.ts";
import type { LucernaConfig } from "./config.ts";
import { DEFAULT_AUTO_COMMIT_COOLDOWN_MS } from "./config.ts";
import { houseRuntimeDir, logPath } from "./paths.ts";
import { StateManager } from "./state.ts";
import { DaemonLoop } from "./daemon.ts";

function baseConfig(repo: string, overrides: Partial<LucernaConfig> = {}): LucernaConfig {
  return {
    houseRoot: repo,
    runtimeDir: houseRuntimeDir(repo),
    userConfigDir: join(repo, ".uc"),
    intervalMs: 8000,
    dryRun: true,
    dreamsEnabled: false,
    autoCommitEnabled: true,
    autoCommitDryRun: true,
    amoreBin: "amore",
    processName: "lucerna",
    version: "0.1.0",
    autoCommitModel: "",
    dreamModel: "",
    dailyActionCap: 12,
    weeklyExpensiveCap: 6,
    cycleCooldownMs: 7200000,
    dailyTokenCeiling: 200000,
    autoCommitCooldownMs: DEFAULT_AUTO_COMMIT_COOLDOWN_MS,
    ...overrides,
  };
}

function initDirtyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lucerna-git-"));
  spawnSync("git", ["init"], { cwd: repo, encoding: "utf-8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# t\n", "utf-8");
  spawnSync("git", ["add", "README.md"], { cwd: repo });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
  writeFileSync(join(repo, "note.txt"), "dirty\n", "utf-8");
  mkdirSync(houseRuntimeDir(repo), { recursive: true });
  return repo;
}

describe("parse helpers", () => {
  test("parsePorcelainStatus", () => {
    const files = parsePorcelainStatus(
      [" M src/a.ts", "?? new.md", "R  old.ts -> new.ts", ""].join("\n"),
    );
    expect(files).toContain("src/a.ts");
    expect(files).toContain("new.md");
    expect(files).toContain("new.ts");
  });

  test("dangerous paths filtered", () => {
    expect(isDangerousPath(".env")).toBe(true);
    expect(isDangerousPath("secrets/foo")).toBe(true);
    expect(isDangerousPath("src/ok.ts")).toBe(false);
    expect(filterSafeFiles([".env", "src/ok.ts"])).toEqual(["src/ok.ts"]);
  });

  test("parseCommitMessageResponse", () => {
    const m = parseCommitMessageResponse(
      JSON.stringify({ subject: "Add parser", body: "- tests" }),
    );
    expect(m?.subject).toBe("Add parser");
    expect(m?.body).toContain("tests");
  });
});

describe("dryRunAgainstFixture", () => {
  test("never commits; uses one headless call", async () => {
    let called = 0;
    const mock: HeadlessCaller = async () => {
      called++;
      return {
        text: JSON.stringify({ subject: "Draft subject", body: "body line" }),
        structuredOutput: { subject: "Draft subject", body: "body line" },
        raw: { structuredOutput: { subject: "Draft subject", body: "body line" } },
        code: 0,
        stderr: "",
        usage: { total_tokens: 42, input_tokens: 30, output_tokens: 12 },
      };
    };
    const files = ["src/a.ts", "src/b.ts", "README.md"];
    const result = await dryRunAgainstFixture(files, mock, process.cwd());
    expect(result.dryRun).toBe(true);
    expect(result.committed).toBe(false);
    expect(called).toBe(1);
    expect(result.message?.subject).toBe("Draft subject");
    expect(result.files.length).toBe(3);
  });

  test("headless failure still dry-run no commit", async () => {
    const mock: HeadlessCaller = async () => {
      throw new Error("spawn failed");
    };
    const result = await dryRunAgainstFixture(["a.ts", "b.ts"], mock, process.cwd());
    expect(result.dryRun).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.message).not.toBeNull();
  });
});

describe("AutoCommitter dry-run against temp git repo", () => {
  test("asserts NO commit is created", async () => {
    const repo = initDirtyRepo();
    try {
      const before = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      });
      const headBefore = before.stdout.trim();

      const mock: HeadlessCaller = async () => ({
        text: JSON.stringify({ subject: "Add note", body: "" }),
        structuredOutput: { subject: "Add note", body: "" },
        raw: {},
        code: 0,
        stderr: "",
      });

      const ac = new AutoCommitter(baseConfig(repo), mock);
      const result = await ac.run({ force: true });
      expect(result.committed).toBe(false);
      expect(result.dryRun).toBe(true);

      const after = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      });
      expect(after.stdout.trim()).toBe(headBefore);

      const log = spawnSync("git", ["log", "--oneline"], {
        cwd: repo,
        encoding: "utf-8",
      });
      expect(log.stdout.trim().split("\n").length).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("auto-commit cadence and dedup", () => {
  test("hashChangeSet is stable for identical porcelain", () => {
    const a = " M src/a.ts\n?? note.txt\n";
    const b = " M src/a.ts\n?? note.txt\n";
    expect(hashChangeSet(a)).toBe(hashChangeSet(b));
    expect(hashChangeSet(a)).not.toBe(hashChangeSet(" M src/a.ts\n"));
    expect(hashChangeSet("")).toBe("");
  });

  test("tick-storm: many resting cycles invoke driver exactly once inside cooldown", async () => {
    const repo = initDirtyRepo();
    try {
      let calls = 0;
      const mock: HeadlessCaller = async () => {
        calls++;
        return {
          text: JSON.stringify({ subject: "Draft once", body: "" }),
          structuredOutput: { subject: "Draft once", body: "" },
          raw: {},
          code: 0,
          stderr: "",
          usage: { total_tokens: 20, input_tokens: 15, output_tokens: 5 },
        };
      };

      const config = baseConfig(repo, {
        autoCommitEnabled: true,
        autoCommitCooldownMs: 30 * 60 * 1000, // 30m
      });
      const loop = new DaemonLoop(config);
      loop.setAutoCommitHeadless(mock);
      // Heartbeat starts resting - same phase as production draft window.
      for (let i = 0; i < 25; i++) {
        await loop.cycleOnce();
      }
      expect(calls).toBe(1);

      // Log is quiet on skips: only one draft line after many ticks.
      const logFile = logPath(config.runtimeDir);
      if (existsSync(logFile)) {
        const lines = readFileSync(logFile, "utf-8")
          .split("\n")
          .filter((l) => l.includes("auto-commit"));
        expect(lines.length).toBe(1);
        expect(lines[0]).toMatch(/dry-run draft: Draft once/);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("unchanged change-set: second draft skips without driver call", async () => {
    const repo = initDirtyRepo();
    try {
      let calls = 0;
      const mock: HeadlessCaller = async () => {
        calls++;
        return {
          text: JSON.stringify({ subject: "First draft", body: "" }),
          structuredOutput: { subject: "First draft", body: "" },
          raw: {},
          code: 0,
          stderr: "",
          usage: { total_tokens: 10 },
        };
      };
      // Zero effective cooldown so only hash dedup blocks the second call.
      const config = baseConfig(repo, { autoCommitCooldownMs: 0 });
      const sm = new StateManager(config.runtimeDir, {
        tokenCeiling: config.dailyTokenCeiling,
      });
      const ac = new AutoCommitter(config, mock, sm);

      const t0 = new Date("2026-01-01T00:00:00");
      const r1 = await ac.run({ now: t0 });
      expect(r1.composed).toBe(true);
      expect(r1.driverInvoked).toBe(true);
      expect(calls).toBe(1);

      // Far past any cooldown; same porcelain → still no second call.
      const t1 = new Date("2026-01-01T12:00:00");
      const r2 = await ac.run({ now: t1 });
      expect(r2.skippedReason).toMatch(/unchanged/i);
      expect(r2.driverInvoked).toBe(false);
      expect(calls).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("token ceiling crossed: zero driver invocations", async () => {
    const repo = initDirtyRepo();
    try {
      let calls = 0;
      const mock: HeadlessCaller = async () => {
        calls++;
        return {
          text: JSON.stringify({ subject: "Should not run", body: "" }),
          structuredOutput: { subject: "Should not run", body: "" },
          raw: {},
          code: 0,
          stderr: "",
        };
      };
      const config = baseConfig(repo, {
        dailyTokenCeiling: 50,
        autoCommitCooldownMs: 0,
      });
      const sm = new StateManager(config.runtimeDir, {
        tokenCeiling: 50,
      });
      sm.recordTokens({ total_tokens: 50 });
      sm.save();

      const ac = new AutoCommitter(config, mock, sm);
      const r = await ac.run({ force: true });
      expect(r.skippedReason).toMatch(/token ceiling/i);
      expect(r.driverInvoked).toBe(false);
      expect(calls).toBe(0);

      // Daemon path also stays quiet and never calls.
      const loop = new DaemonLoop(config);
      loop.setAutoCommitHeadless(mock);
      // Seed ceiling into the loop's own state manager
      loop.getState().recordTokens({ total_tokens: 50 });
      loop.getState().save();
      for (let i = 0; i < 5; i++) await loop.cycleOnce();
      expect(calls).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("composeDraft records tokens toward the daily ceiling", async () => {
    const repo = initDirtyRepo();
    try {
      const mock: HeadlessCaller = async () => ({
        text: JSON.stringify({ subject: "Tok", body: "" }),
        structuredOutput: { subject: "Tok", body: "" },
        raw: {},
        code: 0,
        stderr: "",
        usage: { total_tokens: 77, input_tokens: 50, output_tokens: 27 },
      });
      const config = baseConfig(repo, { autoCommitCooldownMs: 0 });
      const sm = new StateManager(config.runtimeDir, {
        tokenCeiling: 200_000,
      });
      const ac = new AutoCommitter(config, mock, sm);
      await ac.run({ now: new Date("2026-06-01T10:00:00") });
      expect(sm.get().dream.tokensToday).toBe(77);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
