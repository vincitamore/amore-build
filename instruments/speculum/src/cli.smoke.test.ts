import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
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
      expect(statusOut.probes.registered).toBe(11);

      const scan = Bun.spawnSync(["bun", "run", CLI, "scan", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(scan.exitCode).toBe(0);
      const scanOut = JSON.parse(scan.stdout.toString());
      expect(Array.isArray(scanOut)).toBe(true);
      expect(scanOut.length).toBe(11);

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

  test("ingest → lens session-postmortem --dry-run prints scrub, exit 0", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = join(
      tmpdir(),
      `speculum-lens-cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(home, { recursive: true });
    const dbPath = join(home, "speculum.sqlite");
    const auditPath = join(home, "lens-audit.jsonl");

    try {
      const env = {
        ...process.env,
        SPECULUM_HOME: home,
        SPECULUM_DB: dbPath,
        SPECULUM_SESSIONS_DIR: corpus.root,
        SPECULUM_AUDIT_PATH: auditPath,
        SPECULUM_REPORTS_DIR: join(home, "reports"),
        // Point binary at something that would fail if spawned.
        SPECULUM_AMORE_BIN: join(home, "must-not-run-amore.exe"),
      };

      const ingest = Bun.spawnSync(["bun", "run", CLI, "ingest", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ingest.exitCode).toBe(0);

      const dry = Bun.spawnSync(
        ["bun", "run", CLI, "lens", "session-postmortem", "--dry-run", "--json"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(dry.exitCode).toBe(0);
      const dryOut = JSON.parse(dry.stdout.toString());
      expect(dryOut.dryRun).toBe(true);
      expect(dryOut.spawned).toBe(false);
      expect(dryOut.scrub.ok).toBe(true);
      expect(typeof dryOut.scrub.bytes).toBe("number");
      expect(existsSync(auditPath)).toBe(true);

      const lenses = Bun.spawnSync(["bun", "run", CLI, "lenses", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(lenses.exitCode).toBe(0);
      const lensesOut = JSON.parse(lenses.stdout.toString());
      expect(lensesOut.lenses.length).toBe(3);

      const audit = Bun.spawnSync(["bun", "run", CLI, "audit", "-n", "5", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(audit.exitCode).toBe(0);
      const auditOut = JSON.parse(audit.stdout.toString());
      expect(auditOut.records.length).toBeGreaterThan(0);
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
