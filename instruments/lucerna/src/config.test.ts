import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERSION,
  PROCESS_NAME,
  packageVersion,
  formatVersionLine,
  loadConfig,
} from "./config.ts";
import {
  DAILY_ACTION_BUDGET,
  DEFAULT_DAILY_TOKEN_CEILING,
} from "./budget.ts";

const CAP_ENVS = [
  "LUCERNA_DAILY_ACTION_CAP",
  "LUCERNA_WEEKLY_EXPENSIVE_CAP",
  "LUCERNA_DAILY_TOKEN_CEILING",
] as const;

function withIsolatedCaps(
  patch: Partial<Record<(typeof CAP_ENVS)[number], string>>,
  fn: (house: string) => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of CAP_ENVS) prev[k] = process.env[k];
  for (const k of CAP_ENVS) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  const house = mkdtempSync(join(tmpdir(), "lucerna-cfg-"));
  try {
    fn(house);
  } finally {
    for (const k of CAP_ENVS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(house, { recursive: true, force: true });
  }
}

describe("package version (embedded package.json)", () => {
  test("VERSION matches package.json and is not empty", () => {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version.length).toBeGreaterThan(0);
    expect(VERSION).toBe(pkg.version);
    expect(packageVersion()).toBe(pkg.version);
  });

  test("formatVersionLine is 'lucerna <semver>'", () => {
    const line = formatVersionLine();
    expect(line).toBe(`${PROCESS_NAME} ${packageVersion()}`);
    expect(line).toMatch(/^lucerna \d+\.\d+\.\d+/);
  });

  test("CLI --version prints formatVersionLine and exits 0", async () => {
    const cli = join(import.meta.dir, "cli.ts");
    const proc = Bun.spawn(["bun", "run", cli, "--version"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(formatVersionLine());
  });

  test("CLI version (bare) also works", async () => {
    const cli = join(import.meta.dir, "cli.ts");
    const proc = Bun.spawn(["bun", "run", cli, "version"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(formatVersionLine());
  });
});

describe("env budget cap parse (strict uint)", () => {
  test("LUCERNA_DAILY_TOKEN_CEILING=1e9 uses shipped default, not 1", () => {
    withIsolatedCaps({ LUCERNA_DAILY_TOKEN_CEILING: "1e9" }, (house) => {
      const cfg = loadConfig(["--house", house]);
      expect(cfg.dailyTokenCeiling).toBe(DEFAULT_DAILY_TOKEN_CEILING);
      expect(cfg.dailyTokenCeiling).not.toBe(1);
    });
  });

  test("LUCERNA_DAILY_TOKEN_CEILING=200_000 uses shipped default, not 200", () => {
    withIsolatedCaps({ LUCERNA_DAILY_TOKEN_CEILING: "200_000" }, (house) => {
      const cfg = loadConfig(["--house", house]);
      expect(cfg.dailyTokenCeiling).toBe(DEFAULT_DAILY_TOKEN_CEILING);
      expect(cfg.dailyTokenCeiling).not.toBe(200);
    });
  });

  test("LUCERNA_DAILY_ACTION_CAP=50/day uses shipped default, not 50", () => {
    withIsolatedCaps({ LUCERNA_DAILY_ACTION_CAP: "50/day" }, (house) => {
      const cfg = loadConfig(["--house", house]);
      expect(cfg.dailyActionCap).toBe(DAILY_ACTION_BUDGET);
      expect(cfg.dailyActionCap).not.toBe(50);
    });
  });

  test("LUCERNA_DAILY_ACTION_CAP=-5 uses shipped default, not -5", () => {
    withIsolatedCaps({ LUCERNA_DAILY_ACTION_CAP: "-5" }, (house) => {
      const cfg = loadConfig(["--house", house]);
      expect(cfg.dailyActionCap).toBe(DAILY_ACTION_BUDGET);
      expect(cfg.dailyActionCap).not.toBe(-5);
    });
  });

  test("LUCERNA_DAILY_TOKEN_CEILING=400000 raises", () => {
    withIsolatedCaps({ LUCERNA_DAILY_TOKEN_CEILING: "400000" }, (house) => {
      const cfg = loadConfig(["--house", house]);
      expect(cfg.dailyTokenCeiling).toBe(400000);
    });
  });

  test("budgets.json raise above shipped is accepted with source file", () => {
    withIsolatedCaps({}, (house) => {
      mkdirSync(join(house, ".amore", "lucerna"), { recursive: true });
      writeFileSync(
        join(house, ".amore", "lucerna", "budgets.json"),
        JSON.stringify({
          schemaVersion: 1,
          dailyActionCap: 20,
          dailyTokenCeiling: 400000,
        }),
        "utf-8",
      );
      const cfg = loadConfig(["--house", house]);
      expect(cfg.dailyActionCap).toBe(20);
      expect(cfg.dailyTokenCeiling).toBe(400000);
      expect(cfg.charter?.budgets.dailyActionCap.source).toBe("file");
      expect(cfg.charter?.budgets.dailyActionCap.aboveShipped).toBe(true);
      expect(cfg.charter?.budgets.dailyTokenCeiling.source).toBe("file");
    });
  });
});
