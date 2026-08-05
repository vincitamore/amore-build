import { describe, expect, test } from "bun:test";
import {
  coalesceMessageChunks,
  extractContentText,
  normalizeUpdatesLine,
  parseSubagentMeta,
  parseSummaryJson,
  parseUpdatesJsonl,
} from "./ingest/parser";
import {
  agentChunk,
  makeUsage,
  toolCall,
  turnCompleted,
  updateLine,
  userChunk,
} from "./test/fixtures";

const CTX = {
  sessionId: "sess-1",
  projectPath: "C:\\proj",
  agent: "primary" as const,
  parentSession: null,
};

describe("extractContentText", () => {
  test("string content", () => {
    expect(extractContentText("hello")).toBe("hello");
  });
  test("typed text object", () => {
    expect(extractContentText({ type: "text", text: "hi" })).toBe("hi");
  });
  test("array of content blocks", () => {
    expect(extractContentText([{ type: "content", content: "a" }, { text: "b" }])).toBe("a\nb");
  });
});

describe("normalizeUpdatesLine", () => {
  test("user_message_chunk", () => {
    const raw = updateLine("sess-1", userChunk("hello operator"));
    const r = normalizeUpdatesLine(raw, CTX);
    expect(r?.event?.kind).toBe("user");
    expect(r?.event?.text).toBe("hello operator");
  });

  test("agent_message_chunk", () => {
    const raw = updateLine("sess-1", agentChunk("hello agent"));
    const r = normalizeUpdatesLine(raw, CTX);
    expect(r?.event?.kind).toBe("assistant");
    expect(r?.event?.text).toBe("hello agent");
  });

  test("tool_call maps title → tool_name", () => {
    const raw = updateLine(
      "sess-1",
      toolCall("t1", "run_terminal_command", { command: "ls", description: "list" }),
    );
    const r = normalizeUpdatesLine(raw, CTX);
    expect(r?.event?.kind).toBe("tool_use");
    expect(r?.event?.tool_name).toBe("run_terminal_command");
    expect(r?.event?.tool_call_id).toBe("t1");
    expect(r?.event?.tool_input).toContain("ls");
  });

  test("turn_completed yields usage", () => {
    const raw = updateLine("sess-1", turnCompleted(makeUsage("grok-4")));
    const r = normalizeUpdatesLine(raw, CTX);
    expect(r?.event?.kind).toBe("usage");
    expect(r?.usage?.input_tokens).toBe(1000);
    expect(r?.usage?.output_tokens).toBe(200);
    expect(r?.usage?.model_id).toBe("grok-4");
  });

  test("truncated line tolerated", () => {
    expect(normalizeUpdatesLine('{"timestamp":"2026-01-01", "params":{', CTX)).toBeNull();
  });

  test("unknown sessionUpdate kind tolerated", () => {
    const raw = updateLine("sess-1", { sessionUpdate: "future_kind_xyz", foo: 1 });
    expect(normalizeUpdatesLine(raw, CTX)).toBeNull();
  });
});

describe("coalesceMessageChunks", () => {
  test("merges consecutive agent chunks", () => {
    const a = normalizeUpdatesLine(updateLine("s", agentChunk("Hel"), "2026-01-01T00:00:00Z"), {
      ...CTX,
      sessionId: "s",
    })!.event!;
    const b = normalizeUpdatesLine(updateLine("s", agentChunk("lo"), "2026-01-01T00:00:01Z"), {
      ...CTX,
      sessionId: "s",
    })!.event!;
    const out = coalesceMessageChunks([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Hello");
  });
});

describe("parseUpdatesJsonl", () => {
  test("counts well-formed and skipped lines", () => {
    const body = [
      updateLine("s", userChunk("hi")),
      "{not json",
      updateLine("s", { sessionUpdate: "unknown_kind" }),
      updateLine("s", agentChunk("yo")),
      "",
    ].join("\n");
    const r = parseUpdatesJsonl(body, { ...CTX, sessionId: "s" });
    expect(r.linesSeen).toBe(4);
    expect(r.linesParsed).toBe(2);
    expect(r.linesSkipped).toBe(2);
    expect(r.events.filter((e) => e.kind === "user" || e.kind === "assistant").length).toBe(2);
  });
});

describe("summary + subagent meta", () => {
  test("parseSummaryJson", () => {
    const m = parseSummaryJson(
      JSON.stringify({
        info: { id: "abc", cwd: "C:\\work" },
        current_model_id: "grok-4",
        created_at: "2026-01-01T00:00:00Z",
      }),
      "fallback",
      "C:\\fallback",
    );
    expect(m.sessionId).toBe("abc");
    expect(m.projectPath).toBe("C:\\work");
    expect(m.modelId).toBe("grok-4");
  });

  test("parseSubagentMeta linkage", () => {
    const m = parseSubagentMeta(
      JSON.stringify({
        subagent_id: "child-1",
        parent_session_id: "parent-1",
        child_session_id: "child-1",
        subagent_type: "explore",
      }),
    );
    expect(m?.parentSessionId).toBe("parent-1");
    expect(m?.childSessionId).toBe("child-1");
  });
});
