/**
 * WU-14: event_links + decisions derivation and rebuild.
 * Synthetic fixtures only.
 */

import { describe, expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, getUserVersion } from "../store/db";
import { ingest } from "../ingest";
import {
  agentChunk,
  CWD_DEC,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  makeUsage,
  updateLine,
  userChunk,
  writeCorpus,
} from "../test/fixtures";
import {
  buildEventLinks,
  extractArtifactIds,
  extractDecisions,
  rebuildEventLinksAndDecisions,
  decisionId,
} from "./index";

const SESSION_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

function artifactCorpus() {
  const id = SESSION_ID;
  const t = (n: number) => `2026-07-01T10:00:${String(n).padStart(2, "0")}.000Z`;
  return [
    {
      id,
      cwdEnc: encodeURIComponent("C:\\Users\\Synthetic\\project"),
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(id, userChunk("write then read the file"), t(0)),
        updateLine(id, agentChunk("writing"), t(1)),
        // Generates artifact path via tool_call_id + tool_input path
        updateLine(
          id,
          toolCall("gen1", "write_file", {
            file_path: "src/artifact.ts",
            content: "export const a = 1;",
          }),
          t(2),
        ),
        updateLine(
          id,
          toolCallUpdate("gen1", "write_file", "wrote src/artifact.ts"),
          t(3),
        ),
        // Uses same artifact path
        updateLine(
          id,
          toolCall("use1", "read_file", { target_file: "src/artifact.ts" }),
          t(4),
        ),
        updateLine(
          id,
          toolCallUpdate("use1", "read_file", "export const a = 1;"),
          t(5),
        ),
        // Operator correction → decision
        updateLine(id, userChunk("Nope, you failed to read what I said."), t(6)),
        updateLine(id, agentChunk("correcting"), t(7)),
        updateLine(id, turnCompleted(makeUsage()), t(8)),
      ],
    },
  ];
}

describe("WU-14 links + decisions", () => {
  test("extractArtifactIds pulls path fields from JSON tool_input", () => {
    const ids = extractArtifactIds(
      JSON.stringify({ target_file: "src/foo.ts", offset: 0 }),
    );
    expect(ids.some((a) => a.includes("foo.ts"))).toBe(true);
  });

  test("buildEventLinks: GENERATED via tool_call_id + USED via artifact path", () => {
    const events = [
      {
        id: 1,
        sessionId: "s",
        ts: "2026-01-01T00:00:00.000Z",
        kind: "tool_use",
        text: null,
        toolName: "write_file",
        toolInput: JSON.stringify({ file_path: "src/a.ts" }),
        toolOutput: null,
        toolCallId: "tc-a",
      },
      {
        id: 2,
        sessionId: "s",
        ts: "2026-01-01T00:00:01.000Z",
        kind: "tool_result",
        text: null,
        toolName: "write_file",
        toolInput: null,
        toolOutput: "ok",
        toolCallId: "tc-a",
      },
      {
        id: 3,
        sessionId: "s",
        ts: "2026-01-01T00:00:02.000Z",
        kind: "tool_use",
        text: null,
        toolName: "read_file",
        toolInput: JSON.stringify({ target_file: "src/a.ts" }),
        toolOutput: null,
        toolCallId: "tc-b",
      },
      {
        id: 4,
        sessionId: "s",
        ts: "2026-01-01T00:00:03.000Z",
        kind: "tool_result",
        text: null,
        toolName: "read_file",
        toolInput: null,
        toolOutput: "export {}",
        toolCallId: "tc-b",
      },
    ];
    const links = buildEventLinks(events);
    const generated = links.filter((l) => l.kind === "GENERATED");
    const used = links.filter((l) => l.kind === "USED");
    expect(generated.length).toBe(2);
    expect(generated.every((l) => l.method === "tool_call_id")).toBe(true);
    expect(generated.every((l) => l.heuristic === 0)).toBe(true);
    // use → result for tc-a
    expect(generated.some((l) => l.sourceEventId === 1 && l.targetEventId === 2)).toBe(
      true,
    );
    // USED: generator result (or use) → consumer use
    expect(used.length).toBeGreaterThanOrEqual(1);
    expect(used.some((l) => l.targetEventId === 3 && l.method === "artifact_path")).toBe(
      true,
    );
  });

  test("extractDecisions: operator_correction carries method banner", () => {
    const decisions = extractDecisions([
      {
        id: 10,
        sessionId: "s",
        projectPath: "/p",
        ts: "2026-01-01T00:00:00.000Z",
        kind: "user",
        text: "Nope, you failed to read what I said.",
        toolName: null,
        toolInput: null,
        toolOutput: null,
        toolCallId: null,
        toolError: null,
      },
    ]);
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.category).toBe("operator_correction");
    expect(decisions[0]!.method).toContain("heuristic");
    expect(decisions[0]!.id).toBe(decisionId(10, "operator_correction"));
  });

  test("ingest rebuilds event_links + decisions; GENERATED/USED pair on fixture", () => {
    const corpus = writeCorpus(artifactCorpus());
    const db = openDb(":memory:");
    try {
      expect(getUserVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(4);

      ingest(db, { sessionsDir: corpus.root });

      const gen =
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM event_links WHERE kind = 'GENERATED'`,
          )
          .get()?.n ?? 0;
      const used =
        db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM event_links WHERE kind = 'USED'`,
          )
          .get()?.n ?? 0;
      expect(gen).toBeGreaterThanOrEqual(2);
      expect(used).toBeGreaterThanOrEqual(1);

      const pair = db
        .query<{ kind: string; method: string }, []>(
          `SELECT kind, method FROM event_links WHERE kind IN ('GENERATED','USED')`,
        )
        .all();
      expect(pair.some((r) => r.kind === "GENERATED" && r.method === "tool_call_id")).toBe(
        true,
      );
      expect(pair.some((r) => r.kind === "USED" && r.method === "artifact_path")).toBe(
        true,
      );

      const dec =
        db
          .query<{ n: number; method: string }, []>(
            `SELECT COUNT(*) AS n, method FROM decisions WHERE category = 'operator_correction'`,
          )
          .get();
      expect((dec?.n ?? 0)).toBeGreaterThanOrEqual(1);

      const methods = db
        .query<{ method: string }, []>(`SELECT method FROM decisions`)
        .all();
      expect(methods.every((m) => m.method.length > 0)).toBe(true);

      // Re-derive is idempotent in count shape
      const before =
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event_links").get()?.n ?? 0;
      const stats = rebuildEventLinksAndDecisions(db);
      expect(stats.links).toBe(before);
      expect(stats.eventsScanned).toBeGreaterThan(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("greenfield open creates event_links and decisions tables", () => {
    const db = openDb(":memory:");
    try {
      const tables = db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('event_links', 'decisions')
           ORDER BY name`,
        )
        .all()
        .map((r) => r.name);
      expect(tables).toEqual(["decisions", "event_links"]);
    } finally {
      db.close();
    }
  });
});
