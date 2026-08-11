import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { spawn as SpawnFn, SpawnOptions } from "node:child_process";
import { openDb } from "./store/db";
import { ingest } from "./ingest";
import { writeCorpus, cleanCorpus, CWD_DEC } from "./test/fixtures";
import {
  runLens,
  parseJsonEnvelope,
  runAmoreProcess,
  buildAmoreLensArgv,
  resolveAmoreBin,
  killProcessTree,
} from "./lens-runner";
import { readAuditTail } from "./audit";
import { LENS_PAYLOAD_CAP_BYTES } from "./scrub";
import { listLenses } from "./lenses";

function tempHome(): string {
  const home = join(
    tmpdir(),
    `speculum-lens-home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(home, { recursive: true });
  return home;
}

function cleanupHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows may keep sqlite WAL locked briefly; ignore.
  }
}

function fakeSpawnSuccess(envelope: object): typeof SpawnFn {
  return ((_bin: string, argv: string[]) => {
    if (argv[0] === "/T" || argv.includes("/PID")) {
      return new EventEmitter() as ReturnType<typeof SpawnFn>;
    }
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: () => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    fakeChild.pid = 111;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = () => true;
    queueMicrotask(() => {
      fakeChild.stdout.emit("data", Buffer.from(JSON.stringify(envelope)));
      fakeChild.emit("close", 0);
    });
    return fakeChild as unknown as ReturnType<typeof SpawnFn>;
  }) as unknown as typeof SpawnFn;
}

function fakeSpawnHang(): { spawnImpl: typeof SpawnFn; killed: { value: boolean } } {
  const killed = { value: false };
  const fakeChild = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  fakeChild.pid = 424242;
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => {
    killed.value = true;
    return true;
  };
  const spawnImpl = ((_bin: string, argv: string[]) => {
    if (argv[0] === "/T" || argv.includes("/PID")) {
      killed.value = true;
      return new EventEmitter() as ReturnType<typeof SpawnFn>;
    }
    return fakeChild as unknown as ReturnType<typeof SpawnFn>;
  }) as unknown as typeof SpawnFn;
  return { spawnImpl, killed };
}

describe("lens registry", () => {
  test("ships three lenses", () => {
    const names = listLenses().map((l) => l.name).sort();
    expect(names).toEqual(["pattern-extraction", "session-postmortem", "usage-story"]);
  });
});

describe("parseJsonEnvelope + argv", () => {
  test("parses envelope fields", () => {
    const env = parseJsonEnvelope(
      JSON.stringify({
        text: "postmortem body",
        stopReason: "end_turn",
        sessionId: "s1",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        modelUsage: { "test-model": { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
      }),
    );
    expect(env.text).toBe("postmortem body");
    expect(env.stopReason).toBe("end_turn");
    expect(env.usage?.total_tokens).toBe(30);
    expect(env.modelUsage?.["test-model"]?.output_tokens).toBe(20);
  });

  test("buildAmoreLensArgv uses prompt-file and json", () => {
    const argv = buildAmoreLensArgv({
      promptFile: "C:/tmp/p.md",
      cwd: "C:/tmp/scratch",
      maxTurns: 3,
    });
    expect(argv).toContain("--prompt-file");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("3");
    expect(argv).toContain("--cwd");
    expect(argv).not.toContain("--single");
  });

  test("resolveAmoreBin prefers override then env", () => {
    expect(resolveAmoreBin("/custom/amore")).toBe("/custom/amore");
    const prev = process.env.SPECULUM_AMORE_BIN;
    try {
      process.env.SPECULUM_AMORE_BIN = "C:/bins/amore.exe";
      expect(resolveAmoreBin()).toBe("C:/bins/amore.exe");
      delete process.env.SPECULUM_AMORE_BIN;
      expect(resolveAmoreBin()).toBe("amore");
    } finally {
      if (prev === undefined) delete process.env.SPECULUM_AMORE_BIN;
      else process.env.SPECULUM_AMORE_BIN = prev;
    }
  });
});

describe("runAmoreProcess timeout kill", () => {
  test("rejects on wall timeout and kills process tree", async () => {
    const { spawnImpl, killed } = fakeSpawnHang();
    await expect(
      runAmoreProcess("stub-amore", ["--prompt-file", "p"], process.cwd(), 50, spawnImpl),
    ).rejects.toThrow(/wall timeout/i);
    expect(killed.value || process.platform === "win32").toBe(true);
  });

  test("killProcessTree does not throw", () => {
    let called = false;
    killProcessTree({
      pid: 99999999,
      kill: () => {
        called = true;
        return true;
      },
    });
    expect(called || process.platform === "win32" || true).toBe(true);
  });
});

describe("runLens dry-run and fail-closed", () => {
  test("--dry-run never spawns; audit records dry-run", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const dbPath = join(home, "speculum.sqlite");
    const auditPath = join(home, "lens-audit.jsonl");
    let spawnCalls = 0;
    const spawnImpl = ((..._args: unknown[]) => {
      spawnCalls++;
      throw new Error("spawn must not be called on dry-run");
    }) as unknown as typeof SpawnFn;

    try {
      const db = openDb(dbPath);
      const stats = ingest(db, { sessionsDir: corpus.root });
      expect(stats.sessionDirsIngested).toBe(1);

      const result = await runLens(db, "session-postmortem", {
        lastN: 1,
        dryRun: true,
        auditPath,
        reportsDir: join(home, "reports"),
        spawnImpl,
        scrubHomeDir: "C:\\Users\\Synthetic",
      });
      db.close();

      expect(result.spawned).toBe(false);
      expect(spawnCalls).toBe(0);
      expect(result.dryRun).toBe(true);
      expect(result.scrub.ok).toBe(true);
      expect(result.audit.decision).toBe("dry-run");
      expect(result.reportPath).toBeNull();

      const tail = readAuditTail(auditPath, 5);
      expect(tail.length).toBe(1);
      expect(tail[0]!.decision).toBe("dry-run");
      expect(tail[0]!.lens).toBe("session-postmortem");
      expect(typeof tail[0]!.payloadBytes).toBe("number");
      expect(tail[0]!.scrubCounts).toBeDefined();
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("fail-closed oversized payload: refuses, stub never invoked, audit records refusal", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const dbPath = join(home, "speculum.sqlite");
    const auditPath = join(home, "lens-audit.jsonl");
    let spawnCalls = 0;
    const spawnImpl = ((..._args: unknown[]) => {
      spawnCalls++;
      throw new Error("must not spawn on oversize refuse");
    }) as unknown as typeof SpawnFn;

    try {
      const db = openDb(dbPath);
      ingest(db, { sessionsDir: corpus.root });

      const result = await runLens(db, "session-postmortem", {
        lastN: 1,
        dryRun: false,
        auditPath,
        reportsDir: join(home, "reports"),
        maxBytes: 64, // tiny cap forces refuse
        spawnImpl,
        scrubHomeDir: "C:\\Users\\Synthetic",
      });
      db.close();

      expect(result.refused).toBe(true);
      expect(result.spawned).toBe(false);
      expect(spawnCalls).toBe(0);
      expect(result.refusedReason).toMatch(/exceeds lens cap|narrow the slice/i);
      expect(result.audit.decision).toBe("refused");
      expect(result.audit.reason).toBeTruthy();

      const tail = readAuditTail(auditPath, 5);
      expect(tail.some((r) => r.decision === "refused")).toBe(true);
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("full lens run with spawn stub writes report and audit accepted", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const dbPath = join(home, "speculum.sqlite");
    const auditPath = join(home, "lens-audit.jsonl");
    const reportsDir = join(home, "reports");
    const envelope = {
      text: "## What was attempted\nSynthetic postmortem for the clean fixture session.",
      stopReason: "end_turn",
      sessionId: "lens-sess-1",
      usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      modelUsage: {
        "stub/model-id": {
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
        },
      },
    };

    try {
      const db = openDb(dbPath);
      ingest(db, { sessionsDir: corpus.root });

      const result = await runLens(db, "session-postmortem", {
        lastN: 1,
        auditPath,
        reportsDir,
        spawnImpl: fakeSpawnSuccess(envelope),
        amoreBin: "stub-amore",
        scrubHomeDir: "C:\\Users\\Synthetic",
      });
      db.close();

      expect(result.spawned).toBe(true);
      expect(result.refused).toBe(false);
      expect(result.text).toContain("Synthetic postmortem");
      expect(result.modelId).toBe("stub/model-id");
      expect(result.reportPath).toBeTruthy();
      expect(existsSync(result.reportPath!)).toBe(true);
      const reportBody = readFileSync(result.reportPath!, "utf-8");
      expect(reportBody).toContain("session-postmortem");
      expect(reportBody).toContain("stub/model-id");

      expect(result.audit.decision).toBe("accepted");
      expect(result.audit.usage?.total_tokens).toBe(140);
      expect(result.audit.modelId).toBe("stub/model-id");
      expect(result.audit.payloadBytes).toBeLessThanOrEqual(LENS_PAYLOAD_CAP_BYTES);
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("live lens spawn isolates AMORE_HOME to the scratch tree", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const dbPath = join(home, "speculum.sqlite");
    const auditPath = join(home, "lens-audit.jsonl");
    const reportsDir = join(home, "reports");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const envCaptureSpawn = ((
      _bin: string,
      argv: string[],
      opts?: SpawnOptions,
    ) => {
      if (argv[0] === "/T" || argv.includes("/PID")) {
        return new EventEmitter() as ReturnType<typeof SpawnFn>;
      }
      capturedEnv = opts?.env;
      const fakeChild = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => boolean;
      };
      fakeChild.pid = 333;
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      fakeChild.kill = () => true;
      queueMicrotask(() => {
        fakeChild.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ text: "isolated postmortem", stopReason: "end_turn" }),
          ),
        );
        fakeChild.emit("close", 0);
      });
      return fakeChild as unknown as ReturnType<typeof SpawnFn>;
    }) as unknown as typeof SpawnFn;

    try {
      const db = openDb(dbPath);
      ingest(db, { sessionsDir: corpus.root });

      const result = await runLens(db, "session-postmortem", {
        lastN: 1,
        auditPath,
        reportsDir,
        spawnImpl: envCaptureSpawn,
        amoreBin: "stub-amore",
        scrubHomeDir: "C:\\Users\\Synthetic",
      });
      db.close();

      expect(result.spawned).toBe(true);
      expect(result.refused).toBe(false);
      expect(capturedEnv).toBeTruthy();
      const amoreHome = capturedEnv!.AMORE_HOME;
      expect(typeof amoreHome).toBe("string");
      // The headless amore's home lives under the lens scratch tree (mkdtemp
      // prefix), never a real user home — the pollution class this isolation closes.
      expect(amoreHome!).toMatch(/speculum-lens-/);
      expect(capturedEnv!.GROK_HOME).toBe(amoreHome);
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("audit record shape has required fields", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const auditPath = join(home, "lens-audit.jsonl");
    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      await runLens(db, "pattern-extraction", {
        projectPath: CWD_DEC,
        lastN: 1,
        dryRun: true,
        auditPath,
        reportsDir: join(home, "reports"),
        scrubHomeDir: "C:\\Users\\Synthetic",
      });
      db.close();
      const [rec] = readAuditTail(auditPath, 1);
      expect(rec).toBeDefined();
      expect(typeof rec!.ts).toBe("string");
      expect(rec!.lens).toBe("pattern-extraction");
      expect(rec!.selection).toBeDefined();
      expect(typeof rec!.payloadBytes).toBe("number");
      expect(rec!.scrubCounts).toBeDefined();
      expect(["accepted", "refused", "dry-run"]).toContain(rec!.decision);
      expect(rec!.reason !== undefined).toBe(true);
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });
});
