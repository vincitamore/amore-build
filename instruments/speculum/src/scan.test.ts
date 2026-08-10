/**
 * Scan presentation: --hits / --verbose render HitDetail on human output;
 * --json shape stays complete and stable (hits included).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeTripwireCorpus } from "./test/fixtures";

const CLI = join(import.meta.dir, "cli.ts");

function tempHome(): { home: string; dbPath: string; cleanup: () => void } {
  const home = join(
    tmpdir(),
    `speculum-scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

describe("scan hits presentation", () => {
  test("scan --hits prints hit evidence from tripwire fixture", () => {
    const corpus = writeTripwireCorpus();
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

      const hits = Bun.spawnSync(
        ["bun", "run", CLI, "scan", "--hits", "--probe", "rage-rate"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(hits.exitCode).toBe(0);
      const text = hits.stdout.toString();
      // Human path forced by --hits (even when stdout is a pipe).
      expect(text).toContain("speculum scan");
      expect(text).toContain("rage-rate");
      expect(text).toContain("[heuristic]");
      expect(text).toMatch(/hits \(\d+\):/);
      expect(text).toContain("session=");
      expect(text).toContain("evidence=");
      // Tripwire user message fires strong-language evidence.
      expect(text.toLowerCase()).toMatch(/fuck|bullshit|hell/);
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("scan --verbose is an alias for --hits", () => {
    const corpus = writeTripwireCorpus();
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

      const verbose = Bun.spawnSync(
        ["bun", "run", CLI, "scan", "--verbose", "--probe", "sensitive-content"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(verbose.exitCode).toBe(0);
      const text = verbose.stdout.toString();
      expect(text).toContain("speculum scan");
      expect(text).toContain("sensitive-content");
      expect(text).toMatch(/hits \(\d+\):/);
      expect(text).toContain("session=");
      expect(text).toContain("evidence=");
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("scan --json still carries hits with stable HitDetail shape", () => {
    const corpus = writeTripwireCorpus();
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
        ["bun", "run", CLI, "scan", "--json", "--probe", "rage-rate"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(scan.exitCode).toBe(0);
      const results = JSON.parse(scan.stdout.toString()) as Array<{
        probe: string;
        heuristic: true;
        hits?: Array<{
          sessionId: string;
          ts?: string;
          evidence: string;
          category?: string;
        }>;
      }>;
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      const r = results[0]!;
      expect(r.probe).toBe("rage-rate");
      expect(r.heuristic).toBe(true);
      expect(Array.isArray(r.hits)).toBe(true);
      expect(r.hits!.length).toBeGreaterThan(0);
      for (const h of r.hits!) {
        expect(typeof h.sessionId).toBe("string");
        expect(h.sessionId.length).toBeGreaterThan(0);
        expect(typeof h.evidence).toBe("string");
        if (h.ts !== undefined) expect(typeof h.ts).toBe("string");
        if (h.category !== undefined) expect(typeof h.category).toBe("string");
      }
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });

  test("scan without --hits does not print hits block on human path", () => {
    const corpus = writeTripwireCorpus();
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

      // Piped stdout without --hits keeps auto-JSON (existing pipe convenience).
      const plain = Bun.spawnSync(
        ["bun", "run", CLI, "scan", "--probe", "rage-rate"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(plain.exitCode).toBe(0);
      const out = plain.stdout.toString();
      expect(out.trimStart().startsWith("[") || out.trimStart().startsWith("{")).toBe(
        true,
      );
      const parsed = JSON.parse(out);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].probe).toBe("rage-rate");
      // JSON still includes hits; human "hits (N):" block is absent.
      expect(out).not.toContain("hits (");
      expect(Array.isArray(parsed[0].hits)).toBe(true);
    } finally {
      corpus.cleanup();
      cleanup();
    }
  });
});
