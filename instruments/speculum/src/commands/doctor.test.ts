/**
 * Doctor report + forget-ledger fixture coverage.
 * Uses scratch instrument home via SPECULUM_* overrides — never a real home.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, SCHEMA_VERSION, type Db } from "../store/db";
import { ingest } from "../ingest";
import { forgetSession, type ForgetAuditRecord } from "../ingest/forget";
import { buildDoctorReport, formatDoctorReportTty } from "./doctor";
import { defaultForgetAuditPath } from "../paths";
import { cleanCorpus, writeCorpus } from "../test/fixtures";

function scratchHome(): { home: string; cleanup: () => void } {
  const home = join(
    tmpdir(),
    `speculum-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(home, { recursive: true });
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("buildDoctorReport", () => {
  test("healthy fixture db: integrity and required checks pass", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const report = buildDoctorReport(db, {
        dbPath: ":memory:",
        nowMs: Date.now(),
      });

      expect(report.ok).toBe(true);
      expect(report.summary.fail).toBe(0);

      const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
      expect(byId.db_queryable?.status).toBe("pass");
      expect(byId.db_integrity?.status).toBe("pass");
      expect(byId.db_integrity?.message).toContain("ok");
      expect(byId.schema_version?.status).toBe("pass");
      expect(byId.schema_version?.message).toContain(String(SCHEMA_VERSION));
      expect(byId.probe_registry?.status).toBe("pass");
      expect(byId.ingest_freshness?.status).toBe("pass");

      const tty = formatDoctorReportTty(report);
      expect(tty).toContain("PASS");
      expect(tty).toContain("speculum doctor");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("broken reads: queryable check fails and report.ok is false", () => {
    const broken = {
      query() {
        throw new Error("disk I/O error");
      },
    } as unknown as Db;

    const report = buildDoctorReport(broken, { dbPath: ":memory:" });
    expect(report.ok).toBe(false);
    expect(report.summary.fail).toBeGreaterThan(0);

    const queryable = report.checks.find((c) => c.id === "db_queryable");
    expect(queryable?.status).toBe("fail");
    expect(queryable?.fatal).toBe(true);
    expect(queryable?.message).toContain("disk I/O error");

    // Downstream checks that also query should fail closed, not throw.
    for (const c of report.checks) {
      expect(["pass", "fail", "warn"]).toContain(c.status);
    }
  });

  test("schema version mismatch is a fatal fail", () => {
    const db = openDb(":memory:");
    try {
      db.run("PRAGMA user_version = 999");
      const report = buildDoctorReport(db, { dbPath: ":memory:" });
      expect(report.ok).toBe(false);
      const schema = report.checks.find((c) => c.id === "schema_version");
      expect(schema?.status).toBe("fail");
      expect(schema?.fatal).toBe(true);
      expect(schema?.message).toContain("999");
    } finally {
      db.close();
    }
  });

  test("empty index warns on ingest freshness without failing", () => {
    const db = openDb(":memory:");
    try {
      const report = buildDoctorReport(db, { dbPath: ":memory:" });
      expect(report.ok).toBe(true);
      const fresh = report.checks.find((c) => c.id === "ingest_freshness");
      expect(fresh?.status).toBe("warn");
      expect(fresh?.fatal).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("forget audit ledger", () => {
  const envKeys = [
    "SPECULUM_HOME",
    "SPECULUM_FORGET_AUDIT_PATH",
    "SPECULUM_DB",
    "SPECULUM_SESSIONS_DIR",
  ] as const;
  const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete saved[k];
    }
  });

  function pinEnv(key: (typeof envKeys)[number], value: string) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  test("forget appends a correctly-shaped JSONL record to sibling ledger", () => {
    const scratch = scratchHome();
    const corpus = writeCorpus(cleanCorpus());
    pinEnv("SPECULUM_HOME", scratch.home);
    pinEnv("SPECULUM_SESSIONS_DIR", corpus.root);

    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const sessionId = cleanCorpus()[0]!.id;
      const beforeEvents =
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM events WHERE session_id = ?",
          )
          .get(sessionId)?.n ?? 0;
      expect(beforeEvents).toBeGreaterThan(0);

      const auditPath = defaultForgetAuditPath();
      expect(auditPath.includes(scratch.home)).toBe(true);
      expect(auditPath.endsWith("forget-audit.jsonl")).toBe(true);
      expect(existsSync(auditPath)).toBe(false);

      const result = forgetSession(db, sessionId.slice(0, 8));
      expect(result.ok).toBe(true);
      expect(result.found).toBe(true);
      expect(result.eventsDeleted).toBe(beforeEvents);

      expect(existsSync(auditPath)).toBe(true);
      const raw = readFileSync(auditPath, "utf-8").trim();
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(1);

      const rec = JSON.parse(lines[0]!) as ForgetAuditRecord;
      expect(rec.action).toBe("forget");
      expect(typeof rec.ts).toBe("string");
      expect(rec.ts.length).toBeGreaterThan(10);
      expect(rec.sessionPrefix).toBe(sessionId.slice(0, 8));
      expect(rec.sessionId).toBe(sessionId);
      expect(rec.found).toBe(true);
      expect(rec.eventsDeleted).toBe(beforeEvents);
      expect(typeof rec.usageDeleted).toBe("number");
      expect(rec.sessionRowsDeleted).toBe(1);
      expect(rec.filesMarkedForgotten).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(rec.sources)).toBe(true);
      expect(rec.sources.length).toBeGreaterThanOrEqual(1);
      expect(typeof rec.sources[0]!.filePath).toBe("string");
      expect(typeof rec.sources[0]!.sizeBytes).toBe("number");
      expect(rec.sources[0]!.sizeBytes).toBeGreaterThan(0);
      expect(typeof rec.sources[0]!.mtime).toBe("string");

      // Identity preserved: rows gone, forgotten flag set.
      const afterEvents =
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM events WHERE session_id = ?",
          )
          .get(sessionId)?.n ?? 0;
      expect(afterEvents).toBe(0);

      // Lens audit sibling must not have been written.
      const lensAudit = join(scratch.home, "lens-audit.jsonl");
      expect(existsSync(lensAudit)).toBe(false);
    } finally {
      db.close();
      corpus.cleanup();
      scratch.cleanup();
    }
  });

  test("explicit auditPath override writes only there", () => {
    const scratch = scratchHome();
    const corpus = writeCorpus(cleanCorpus());
    const auditPath = join(scratch.home, "custom-forget.jsonl");
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const sessionId = cleanCorpus()[0]!.id;
      const result = forgetSession(db, sessionId, { auditPath });
      expect(result.ok).toBe(true);
      expect(existsSync(auditPath)).toBe(true);
      const rec = JSON.parse(readFileSync(auditPath, "utf-8").trim()) as ForgetAuditRecord;
      expect(rec.sessionId).toBe(sessionId);
      expect(rec.action).toBe("forget");
    } finally {
      db.close();
      corpus.cleanup();
      scratch.cleanup();
    }
  });
});
