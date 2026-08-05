#!/usr/bin/env bun
/**
 * lucerna CLI  -  house steward daemon control surface.
 *
 *   lucerna status|start|stop|dream <action>|log [-n]|smoke
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, packageVersion, VERSION } from "./config.ts";
import {
  DaemonLoop,
  appendLog,
  readPidFile,
  isPidAlive,
  clearPidFile,
  runLifecycleSmoke,
} from "./daemon.ts";
import { healthPath, logPath, sentinelPath, RUNTIME_FILES } from "./paths.ts";
import { StateManager } from "./state.ts";
import { ADMITTED_ACTION_KEYS, ACTION_CATALOG } from "./actions.ts";
import { readEnablementFile } from "./enablement.ts";
import {
  buildAmoreHeadlessArgv,
  parseJsonEnvelope,
  resolveAmoreBin,
} from "./engine/amore-headless.ts";
import {
  DAILY_ACTION_BUDGET,
  WEEKLY_EXPENSIVE_BUDGET,
  DEFAULT_DAILY_TOKEN_CEILING,
} from "./budget.ts";
import { PROTECTED_PATTERNS, WRITABLE_PATTERNS } from "./governance.ts";

const HELP = `lucerna  -  house steward daemon

Usage:
  lucerna status [--house PATH]
  lucerna start  [--house PATH] [--dreams-enabled] [--auto-commit-live] [--dry-run]
  lucerna stop   [--house PATH]
  lucerna dream  <action> [--house PATH] [--respect-gates]
  lucerna log    [-n N] [--house PATH]
  lucerna smoke  [--house PATH]

Light actions (phase 1):
  ${ADMITTED_ACTION_KEYS.join(", ")}

Defaults:
  dreams OFF, auto-commit dry-run, daily actions ${DAILY_ACTION_BUDGET},
  weekly expensive ${WEEKLY_EXPENSIVE_BUDGET}, token ceiling ${DEFAULT_DAILY_TOKEN_CEILING}

Env:
  LUCERNA_HOUSE_ROOT, LUCERNA_AMORE_BIN, LUCERNA_DREAMS_ENABLED,
  LUCERNA_AUTO_COMMIT_LIVE, LUCERNA_MODEL
`;

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function cmdStatus(args: string[]): Promise<number> {
  const config = loadConfig(args);
  const hPath = healthPath(config.runtimeDir);
  const sPath = join(config.runtimeDir, RUNTIME_FILES.state);

  let health: Record<string, unknown> | null = null;
  if (existsSync(hPath)) {
    try {
      health = JSON.parse(readFileSync(hPath, "utf-8"));
    } catch {
      health = null;
    }
  }

  const pid = readPidFile(config.runtimeDir);
  let online = false;
  let healthy = false;
  if (health?.lastBeat && typeof health.lastBeat === "string") {
    const ts = new Date(health.lastBeat as string).getTime();
    const staleSec = (Date.now() - ts) / 1000;
    const intervalSec =
      typeof health.intervalMs === "number" ? (health.intervalMs as number) / 1000 : 8;
    const threshold = Math.max(120, intervalSec * 2.5);
    healthy = Number.isFinite(staleSec) && staleSec >= 0 && staleSec < threshold;
    online = healthy;
  }
  if (pid !== null && isPidAlive(pid)) {
    online = true;
  } else if (pid !== null && !isPidAlive(pid)) {
    online = false;
    healthy = false;
  }

  const { enablement } = readEnablementFile(config.runtimeDir);
  let budget: Record<string, unknown> | null = null;
  if (existsSync(sPath)) {
    try {
      const sm = new StateManager(config.runtimeDir, {
        dailyCap: config.dailyActionCap,
        weeklyCap: config.weeklyExpensiveCap,
        cooldownMs: config.cycleCooldownMs,
        tokenCeiling: config.dailyTokenCeiling,
      });
      budget = sm.budgetSnapshot() as unknown as Record<string, unknown>;
    } catch {
      budget = null;
    }
  }

  const out = {
    processName: config.processName,
    version: packageVersion(),
    houseRoot: config.houseRoot,
    runtimeDir: config.runtimeDir,
    online,
    healthy,
    pid,
    health: health ?? { available: false, note: "no health.json  -  daemon offline" },
    statePresent: existsSync(sPath),
    enablement,
    budget,
    driver: "amore-headless",
    amoreBin: resolveAmoreBin(config.amoreBin),
    dreamsAutonomousDefault: false,
    autoCommitDefault: "dry-run",
    admittedActions: ADMITTED_ACTION_KEYS,
  };
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

async function cmdStart(args: string[]): Promise<number> {
  const config = loadConfig(args);
  const loop = new DaemonLoop(config);
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    loop.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await loop.start();
  return 0;
}

async function cmdStop(args: string[]): Promise<number> {
  const config = loadConfig(args);
  mkdirSync(config.runtimeDir, { recursive: true });
  const halt = sentinelPath(config.runtimeDir, "halt");
  writeFileSync(halt, `halt requested at ${new Date().toISOString()}\n`, "utf-8");
  appendLog(config.runtimeDir, "stop: halt sentinel written");

  const pid = readPidFile(config.runtimeDir);
  if (pid !== null && !isPidAlive(pid)) {
    clearPidFile(config.runtimeDir);
    try {
      unlinkSync(halt);
    } catch {
      /* ignore */
    }
    console.log(JSON.stringify({ ok: true, note: "stale pid cleared; daemon was not running", pid }));
    return 0;
  }

  console.log(
    JSON.stringify({
      ok: true,
      note: "halt sentinel written; daemon will stop on next poll",
      haltPath: halt,
      pid,
    }),
  );
  return 0;
}

async function cmdDream(args: string[]): Promise<number> {
  const action = args.find((a) => !a.startsWith("-") && a !== "dream");
  if (!action) {
    console.error("dream requires an action key: " + ADMITTED_ACTION_KEYS.join(", "));
    return 64;
  }
  const config = loadConfig(args);
  const loop = new DaemonLoop(config);
  const respectGates = args.includes("--respect-gates");
  const result = await loop.runAction(action, {
    ignoreBudget: !respectGates,
    ignoreCooldown: !respectGates,
  });
  console.log(JSON.stringify({ action, ...result }, null, 2));
  return result.ok ? 0 : 1;
}

async function cmdLog(args: string[]): Promise<number> {
  const config = loadConfig(args);
  const nFlag = getArg(args, "-n");
  const n = nFlag ? parseInt(nFlag, 10) : 40;
  const p = logPath(config.runtimeDir);
  if (!existsSync(p)) {
    console.log("(no log yet)");
    return 0;
  }
  const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const tail = lines.slice(-Math.max(1, Number.isFinite(n) ? n : 40));
  for (const line of tail) console.log(line);
  return 0;
}

async function cmdSmoke(args: string[]): Promise<number> {
  // Spawn-stubbed self-check; no network, no real amore binary.
  const config = loadConfig(args);
  const results: Array<{ check: string; ok: boolean; detail: string }> = [];

  // 1. Governance lists pin
  results.push({
    check: "governance-protected-count",
    ok: PROTECTED_PATTERNS.length === 15,
    detail: `PROTECTED_PATTERNS.length=${PROTECTED_PATTERNS.length}`,
  });
  results.push({
    check: "governance-writable",
    ok: WRITABLE_PATTERNS.includes("forge/") && WRITABLE_PATTERNS.includes("inbox/captures/"),
    detail: WRITABLE_PATTERNS.join(","),
  });

  // 2. Argv builder never pairs --single with --prompt-file
  const argv = buildAmoreHeadlessArgv({
    promptFile: "/tmp/p.md",
    cwd: config.houseRoot,
    maxTurns: 1,
    outputFormat: "json",
  });
  results.push({
    check: "argv-no-single-with-prompt-file",
    ok: argv.includes("--prompt-file") && !argv.includes("--single"),
    detail: argv.join(" "),
  });

  // 3. Envelope parse (fixture)
  const fixture = JSON.stringify({
    text: "ok",
    stopReason: "end_turn",
    sessionId: "sess-smoke",
    requestId: "req-smoke",
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 0,
    },
    modelUsage: { "model-x": { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
  });
  try {
    const env = parseJsonEnvelope(fixture);
    results.push({
      check: "envelope-parse",
      ok: env.text === "ok" && env.usage?.total_tokens === 15,
      detail: `sessionId=${env.sessionId}`,
    });
  } catch (e) {
    results.push({ check: "envelope-parse", ok: false, detail: String(e) });
  }

  // 4. Lifecycle sentinels + health
  try {
    const life = await runLifecycleSmoke(config);
    results.push({
      check: "lifecycle-health",
      ok: life.health.available === true && typeof life.health.pid === "number",
      detail: life.healthPath,
    });
    results.push({
      check: "lifecycle-sentinels",
      ok: life.wakeConsumed && life.haltDetected,
      detail: `wake=${life.wakeConsumed} halt=${life.haltDetected}`,
    });
  } catch (e) {
    results.push({ check: "lifecycle", ok: false, detail: String(e) });
  }

  // 5. Catalog
  results.push({
    check: "action-catalog",
    ok: ACTION_CATALOG.filter((a) => a.admitted).length === 4,
    detail: ADMITTED_ACTION_KEYS.join(","),
  });

  // 6. Enablement defaults
  const { enablement } = readEnablementFile(config.runtimeDir);
  results.push({
    check: "enablement-safe-defaults",
    ok: enablement.dreamsEnabled === false || existsSync(join(config.runtimeDir, RUNTIME_FILES.enable)),
    detail: JSON.stringify(enablement),
  });

  const allOk = results.every((r) => r.ok);
  console.log(
    JSON.stringify(
      {
        ok: allOk,
        version: VERSION,
        driver: "amore-headless",
        checks: results,
      },
      null,
      2,
    ),
  );
  return allOk ? 0 : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const rest = argv.slice(1);

  let code = 0;
  switch (cmd) {
    case "status":
      code = await cmdStatus(rest);
      break;
    case "start":
      code = await cmdStart(rest);
      break;
    case "stop":
      code = await cmdStop(rest);
      break;
    case "dream":
      code = await cmdDream(argv); // keep action name in args for parser
      break;
    case "log":
      code = await cmdLog(rest);
      break;
    case "smoke":
      code = await cmdSmoke(rest);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      code = 0;
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      code = 64;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
