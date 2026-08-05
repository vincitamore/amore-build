import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeCorpus, cleanCorpus } from "./test/fixtures";

const CLI = join(import.meta.dir, "cli.ts");

describe("CLI smoke", () => {
  test("ingest fixture → status/scan/usage exit 0", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = join(
      tmpdir(),
      `speculum-home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);
      const ingestOut = JSON.parse(ingest.stdout.toString());
      expect(ingestOut.sessionDirsIngested).toBe(1);
      expect(ingestOut.eventsAppended).toBeGreaterThan(0);

      const status = Bun.spawnSync(["bun", "run", CLI, "status", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(status.exitCode).toBe(0);
      const statusOut = JSON.parse(status.stdout.toString());
      expect(statusOut.counts.sessions).toBe(1);
      expect(statusOut.probes.registered).toBe(8);

      const scan = Bun.spawnSync(["bun", "run", CLI, "scan", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(scan.exitCode).toBe(0);
      const scanOut = JSON.parse(scan.stdout.toString());
      expect(Array.isArray(scanOut)).toBe(true);
      expect(scanOut.length).toBe(8);

      const usage = Bun.spawnSync(["bun", "run", CLI, "usage", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(usage.exitCode).toBe(0);
      const usageOut = JSON.parse(usage.stdout.toString());
      expect(usageOut.totals.tokens.input).toBe(500);
      expect(usageOut.totals.tokens.output).toBe(100);
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
