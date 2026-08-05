import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  consumeSentinel,
  writeHealthFile,
  runLifecycleSmoke,
  DaemonLoop,
  appendLog,
} from "./daemon.ts";
import { sentinelPath, healthPath, houseRuntimeDir } from "./paths.ts";
import type { LucernaConfig } from "./config.ts";

function makeConfig(house: string): LucernaConfig {
  const runtimeDir = houseRuntimeDir(house);
  mkdirSync(runtimeDir, { recursive: true });
  return {
    houseRoot: house,
    runtimeDir,
    userConfigDir: join(house, ".user-config"),
    intervalMs: 8000,
    dryRun: true,
    dreamsEnabled: false,
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
  };
}

describe("sentinel consume", () => {
  test("consumeSentinel deletes halt/wake/sleep", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-sent-"));
    try {
      for (const kind of ["halt", "wake", "sleep"] as const) {
        const p = sentinelPath(dir, kind);
        writeFileSync(p, "x\n", "utf-8");
        expect(existsSync(p)).toBe(true);
        expect(consumeSentinel(dir, kind)).toBe(true);
        expect(existsSync(p)).toBe(false);
        expect(consumeSentinel(dir, kind)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("health + lifecycle", () => {
  test("writeHealthFile atomic", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-health-"));
    try {
      const path = writeHealthFile(dir, { pid: 1, version: "0.1.0", available: true });
      expect(existsSync(path)).toBe(true);
      const j = JSON.parse(readFileSync(path, "utf-8"));
      expect(j.pid).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runLifecycleSmoke writes health and consumes sentinels", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-life-"));
    try {
      const config = makeConfig(house);
      const r = await runLifecycleSmoke(config);
      expect(existsSync(r.healthPath)).toBe(true);
      expect(r.wakeConsumed).toBe(true);
      expect(r.haltDetected).toBe(true);
      expect(r.health.available).toBe(true);
      expect(r.health.driver).toBe("amore-headless");
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("DaemonLoop.cycleOnce updates state and health", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-cycle-"));
    try {
      const config = makeConfig(house);
      const loop = new DaemonLoop(config);
      await loop.cycleOnce();
      expect(existsSync(healthPath(config.runtimeDir))).toBe(true);
      expect(existsSync(join(config.runtimeDir, "state.json"))).toBe(true);
      appendLog(config.runtimeDir, "test line");
      expect(readFileSync(join(config.runtimeDir, "log"), "utf-8")).toContain("test line");
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});
