/**
 * Synthetic Amore session fixtures. No real session content.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface FixtureSession {
  /** UUID-like id (synthetic). */
  id: string;
  cwdEnc: string;
  cwdDecoded: string;
  modelId?: string;
  parentSessionId?: string;
  updates: unknown[];
  summaryExtra?: Record<string, unknown>;
}

/** Default fixture timestamps: recent enough that stale-corpus (30d) stays quiet. */
export function recentTs(offsetMinutes = 0): string {
  return new Date(Date.now() - offsetMinutes * 60_000).toISOString();
}

/** Build a standard updates.jsonl line with session id filled in later. */
export function updateLine(
  sessionId: string,
  update: Record<string, unknown>,
  ts: string = recentTs(),
): string {
  return JSON.stringify({
    timestamp: ts,
    method: "session/update",
    params: {
      sessionId,
      update,
      _meta: {},
    },
  });
}

export function userChunk(text: string): Record<string, unknown> {
  return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
}

export function agentChunk(text: string): Record<string, unknown> {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

export function toolCall(
  id: string,
  title: string,
  rawInput: unknown,
): Record<string, unknown> {
  return { sessionUpdate: "tool_call", toolCallId: id, title, rawInput };
}

export function toolCallUpdate(
  id: string,
  title: string,
  content: unknown,
  kind = "execute",
): Record<string, unknown> {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    title,
    kind,
    content: Array.isArray(content)
      ? content
      : [{ type: "content", content: String(content) }],
  };
}

export function turnCompleted(usage: Record<string, unknown>): Record<string, unknown> {
  return { sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn", usage };
}

export function hookExecution(name = "SessionStart"): Record<string, unknown> {
  return { sessionUpdate: "hook_execution", event_name: name, runs: [] };
}

export function makeUsage(model = "grok-4", overrides: Partial<Record<string, number>> = {}) {
  const inputTokens = overrides.inputTokens ?? 1000;
  const outputTokens = overrides.outputTokens ?? 200;
  const cachedReadTokens = overrides.cachedReadTokens ?? 100;
  const reasoningTokens = overrides.reasoningTokens ?? 50;
  const totalTokens = overrides.totalTokens ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens,
    reasoningTokens,
    modelCalls: overrides.modelCalls ?? 1,
    apiDurationMs: 500,
    numTurns: overrides.numTurns ?? 1,
    modelUsage: {
      [model]: {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedReadTokens,
        reasoningTokens,
        modelCalls: 1,
        apiDurationMs: 500,
      },
    },
  };
}

export interface WrittenCorpus {
  root: string;
  cleanup: () => void;
}

/**
 * Write a synthetic sessions tree under the OS temp directory:
 *   root/<cwdEnc>/<sessionId>/updates.jsonl + summary.json
 *   optional subagents/<child>/meta.json under parent
 */
export function writeCorpus(sessions: FixtureSession[]): WrittenCorpus {
  const root = join(
    tmpdir(),
    `speculum-fixtures-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });

  for (const s of sessions) {
    const dir = join(root, s.cwdEnc, s.id);
    mkdirSync(dir, { recursive: true });

    const lines = s.updates.map((u, i) => {
      if (typeof u === "string") return u;
      return updateLine(s.id, u as Record<string, unknown>, recentTs(60 - i));
    });
    writeFileSync(join(dir, "updates.jsonl"), lines.join("\n") + "\n", "utf-8");

    const summary = {
      info: { id: s.id, cwd: s.cwdDecoded },
      current_model_id: s.modelId ?? "grok-4",
      created_at: recentTs(120),
      updated_at: recentTs(0),
      num_messages: lines.length,
      ...s.summaryExtra,
    };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

    if (s.parentSessionId) {
      // Child linkage lives under the parent's subagents dir.
      const parentDir = join(root, s.cwdEnc, s.parentSessionId);
      const metaDir = join(parentDir, "subagents", s.id);
      mkdirSync(metaDir, { recursive: true });
      writeFileSync(
        join(metaDir, "meta.json"),
        JSON.stringify({
          subagent_id: s.id,
          parent_session_id: s.parentSessionId,
          child_session_id: s.id,
          subagent_type: "explore",
          description: "synthetic child",
          status: "completed",
          effective_model_id: s.modelId ?? "grok-4",
        }),
        "utf-8",
      );
    }
  }

  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export const CWD_ENC = encodeURIComponent("C:\\Users\\Synthetic\\project");
export const CWD_DEC = "C:\\Users\\Synthetic\\project";

/** Clean corpus: calm user, polite agent, varied tools, no secrets. */
export function cleanCorpus(): FixtureSession[] {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  return [
    {
      id,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        hookExecution(),
        userChunk("Please list the files in the src directory."),
        agentChunk("I'll list the directory for you."),
        toolCall("tc1", "list_dir", { target_directory: "src" }),
        toolCallUpdate("tc1", "list_dir", "index.ts\ncli.ts"),
        toolCall("tc2", "read_file", { target_file: "src/index.ts", offset: 0 }),
        toolCallUpdate("tc2", "read_file", "export const x = 1;"),
        agentChunk("Here is a short summary of the entrypoint."),
        turnCompleted(makeUsage("grok-4", { inputTokens: 500, outputTokens: 100 })),
      ],
    },
  ];
}

/** Engineered corpus that trips every v1 probe. */
export function tripwireCorpus(): FixtureSession[] {
  const parentId = "11111111-2222-3333-4444-555555555555";
  const childId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const oldId = "99999999-aaaa-bbbb-cccc-dddddddddddd";

  const repeatedShell = Array.from({ length: 5 }, (_, i) =>
    toolCall(`loop${i}`, "run_terminal_command", {
      command: "bun test",
      description: "run tests",
    }),
  );

  return [
    {
      id: parentId,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      updates: [
        userChunk("this is fucking broken and total bullshit"),
        userChunk("WHY IS THIS STILL FAILING NOW?? what the hell"),
        userChunk("Nope, you failed to read what I said. I told you already."),
        agentChunk("You're right. I was wrong about the path. Sorry about that."),
        agentChunk("Good catch — let me actually fix it."),
        // Dominate with shell for tool-mix outlier (>=20 and >=70%).
        ...Array.from({ length: 22 }, (_, i) =>
          toolCall(`sh${i}`, "run_terminal_command", {
            command: i < 5 ? "bun test" : `echo ${i}`,
            description: "shell",
          }),
        ),
        // Stuck loop: identical bun test fingerprint thrice+ in window.
        ...repeatedShell,
        // Sensitive content
        userChunk("my key is xai-abcdefghijklmnopqrstuvwxyz012345 and also sk-or-v1-abcdefghijklmnopqrstuvwxyz"),
        agentChunk("Do not paste secrets. Example AWS AKIAIOSFODNN7EXAMPLE is bad."),
        turnCompleted(
          makeUsage("grok-4", {
            inputTokens: 2000,
            outputTokens: 400,
            cachedReadTokens: 800,
            reasoningTokens: 100,
          }),
        ),
      ],
    },
    {
      id: childId,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-4",
      parentSessionId: parentId,
      updates: [
        userChunk("subagent task"),
        agentChunk("working"),
        toolCall("c1", "grep", { pattern: "TODO", path: "src" }),
        turnCompleted(makeUsage("grok-4", { inputTokens: 100, outputTokens: 20 })),
      ],
    },
    {
      // Old session for stale-corpus (started_at from first event ts).
      id: oldId,
      cwdEnc: CWD_ENC,
      cwdDecoded: CWD_DEC,
      modelId: "grok-3",
      updates: [
        // Use old timestamps via raw lines
      ],
    },
  ];
}

/** Write tripwire including an old-timestamp session via raw line override. */
export function writeTripwireCorpus(): WrittenCorpus {
  const sessions = tripwireCorpus();
  // Replace the empty old session with raw-timestamped lines.
  const old = sessions.find((s) => s.id.startsWith("99999999"))!;
  old.updates = [
    updateLine(
      old.id,
      userChunk("old quiet session"),
      "2020-01-01T00:00:00.000Z",
    ),
    updateLine(
      old.id,
      agentChunk("acknowledged"),
      "2020-01-01T00:01:00.000Z",
    ),
    updateLine(
      old.id,
      turnCompleted(makeUsage("grok-3", { inputTokens: 50, outputTokens: 10 })),
      "2020-01-01T00:02:00.000Z",
    ),
  ];
  return writeCorpus(sessions);
}


