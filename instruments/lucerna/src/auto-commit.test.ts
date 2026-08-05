import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  dryRunAgainstFixture,
  parsePorcelainStatus,
  parseCommitMessageResponse,
  isDangerousPath,
  filterSafeFiles,
  AutoCommitter,
  type HeadlessCaller,
} from "./auto-commit.ts";
import type { LucernaConfig } from "./config.ts";
import { houseRuntimeDir } from "./paths.ts";

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
    const repo = mkdtempSync(join(tmpdir(), "lucerna-git-"));
    try {
      spawnSync("git", ["init"], { cwd: repo, encoding: "utf-8" });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
      writeFileSync(join(repo, "README.md"), "# t\n", "utf-8");
      spawnSync("git", ["add", "README.md"], { cwd: repo });
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo });

      writeFileSync(join(repo, "note.txt"), "dirty\n", "utf-8");
      mkdirSync(houseRuntimeDir(repo), { recursive: true });

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

      const config: LucernaConfig = {
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
      };

      const ac = new AutoCommitter(config, mock);
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
