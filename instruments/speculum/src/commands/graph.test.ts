/**
 * graph + decisions CLI shells over fixture index.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../store/db";
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
import { buildGraph, shortestPath } from "./graph";
import { listDecisions, chainUpstream, decisionSummary } from "../decisions";
import { nodeIdForEvent } from "../graph";

const CLI = join(import.meta.dir, "../cli.ts");
const SESSION_ID = "cccccccc-dddd-eeee-ffff-000000000001";

function fixtureCorpus() {
  const id = SESSION_ID;
  const t = (n: number) => `2026-07-02T12:00:${String(n).padStart(2, "0")}.000Z`;
  return [
    {
      id,
      cwdEnc: encodeURIComponent("C:\\Users\\Synthetic\\project"),
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(id, userChunk("list then read"), t(0)),
        updateLine(id, agentChunk("ok"), t(1)),
        updateLine(
          id,
          toolCall("g1", "write_file", { file_path: "notes.md", content: "hi" }),
          t(2),
        ),
        updateLine(id, toolCallUpdate("g1", "write_file", "wrote notes.md"), t(3)),
        updateLine(id, toolCall("g2", "read_file", { target_file: "notes.md" }), t(4)),
        updateLine(id, toolCallUpdate("g2", "read_file", "hi"), t(5)),
        updateLine(id, userChunk("Nope, that is wrong."), t(6)),
        updateLine(id, agentChunk("fixing"), t(7)),
        updateLine(id, turnCompleted(makeUsage()), t(8)),
      ],
    },
  ];
}

describe("graph + decisions CLI", () => {
  test("buildGraph + shortestPath over ingested fixture", () => {
    const corpus = writeCorpus(fixtureCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const g = buildGraph(db, { limit: 20, json: false, sessionId: SESSION_ID });
      expect(g.nodes.length).toBeGreaterThanOrEqual(6);
      expect(g.edges.length).toBeGreaterThan(0);

      const first = g.nodes[0]!.eventId;
      const last = g.nodes[g.nodes.length - 1]!.eventId;
      const path = shortestPath(g, first, last);
      expect(path).not.toBeNull();
      expect(path![0]).toBe(nodeIdForEvent(first));
      expect(path![path!.length - 1]).toBe(nodeIdForEvent(last));
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("decisions table populated; chain walk from decision source", () => {
    const corpus = writeCorpus(fixtureCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const rows = listDecisions(db, { sessionId: SESSION_ID });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.method.length > 0)).toBe(true);

      const summary = decisionSummary(db);
      expect(summary.total).toBeGreaterThanOrEqual(1);

      const seed = rows[0]!.sourceEventId;
      expect(seed).not.toBeNull();
      const chain = chainUpstream(db, seed!, 6);
      expect(chain[0]!.eventId).toBe(seed!);
      expect(chain.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("CLI graph + decisions produce output on fixture index", () => {
    const corpus = writeCorpus(fixtureCorpus());
    const home = join(
      tmpdir(),
      `speculum-wu14-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

      const graph = Bun.spawnSync(
        ["bun", "run", CLI, "graph", "summary", "--json", "--session", SESSION_ID],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(graph.exitCode).toBe(0);
      const graphOut = JSON.parse(graph.stdout.toString());
      expect(graphOut.nodes).toBeGreaterThan(0);
      expect(graphOut.edges).toBeGreaterThan(0);

      const dec = Bun.spawnSync(
        ["bun", "run", CLI, "decisions", "list", "--json", "--session", SESSION_ID],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      expect(dec.exitCode).toBe(0);
      const decOut = JSON.parse(dec.stdout.toString());
      expect(Array.isArray(decOut.decisions)).toBe(true);
      expect(decOut.decisions.length).toBeGreaterThanOrEqual(1);
      expect(decOut.decisions[0].method).toBeTruthy();
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
