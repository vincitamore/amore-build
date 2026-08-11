/**
 * CLI wiring for scan --series / --windows and refusal with --policy.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  agentChunk,
  makeUsage,
  turnCompleted,
  updateLine,
  userChunk,
  writeCorpus,
  type FixtureSession,
} from "../test/fixtures";
import { addLocalDays, startOfLocalDay } from "../probes/series";

const CLI = join(import.meta.dir, "..", "cli.ts");

function tempHome(): { home: string; dbPath: string; cleanup: () => void } {
  const home = join(
    tmpdir(),
    `speculum-scan-series-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "speculum.sqlite");
  return {
    home,
    dbPath,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function writeMiniCorpus() {
  const base = startOfLocalDay(new Date(2026, 5, 10));
  const id = "bbbbbbbb-0001-4000-8000-000000000001";
  function ts(dayOffset: number, hour: number): string {
    const d = addLocalDays(base, dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }
  const sessions: FixtureSession[] = [
    {
      id,
      cwdEnc: "enc_series",
      cwdDecoded: "C:\\work\\series",
      updates: [
        updateLine(id, userChunk("this is fucking broken"), ts(0, 10)),
        updateLine(id, agentChunk("sorry"), ts(0, 10)),
        updateLine(id, userChunk("please continue"), ts(1, 10)),
        updateLine(id, turnCompleted(makeUsage()), ts(1, 11)),
      ],
    },
  ];
  return writeCorpus(sessions);
}

describe("scan --series CLI", () => {
  test("scan --series weekly --json emits probe series shape", () => {
    const corpus = writeMiniCorpus();
    const { home, dbPath, cleanup } = tempHome();
    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
      };
      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);

      const scan = Bun.spawnSync(
        [
          "bun",
          "run",
          CLI,
          "scan",
          "--series",
          "weekly",
          "--windows",
          "4",
          "--probe",
          "rage-rate",
          "--json",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(scan.exitCode).toBe(0);
      const body = JSON.parse(scan.stdout.toString()) as Array<{
        probe: string;
        granularity: string;
        windows: Array<{
          since: string;
          until: string;
          value: number;
          ciLow: number;
          ciHigh: number;
          n: number;
          partial: boolean;
        }>;
      }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0]!.probe).toBe("rage-rate");
      expect(body[0]!.granularity).toBe("weekly");
      expect(body[0]!.windows).toHaveLength(4);
      const last = body[0]!.windows[3]!;
      expect(last.partial).toBe(true);
      for (let i = 0; i < 3; i++) {
        expect(body[0]!.windows[i]!.partial).toBe(false);
      }
      for (const w of body[0]!.windows) {
        expect(typeof w.since).toBe("string");
        expect(typeof w.until).toBe("string");
        expect(typeof w.value).toBe("number");
        expect(typeof w.ciLow).toBe("number");
        expect(typeof w.ciHigh).toBe("number");
        expect(typeof w.n).toBe("number");
      }
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("--windows is capped at 52", () => {
    const corpus = writeMiniCorpus();
    const { home, dbPath, cleanup } = tempHome();
    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
      };
      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);

      const scan = Bun.spawnSync(
        [
          "bun",
          "run",
          CLI,
          "scan",
          "--series",
          "daily",
          "--windows",
          "999",
          "--probe",
          "rage-rate",
          "--json",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(scan.exitCode).toBe(0);
      const body = JSON.parse(scan.stdout.toString()) as Array<{
        windows: unknown[];
      }>;
      expect(body[0]!.windows).toHaveLength(52);
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("default --windows is 12", () => {
    const corpus = writeMiniCorpus();
    const { home, dbPath, cleanup } = tempHome();
    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
      };
      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);

      const scan = Bun.spawnSync(
        [
          "bun",
          "run",
          CLI,
          "scan",
          "--series",
          "daily",
          "--probe",
          "rage-rate",
          "--json",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(scan.exitCode).toBe(0);
      const body = JSON.parse(scan.stdout.toString()) as Array<{
        windows: unknown[];
      }>;
      expect(body[0]!.windows).toHaveLength(12);
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("--series with --policy is refused (exit 64)", () => {
    const corpus = writeMiniCorpus();
    const { home, dbPath, cleanup } = tempHome();
    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
      };
      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);

      const scan = Bun.spawnSync(
        [
          "bun",
          "run",
          CLI,
          "scan",
          "--series",
          "weekly",
          "--policy",
          "--json",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(scan.exitCode).toBe(64);
      const err = scan.stderr.toString();
      expect(err).toMatch(/--series.*--policy|--policy.*--series/i);
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("--series with --policy-report is refused (exit 64)", () => {
    const corpus = writeMiniCorpus();
    const { home, dbPath, cleanup } = tempHome();
    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
      };
      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);

      const scan = Bun.spawnSync(
        ["bun", "run", CLI, "scan", "--series", "daily", "--policy-report"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(scan.exitCode).toBe(64);
      expect(scan.stderr.toString()).toMatch(/series/i);
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("invalid --series value exits 64", () => {
    const corpus = writeMiniCorpus();
    const { home, dbPath, cleanup } = tempHome();
    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
      };
      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);

      const scan = Bun.spawnSync(
        ["bun", "run", CLI, "scan", "--series", "monthly", "--json"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(scan.exitCode).toBe(64);
      expect(scan.stderr.toString()).toMatch(/weekly\|daily/);
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });
});
