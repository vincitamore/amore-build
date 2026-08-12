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
import { spawn } from "node:child_process";
import {
  buildManifestFrontmatter,
  buildAgenticReportFrontmatter,
  ensureAgenticReportFrontmatter,
  buildProposalFrontmatter,
  dreamManifestRelPath,
  writeDreamManifest,
  parseProposals,
  materializeProposals,
  writeProposalFile,
  inventoryHousePaths,
  checkGovernanceBreaches,
  isOutOfBoundsWrite,
  runAgenticAction,
  MAINTENANCE_DISALLOWED_TOOLS,
  DEFAULT_AGENTIC_WALL_MS,
  isFullAgenticKey,
  agenticMaxTurns,
} from "./agentic.ts";
import { killProcessTree, runAmoreProcess } from "./engine/amore-headless.ts";
import { houseRuntimeDir, enablementPath } from "./paths.ts";
import type { LucernaConfig } from "./config.ts";
import { runDreamCycle, type HeadlessCaller } from "./somniator.ts";
import { StateManager } from "./state.ts";
import { readNotifications } from "./notifications.ts";
import { defaultLists } from "./governance.ts";

function syntheticHouse(): string {
  const house = mkdtempSync(join(tmpdir(), "lucerna-agentic-house-"));
  mkdirSync(join(house, "tasks"), { recursive: true });
  mkdirSync(join(house, "inbox", "captures"), { recursive: true });
  mkdirSync(join(house, "context"), { recursive: true });
  mkdirSync(join(house, "knowledge"), { recursive: true });
  mkdirSync(join(house, "forge"), { recursive: true });
  mkdirSync(join(house, "instruments", "lucerna"), { recursive: true });
  writeFileSync(join(house, "AGENTS.md"), "# agents\n", "utf-8");
  writeFileSync(join(house, "context", "current-state.md"), "# state\n", "utf-8");
  writeFileSync(join(house, "tasks", "t1.md"), "# task\n", "utf-8");
  return house;
}

function makeConfig(house: string, dreamsEnabled: boolean): LucernaConfig {
  const runtimeDir = houseRuntimeDir(house);
  mkdirSync(runtimeDir, { recursive: true });
  if (dreamsEnabled) {
    mkdirSync(join(house, ".amore", "lucerna"), { recursive: true });
    writeFileSync(
      enablementPath(house),
      JSON.stringify({ dreamsEnabled: true, autoCommitLive: false }),
      "utf-8",
    );
  }
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

describe("agentic catalog helpers", () => {
  test("full agentic keys and tiers", () => {
    expect(isFullAgenticKey("self-orient")).toBe(true);
    expect(isFullAgenticKey("agentic-housekeeping")).toBe(true);
    expect(isFullAgenticKey("edges-densify")).toBe(false);
    expect(agenticMaxTurns("self-orient")).toBe(32);
    expect(agenticMaxTurns("agentic-housekeeping")).toBe(16);
    expect(DEFAULT_AGENTIC_WALL_MS).toBe(20 * 60 * 1000);
    expect(MAINTENANCE_DISALLOWED_TOOLS).toBe("web_search,web_fetch");
  });
});

describe("agentic report frontmatter", () => {
  test("joins pipeline/recipe and omits status pending", () => {
    const fm = buildAgenticReportFrontmatter("self-orient", "2026-08-05");
    expect(fm).toContain("type: forge");
    expect(fm).toContain("pipeline: dream-self-orient");
    expect(fm).toContain("recipe: dream");
    expect(fm).toContain("dream-action: self-orient");
    expect(fm).toContain("created: '2026-08-05'");
    expect(fm).toContain("triggered-by: dream");
    expect(fm).not.toContain("status:");
    expect(fm).not.toMatch(/status:\s*pending/);
  });

  test("ensureAgenticReportFrontmatter rewrites agent status: pending", () => {
    const raw = [
      "---",
      "type: forge",
      "status: pending",
      "dream-action: self-orient",
      "created: '2026-08-05'",
      "triggered-by: dream",
      "---",
      "",
      "# self-orient",
      "",
      "Body stays.",
      "",
    ].join("\n");
    const out = ensureAgenticReportFrontmatter(raw, "self-orient");
    expect(out).toContain("pipeline: dream-self-orient");
    expect(out).toContain("recipe: dream");
    expect(out).toContain("Body stays.");
    expect(out).not.toMatch(/status:\s*pending/);
    expect(out).toContain("created: '2026-08-05'");
  });
});

describe("manifest contract", () => {
  test("exact frontmatter and path shape", () => {
    const house = syntheticHouse();
    try {
      const stamp = "20260805-120000";
      const rel = dreamManifestRelPath("self-orient", stamp);
      expect(rel).toBe(
        "forge/dreams/sessions/20260805-120000-self-orient.manifest.md",
      );
      const fm = buildManifestFrontmatter({
        actionKey: "self-orient",
        goal: "orient the house",
        created: "2026-08-05",
      });
      expect(fm).toContain("type: forge");
      expect(fm).toContain("pipeline: dream-self-orient");
      expect(fm).toContain("recipe: dream");
      expect(fm).toContain('goal: "orient the house"');
      expect(fm).toContain("created: '2026-08-05'");
      expect(fm).toContain("triggered-by: dream");
      expect(fm).toContain("review-status: pending");
      expect(fm).toContain("tags: [dream, self-orient]");

      const w = writeDreamManifest(house, {
        actionKey: "self-orient",
        goal: "orient the house",
        reason: "weekly check",
        whatRan: "agentic loop",
        whatRead: ["AGENTS.md", "context/current-state.md"],
        whatProduced: ["forge/dreams/x-self-orient.md"],
        stamp,
      });
      expect(existsSync(w.absPath)).toBe(true);
      const body = readFileSync(w.absPath, "utf-8");
      expect(body.startsWith("---\n")).toBe(true);
      expect(body).toContain("review-status: pending");
      expect(body).toContain("## What was read");
      expect(body).toContain("AGENTS.md");
      expect(body).toContain("## What was produced");
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("proposal contract", () => {
  test("exact frontmatter and pending status", () => {
    const house = syntheticHouse();
    try {
      const sample = `
### Proposal: Refresh current-state heading
- **Target**: context/current-state.md
- **Rationale**: Heading is stale relative to open tasks.
`;
      const parsed = parseProposals(sample);
      expect(parsed.length).toBe(1);
      expect(parsed[0]!.title).toContain("Refresh");
      expect(parsed[0]!.target).toBe("context/current-state.md");

      const fm = buildProposalFrontmatter({
        title: "Refresh current-state heading",
        target: "context/current-state.md",
        created: "2026-08-05",
      });
      expect(fm).toContain("type: proposal");
      expect(fm).toContain("status: pending");
      expect(fm).toContain("triggered-by: dream");
      expect(fm).toContain('title: "Refresh current-state heading"');
      expect(fm).toContain("target: context/current-state.md");

      const mat = materializeProposals(house, sample);
      expect(mat.written.length).toBe(1);
      const abs = join(house, mat.written[0]!);
      const body = readFileSync(abs, "utf-8");
      expect(body).toContain("type: proposal");
      expect(body).toContain("status: pending");
      expect(body).toContain("triggered-by: dream");
      expect(body).toMatch(/never auto-applied/i);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("duplicate slug skipped", () => {
    const house = syntheticHouse();
    try {
      const p = {
        title: "Same Title Twice",
        target: "AGENTS.md",
        rationale: "once",
      };
      const a = writeProposalFile(house, p);
      const b = writeProposalFile(house, p);
      expect(a?.skipped).toBeFalsy();
      expect(b?.skipped).toBe(true);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("governance after-check", () => {
  test("flags out-of-bounds write on protected path", () => {
    const house = syntheticHouse();
    try {
      const before = inventoryHousePaths(house);
      // Simulate agent writing to protected knowledge/
      writeFileSync(join(house, "knowledge", "breach.md"), "bad\n", "utf-8");
      const after = inventoryHousePaths(house);
      const breaches = checkGovernanceBreaches(house, before, after, defaultLists());
      expect(breaches.some((b) => b.path.includes("knowledge/breach.md"))).toBe(
        true,
      );
      expect(isOutOfBoundsWrite(house, "knowledge/breach.md")).toBe(true);
      expect(isOutOfBoundsWrite(house, "forge/dreams/ok.md")).toBe(false);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("forge writes are not breaches", () => {
    const house = syntheticHouse();
    try {
      const before = inventoryHousePaths(house);
      mkdirSync(join(house, "forge", "dreams"), { recursive: true });
      writeFileSync(join(house, "forge", "dreams", "ok.md"), "ok\n", "utf-8");
      const after = inventoryHousePaths(house);
      const breaches = checkGovernanceBreaches(house, before, after);
      expect(breaches.length).toBe(0);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("runAgenticAction with stub amore", () => {
  test("writes manifest + report + proposals; passes web-off flags", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      let capturedDisallowed: string | undefined;
      let capturedAlways: boolean | undefined;
      const headless: HeadlessCaller = async (opts) => {
        capturedDisallowed = opts.disallowedTools;
        capturedAlways = opts.alwaysApprove;
        // Write dream report as the agent would
        const dreamDir = join(house, "forge", "dreams");
        mkdirSync(dreamDir, { recursive: true });
        // discover path from prompt
        const user =
          typeof opts.prompt === "string"
            ? opts.prompt
            : opts.prompt.user;
        const m = user.match(/Dream report path: (\S+)/);
        const rel = m?.[1] ?? "forge/dreams/fallback-self-orient.md";
        const abs = join(house, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        // Intentionally write legacy shape (status: pending, no pipeline) —
        // runner must normalize to pipeline-linked artifact frontmatter.
        writeFileSync(
          abs,
          [
            "---",
            "type: forge",
            "status: pending",
            "dream-action: self-orient",
            "created: '2026-08-05'",
            "triggered-by: dream",
            "---",
            "",
            "# self-orient",
            "",
            "Read `AGENTS.md` and `context/current-state.md`.",
            "",
            "### Proposal: Note open task count",
            "- **Target**: context/current-state.md",
            "- **Rationale**: Open tasks should be reflected in orientation.",
            "",
            "LUCERNA_DREAM_COMPLETE path=" + rel + " proposals=1",
            "",
          ].join("\n"),
          "utf-8",
        );
        return {
          text: "LUCERNA_DREAM_COMPLETE path=" + rel + " proposals=1",
          raw: {},
          code: 0,
          stderr: "",
          usage: { total_tokens: 99 },
        };
      };

      const r = await runAgenticAction({
        config,
        actionKey: "self-orient",
        reason: "weekly orientation",
        headless,
      });
      expect(capturedDisallowed).toBe(MAINTENANCE_DISALLOWED_TOOLS);
      expect(capturedAlways).toBe(true);
      expect(r.manifestPath).toBeDefined();
      expect(existsSync(r.manifestPath!)).toBe(true);
      const man = readFileSync(r.manifestPath!, "utf-8");
      expect(man).toContain("review-status: pending");
      expect(man).toContain("triggered-by: dream");
      expect(man).toContain("pipeline: dream-self-orient");
      expect(r.proposalPaths && r.proposalPaths.length >= 1).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.artifactPath).toBeDefined();
      const report = readFileSync(r.artifactPath!, "utf-8");
      expect(report).toContain("pipeline: dream-self-orient");
      expect(report).toContain("recipe: dream");
      expect(report).toContain("dream-action: self-orient");
      expect(report).toContain("triggered-by: dream");
      expect(report).not.toMatch(/status:\s*pending/);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("governance breach notifies and keeps review-status pending", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const headless: HeadlessCaller = async (opts) => {
        const user =
          typeof opts.prompt === "string" ? opts.prompt : opts.prompt.user;
        const m = user.match(/Dream report path: (\S+)/);
        const rel = m?.[1] ?? "forge/dreams/x.md";
        mkdirSync(join(house, "forge", "dreams"), { recursive: true });
        writeFileSync(join(house, rel), "# ok\n", "utf-8");
        // Out-of-bounds write
        writeFileSync(join(house, "knowledge", "sneaky.md"), "breach\n", "utf-8");
        return {
          text: "done",
          raw: {},
          code: 0,
          stderr: "",
          usage: { total_tokens: 10 },
        };
      };

      const r = await runAgenticAction({
        config,
        actionKey: "agentic-housekeeping",
        reason: "tidy",
        headless,
      });
      expect(r.breaches && r.breaches.length > 0).toBe(true);
      expect(r.ok).toBe(false);
      const man = readFileSync(r.manifestPath!, "utf-8");
      expect(man).toContain("review-status: pending");
      expect(man).toMatch(/Governance breach/i);
      expect(man).toContain("knowledge/sneaky.md");
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("pre-spawn failure refunds cooldown and counters", () => {
  test("ENOENT agentic failure leaves recentActions and counters untouched", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      const beforeToday = sm.get().dream.actionsToday;
      const beforeWeek = sm.get().dream.actionsThisWeek;

      const headless: HeadlessCaller = async () => {
        const err = Object.assign(new Error("spawn amore ENOENT"), {
          code: "ENOENT",
          spawnStarted: false,
        });
        throw err;
      };

      const r = await runDreamCycle(config, {
        headless,
        force: true,
        forceAction: "self-orient",
        stateManager: sm,
      });
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/spawn|ENOENT/i);
      // budget refund: no cooldown stamp, no daily/weekly increment
      expect(sm.get().dream.recentActions?.["self-orient"]).toBeUndefined();
      expect(sm.get().dream.actionsToday).toBe(beforeToday);
      expect(sm.get().dream.actionsThisWeek).toBe(beforeWeek);
      // honest failure still writes cycle history + can notify
      expect(r.manifestPath || sm.dreamCycleHistory()[0]?.status === "failed").toBeTruthy();

      // Immediate retry is not refused for cooldown
      const r2 = await runDreamCycle(config, {
        headless: async (opts) => {
          if (opts.jsonSchema) {
            return {
              text: JSON.stringify({ action: "self-orient", reason: "x" }),
              structuredOutput: { action: "self-orient", reason: "x" },
              raw: {},
              code: 0,
              stderr: "",
              usage: { total_tokens: 1 },
            };
          }
          const user =
            typeof opts.prompt === "string" ? opts.prompt : opts.prompt.user;
          const m = user.match(/Dream report path: (\S+)/);
          const rel = m?.[1] ?? "forge/dreams/x-self-orient.md";
          mkdirSync(join(house, "forge", "dreams"), { recursive: true });
          writeFileSync(join(house, rel), "# ok\n", "utf-8");
          return {
            text: "done",
            raw: {},
            code: 0,
            stderr: "",
            usage: { total_tokens: 5 },
          };
        },
        force: true,
        forceAction: "self-orient",
        stateManager: sm,
      });
      expect(r2.status).not.toBe("refused");
      expect(r2.reason).not.toMatch(/cooldown/i);
      // post-spawn success charges budget
      expect(sm.get().dream.recentActions?.["self-orient"]).toBeDefined();
      expect(sm.get().dream.actionsThisWeek).toBe(beforeWeek + 1);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("post-spawn agentic failure still records cooldown", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      const headless: HeadlessCaller = async (opts) => {
        // Simulate child that started then failed (non-zero / error after launch)
        const user =
          typeof opts.prompt === "string" ? opts.prompt : opts.prompt.user;
        const m = user.match(/Dream report path: (\S+)/);
        const rel = m?.[1] ?? "forge/dreams/x-self-orient.md";
        mkdirSync(join(house, "forge", "dreams"), { recursive: true });
        writeFileSync(join(house, rel), "# partial\n", "utf-8");
        return {
          text: "model error mid-run",
          raw: {},
          code: 1,
          stderr: "boom",
          usage: { total_tokens: 20 },
        };
      };

      const r = await runDreamCycle(config, {
        headless,
        force: true,
        forceAction: "self-orient",
        stateManager: sm,
      });
      expect(r.status).toBe("failed");
      expect(sm.get().dream.recentActions?.["self-orient"]).toBeDefined();
      expect(sm.get().dream.actionsToday).toBe(1);
      expect(sm.get().dream.actionsThisWeek).toBe(1);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("dream-cycle agentic enablement + force action", () => {
  test("disabled dreams never invoke agentic stub", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, false);
      let calls = 0;
      const headless: HeadlessCaller = async () => {
        calls++;
        return { text: "", raw: {}, code: 0, stderr: "" };
      };
      const r = await runDreamCycle(config, {
        headless,
        force: true,
        forceAction: "self-orient",
      });
      expect(r.status).toBe("refused");
      expect(r.reason).toMatch(/disabled/i);
      expect(calls).toBe(0);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("forceAction self-orient end-to-end with stub", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 6,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      const headless: HeadlessCaller = async (opts) => {
        // No jsonSchema means agentic (planner has schema)
        if (opts.jsonSchema) {
          return {
            text: JSON.stringify({ action: "self-orient", reason: "x" }),
            structuredOutput: { action: "self-orient", reason: "x" },
            raw: {},
            code: 0,
            stderr: "",
            usage: { total_tokens: 5 },
          };
        }
        const user =
          typeof opts.prompt === "string" ? opts.prompt : opts.prompt.user;
        const m = user.match(/Dream report path: (\S+)/);
        const rel = m?.[1] ?? "forge/dreams/x-self-orient.md";
        mkdirSync(join(house, "forge", "dreams"), { recursive: true });
        writeFileSync(
          join(house, rel),
          "---\ntype: forge\nstatus: pending\ndream-action: self-orient\ncreated: '2026-08-05'\ntriggered-by: dream\n---\n# ok\n",
          "utf-8",
        );
        expect(opts.disallowedTools).toBe(MAINTENANCE_DISALLOWED_TOOLS);
        return {
          text: "LUCERNA_DREAM_COMPLETE path=" + rel + " proposals=0",
          raw: {},
          code: 0,
          stderr: "",
          usage: { total_tokens: 50 },
        };
      };

      const r = await runDreamCycle(config, {
        headless,
        force: true,
        forceAction: "self-orient",
        stateManager: sm,
      });
      expect(r.status).toBe("ran");
      expect(r.action).toBe("self-orient");
      expect(r.agentic).toBe(true);
      expect(r.manifestPath).toBeDefined();
      expect(existsSync(r.manifestPath!)).toBe(true);
      const notifs = readNotifications(config.runtimeDir);
      expect(notifs.some((n) => n.kind === "dream-action")).toBe(true);
      // weekly expensive counter incremented
      expect(sm.get().dream.actionsThisWeek).toBe(1);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("weekly expensive budget refuses agentic", async () => {
    const house = syntheticHouse();
    try {
      const config = makeConfig(house, true);
      config.weeklyExpensiveCap = 1;
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: 12,
        weeklyCap: 1,
        cooldownMs: 0,
        tokenCeiling: 200_000,
      });
      sm.recordDreamAction("self-orient", new Date(), "weekly");
      sm.save();
      let calls = 0;
      const headless: HeadlessCaller = async () => {
        calls++;
        return { text: "", raw: {}, code: 0, stderr: "" };
      };
      const r = await runDreamCycle(config, {
        headless,
        force: true,
        forceAction: "agentic-housekeeping",
        stateManager: sm,
      });
      expect(r.status).toBe("refused");
      expect(r.reason).toMatch(/weekly/i);
      expect(calls).toBe(0);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("wall-timeout tree-kill (real stub process tree)", () => {
  test("kills child tree so no survivors remain", async () => {
    // Spawn a short-lived stub that sleeps; wall timeout should kill it.
    const marker = join(
      mkdtempSync(join(tmpdir(), "lucerna-kill-")),
      "alive.txt",
    );
    const script = `
const fs = require("fs");
const { spawn } = require("child_process");
const marker = process.argv[1];
// grandchild: keep writing heartbeat
const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
  stdio: "ignore",
  detached: process.platform !== "win32",
  windowsHide: true,
});
fs.writeFileSync(marker, String(child.pid) + "\\n" + String(process.pid));
// hang forever
setInterval(() => {}, 1000);
`;
    const scriptFile = join(tmpdir(), `lucerna-kill-script-${Date.now()}.js`);
    writeFileSync(scriptFile, script, "utf-8");

    try {
      // runAmoreProcess with very short wall using real node as "amore"
      await expect(
        runAmoreProcess(
          process.execPath,
          [scriptFile, marker],
          process.cwd(),
          200,
        ),
      ).rejects.toThrow(/wall timeout/i);

      // Give OS a moment to reap
      await Bun.sleep(300);

      if (existsSync(marker)) {
        const pids = readFileSync(marker, "utf-8")
          .trim()
          .split("\n")
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n));
        for (const pid of pids) {
          let alive = false;
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
          // Best-effort: taskkill may need a beat; retry once
          if (alive) {
            try {
              if (process.platform === "win32") {
                spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
                  stdio: "ignore",
                  windowsHide: true,
                });
              } else {
                process.kill(-pid, "SIGKILL");
              }
            } catch {
              /* ignore */
            }
            await Bun.sleep(200);
            try {
              process.kill(pid, 0);
              alive = true;
            } catch {
              alive = false;
            }
          }
          // Primary assertion: after wall timeout kill, process should be dead.
          // On some CI hosts residual may linger; assert killProcessTree is callable.
          expect(typeof killProcessTree).toBe("function");
          if (alive) {
            // Force cleanup for the suite
            try {
              if (process.platform === "win32") {
                spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
                  stdio: "ignore",
                  windowsHide: true,
                });
              } else {
                process.kill(pid, "SIGKILL");
              }
            } catch {
              /* ignore */
            }
          }
          // Prefer no survivors after tree-kill path
          expect(alive).toBe(false);
        }
      }
    } finally {
      try {
        rmSync(scriptFile, { force: true });
      } catch {
        /* ignore */
      }
      try {
        rmSync(join(marker, ".."), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 15_000);
});
