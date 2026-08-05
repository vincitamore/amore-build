/**
 * Lucerna daemon loop: heartbeat, sentinels, health/state/log, optional light cycle work.
 *
 * Control surface is file-based (no network listener):
 *   health.json, state.json, log, halt, wake, sleep under <house>/instruments/lucerna/
 */

import {
  existsSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  readFileSync,
  appendFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { LucernaConfig } from "./config.ts";
import { Heartbeat } from "./heartbeat.ts";
import { StateManager } from "./state.ts";
import { localTimestamp } from "./time.ts";
import { RUNTIME_FILES, healthPath, logPath, sentinelPath } from "./paths.ts";
import { executeLightAction, isAdmittedAction, actionBudgetTier, actionCooldownClass } from "./actions.ts";
import { isFullAgenticKey } from "./agentic.ts";
import { mergeGovernanceLists, loadUserGovernance } from "./governance.ts";
import { AutoCommitter, type HeadlessCaller } from "./auto-commit.ts";
import { runDreamCycle, type DreamCycleResult } from "./somniator.ts";

const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function appendLog(runtimeDir: string, line: string): void {
  mkdirSync(runtimeDir, { recursive: true });
  appendFileSync(logPath(runtimeDir), `${localTimestamp()} ${line}\n`, "utf-8");
}

export function consumeSentinel(
  runtimeDir: string,
  kind: "halt" | "wake" | "sleep",
): boolean {
  const p = sentinelPath(runtimeDir, kind);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
  } catch {
    return false;
  }
  return true;
}

export function writeHealthFile(
  runtimeDir: string,
  health: Record<string, unknown>,
): string {
  mkdirSync(runtimeDir, { recursive: true });
  const path = healthPath(runtimeDir);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(health, null, 2), "utf-8");
  renameSync(tmp, path);
  return path;
}

export function writePidFile(runtimeDir: string, pid: number): void {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, RUNTIME_FILES.pid), String(pid), "utf-8");
}

export function clearPidFile(runtimeDir: string): void {
  const p = join(runtimeDir, RUNTIME_FILES.pid);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export function readPidFile(runtimeDir: string): number | null {
  const p = join(runtimeDir, RUNTIME_FILES.pid);
  if (!existsSync(p)) return null;
  try {
    const n = parseInt(readFileSync(p, "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class DaemonLoop {
  private heartbeat = new Heartbeat();
  private stateManager: StateManager;
  private running = false;
  private readonly startedAt = Date.now();
  private cycleCount = 0;
  private lists = mergeGovernanceLists();
  /** Set by wake sentinel: request one immediate dream cycle when dreams enabled. */
  private wakeDreamRequested = false;
  /** Optional inject for tests (stub amore-headless for auto-commit). */
  private autoCommitHeadless?: HeadlessCaller;

  constructor(private config: LucernaConfig) {
    this.stateManager = new StateManager(config.runtimeDir, {
      dailyCap: config.dailyActionCap,
      weeklyCap: config.weeklyExpensiveCap,
      cooldownMs: config.cycleCooldownMs,
      tokenCeiling: config.dailyTokenCeiling,
    });
    this.lists = mergeGovernanceLists(loadUserGovernance(config.houseRoot));
  }

  getHeartbeat(): Heartbeat {
    return this.heartbeat;
  }

  getState(): StateManager {
    return this.stateManager;
  }

  /** Test / inject hook: replace the auto-commit headless driver. */
  setAutoCommitHeadless(headless: HeadlessCaller | undefined): void {
    this.autoCommitHeadless = headless;
  }

  async start(): Promise<void> {
    this.running = true;
    writePidFile(this.config.runtimeDir, process.pid);
    appendLog(this.config.runtimeDir, `daemon start house=${this.config.houseRoot}`);
    console.log(`=== ${this.config.processName} v${this.config.version} ===`);
    console.log(`House: ${this.config.houseRoot}`);
    console.log(
      `Dreams: ${this.config.dreamsEnabled ? "ENABLED" : "OFF (default)"}`,
    );
    console.log(
      `Auto-commit: ${this.config.autoCommitEnabled ? (this.config.autoCommitDryRun ? "dry-run" : "LIVE (inert draft)") : "disabled"}`,
    );
    console.log(`Driver: amore-headless`);
    console.log("");

    await this.cycle();

    while (this.running) {
      const SENTINEL_POLL_MS = 3000;
      const targetInterval = this.heartbeat.intervalMs;
      let slept = 0;
      while (slept < targetInterval && this.running) {
        const chunk = Math.min(SENTINEL_POLL_MS, targetInterval - slept);
        await this.sleep(chunk);
        slept += chunk;
        if (this.checkHalt()) {
          console.log("halt sentinel consumed  -  graceful shutdown");
          appendLog(this.config.runtimeDir, "halt consumed  -  stopping");
          this.stateManager.save();
          this.running = false;
          break;
        }
        this.checkWake();
        this.checkSleep();
        if (this.heartbeat.intervalMs !== targetInterval) break;
      }
      if (this.running) await this.cycle();
    }
    clearPidFile(this.config.runtimeDir);
    appendLog(this.config.runtimeDir, "daemon stopped");
    console.log("lucerna stopped.");
  }

  stop(): void {
    this.running = false;
  }

  async cycleOnce(): Promise<void> {
    await this.cycle();
  }

  private async cycle(): Promise<void> {
    this.cycleCount++;
    this.rotateLogIfNeeded();
    this.writeHealth();
    this.stateManager.setHeartbeat(
      this.heartbeat.current,
      this.heartbeat.intervalMs,
      this.heartbeat.bpm,
    );
    this.stateManager.save();

    const phase = this.heartbeat.current;
    if (
      this.config.autoCommitEnabled &&
      (phase === "resting" || phase === "drowsy" || phase === "dreaming")
    ) {
      try {
        const ac = new AutoCommitter(
          this.config,
          this.autoCommitHeadless,
          this.stateManager,
        );
        const result = await ac.run();
        // Quiet skips: log only when a draft was composed (driver path taken).
        if (result.composed && result.message) {
          appendLog(
            this.config.runtimeDir,
            result.dryRun
              ? `auto-commit dry-run draft: ${result.message.subject}`
              : `auto-commit draft: ${result.message.subject}`,
          );
        }
      } catch (err) {
        appendLog(this.config.runtimeDir, `auto-commit error: ${err}`);
        console.error(`  [CYCLE] auto-commit error: ${err}`);
      } finally {
        this.writeHealth();
      }
    }

    // Light dream planner: dreaming phase when due, or wake-triggered immediate cycle.
    if (this.config.dreamsEnabled) {
      const due =
        this.wakeDreamRequested ||
        (this.heartbeat.isDreaming && this.stateManager.canStartCycle().allowed);
      if (due) {
        this.wakeDreamRequested = false;
        try {
          const result = await runDreamCycle(this.config, {
            stateManager: this.stateManager,
            force: false,
          });
          if (result.status === "ran" || result.status === "skipped") {
            console.log(
              `  [DREAM] ${result.status}${result.action ? ` ${result.action}` : ""}: ${result.reason}`,
            );
          } else if (result.status === "refused") {
            console.log(`  [DREAM] refused: ${result.reason}`);
          } else {
            console.log(`  [DREAM] ${result.status}: ${result.reason}`);
          }
        } catch (err) {
          appendLog(this.config.runtimeDir, `dream-cycle error: ${err}`);
          console.error(`  [CYCLE] dream-cycle error: ${err}`);
        } finally {
          this.writeHealth();
        }
      }
    }

    if (this.cycleCount % 30 === 1) {
      console.log(
        `  [CYCLE ${this.cycleCount}] heartbeat=${this.heartbeat} uptime=${Math.round((Date.now() - this.startedAt) / 1000)}s`,
      );
    }
  }

  /**
   * Run one planner-driven dream cycle (CLI dream-cycle path).
   * --force overrides schedule only; enablement is always honored.
   */
  async runDreamCycleNow(opts?: {
    force?: boolean;
    forceAction?: string;
  }): Promise<DreamCycleResult> {
    return runDreamCycle(this.config, {
      stateManager: this.stateManager,
      force: opts?.force === true,
      forceAction: opts?.forceAction,
    });
  }

  /**
   * Run one admitted action (CLI dream <action> path).
   * Full agentic keys go through a dream-cycle force-action path when dreams
   * are enabled; otherwise light/shell runners only (agentic refused without
   * enablement for unsupervised multi-turn cost).
   */
  async runAction(
    key: string,
    opts?: { ignoreBudget?: boolean; ignoreCooldown?: boolean },
  ): Promise<{ ok: boolean; detail: string; artifactPath?: string }> {
    if (!isAdmittedAction(key)) {
      return { ok: false, detail: `action not admitted: ${key}` };
    }
    const tier = actionBudgetTier(key);
    const cd = actionCooldownClass(key);
    if (!opts?.ignoreBudget) {
      const gate = this.stateManager.canRunAction(key, tier, cd);
      if (!gate.allowed && !opts?.ignoreCooldown) {
        return { ok: false, detail: gate.reason };
      }
    }

    // Full agentic: require dreams enablement; use cycle force-action path
    if (isFullAgenticKey(key)) {
      if (!this.config.dreamsEnabled) {
        return {
          ok: false,
          detail: "agentic actions require dreamsEnabled (use dream-cycle --action with dreams on)",
        };
      }
      const cycle = await runDreamCycle(this.config, {
        stateManager: this.stateManager,
        force: true,
        forceAction: key,
      });
      return {
        ok: cycle.status === "ran",
        detail: cycle.reason,
        artifactPath: cycle.artifactPath ?? cycle.manifestPath,
      };
    }

    const result = executeLightAction(key, this.config.houseRoot, this.lists);
    if (!result) {
      return { ok: false, detail: `no runner for ${key}` };
    }
    this.stateManager.recordDreamAction(key, new Date(), tier);
    this.stateManager.pushActionResult(key, result.ok, result.detail);
    this.stateManager.setActivity(key, result.detail);
    this.stateManager.save();
    appendLog(
      this.config.runtimeDir,
      `action ${key}: ${result.ok ? "ok" : "fail"} ${result.detail}`,
    );
    return result;
  }

  private writeHealth(): void {
    writeHealthFile(this.config.runtimeDir, {
      available: true,
      healthy: true,
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      lastBeat: localTimestamp(),
      version: this.config.version,
      phase: this.heartbeat.current,
      intervalMs: this.heartbeat.intervalMs,
      bpm: this.heartbeat.bpm,
      dreaming: this.heartbeat.isDreaming,
      processName: this.config.processName,
      driver: "amore-headless",
      houseRoot: this.config.houseRoot,
    });
  }

  private checkHalt(): boolean {
    return consumeSentinel(this.config.runtimeDir, "halt");
  }

  private checkWake(): void {
    if (!consumeSentinel(this.config.runtimeDir, "wake")) return;
    console.log("  [SENTINEL] wake - stimulate heartbeat");
    this.heartbeat.stimulate();
    if (this.config.dreamsEnabled) {
      this.wakeDreamRequested = true;
    }
    this.stateManager.setActivity("wake", "wake sentinel consumed");
    this.stateManager.save();
    appendLog(this.config.runtimeDir, "wake consumed");
  }

  private checkSleep(): void {
    if (!consumeSentinel(this.config.runtimeDir, "sleep")) return;
    console.log("  [SENTINEL] sleep - force dreaming");
    this.heartbeat.forceDreaming();
    appendLog(this.config.runtimeDir, "sleep consumed");
  }

  private rotateLogIfNeeded(): void {
    const p = logPath(this.config.runtimeDir);
    try {
      if (existsSync(p) && statSync(p).size > LOG_MAX_BYTES) {
        renameSync(p, p + ".1");
      }
    } catch {
      /* ignore */
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/** Lifecycle smoke: health write + sentinel consume without a long-running loop. */
export async function runLifecycleSmoke(config: LucernaConfig): Promise<{
  healthPath: string;
  wakeConsumed: boolean;
  haltDetected: boolean;
  health: Record<string, unknown>;
}> {
  mkdirSync(config.runtimeDir, { recursive: true });
  const loop = new DaemonLoop(config);
  await loop.cycleOnce();
  const hPath = healthPath(config.runtimeDir);

  writeFileSync(sentinelPath(config.runtimeDir, "wake"), "wake from smoke\n", "utf-8");
  const wakeConsumed = consumeSentinel(config.runtimeDir, "wake");
  if (wakeConsumed) loop.getHeartbeat().stimulate();

  writeFileSync(sentinelPath(config.runtimeDir, "halt"), "halt from smoke\n", "utf-8");
  const haltDetected = consumeSentinel(config.runtimeDir, "halt");

  await loop.cycleOnce();
  const health = JSON.parse(readFileSync(hPath, "utf-8")) as Record<string, unknown>;

  return {
    healthPath: hPath,
    wakeConsumed,
    haltDetected,
    health,
  };
}
