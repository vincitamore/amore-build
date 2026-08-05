/**
 * Lens slice construction over the local event store.
 *
 * Renders events from one or more sessions into a transcript string for
 * embedding in a lens prompt. Tool calls are summarized (name + target) rather
 * than dumped raw so payload size stays bounded.
 */

import type { Db } from "./store/db";
import { PROBES } from "./probes";
import type { ProbeOptions } from "./probes/types";

export interface SliceOptions {
  sessionId?: string;
  sessionIds?: string[];
  /** Take the N most-recent primary sessions (by started_at desc). */
  lastN?: number;
  projectPath?: string;
  since?: Date;
  until?: Date;
  /**
   * Select sessions that a named probe flagged (uses that probe's hit list).
   * Combined with other filters when both are set.
   */
  probeHit?: string;
  includeSubagents?: boolean;
  includeBoilerplate?: boolean;
  /** Soft cap on transcript characters (marker only; payload cap is scrub). */
  maxChars?: number;
}

export interface SliceResult {
  transcript: string;
  sessionId: string | null;
  project: string | null;
  distinctProjects: string[];
  estimatedChars: number;
  truncated: boolean;
  turnsRendered: number;
  subagentCount: number;
  selectionSessionIds: string[];
}

interface EventRow {
  id: number;
  session_id: string;
  project_path: string;
  agent: string;
  parent_session: string | null;
  ts: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_error: number | null;
  is_boilerplate: number;
}

function sessionsFromProbeHit(db: Db, probeName: string, opts: SliceOptions): string[] {
  const probe = PROBES[probeName];
  if (!probe) {
    throw new Error(
      `unknown probe for --probe-hit: ${probeName} (known: ${Object.keys(PROBES).join(", ")})`,
    );
  }
  const probeOpts: ProbeOptions = {};
  if (opts.projectPath) probeOpts.project = opts.projectPath;
  if (opts.since) probeOpts.since = opts.since;
  if (opts.until) probeOpts.until = opts.until;
  const result = probe(db, probeOpts);
  const ids = new Set<string>();
  for (const h of result.hits ?? []) {
    if (h.sessionId) ids.add(h.sessionId);
  }
  return Array.from(ids);
}

export function buildSlice(db: Db, opts: SliceOptions = {}): SliceResult {
  const wheres: string[] = [];
  const params: (string | number)[] = [];

  let effectiveSessionIds: string[] | null = null;

  if (opts.probeHit) {
    const hitIds = sessionsFromProbeHit(db, opts.probeHit, opts);
    if (opts.sessionId) {
      effectiveSessionIds = hitIds.includes(opts.sessionId) ? [opts.sessionId] : [];
    } else if (opts.sessionIds?.length) {
      effectiveSessionIds = opts.sessionIds.filter((id) => hitIds.includes(id));
    } else {
      effectiveSessionIds = hitIds;
    }
  } else if (opts.sessionId) {
    effectiveSessionIds = [opts.sessionId];
  } else if (opts.sessionIds && opts.sessionIds.length > 0) {
    effectiveSessionIds = opts.sessionIds;
  } else if (opts.lastN && opts.lastN > 0) {
    const sessWheres: string[] = ["agent = 'primary'"];
    const sessParams: (string | number)[] = [];
    if (opts.projectPath) {
      sessWheres.push("project_path = ?");
      sessParams.push(opts.projectPath);
    }
    if (opts.since) {
      sessWheres.push("started_at >= ?");
      sessParams.push(opts.since.toISOString());
    }
    if (opts.until) {
      sessWheres.push("started_at < ?");
      sessParams.push(opts.until.toISOString());
    }
    const recent = db
      .query<{ id: string }, (string | number)[]>(
        `SELECT id FROM sessions WHERE ${sessWheres.join(" AND ")}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...sessParams, opts.lastN);
    effectiveSessionIds = recent.map((r) => r.id);
  }

  if (effectiveSessionIds !== null) {
    if (effectiveSessionIds.length === 0) {
      wheres.push("1 = 0");
    } else {
      const placeholders = effectiveSessionIds.map(() => "?").join(",");
      if (opts.includeSubagents !== false) {
        wheres.push(`(session_id IN (${placeholders}) OR parent_session IN (${placeholders}))`);
        for (const id of effectiveSessionIds) params.push(id);
        for (const id of effectiveSessionIds) params.push(id);
      } else {
        wheres.push(`session_id IN (${placeholders})`);
        for (const id of effectiveSessionIds) params.push(id);
      }
    }
  } else if (opts.includeSubagents === false) {
    wheres.push("agent = 'primary'");
  }

  if (opts.projectPath) {
    wheres.push("project_path = ?");
    params.push(opts.projectPath);
  }
  if (opts.since) {
    wheres.push("ts >= ?");
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    wheres.push("ts < ?");
    params.push(opts.until.toISOString());
  }
  if (!opts.includeBoilerplate) {
    wheres.push("is_boilerplate = 0");
  }

  const sql = `
    SELECT id, session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, is_boilerplate
    FROM events
    ${wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : ""}
    ORDER BY session_id, ts, id
  `;

  const rows = db.query<EventRow, (string | number)[]>(sql).all(...params);

  const distinctProjects = Array.from(new Set(rows.map((r) => r.project_path)));

  const rootRows = rows.filter((r) => r.agent === "primary");
  const subagentRows = rows.filter((r) => r.agent === "subagent");

  const lines: string[] = [];
  let turnsRendered = 0;
  let lastSessionId: string | null = null;
  const orderedRoot = [...rootRows].sort(
    (a, b) =>
      a.session_id.localeCompare(b.session_id) ||
      a.ts.localeCompare(b.ts) ||
      a.id - b.id,
  );

  for (const r of orderedRoot) {
    if (r.session_id !== lastSessionId) {
      lines.push(`\n=== [SESSION ${r.session_id}] ===`);
      lastSessionId = r.session_id;
    }
    const rendered = renderEvent(r);
    if (rendered === null) continue;
    lines.push(rendered);
    turnsRendered++;
  }

  let subagentCount = 0;
  if (subagentRows.length > 0 && opts.includeSubagents !== false) {
    const bySession = new Map<string, EventRow[]>();
    for (const r of subagentRows) {
      let arr = bySession.get(r.session_id);
      if (!arr) {
        arr = [];
        bySession.set(r.session_id, arr);
      }
      arr.push(r);
    }
    if (bySession.size > 0) {
      lines.push("");
      lines.push("=== Subagent dispatches ===");
      lines.push("");
      for (const [subSession, subRows] of bySession) {
        subagentCount++;
        lines.push(`--- subagent ${subSession.slice(0, 8)} ---`);
        for (const r of subRows) {
          const rendered = renderEvent(r);
          if (rendered !== null) lines.push(rendered);
        }
        lines.push("");
      }
    }
  }

  let transcript = lines.join("\n");
  let truncated = false;
  if (opts.maxChars !== undefined && transcript.length > opts.maxChars) {
    transcript = `${transcript.slice(0, opts.maxChars)}\n\n[... transcript truncated for display]`;
    truncated = true;
  }

  if (turnsRendered === 0 && rows.length === 0) {
    transcript =
      transcript.trim().length > 0
        ? transcript
        : "(empty slice: no events matched the selection)";
  }

  return {
    transcript,
    sessionId: rootRows[0]?.session_id ?? effectiveSessionIds?.[0] ?? null,
    project: rootRows[0]?.project_path ?? opts.projectPath ?? null,
    distinctProjects,
    estimatedChars: transcript.length,
    truncated,
    turnsRendered,
    subagentCount,
    selectionSessionIds: effectiveSessionIds ?? Array.from(new Set(rows.map((r) => r.session_id))),
  };
}

function renderEvent(r: EventRow): string | null {
  switch (r.kind) {
    case "user": {
      if (!r.text) return null;
      return `\n[USER ${r.ts}]\n${r.text.trim()}`;
    }
    case "assistant": {
      if (!r.text) return null;
      return `\n[ASSISTANT ${r.ts}]\n${r.text.trim()}`;
    }
    case "tool_use": {
      const name = r.tool_name ?? "<unknown>";
      const target = summarizeToolInput(r.tool_name, r.tool_input);
      const text = r.text ? `\n${r.text.trim()}` : "";
      return `\n[ASSISTANT ${r.ts}]${text}\n  → tool: ${name}${target ? `  ${target}` : ""}`;
    }
    case "tool_result": {
      const status = r.tool_error === 1 ? "ERROR" : "ok";
      const preview = (r.tool_output ?? "").slice(0, 80).replace(/\n/g, " ");
      return `  ← tool result: ${status}${preview ? `  ${preview}…` : ""}`;
    }
    case "plan":
    case "task":
      return r.text ? `\n[${r.kind.toUpperCase()} ${r.ts}]\n${r.text.trim()}` : null;
    case "system":
    case "usage":
      return null;
    default:
      return null;
  }
}

function summarizeToolInput(toolName: string | null, jsonStr: string | null): string {
  if (!jsonStr) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const o = parsed as Record<string, unknown>;
  switch (toolName) {
    case "run_terminal_command": {
      const cmd = typeof o.command === "string" ? o.command : "";
      return cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd;
    }
    case "read_file":
    case "search_replace":
    case "write": {
      const fp =
        typeof o.target_file === "string"
          ? o.target_file
          : typeof o.file_path === "string"
            ? o.file_path
            : "";
      return fp;
    }
    case "list_dir": {
      return typeof o.target_directory === "string" ? o.target_directory : "";
    }
    case "grep": {
      const pat = typeof o.pattern === "string" ? o.pattern : "";
      const path = typeof o.path === "string" ? `  in ${o.path}` : "";
      return `${pat}${path}`;
    }
    default: {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") {
          const s = v.length > 60 ? `${v.slice(0, 57)}…` : v;
          return `${k}=${s}`;
        }
      }
      return "";
    }
  }
}

export function renderPromptTemplate(
  template: string,
  slice: SliceResult,
  extra: Record<string, string> = {},
): string {
  let out = template
    .replaceAll("{{transcript}}", slice.transcript)
    .replaceAll("{{session_id}}", slice.sessionId ?? "<no session>")
    .replaceAll("{{project}}", slice.project ?? "<no project>");
  for (const [k, v] of Object.entries(extra)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}
