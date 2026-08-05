/**
 * Query helpers for probes and commands.
 */

import type { Db } from "./db";

export interface Turn {
  sessionId: string;
  projectPath: string;
  role: "user" | "assistant";
  ts: string;
  text: string;
  isBoilerplate: boolean;
}

export interface TurnQueryOpts {
  sessionIds?: string[];
  projectPath?: string;
  since?: Date;
  until?: Date;
  /** Include subagent sessions. Default false for operator-language probes. */
  includeSubagents?: boolean;
  includeBoilerplate?: boolean;
}

export function* userTurns(db: Db, opts: TurnQueryOpts = {}): Iterable<Turn> {
  yield* turnsByRole(db, "user", opts);
}

export function* assistantTurns(db: Db, opts: TurnQueryOpts = {}): Iterable<Turn> {
  yield* turnsByRole(db, "assistant", opts);
}

function* turnsByRole(db: Db, role: "user" | "assistant", opts: TurnQueryOpts): Iterable<Turn> {
  const wheres: string[] = ["kind = ?", "text IS NOT NULL"];
  const params: (string | number)[] = [role];

  if (!opts.includeSubagents) wheres.push("agent = 'primary'");
  if (!opts.includeBoilerplate) wheres.push("is_boilerplate = 0");
  if (opts.sessionIds?.length) {
    wheres.push(`session_id IN (${opts.sessionIds.map(() => "?").join(",")})`);
    for (const id of opts.sessionIds) params.push(id);
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

  const sql = `
    SELECT session_id, project_path, ts, text, is_boilerplate
    FROM events
    WHERE ${wheres.join(" AND ")}
    ORDER BY session_id, ts
  `;

  const rows = db
    .query<
      { session_id: string; project_path: string; ts: string; text: string; is_boilerplate: number },
      (string | number)[]
    >(sql)
    .iterate(...params);

  for (const row of rows) {
    yield {
      sessionId: row.session_id,
      projectPath: row.project_path,
      role,
      ts: row.ts,
      text: row.text ?? "",
      isBoilerplate: row.is_boilerplate === 1,
    };
  }
}

export interface ToolUse {
  sessionId: string;
  projectPath: string;
  ts: string;
  toolName: string;
  toolInput: string | null;
  agent: string;
}

export function* toolUses(db: Db, opts: TurnQueryOpts = {}): Iterable<ToolUse> {
  const wheres: string[] = ["kind = 'tool_use'", "tool_name IS NOT NULL"];
  const params: (string | number)[] = [];

  if (opts.sessionIds?.length) {
    wheres.push(`session_id IN (${opts.sessionIds.map(() => "?").join(",")})`);
    for (const id of opts.sessionIds) params.push(id);
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
  if (!opts.includeSubagents) wheres.push("agent = 'primary'");

  const sql = `
    SELECT session_id, project_path, ts, tool_name, tool_input, agent
    FROM events
    WHERE ${wheres.join(" AND ")}
    ORDER BY session_id, ts
  `;

  const rows = db
    .query<
      {
        session_id: string;
        project_path: string;
        ts: string;
        tool_name: string;
        tool_input: string | null;
        agent: string;
      },
      (string | number)[]
    >(sql)
    .iterate(...params);

  for (const row of rows) {
    yield {
      sessionId: row.session_id,
      projectPath: row.project_path,
      ts: row.ts,
      toolName: row.tool_name,
      toolInput: row.tool_input,
      agent: row.agent,
    };
  }
}

export interface SessionToolMix {
  sessionId: string;
  projectPath: string;
  toolCounts: Record<string, number>;
  totalTools: number;
}

export function sessionToolMixes(db: Db, opts: TurnQueryOpts = {}): SessionToolMix[] {
  const bySession = new Map<string, SessionToolMix>();
  for (const t of toolUses(db, { ...opts, includeSubagents: true })) {
    let m = bySession.get(t.sessionId);
    if (!m) {
      m = { sessionId: t.sessionId, projectPath: t.projectPath, toolCounts: {}, totalTools: 0 };
      bySession.set(t.sessionId, m);
    }
    m.toolCounts[t.toolName] = (m.toolCounts[t.toolName] ?? 0) + 1;
    m.totalTools++;
  }
  return Array.from(bySession.values());
}
