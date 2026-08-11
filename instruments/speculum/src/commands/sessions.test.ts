/**
 * `speculum sessions` flag surface and list output.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { formatAge, parseSessionsArgs } from "./sessions";
import {
  agentChunk,
  cleanCorpus,
  makeUsage,
  turnCompleted,
  userChunk,
  writeCorpus,
} from "../test/fixtures";

const CLI = join(import.meta.dir, "..", "cli.ts");

describe("parseSessionsArgs", () => {
  test("defaults", () => {
    const p = parseSessionsArgs([]);
    expect(p.limit).toBe(50);
    expect(p.offset).toBe(0);
    expect(p.sort).toBe("recent");
    expect(p.countOnly).toBe(false);
    expect(p.json).toBe(false);
  });

  test("accepts valid class/agent/sort", () => {
    const p = parseSessionsArgs([
      "--class",
      "operator",
      "--agent",
      "primary",
      "--sort",
      "turns",
      "--limit",
      "10",
      "--offset",
      "5",
      "--project",
      "foo",
      "--title",
      "bar",
      "--json",
      "--count",
    ]);
    expect(p.cwdClass).toBe("operator");
    expect(p.agent).toBe("primary");
    expect(p.sort).toBe("turns");
    expect(p.limit).toBe(10);
    expect(p.offset).toBe(5);
    expect(p.project).toBe("foo");
    expect(p.title).toBe("bar");
    expect(p.json).toBe(true);
    expect(p.countOnly).toBe(true);
  });

  test("formatAge compact", () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    expect(formatAge("2026-08-10T11:59:30.000Z", now)).toBe("30s");
    expect(formatAge("2026-08-10T11:00:00.000Z", now)).toBe("1h");
    expect(formatAge("2026-08-08T12:00:00.000Z", now)).toBe("2d");
  });
});

describe("sessions CLI", () => {
  test("lists and counts over an ingested fixture index", () => {
    const base = cleanCorpus()[0]!;
    const harnessPath = "C:\\Users\\Synthetic\\AppData\\Local\\Temp\\chat-mode-cli";
    const corpus = writeCorpus([
      {
        ...base,
        summaryExtra: {
          session_summary: "CLI Session Title",
          agent_name: "grok-build-plan",
          generated_title: "CLI Session Title",
        },
      },
      {
        id: "ffffffff-aaaa-bbbb-cccc-dddddddddddd",
        cwdEnc: encodeURIComponent(harnessPath),
        cwdDecoded: harnessPath,
        updates: [
          userChunk("h"),
          agentChunk("a"),
          turnCompleted(makeUsage()),
        ],
        summaryExtra: { session_summary: "Harness CLI", agent_name: "smoke" },
      },
    ]);
    const home = join(
      tmpdir(),
      `speculum-sessions-cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(home, { recursive: true });
    const dbPath = join(home, "speculum.sqlite");

    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
      };

      const ingestRun = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingestRun.exitCode).toBe(0);

      const count = Bun.spawnSync(["bun", "run", CLI, "sessions", "--count"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(count.exitCode).toBe(0);
      expect(count.stdout.toString().trim()).toBe("2");

      const list = Bun.spawnSync(
        ["bun", "run", CLI, "sessions", "--json", "--limit", "10"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(list.exitCode).toBe(0);
      const body = JSON.parse(list.stdout.toString()) as {
        rows: Array<{ title: string; cwdClass: string; agentName: string }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(body.total).toBe(2);
      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
      expect(body.rows.length).toBe(2);
      expect(body.rows.some((r) => r.cwdClass === "operator")).toBe(true);
      expect(body.rows.some((r) => r.cwdClass === "harness")).toBe(true);

      const filtered = Bun.spawnSync(
        ["bun", "run", CLI, "sessions", "--class", "operator", "--count"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(filtered.exitCode).toBe(0);
      expect(filtered.stdout.toString().trim()).toBe("1");

      const bad = Bun.spawnSync(
        ["bun", "run", CLI, "sessions", "--class", "bogus"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(bad.exitCode).toBe(64);
      expect(bad.stderr.toString()).toContain("invalid --class");
    } finally {
      corpus.cleanup();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

// parseSessionsArgs uses process.exit(64) — intercept via spawn for bad flags.
// Unit path: process.exit throws under bun test when we stub it.
describe("parseSessionsArgs exit codes", () => {
  test("invalid sort exits 64", () => {
    const original = process.exit.bind(process);
    let code: number | undefined;
    process.exit = ((c?: number) => {
      code = c;
      throw new Error(`exit:${c}`);
    }) as typeof process.exit;
    try {
      expect(() => parseSessionsArgs(["--sort", "nope"])).toThrow("exit:64");
      expect(code).toBe(64);
    } finally {
      process.exit = original;
    }
  });

  test("invalid agent exits 64", () => {
    const original = process.exit.bind(process);
    let code: number | undefined;
    process.exit = ((c?: number) => {
      code = c;
      throw new Error(`exit:${c}`);
    }) as typeof process.exit;
    try {
      expect(() => parseSessionsArgs(["--agent", "bot"])).toThrow("exit:64");
      expect(code).toBe(64);
    } finally {
      process.exit = original;
    }
  });
});
