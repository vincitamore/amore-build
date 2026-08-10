import { describe, expect, test } from "bun:test";
import { openDb } from "./store/db";
import { ingest } from "./ingest";
import { forgetSession } from "./ingest/forget";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  makeUsage,
  toolCall,
  turnCompleted,
  updateLine,
  userChunk,
  writeCorpus,
  writeTripwireCorpus,
} from "./test/fixtures";
import { join } from "node:path";
import { appendFileSync, statSync, utimesSync } from "node:fs";

describe("ingest", () => {
  test("indexes synthetic clean corpus", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      const stats = ingest(db, { sessionsDir: corpus.root });
      expect(stats.sessionDirsIngested).toBe(1);
      expect(stats.eventsAppended).toBeGreaterThan(0);
      expect(stats.usageRowsAppended).toBe(1);

      const sessions =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n ?? 0;
      expect(sessions).toBe(1);

      const users =
        db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'user'")
          .get()?.n ?? 0;
      expect(users).toBe(1);

      const tools =
        db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'tool_use'")
          .get()?.n ?? 0;
      expect(tools).toBe(2);

      const proj =
        db.query<{ project_path: string }, []>("SELECT project_path FROM sessions LIMIT 1").get()
          ?.project_path;
      expect(proj).toBe(CWD_DEC);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("subagent linkage from meta.json", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const child = db
        .query<{ agent: string; parent_session: string | null }, [string]>(
          "SELECT agent, parent_session FROM sessions WHERE id = ?",
        )
        .get("66666666-7777-8888-9999-aaaaaaaaaaaa");
      expect(child?.agent).toBe("subagent");
      expect(child?.parent_session).toBe("11111111-2222-3333-4444-555555555555");
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("incremental cursor skips unchanged files", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      const first = ingest(db, { sessionsDir: corpus.root });
      expect(first.sessionDirsIngested).toBe(1);
      const second = ingest(db, { sessionsDir: corpus.root });
      expect(second.sessionDirsSkippedUnchanged).toBe(1);
      expect(second.eventsAppended).toBe(0);

      const count1 =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;

      // Grow the file so cursor resumes.
      const session = cleanCorpus()[0]!;
      const updatesPath = join(corpus.root, session.cwdEnc, session.id, "updates.jsonl");
      appendFileSync(
        updatesPath,
        updateLine(session.id, userChunk("one more question"), new Date().toISOString()) + "\n",
      );
      // Ensure mtime changes on filesystems with coarse resolution.
      const st = statSync(updatesPath);
      utimesSync(updatesPath, st.atime, new Date(st.mtimeMs + 2000));

      const third = ingest(db, { sessionsDir: corpus.root });
      expect(third.eventsAppended).toBeGreaterThanOrEqual(1);
      const count2 =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
      expect(count2).toBeGreaterThan(count1);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("dry-run writes nothing", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      const stats = ingest(db, { sessionsDir: corpus.root, dryRun: true });
      expect(stats.dryRun).toBe(true);
      expect(stats.eventsAppended).toBeGreaterThan(0);
      const n =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
      expect(n).toBe(0);
      const tracked =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_state").get()?.n ?? 0;
      expect(tracked).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("forget deletes everything for a session", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const id = "11111111-2222-3333-4444-555555555555";
      const before =
        db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
          .get(id)?.n ?? 0;
      expect(before).toBeGreaterThan(0);

      // skipAudit: purge-identity test must not write the operator home ledger.
      const result = forgetSession(db, "11111111", { skipAudit: true });
      expect(result.ok).toBe(true);
      expect(result.eventsDeleted).toBe(before);

      const afterEvents =
        db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
          .get(id)?.n ?? 0;
      const afterUsage =
        db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage WHERE session_id = ?")
          .get(id)?.n ?? 0;
      const afterSession =
        db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sessions WHERE id = ?")
          .get(id)?.n ?? 0;
      expect(afterEvents).toBe(0);
      expect(afterUsage).toBe(0);
      expect(afterSession).toBe(0);

      // Re-ingest should skip forgotten.
      const again = ingest(db, { sessionsDir: corpus.root });
      expect(again.sessionDirsSkippedForgotten).toBeGreaterThanOrEqual(1);
      const resurrected =
        db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
          .get(id)?.n ?? 0;
      expect(resurrected).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  // WU-04
  test("stage timings and onProgress are additive observability", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      const phases: string[] = [];
      const progress: Array<{ phase: string; sessionsDone: number; sessionsTotal: number; pct: number }> =
        [];
      const stats = ingest(db, {
        sessionsDir: corpus.root,
        onProgress: (p) => {
          phases.push(p.phase);
          progress.push({
            phase: p.phase,
            sessionsDone: p.sessionsDone,
            sessionsTotal: p.sessionsTotal,
            pct: p.pct,
          });
        },
      });

      expect(stats.listMs).toBeGreaterThanOrEqual(0);
      expect(stats.parseMs).toBeGreaterThanOrEqual(0);
      expect(stats.writeMs).toBeGreaterThanOrEqual(0);
      expect(stats.rebuildMs).toBeGreaterThanOrEqual(0);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
      // Real fixture work should land at least list + parse ticks (or 0 on clock grain).
      expect(stats.listMs + stats.parseMs + stats.writeMs + stats.rebuildMs).toBeGreaterThanOrEqual(0);
      expect(stats.sessionDirsIngested).toBe(1);
      expect(stats.linesSkipped).toBeGreaterThanOrEqual(0);

      expect(phases[0]).toBe("list");
      expect(phases).toContain("session");
      expect(phases).toContain("rebuild");
      expect(phases[phases.length - 1]).toBe("done");
      const done = progress[progress.length - 1]!;
      expect(done.pct).toBe(100);
      expect(done.sessionsTotal).toBe(1);
      expect(done.sessionsDone).toBe(1);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  // WU-04: derived-index honesty — onProgress must not change written rows
  test("onProgress does not change event/usage rows vs baseline ingest", () => {
    const corpus = writeCorpus(cleanCorpus());
    const dbA = openDb(":memory:");
    const dbB = openDb(":memory:");
    try {
      const baseline = ingest(dbA, { sessionsDir: corpus.root });
      const withProgress = ingest(dbB, {
        sessionsDir: corpus.root,
        onProgress: () => {
          /* no-op observer */
        },
      });

      expect(withProgress.sessionDirsIngested).toBe(baseline.sessionDirsIngested);
      expect(withProgress.eventsAppended).toBe(baseline.eventsAppended);
      expect(withProgress.usageRowsAppended).toBe(baseline.usageRowsAppended);
      expect(withProgress.linesSeen).toBe(baseline.linesSeen);
      expect(withProgress.linesParsed).toBe(baseline.linesParsed);
      expect(withProgress.linesSkipped).toBe(baseline.linesSkipped);

      type EventRow = {
        session_id: string;
        kind: string;
        text: string | null;
        tool_name: string | null;
        tool_call_id: string | null;
        is_boilerplate: number;
        raw: string;
      };
      const eventSql =
        "SELECT session_id, kind, text, tool_name, tool_call_id, is_boilerplate, raw FROM events ORDER BY session_id, ts, id";
      const usageSql =
        "SELECT session_id, model_id, input_tokens, output_tokens, total_tokens, raw FROM usage ORDER BY session_id, ts, id";

      const eventsA = dbA.query<EventRow, []>(eventSql).all();
      const eventsB = dbB.query<EventRow, []>(eventSql).all();
      expect(JSON.stringify(eventsB)).toBe(JSON.stringify(eventsA));

      const usageA = dbA.query<Record<string, unknown>, []>(usageSql).all();
      const usageB = dbB.query<Record<string, unknown>, []>(usageSql).all();
      expect(JSON.stringify(usageB)).toBe(JSON.stringify(usageA));
    } finally {
      dbA.close();
      dbB.close();
      corpus.cleanup();
    }
  });

  // WU-04
  test("dry-run stage timings have zero write/rebuild and still report linesSkipped", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      const stats = ingest(db, { sessionsDir: corpus.root, dryRun: true });
      expect(stats.dryRun).toBe(true);
      expect(stats.writeMs).toBe(0);
      expect(stats.rebuildMs).toBe(0);
      expect(stats.parseMs).toBeGreaterThanOrEqual(0);
      expect(stats.listMs).toBeGreaterThanOrEqual(0);
      expect(stats.linesSkipped).toBeGreaterThanOrEqual(0);
      expect(stats.eventsAppended).toBeGreaterThan(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
