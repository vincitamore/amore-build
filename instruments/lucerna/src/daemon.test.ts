import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  consumeSentinel,
  writeHealthFile,
  runLifecycleSmoke,
  DaemonLoop,
  appendLog,
} from "./daemon.ts";
import {
  sentinelPath,
  healthPath,
  houseRuntimeDir,
  RUNTIME_FILES,
  enablementPath,
} from "./paths.ts";
import type { LucernaConfig } from "./config.ts";
import { AUTO_COMMIT_WALL_MS } from "./auto-commit.ts";
import { DEFAULT_AGENTIC_WALL_MS } from "./agentic.ts";
import type { HeadlessCaller } from "./auto-commit.ts";

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
    autoCommitCooldownMs: 30 * 60 * 1000,
  };
}

function readHealth(runtimeDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(healthPath(runtimeDir), "utf-8")) as Record<
    string,
    unknown
  >;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function initDirtyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lucerna-daemon-git-"));
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

function draftHeadless(inspect?: () => Promise<void> | void): HeadlessCaller {
  return async () => {
    if (inspect) await inspect();
    return {
      text: JSON.stringify({ subject: "Draft note", body: "" }),
      structuredOutput: { subject: "Draft note", body: "" },
      raw: {},
      code: 0,
      stderr: "",
    };
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
      const health = readHealth(config.runtimeDir);
      expect(health.workInProgress).toBeUndefined();
      expect(health.stopped).toBeUndefined();
      expect(health.healthy).toBe(true);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("long-work health + graceful stop", () => {
  test("workInProgress is present during auto-commit and dropped after finally", async () => {
    const repo = initDirtyRepo();
    try {
      const config = makeConfig(repo);
      config.autoCommitEnabled = true;
      config.autoCommitCooldownMs = 0;
      const loop = new DaemonLoop(config);
      loop.setProgressBeatIntervalMs(40);
      let sawWip: Record<string, unknown> | undefined;
      loop.setAutoCommitHeadless(
        draftHeadless(() => {
          const h = readHealth(config.runtimeDir);
          sawWip = h.workInProgress as Record<string, unknown> | undefined;
          expect(loop.hasProgressBeat()).toBe(true);
          expect(loop.progressBeatWasUnrefed()).toBe(true);
        }),
      );
      await loop.cycleOnce();
      expect(sawWip).toBeDefined();
      expect(sawWip?.kind).toBe("auto-commit");
      expect(sawWip?.wallMs).toBe(AUTO_COMMIT_WALL_MS);
      expect(typeof sawWip?.startedAt).toBe("string");
      expect(Date.parse(String(sawWip?.startedAt))).not.toBeNaN();
      const after = readHealth(config.runtimeDir);
      expect(after.workInProgress).toBeUndefined();
      expect(after.healthy).toBe(true);
      expect(after.stopped).toBeUndefined();
      expect(loop.hasProgressBeat()).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("lastBeat advances during a stubbed long segment", async () => {
    const repo = initDirtyRepo();
    try {
      const config = makeConfig(repo);
      config.autoCommitEnabled = true;
      config.autoCommitCooldownMs = 0;
      const loop = new DaemonLoop(config);
      loop.setProgressBeatIntervalMs(40);
      let beatAtOpen = "";
      let beatMid = "";
      loop.setAutoCommitHeadless(
        draftHeadless(async () => {
          beatAtOpen = String(readHealth(config.runtimeDir).lastBeat);
          await sleep(1200);
          const mid = readHealth(config.runtimeDir);
          beatMid = String(mid.lastBeat);
          expect(mid.workInProgress).toBeDefined();
        }),
      );
      await loop.cycleOnce();
      expect(beatAtOpen).toBeTruthy();
      expect(beatMid).toBeTruthy();
      expect(beatMid).not.toBe(beatAtOpen);
      expect(loop.hasProgressBeat()).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("workInProgress is present during dream-cycle and dropped after finally", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-dream-wip-"));
    try {
      const config = makeConfig(house);
      mkdirSync(join(house, ".amore", "lucerna"), { recursive: true });
      writeFileSync(
        enablementPath(house),
        JSON.stringify({ dreamsEnabled: true, autoCommitLive: false }),
        "utf-8",
      );
      config.dreamsEnabled = true;
      const loop = new DaemonLoop(config);
      loop.getHeartbeat().forceDreaming();
      let sawWip: Record<string, unknown> | undefined;
      loop.setDreamCycleRunner(async () => {
        const h = readHealth(config.runtimeDir);
        sawWip = h.workInProgress as Record<string, unknown> | undefined;
        expect(loop.hasProgressBeat()).toBe(true);
        expect(loop.progressBeatWasUnrefed()).toBe(true);
        return { status: "skipped", reason: "stub" };
      });
      await loop.cycleOnce();
      expect(sawWip?.kind).toBe("dream-cycle");
      expect(sawWip?.wallMs).toBe(DEFAULT_AGENTIC_WALL_MS);
      expect(typeof sawWip?.startedAt).toBe("string");
      const after = readHealth(config.runtimeDir);
      expect(after.workInProgress).toBeUndefined();
      expect(loop.hasProgressBeat()).toBe(false);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("graceful halt leaves stopped tombstone and clears pidfile", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-halt-"));
    try {
      const config = makeConfig(house);
      const loop = new DaemonLoop(config);
      loop.setSentinelPollMs(20);
      writeFileSync(sentinelPath(config.runtimeDir, "halt"), "halt\n", "utf-8");
      await loop.start();
      const health = readHealth(config.runtimeDir);
      expect(health.stopped).toBe(true);
      expect(health.healthy).toBe(false);
      expect(health.pid).toBe(process.pid);
      expect(typeof health.lastBeat).toBe("string");
      expect(typeof health.phase).toBe("string");
      expect(health.workInProgress).toBeUndefined();
      expect(health.heartbeatIntervalSec).toBeUndefined();
      expect(existsSync(join(config.runtimeDir, RUNTIME_FILES.pid))).toBe(false);
      expect(loop.hasProgressBeat()).toBe(false);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("stop() leaves the same tombstone as halt", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-stop-"));
    try {
      const config = makeConfig(house);
      const loop = new DaemonLoop(config);
      const started = loop.start();
      loop.stop();
      await started;
      const health = readHealth(config.runtimeDir);
      expect(health.stopped).toBe(true);
      expect(health.healthy).toBe(false);
      expect(existsSync(join(config.runtimeDir, RUNTIME_FILES.pid))).toBe(false);
      expect(loop.hasProgressBeat()).toBe(false);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("fresh start after a tombstone writes health without stopped", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-restart-"));
    try {
      const config = makeConfig(house);
      const first = new DaemonLoop(config);
      const started = first.start();
      first.stop();
      await started;
      expect(readHealth(config.runtimeDir).stopped).toBe(true);

      const second = new DaemonLoop(config);
      await second.cycleOnce();
      const health = readHealth(config.runtimeDir);
      expect(health.stopped).toBeUndefined();
      expect(health.healthy).toBe(true);
      expect(health.available).toBe(true);
      expect(health.workInProgress).toBeUndefined();
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("progress-beat timer is cleared after a long segment so the loop can exit", async () => {
    const repo = initDirtyRepo();
    try {
      const config = makeConfig(repo);
      config.autoCommitEnabled = true;
      config.autoCommitCooldownMs = 0;
      const loop = new DaemonLoop(config);
      loop.setProgressBeatIntervalMs(40);
      loop.setSentinelPollMs(20);
      loop.setAutoCommitHeadless(
        draftHeadless(async () => {
          expect(loop.hasProgressBeat()).toBe(true);
          await sleep(80);
        }),
      );
      writeFileSync(sentinelPath(config.runtimeDir, "halt"), "halt\n", "utf-8");
      await loop.start();
      expect(loop.hasProgressBeat()).toBe(false);
      expect(loop.progressBeatWasUnrefed()).toBe(true);
      const health = readHealth(config.runtimeDir);
      expect(health.stopped).toBe(true);
      expect(health.healthy).toBe(false);
      expect(health.workInProgress).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("cycle-boundary enablement reload", () => {
  function writeDreamsOn(house: string): void {
    mkdirSync(join(house, ".amore", "lucerna"), { recursive: true });
    writeFileSync(
      enablementPath(house),
      JSON.stringify({ dreamsEnabled: true, autoCommitLive: false }),
      "utf-8",
    );
  }

  test("enablement file present allows a cycle; delete is honored on the next cycle", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-reload-"));
    try {
      const config = makeConfig(house);
      writeDreamsOn(house);
      config.dreamsEnabled = true;
      const loop = new DaemonLoop(config);
      loop.getHeartbeat().forceDreaming();
      let calls = 0;
      loop.setDreamCycleRunner(async () => {
        calls += 1;
        return { status: "skipped", reason: "stub" };
      });
      await loop.cycleOnce();
      expect(calls).toBe(1);
      unlinkSync(enablementPath(house));
      await loop.cycleOnce();
      expect(calls).toBe(1);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("LUCERNA_DREAMS_ENABLED=1 still wins after file delete", async () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-reload-env-"));
    const prev = process.env.LUCERNA_DREAMS_ENABLED;
    try {
      process.env.LUCERNA_DREAMS_ENABLED = "1";
      const config = makeConfig(house);
      writeDreamsOn(house);
      const loop = new DaemonLoop(config);
      if (prev === undefined) delete process.env.LUCERNA_DREAMS_ENABLED;
      else process.env.LUCERNA_DREAMS_ENABLED = prev;
      loop.getHeartbeat().forceDreaming();
      let calls = 0;
      loop.setDreamCycleRunner(async () => {
        calls += 1;
        return { status: "skipped", reason: "stub" };
      });
      await loop.cycleOnce();
      expect(calls).toBe(1);
      unlinkSync(enablementPath(house));
      await loop.cycleOnce();
      expect(calls).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.LUCERNA_DREAMS_ENABLED;
      else process.env.LUCERNA_DREAMS_ENABLED = prev;
      rmSync(house, { recursive: true, force: true });
    }
  });
});
