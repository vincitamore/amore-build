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

// ---------------------------------------------------------------------------
// WU-10: prefix state-at-T + tool activity spans (named helpers only)
// ---------------------------------------------------------------------------

/** Full event row from the derived index (query-time projection grain). */
export interface EventRow {
  id: number;
  sessionId: string;
  projectPath: string;
  agent: string;
  parentSession: string | null;
  ts: string;
  kind: string;
  text: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  toolError: number | null;
  toolCallId: string | null;
  isBoilerplate: boolean;
}

export interface EventQueryOpts {
  sessionIds?: string[];
  projectPath?: string;
  since?: Date;
  /** Exclusive upper bound on ts (same convention as TurnQueryOpts.until). */
  until?: Date;
  /** Include subagent sessions. Default true for raw event projection. */
  includeSubagents?: boolean;
  kinds?: string[];
  includeBoilerplate?: boolean;
}

type EventSqlRow = {
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
  tool_call_id: string | null;
  is_boilerplate: number;
};

function mapEventRow(row: EventSqlRow): EventRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    agent: row.agent,
    parentSession: row.parent_session,
    ts: row.ts,
    kind: row.kind,
    text: row.text,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolOutput: row.tool_output,
    toolError: row.tool_error,
    toolCallId: row.tool_call_id,
    isBoilerplate: row.is_boilerplate === 1,
  };
}

const EVENT_SELECT = `
  SELECT id, session_id, project_path, agent, parent_session, ts, kind,
         text, tool_name, tool_input, tool_output, tool_error, tool_call_id, is_boilerplate
  FROM events
`;

function pushEventFilters(
  wheres: string[],
  params: (string | number)[],
  opts: EventQueryOpts,
): void {
  if (opts.includeSubagents === false) wheres.push("agent = 'primary'");
  if (opts.includeBoilerplate === false) wheres.push("is_boilerplate = 0");
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
  if (opts.kinds?.length) {
    wheres.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
    for (const k of opts.kinds) params.push(k);
  }
}

/**
 * Prefix / state-at-T read: events with ts <= at (inclusive), from the derived index.
 * Optional filters mirror TurnQueryOpts windowing.
 */
export function* eventsAtOrBefore(
  db: Db,
  at: Date | string,
  opts: EventQueryOpts = {},
): Iterable<EventRow> {
  const atIso = typeof at === "string" ? at : at.toISOString();
  const wheres: string[] = ["ts <= ?"];
  const params: (string | number)[] = [atIso];
  pushEventFilters(wheres, params, opts);

  const sql = `
    ${EVENT_SELECT}
    WHERE ${wheres.join(" AND ")}
    ORDER BY session_id, ts, id
  `;

  const rows = db.query<EventSqlRow, (string | number)[]>(sql).iterate(...params);
  for (const row of rows) yield mapEventRow(row);
}

/** Tool-call activity span: tool_use start through matching tool_result completion. */
export interface ToolSpan {
  sessionId: string;
  projectPath: string;
  toolCallId: string;
  toolName: string | null;
  startedAt: string;
  endedAt: string | null;
  startEventId: number;
  endEventId: number | null;
  error: boolean;
  /** True when no tool_result has landed yet for this call. */
  open: boolean;
}

/**
 * Tool activity spans for tool_use rows that carry a tool_call_id.
 * Completion is the latest tool_result sharing (session_id, tool_call_id).
 */
export function* toolSpans(db: Db, opts: EventQueryOpts = {}): Iterable<ToolSpan> {
  const wheres: string[] = ["kind = 'tool_use'", "tool_call_id IS NOT NULL"];
  const params: (string | number)[] = [];
  pushEventFilters(wheres, params, opts);

  const sql = `
    SELECT id, session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id, is_boilerplate
    FROM events
    WHERE ${wheres.join(" AND ")}
    ORDER BY session_id, ts, id
  `;

  const uses = db.query<EventSqlRow, (string | number)[]>(sql).all(...params);

  // Preload results keyed by session + call id (latest by ts, id wins).
  const resultWheres: string[] = ["kind = 'tool_result'", "tool_call_id IS NOT NULL"];
  const resultParams: (string | number)[] = [];
  pushEventFilters(resultWheres, resultParams, opts);
  const resultSql = `
    SELECT id, session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id, is_boilerplate
    FROM events
    WHERE ${resultWheres.join(" AND ")}
    ORDER BY session_id, ts, id
  `;
  const results = db.query<EventSqlRow, (string | number)[]>(resultSql).all(...resultParams);
  const latestResult = new Map<string, EventSqlRow>();
  for (const r of results) {
    if (!r.tool_call_id) continue;
    latestResult.set(`${r.session_id}\0${r.tool_call_id}`, r);
  }

  for (const use of uses) {
    if (!use.tool_call_id) continue;
    const res = latestResult.get(`${use.session_id}\0${use.tool_call_id}`) ?? null;
    yield {
      sessionId: use.session_id,
      projectPath: use.project_path,
      toolCallId: use.tool_call_id,
      toolName: use.tool_name,
      startedAt: use.ts,
      endedAt: res?.ts ?? null,
      startEventId: use.id,
      endEventId: res?.id ?? null,
      error: res?.tool_error === 1,
      open: res == null,
    };
  }
}

/**
 * Events in a single tool call's span: from the tool_use row through its
 * tool_result (inclusive), ordered by ts then id. Open spans yield from start
 * onward within the session (no upper bound).
 */
export function* eventsInToolSpan(
  db: Db,
  sessionId: string,
  toolCallId: string,
): Iterable<EventRow> {
  const use = db
    .query<EventSqlRow, [string, string]>(
      `${EVENT_SELECT}
       WHERE session_id = ? AND kind = 'tool_use' AND tool_call_id = ?
       ORDER BY ts, id LIMIT 1`,
    )
    .get(sessionId, toolCallId);
  if (!use) return;

  const res = db
    .query<EventSqlRow, [string, string]>(
      `${EVENT_SELECT}
       WHERE session_id = ? AND kind = 'tool_result' AND tool_call_id = ?
       ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(sessionId, toolCallId);

  const wheres = ["session_id = ?", "((ts > ?) OR (ts = ? AND id >= ?))"];
  const params: (string | number)[] = [sessionId, use.ts, use.ts, use.id];
  if (res) {
    wheres.push("((ts < ?) OR (ts = ? AND id <= ?))");
    params.push(res.ts, res.ts, res.id);
  }

  const sql = `
    ${EVENT_SELECT}
    WHERE ${wheres.join(" AND ")}
    ORDER BY ts, id
  `;
  const rows = db.query<EventSqlRow, (string | number)[]>(sql).iterate(...params);
  for (const row of rows) yield mapEventRow(row);
}
