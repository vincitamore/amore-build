/**
 * Parse Amore Build session artifacts (updates.jsonl envelopes) into
 * normalized events. Tolerates truncated lines and unknown sessionUpdate kinds.
 */

export type EventKind =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system"
  | "usage"
  | "plan"
  | "task";

export type AgentRole = "primary" | "subagent";

export interface NormalizedEvent {
  session_id: string;
  project_path: string;
  agent: AgentRole;
  parent_session: string | null;
  ts: string;
  kind: EventKind;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_error: number | null;
  tool_call_id: string | null;
  is_boilerplate: number;
  raw: string;
}

export interface NormalizedUsage {
  session_id: string;
  project_path: string;
  ts: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_read_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  num_turns: number;
  model_calls: number;
  raw: string;
}

export interface SessionMeta {
  sessionId: string;
  projectPath: string;
  modelId: string | null;
  agent: AgentRole;
  parentSession: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** From summary.json session_summary; empty when absent/non-string. */
  title: string;
}

export interface SubagentMeta {
  subagentId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string | null;
  description: string | null;
  status: string | null;
  effectiveModelId: string | null;
}

interface Envelope {
  timestamp?: string;
  method?: string;
  params?: {
    sessionId?: string;
    update?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
}

/** Extract text from content that may be a string or `{ type, text }` object. */
export function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; content?: unknown; type?: unknown };
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) {
      return c.content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block && typeof block === "object" && typeof (block as { text?: string }).text === "string") {
            return (block as { text: string }).text;
          }
          if (block && typeof block === "object" && typeof (block as { content?: string }).content === "string") {
            return (block as { content: string }).content;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as { text?: string; content?: string };
          if (typeof b.text === "string") return b.text;
          if (typeof b.content === "string") return b.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Normalize one updates.jsonl line. Returns null for blank, unparseable, or
 * intentionally skipped envelopes. Unknown sessionUpdate kinds yield null
 * (tolerated, not errors).
 */
export function normalizeUpdatesLine(
  raw: string,
  ctx: {
    sessionId: string;
    projectPath: string;
    agent: AgentRole;
    parentSession: string | null;
  },
): { event?: NormalizedEvent; usage?: NormalizedUsage } | null {
  const trimmed = raw.replace(/\r$/, "").trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Truncated / partial line — tolerate.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const env = parsed as Envelope;
  const update = env.params?.update;
  if (!update || typeof update !== "object") return null;

  const kind = str(update.sessionUpdate);
  if (!kind) return null;

  const ts =
    str(env.timestamp) ||
    (typeof env.params?._meta?.agentTimestampMs === "number"
      ? new Date(env.params._meta.agentTimestampMs as number).toISOString()
      : new Date().toISOString());

  const sessionId = str(env.params?.sessionId) || ctx.sessionId;
  const base = {
    session_id: sessionId,
    project_path: ctx.projectPath,
    agent: ctx.agent,
    parent_session: ctx.parentSession,
    ts,
    raw: trimmed,
  };

  switch (kind) {
    case "user_message_chunk": {
      const text = extractContentText(update.content);
      return {
        event: {
          ...base,
          kind: "user",
          text: text || null,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          tool_error: null,
          tool_call_id: null,
          is_boilerplate: 0,
        },
      };
    }
    case "agent_message_chunk": {
      const text = extractContentText(update.content);
      return {
        event: {
          ...base,
          kind: "assistant",
          text: text || null,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          tool_error: null,
          tool_call_id: null,
          is_boilerplate: 0,
        },
      };
    }
    case "tool_call": {
      const toolName = str(update.title) || str(update.toolName) || "unknown";
      const toolCallId = str(update.toolCallId);
      let toolInput: string | null = null;
      if (update.rawInput !== undefined) {
        toolInput =
          typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput);
      }
      return {
        event: {
          ...base,
          kind: "tool_use",
          text: null,
          tool_name: toolName,
          tool_input: toolInput,
          tool_output: null,
          tool_error: null,
          tool_call_id: toolCallId,
          is_boilerplate: 0,
        },
      };
    }
    case "tool_call_update": {
      const toolName = str(update.title) || str(update.toolName);
      const toolCallId = str(update.toolCallId);
      const out = extractContentText(update.content);
      const status = str(update.status) || str(update.kind);
      const isError =
        status === "error" || status === "failed" || status === "cancelled" ? 1 : 0;
      return {
        event: {
          ...base,
          kind: "tool_result",
          text: null,
          tool_name: toolName,
          tool_input:
            update.rawInput !== undefined
              ? typeof update.rawInput === "string"
                ? update.rawInput
                : JSON.stringify(update.rawInput)
              : null,
          tool_output: out || null,
          tool_error: isError,
          tool_call_id: toolCallId,
          is_boilerplate: 0,
        },
      };
    }
    case "turn_completed": {
      const usage = update.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== "object") {
        return {
          event: {
            ...base,
            kind: "usage",
            text: null,
            tool_name: null,
            tool_input: null,
            tool_output: null,
            tool_error: null,
            tool_call_id: null,
            is_boilerplate: 0,
          },
        };
      }

      let modelId: string | null = null;
      const modelUsage = usage.modelUsage;
      if (modelUsage && typeof modelUsage === "object") {
        const keys = Object.keys(modelUsage as object);
        if (keys.length > 0) modelId = keys[0] ?? null;
      }

      return {
        event: {
          ...base,
          kind: "usage",
          text: null,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          tool_error: null,
          tool_call_id: null,
          is_boilerplate: 0,
        },
        usage: {
          session_id: sessionId,
          project_path: ctx.projectPath,
          ts,
          model_id: modelId,
          input_tokens: num(usage.inputTokens),
          output_tokens: num(usage.outputTokens),
          cached_read_tokens: num(usage.cachedReadTokens),
          reasoning_tokens: num(usage.reasoningTokens),
          total_tokens: num(usage.totalTokens),
          num_turns: num(usage.numTurns),
          model_calls: num(usage.modelCalls),
          raw: trimmed,
        },
      };
    }
    case "hook_execution":
    case "hook_annotation": {
      return {
        event: {
          ...base,
          kind: "system",
          text: str(update.event_name) || str(update.message) || null,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          tool_error: null,
          tool_call_id: null,
          is_boilerplate: 1,
        },
      };
    }
    case "plan": {
      return {
        event: {
          ...base,
          kind: "plan",
          text: update.entries !== undefined ? JSON.stringify(update.entries) : null,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          tool_error: null,
          tool_call_id: null,
          is_boilerplate: 0,
        },
      };
    }
    case "task_backgrounded":
    case "task_completed": {
      return {
        event: {
          ...base,
          kind: "task",
          text: kind,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          tool_error: null,
          tool_call_id: null,
          is_boilerplate: 0,
        },
      };
    }
    case "session_recap": {
      return {
        event: {
          ...base,
          kind: "system",
          text: extractContentText(update.content) || str(update.message) || null,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          tool_error: null,
          tool_call_id: null,
          is_boilerplate: 1,
        },
      };
    }
    default:
      // Unknown kinds tolerated.
      return null;
  }
}

/**
 * Coalesce consecutive user/assistant chunks into single events so probes
 * see whole turns rather than stream fragments.
 */
export function coalesceMessageChunks(events: NormalizedEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (
      prev &&
      (ev.kind === "user" || ev.kind === "assistant") &&
      prev.kind === ev.kind &&
      prev.session_id === ev.session_id
    ) {
      prev.text = `${prev.text ?? ""}${ev.text ?? ""}`;
      prev.ts = ev.ts;
      prev.raw = ev.raw;
      continue;
    }
    out.push({ ...ev });
  }
  return out;
}

export function parseSummaryJson(
  raw: string,
  fallbackSessionId: string,
  projectPath: string,
): SessionMeta {
  let modelId: string | null = null;
  let sessionId = fallbackSessionId;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let cwd = projectPath;
  let title = "";

  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    if (typeof s.current_model_id === "string") modelId = s.current_model_id;
    if (typeof s.created_at === "string") createdAt = s.created_at;
    if (typeof s.updated_at === "string") updatedAt = s.updated_at;
    else if (typeof s.last_active_at === "string") updatedAt = s.last_active_at;
    const info = s.info as { id?: string; cwd?: string } | undefined;
    if (info?.id) sessionId = info.id;
    if (info?.cwd) cwd = info.cwd;
    // session_summary is the terminal-tab title; empty/non-string → no title.
    if (typeof s.session_summary === "string") {
      title = s.session_summary.trim();
    }
  } catch {
    // tolerate bad summary
  }

  return {
    sessionId,
    projectPath: cwd || projectPath,
    modelId,
    agent: "primary",
    parentSession: null,
    createdAt,
    updatedAt,
    title,
  };
}

export function parseSubagentMeta(raw: string): SubagentMeta | null {
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    const parentSessionId = str(m.parent_session_id);
    const childSessionId = str(m.child_session_id) || str(m.subagent_id);
    if (!parentSessionId || !childSessionId) return null;
    return {
      subagentId: str(m.subagent_id) || childSessionId,
      parentSessionId,
      childSessionId,
      subagentType: str(m.subagent_type),
      description: str(m.description),
      status: str(m.status),
      effectiveModelId: str(m.effective_model_id),
    };
  } catch {
    return null;
  }
}

/**
 * Parse an entire updates.jsonl body (string). Used by dry-run and tests.
 * Returns events (coalesced) + usage rows. Truncated lines are skipped.
 */
export function parseUpdatesJsonl(
  body: string,
  ctx: {
    sessionId: string;
    projectPath: string;
    agent: AgentRole;
    parentSession: string | null;
  },
): { events: NormalizedEvent[]; usage: NormalizedUsage[]; linesSeen: number; linesParsed: number; linesSkipped: number } {
  const events: NormalizedEvent[] = [];
  const usage: NormalizedUsage[] = [];
  let linesSeen = 0;
  let linesParsed = 0;
  let linesSkipped = 0;

  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    linesSeen++;
    const result = normalizeUpdatesLine(line, ctx);
    if (!result) {
      linesSkipped++;
      continue;
    }
    linesParsed++;
    if (result.event) events.push(result.event);
    if (result.usage) usage.push(result.usage);
  }

  return {
    events: coalesceMessageChunks(events),
    usage,
    linesSeen,
    linesParsed,
    linesSkipped,
  };
}
