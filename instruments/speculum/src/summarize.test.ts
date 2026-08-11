import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { spawn as SpawnFn } from "node:child_process";
import { openDb } from "./store/db";
import { ingest } from "./ingest";
import {
  writeCorpus,
  cleanCorpus,
  CWD_DEC,
  userChunk,
  agentChunk,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  makeUsage,
  hookExecution,
  type FixtureSession,
} from "./test/fixtures";
import {
  buildDigestFromEvents,
  buildSessionDigest,
  DIGEST_CAP_BYTES,
  parseTitleReply,
  applyGeneratedTitle,
  getGeneratedTitle,
  selectSessionsForSummarize,
  runSummarize,
  toJsonReport,
  type DigestEvent,
} from "./summarize";
import { readAuditTail } from "./audit";
import { scrubPayload } from "./scrub";
import { renderSummarizePrompt } from "./summarize/prompt";

function tempHome(): string {
  const home = join(
    tmpdir(),
    `speculum-summarize-home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(home, { recursive: true });
  return home;
}

function cleanupHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function setCwdClass(db: ReturnType<typeof openDb>, sessionId: string, cls: string): void {
  db.prepare(`UPDATE sessions SET cwd_class = ? WHERE id = ?`).run(cls, sessionId);
}

function fakeSpawnText(text: string): typeof SpawnFn {
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
    fakeChild.pid = 222;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = () => true;
    queueMicrotask(() => {
      fakeChild.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            text,
            stopReason: "end_turn",
            modelUsage: {
              "stub/title-model": {
                input_tokens: 50,
                output_tokens: 20,
                total_tokens: 70,
              },
            },
            usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
          }),
        ),
      );
      fakeChild.emit("close", 0);
    });
    return fakeChild as unknown as ReturnType<typeof SpawnFn>;
  }) as unknown as typeof SpawnFn;
}

function multiTurnCorpus(id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"): FixtureSession[] {
  const updates: unknown[] = [
    hookExecution(),
    userChunk(
      "Please implement a compact session digest builder that selects the first user message and later tool names only.",
    ),
    agentChunk("I'll design a pure digest builder with a hard byte cap."),
    toolCall("t1", "read_file", { target_file: "src/summarize/digest.ts" }),
    toolCallUpdate("t1", "read_file", "export function buildDigest..."),
    agentChunk("Digest builder skeleton is in place. Adding selection next."),
    toolCall("t2", "run_terminal_command", {
      command: "bun test src/summarize.test.ts",
      description: "run tests",
    }),
    toolCallUpdate("t2", "run_terminal_command", "pass"),
    agentChunk("Tests are green for the digest path."),
    userChunk("Also wire apply into generated_titles please."),
    agentChunk(
      "Applied: upsert generated_titles and update sessions.title with title_source generated.",
    ),
    turnCompleted(makeUsage("grok-4", { inputTokens: 800, outputTokens: 200 })),
  ];
  // Pad mid turns for salience sampling.
  for (let i = 0; i < 12; i++) {
    updates.splice(
      6 + i * 2,
      0,
      agentChunk(`Intermediate progress note number ${i} about the digest module.`),
      toolCall(`pad${i}`, "grep", { pattern: `digest-${i}`, path: "src" }),
    );
  }
  return [
    {
      id,
      cwdEnc: encodeURIComponent(CWD_DEC),
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates,
    },
  ];
}

describe("digest builder", () => {
  test("selects first user, tool names only, final assistant; deterministic", () => {
    const events: DigestEvent[] = [
      {
        id: 1,
        kind: "user",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Build the summarize command",
        toolName: null,
        isBoilerplate: false,
      },
      {
        id: 2,
        kind: "assistant",
        ts: "2026-01-01T00:01:00.000Z",
        text: "Starting with digest builder",
        toolName: null,
        isBoilerplate: false,
      },
      {
        id: 3,
        kind: "tool_use",
        ts: "2026-01-01T00:02:00.000Z",
        text: null,
        toolName: "read_file",
        isBoilerplate: false,
      },
      {
        id: 4,
        kind: "tool_use",
        ts: "2026-01-01T00:03:00.000Z",
        text: null,
        toolName: "search_replace",
        isBoilerplate: false,
      },
      {
        id: 5,
        kind: "assistant",
        ts: "2026-01-01T00:04:00.000Z",
        text: "Done implementing summarize apply path",
        toolName: null,
        isBoilerplate: false,
      },
    ];

    const a = buildDigestFromEvents("sess-1", "/proj", events);
    const b = buildDigestFromEvents("sess-1", "/proj", events);

    expect(a.text).toBe(b.text);
    expect(a.hash).toBe(b.hash);
    expect(a.hasContent).toBe(true);
    expect(a.text).toContain("[USER first]");
    expect(a.text).toContain("Build the summarize command");
    expect(a.text).toContain("tool: read_file");
    expect(a.text).toContain("tool: search_replace");
    // Never embed tool payloads / raw input objects.
    expect(a.text).not.toContain("target_file");
    expect(a.text).not.toContain("rawInput");
    expect(a.text).toContain("[FINAL ASSISTANT]");
    expect(a.text).toContain("Done implementing summarize apply path");
    expect(a.sourceEvents).toBeGreaterThanOrEqual(3);
    expect(a.bytes).toBeLessThanOrEqual(DIGEST_CAP_BYTES);
  });

  test("skips boilerplate user as first message", () => {
    const events: DigestEvent[] = [
      {
        id: 1,
        kind: "user",
        ts: "2026-01-01T00:00:00.000Z",
        text: "SessionStart hook noise",
        toolName: null,
        isBoilerplate: true,
      },
      {
        id: 2,
        kind: "user",
        ts: "2026-01-01T00:01:00.000Z",
        text: "Real task: fix the export CSV path",
        toolName: null,
        isBoilerplate: false,
      },
      {
        id: 3,
        kind: "assistant",
        ts: "2026-01-01T00:02:00.000Z",
        text: "Fixed export path handling",
        toolName: null,
        isBoilerplate: false,
      },
    ];
    const d = buildDigestFromEvents("s", "p", events);
    expect(d.text).toContain("Real task: fix the export CSV path");
    expect(d.text).not.toContain("SessionStart hook noise");
  });

  test("enforces hard byte cap", () => {
    const long = "x".repeat(5000);
    const events: DigestEvent[] = [
      {
        id: 1,
        kind: "user",
        ts: "2026-01-01T00:00:00.000Z",
        text: long,
        toolName: null,
        isBoilerplate: false,
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: i + 2,
        kind: "assistant" as const,
        ts: `2026-01-01T00:${String(i + 1).padStart(2, "0")}:00.000Z`,
        text: `assistant blob ${i} ${long}`,
        toolName: null,
        isBoilerplate: false,
      })),
    ];
    const d = buildDigestFromEvents("s", "p", events, 2048);
    expect(d.bytes).toBeLessThanOrEqual(2048 + 16); // small allowance for ellipsis trailer
  });

  test("buildSessionDigest from ingested fixture", () => {
    const corpus = writeCorpus(multiTurnCorpus());
    const home = tempHome();
    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      const d = buildSessionDigest(db, id);
      db.close();
      expect(d.hasContent).toBe(true);
      expect(d.text).toContain("compact session digest");
      expect(d.text).toMatch(/tool: /);
      expect(d.bytes).toBeLessThanOrEqual(DIGEST_CAP_BYTES);
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });
});

describe("parseTitleReply", () => {
  test("accepts strict JSON", () => {
    const r = parseTitleReply(
      JSON.stringify({
        title: "Implement session digest builder",
        summary: "Built a compact digest. Applied titles to the index.",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Implement session digest builder");
      expect(r.value.summary).toContain("compact digest");
    }
  });

  test("rejects malformed and empty title", () => {
    expect(parseTitleReply("not json at all").ok).toBe(false);
    expect(parseTitleReply(JSON.stringify({ summary: "only summary" })).ok).toBe(false);
    expect(parseTitleReply(JSON.stringify({ title: "   ", summary: "x" })).ok).toBe(false);
    expect(parseTitleReply(JSON.stringify({ title: 42 })).ok).toBe(false);
  });

  test("strips fences, quotes, emoji; caps title length", () => {
    const long = "A".repeat(80);
    const r = parseTitleReply(
      "```json\n" +
        JSON.stringify({ title: `"🚀 ${long}"`, summary: "ok" }) +
        "\n```",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title.length).toBeLessThanOrEqual(60);
      expect(r.value.title).not.toContain("🚀");
      expect(r.value.title).not.toContain('"');
    }
  });
});

describe("applyGeneratedTitle + title precedence", () => {
  test("upserts generated_titles and updates sessions row", () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

      const applied = applyGeneratedTitle(db, {
        sessionId: id,
        title: "List src directory contents",
        summary: "Listed and summarized the entrypoint.",
        modelId: "stub/model",
        sourceEvents: 4,
      });
      expect(applied.title).toBe("List src directory contents");

      const gt = getGeneratedTitle(db, id);
      expect(gt?.title).toBe("List src directory contents");
      expect(gt?.modelId).toBe("stub/model");
      expect(gt?.sourceEvents).toBe(4);

      const sess = db
        .query<{ title: string; title_source: string }, [string]>(
          `SELECT title, title_source FROM sessions WHERE id = ?`,
        )
        .get(id);
      expect(sess?.title).toBe("List src directory contents");
      expect(sess?.title_source).toBe("generated");

      // Re-apply overwrites.
      applyGeneratedTitle(db, {
        sessionId: id,
        title: "Revised title",
        summary: "Updated.",
        modelId: "stub/model-2",
        sourceEvents: 5,
      });
      expect(getGeneratedTitle(db, id)?.title).toBe("Revised title");
      expect(
        db
          .query<{ title: string }, [string]>(`SELECT title FROM sessions WHERE id = ?`)
          .get(id)?.title,
      ).toBe("Revised title");

      db.close();
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("rebuildSessions prefers generated_titles over session_titles", () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

      // Seed a summary-side title (lower precedence).
      db.prepare(
        `INSERT INTO session_titles (session_id, title) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET title = excluded.title`,
      ).run(id, "Summary-derived title");

      applyGeneratedTitle(db, {
        sessionId: id,
        title: "Generated wins",
        summary: "model",
        modelId: "m",
        sourceEvents: 2,
      });

      // Force rebuild path by re-ingesting (rebuildSessions joins generated_titles).
      ingest(db, { sessionsDir: corpus.root });

      const sess = db
        .query<{ title: string; title_source: string }, [string]>(
          `SELECT title, title_source FROM sessions WHERE id = ?`,
        )
        .get(id);
      // generated_titles is NOT wiped on ingest; should still win.
      expect(sess?.title).toBe("Generated wins");
      expect(sess?.title_source).toBe("generated");
      expect(getGeneratedTitle(db, id)?.title).toBe("Generated wins");

      db.close();
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });
});

describe("selection + dry-run plan", () => {
  test("default selects title_source='' and cwd_class=operator only", () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

      // Fixture project_path classifies as operator at ingest; untitled → selected.
      expect(selectSessionsForSummarize(db, {}).map((s) => s.id)).toEqual([id]);

      // Experiment class excluded.
      setCwdClass(db, id, "experiment");
      expect(selectSessionsForSummarize(db, {}).length).toBe(0);

      // Empty class also excluded under the operator filter.
      setCwdClass(db, id, "");
      expect(selectSessionsForSummarize(db, {}).length).toBe(0);
      expect(selectSessionsForSummarize(db, { ignoreCwdClass: true }).length).toBe(1);

      setCwdClass(db, id, "operator");
      applyGeneratedTitle(db, {
        sessionId: id,
        title: "Already titled",
        summary: "x",
        modelId: "m",
        sourceEvents: 1,
      });
      // title_source=generated → excluded without --force.
      expect(selectSessionsForSummarize(db, {}).length).toBe(0);
      expect(selectSessionsForSummarize(db, { force: true }).length).toBe(1);

      // --session targets regardless of filters.
      expect(selectSessionsForSummarize(db, { sessionId: id }).length).toBe(1);

      db.close();
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("dry-run never spawns; audits plan; json shape", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const auditPath = join(home, "lens-audit.jsonl");
    let spawnCalls = 0;
    const spawnImpl = ((..._args: unknown[]) => {
      spawnCalls++;
      throw new Error("spawn must not be called on dry-run");
    }) as unknown as typeof SpawnFn;

    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      setCwdClass(db, id, "operator");

      const report = await runSummarize(db, {
        dryRun: true,
        auditPath,
        spawnImpl,
        scrubHomeDir: "C:\\Users\\Synthetic",
      });
      db.close();

      expect(spawnCalls).toBe(0);
      expect(report.dry_run).toBe(true);
      expect(report.attempted).toBe(1);
      expect(report.generated).toBe(0);
      expect(report.results[0]!.outcome).toBe("dry-run");
      expect(report.results[0]!.digestBytes).toBeGreaterThan(0);
      expect(report.results[0]!.estimatedTokens).toBeGreaterThan(0);

      const json = toJsonReport(report);
      expect(json.attempted).toBe(1);
      expect(json.generated).toBe(0);
      expect(json.refused_scrub).toBe(0);
      expect(json.failed_parse).toBe(0);
      expect(json.results[0]).toEqual({
        sessionId: id,
        outcome: "dry-run",
      });

      const tail = readAuditTail(auditPath, 5);
      expect(tail.length).toBe(1);
      expect(tail[0]!.lens).toBe("summarize");
      expect(tail[0]!.decision).toBe("dry-run");
      expect(tail[0]!.selection.sessionId).toBe(id);
      expect(tail[0]!.reason).toMatch(/digest=/);
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });
});

describe("scrub refusal + parse failure + apply path (stubbed spawn)", () => {
  test("scrub hit refuses session without spawn", async () => {
    // Craft a digest that retains residual secret shape after redaction attempts
    // by forcing a tiny maxBytes so scrub fails closed on size.
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const auditPath = join(home, "audit.jsonl");
    let spawnCalls = 0;
    const spawnImpl = ((..._args: unknown[]) => {
      spawnCalls++;
      throw new Error("must not spawn on scrub refuse");
    }) as unknown as typeof SpawnFn;

    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      setCwdClass(db, id, "operator");

      const report = await runSummarize(db, {
        dryRun: false,
        auditPath,
        spawnImpl,
        maxBytes: 32,
        scrubHomeDir: "C:\\Users\\Synthetic",
      });

      expect(spawnCalls).toBe(0);
      expect(report.refused_scrub).toBe(1);
      expect(report.results[0]!.outcome).toBe("refused_scrub");
      expect(getGeneratedTitle(db, id)).toBeNull();
      db.close();

      const tail = readAuditTail(auditPath, 3);
      expect(tail[0]!.decision).toBe("refused");
      expect(tail[0]!.lens).toBe("summarize");
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("malformed model reply does not write title", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const auditPath = join(home, "audit.jsonl");

    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      setCwdClass(db, id, "operator");

      const report = await runSummarize(db, {
        auditPath,
        spawnImpl: fakeSpawnText("sorry I cannot produce JSON today"),
        amoreBin: "stub-amore",
        scrubHomeDir: "C:\\Users\\Synthetic",
      });

      expect(report.failed_parse).toBe(1);
      expect(report.generated).toBe(0);
      expect(getGeneratedTitle(db, id)).toBeNull();
      const sess = db
        .query<{ title_source: string }, [string]>(
          `SELECT title_source FROM sessions WHERE id = ?`,
        )
        .get(id);
      expect(sess?.title_source).toBe("");

      const tail = readAuditTail(auditPath, 3);
      expect(tail.some((r) => r.decision === "refused" && /parse failed/i.test(r.reason ?? ""))).toBe(
        true,
      );
      db.close();
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });

  test("successful stubbed spawn applies title + audit accepted", async () => {
    const corpus = writeCorpus(cleanCorpus());
    const home = tempHome();
    const auditPath = join(home, "audit.jsonl");
    const reply = JSON.stringify({
      title: "List and summarize src entrypoint",
      summary: "Listed src and summarized the entry module.",
    });

    try {
      const db = openDb(join(home, "db.sqlite"));
      ingest(db, { sessionsDir: corpus.root });
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      setCwdClass(db, id, "operator");

      const report = await runSummarize(db, {
        auditPath,
        spawnImpl: fakeSpawnText(reply),
        amoreBin: "stub-amore",
        scrubHomeDir: "C:\\Users\\Synthetic",
      });

      expect(report.generated).toBe(1);
      expect(report.results[0]!.title).toBe("List and summarize src entrypoint");
      expect(getGeneratedTitle(db, id)?.title).toBe("List and summarize src entrypoint");
      const sess = db
        .query<{ title: string; title_source: string }, [string]>(
          `SELECT title, title_source FROM sessions WHERE id = ?`,
        )
        .get(id);
      expect(sess?.title).toBe("List and summarize src entrypoint");
      expect(sess?.title_source).toBe("generated");

      const tail = readAuditTail(auditPath, 3);
      expect(tail[0]!.decision).toBe("accepted");
      expect(tail[0]!.lens).toBe("summarize");
      expect(tail[0]!.modelId).toBe("stub/title-model");
      db.close();
    } finally {
      corpus.cleanup();
      cleanupHome(home);
    }
  });
});

describe("scrub on rendered prompt (fail-closed unit)", () => {
  test("prompt with secret residual refuses via scrubPayload", () => {
    // Use a synthetic digest containing a live-looking secret; scrub should
    // redact it to placeholders and still ok when fully redacted.
    const digest =
      "SESSION s\nPROJECT p\n\n[USER first]\nmy key is sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789abcd\n";
    const prompt = renderSummarizePrompt(digest);
    const report = scrubPayload(prompt, { homeDir: "C:\\Users\\Synthetic" });
    // Redaction should succeed (ok) with secret counts — failure only on residual.
    if (report.ok) {
      expect(report.text).toContain("REDACTED");
      expect(report.counts.secret).toBeGreaterThan(0);
    } else {
      // Fail-closed residual is also acceptable for this shape.
      expect(report.refuseReason).toBeTruthy();
    }
  });
});
