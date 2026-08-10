/**
 * Graph projection + degree + state-at-T coverage .
 * Synthetic fixtures only — never a live sessions tree.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../store/db";
import { ingest } from "../ingest";
import {
  agentChunk,
  cleanCorpus,
  CWD_DEC,
  toolCall,
  toolCallUpdate,
  turnCompleted,
  makeUsage,
  updateLine,
  userChunk,
  writeCorpus,
} from "../test/fixtures";
import { projectGraph, nodeIdForEvent } from "./project";
import { degreeCentrality } from "./degree";
import {
  eventsAtOrBefore,
  eventsInToolSpan,
  toolSpans,
} from "../store/queries";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Fixed-timestamp corpus so at-T windowing is deterministic. */
function timedCorpus() {
  const id = SESSION_ID;
  const t = (n: number) => `2026-06-01T12:00:${String(n).padStart(2, "0")}.000Z`;
  return [
    {
      id,
      cwdEnc: encodeURIComponent("C:\\Users\\Synthetic\\project"),
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        updateLine(id, userChunk("list files"), t(0)),
        updateLine(id, agentChunk("listing"), t(1)),
        updateLine(id, toolCall("tc1", "list_dir", { target_directory: "src" }), t(2)),
        updateLine(id, toolCallUpdate("tc1", "list_dir", "a.ts\nb.ts"), t(3)),
        updateLine(id, toolCall("tc2", "read_file", { target_file: "a.ts" }), t(4)),
        updateLine(id, toolCallUpdate("tc2", "read_file", "export {}"), t(5)),
        updateLine(id, agentChunk("done"), t(6)),
        updateLine(id, turnCompleted(makeUsage()), t(7)),
      ],
    },
  ];
}

describe("graph project + degree + state-at-T", () => {
  test("projectGraph builds nodes and succession + tool_link edges", () => {
    const corpus = writeCorpus(timedCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const g = projectGraph(db, { sessionIds: [SESSION_ID] });
      expect(g.nodes.length).toBeGreaterThanOrEqual(6);
      expect(g.edges.length).toBeGreaterThan(0);

      const succession = g.edges.filter((e) => e.type === "succession");
      const toolLinks = g.edges.filter((e) => e.type === "tool_link");
      // n events → n-1 succession edges within one session
      expect(succession.length).toBe(g.nodes.length - 1);
      // two completed tool calls → two tool_link edges
      expect(toolLinks.length).toBe(2);

      const tc1 = toolLinks.find((e) => e.toolCallId === "tc1");
      expect(tc1).toBeDefined();
      const fromNode = g.nodes.find((n) => n.id === tc1!.from);
      const toNode = g.nodes.find((n) => n.id === tc1!.to);
      expect(fromNode?.kind).toBe("tool_use");
      expect(toNode?.kind).toBe("tool_result");
      expect(fromNode?.toolName).toBe("list_dir");

      // Known edge: tool_use(tc1) → tool_result(tc1)
      expect(g.edges.some((e) => e.type === "tool_link" && e.toolCallId === "tc1")).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("projectGraph respects at-T prefix", () => {
    const corpus = writeCorpus(timedCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const early = projectGraph(db, {
        sessionIds: [SESSION_ID],
        at: "2026-06-01T12:00:02.000Z",
      });
      // user, assistant, tool_use tc1 only (through t=2)
      expect(early.nodes.every((n) => n.ts <= "2026-06-01T12:00:02.000Z")).toBe(true);
      expect(early.nodes.some((n) => n.kind === "tool_use")).toBe(true);
      // tool_result for tc1 is at t=3 — excluded; no completed tool_link
      expect(early.edges.filter((e) => e.type === "tool_link")).toHaveLength(0);

      const full = projectGraph(db, { sessionIds: [SESSION_ID] });
      expect(early.nodes.length).toBeLessThan(full.nodes.length);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("degreeCentrality reports in/out/total", () => {
    const corpus = writeCorpus(timedCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const g = projectGraph(db, {
        sessionIds: [SESSION_ID],
        edgeTypes: ["succession"],
      });
      const deg = degreeCentrality(g);
      expect(deg.totalNodes).toBe(g.nodes.length);
      expect(deg.totalEdges).toBe(g.edges.length);
      expect(deg.degrees.length).toBe(g.nodes.length);

      // Chain: first node out=1 in=0; last node out=0 in=1; middle in=1 out=1
      const byId = new Map(deg.degrees.map((d) => [d.nodeId, d]));
      const ordered = [...g.nodes].sort((a, b) =>
        a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.eventId - b.eventId,
      );
      const first = byId.get(ordered[0]!.id)!;
      const last = byId.get(ordered[ordered.length - 1]!.id)!;
      expect(first.in).toBe(0);
      expect(first.out).toBe(1);
      expect(last.in).toBe(1);
      expect(last.out).toBe(0);
      expect(first.total).toBe(1);
      expect(deg.maxDegree).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("eventsAtOrBefore windows the prefix", () => {
    const corpus = writeCorpus(timedCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const all = Array.from(eventsAtOrBefore(db, "9999-12-31T00:00:00.000Z", {
        sessionIds: [SESSION_ID],
      }));
      const mid = Array.from(
        eventsAtOrBefore(db, "2026-06-01T12:00:03.000Z", { sessionIds: [SESSION_ID] }),
      );
      expect(mid.length).toBeGreaterThan(0);
      expect(mid.length).toBeLessThan(all.length);
      expect(mid.every((e) => e.ts <= "2026-06-01T12:00:03.000Z")).toBe(true);
      // Includes the first tool_result (t=3)
      expect(mid.some((e) => e.kind === "tool_result" && e.toolCallId === "tc1")).toBe(true);
      // Excludes second tool_use (t=4)
      expect(mid.some((e) => e.toolCallId === "tc2")).toBe(false);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("toolSpans and eventsInToolSpan close a completed call", () => {
    const corpus = writeCorpus(timedCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });

      const spans = Array.from(toolSpans(db, { sessionIds: [SESSION_ID] }));
      expect(spans.length).toBe(2);
      const s1 = spans.find((s) => s.toolCallId === "tc1")!;
      expect(s1.open).toBe(false);
      expect(s1.error).toBe(false);
      expect(s1.startedAt).toBe("2026-06-01T12:00:02.000Z");
      expect(s1.endedAt).toBe("2026-06-01T12:00:03.000Z");
      expect(s1.toolName).toBe("list_dir");
      expect(s1.endEventId).not.toBeNull();

      const inSpan = Array.from(eventsInToolSpan(db, SESSION_ID, "tc1"));
      expect(inSpan.length).toBeGreaterThanOrEqual(2);
      expect(inSpan[0]!.kind).toBe("tool_use");
      expect(inSpan[inSpan.length - 1]!.kind).toBe("tool_result");
      expect(inSpan.every((e) => e.sessionId === SESSION_ID)).toBe(true);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("clean corpus projectGraph has expected tool_link count", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const g = projectGraph(db, { projectPath: CWD_DEC, edgeTypes: ["tool_link"] });
      expect(g.edges.filter((e) => e.type === "tool_link").length).toBe(2);
      // nodeId helper stable
      const n = g.nodes[0]!;
      expect(nodeIdForEvent(n.eventId)).toBe(n.id);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
