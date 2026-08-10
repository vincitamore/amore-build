/**
 * Session-dir walker over ~/.amore/sessions/<urlencoded-cwd>/<uuid>/.
 * Authoritative stream: updates.jsonl. Joins summary.json and subagents meta.json.
 * Incremental via mtime/size cursor in ingest_state. Store is rebuildable.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Db } from "../store/db";
import { decodeCwdDirName } from "../store/db";
import {
  clearEventsFts,
  deleteSessionFromFts,
  upsertEventFts,
} from "../store/search";
import { sessionsRoot } from "../paths";
import {
  coalesceMessageChunks,
  normalizeUpdatesLine,
  parseSubagentMeta,
  parseSummaryJson,
  type AgentRole,
  type NormalizedEvent,
  type NormalizedUsage,
} from "./parser";
import { matchSensitivePatterns } from "../probes/sensitive-content";
import { rebuildEventLinksAndDecisions } from "../decisions";

// WU-04: progress callback shape (per-file / per-stage, not a pipeline).
export type IngestPhase = "list" | "session" | "rebuild" | "done";

export interface IngestProgress {
  phase: IngestPhase;
  sessionsDone: number;
  sessionsTotal: number;
  eventsAppended: number;
  pct: number;
}

export interface IngestOptions {
  /** Force re-read every updates.jsonl from byte 0 (after wipe of those sessions). */
  full?: boolean;
  /** Override sessions root (tests / SPECULUM_SESSIONS_DIR). */
  sessionsDir?: string;
  /** Max session dirs to process (tests). */
  limit?: number;
  /**
   * Walk + parse + count only. Never writes to the DB or mutates ingest_state.
   * Used for live-shape validation and CLI --dry-run.
   */
  dryRun?: boolean;
  // WU-04
  /** Optional progress callback (per session / stage). */
  onProgress?: (p: IngestProgress) => void;
}

export interface IngestStats {
  sessionDirsScanned: number;
  sessionDirsIngested: number;
  sessionDirsSkippedUnchanged: number;
  sessionDirsSkippedForgotten: number;
  eventsAppended: number;
  usageRowsAppended: number;
  linesSeen: number;
  linesParsed: number;
  linesSkipped: number;
  errors: number;
  durationMs: number;
  dryRun: boolean;
  // WU-04: named stage timings (ms)
  listMs: number;
  parseMs: number;
  writeMs: number;
  rebuildMs: number;
}

interface FileCursor {
  size_bytes: number;
  mtime: string;
  byte_offset: number;
  forgotten: number;
}

function getCursor(db: Db, filePath: string): FileCursor | null {
  return (
    db
      .query<FileCursor, [string]>(
        "SELECT size_bytes, mtime, byte_offset, forgotten FROM ingest_state WHERE file_path = ?",
      )
      .get(filePath) ?? null
  );
}

function setCursor(
  db: Db,
  filePath: string,
  sizeBytes: number,
  mtime: string,
  byteOffset: number,
): void {
  db.prepare(
    `INSERT INTO ingest_state(file_path, size_bytes, mtime, byte_offset, last_ingested)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       size_bytes = excluded.size_bytes,
       mtime = excluded.mtime,
       byte_offset = excluded.byte_offset,
       last_ingested = excluded.last_ingested`,
  ).run(filePath, sizeBytes, mtime, byteOffset, new Date().toISOString());
}

const INSERT_EVENT = `INSERT INTO events
  (session_id, project_path, agent, parent_session, ts, kind, text,
   tool_name, tool_input, tool_output, tool_error, tool_call_id, is_boilerplate, sensitive, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_USAGE = `INSERT INTO usage
  (session_id, project_path, ts, model_id, input_tokens, output_tokens,
   cached_read_tokens, reasoning_tokens, total_tokens, num_turns, model_calls, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// WU-08: flag-only sensitive mark from the shared bank; never rewrites raw.
function eventIsSensitive(ev: NormalizedEvent): boolean {
  for (const blob of [ev.text, ev.tool_input, ev.tool_output]) {
    if (blob && matchSensitivePatterns(blob).length > 0) return true;
  }
  return false;
}

function insertEvent(stmt: ReturnType<Db["prepare"]>, ev: NormalizedEvent): number {
  const sensitive = eventIsSensitive(ev) ? 1 : 0;
  const info = stmt.run(
    ev.session_id,
    ev.project_path,
    ev.agent,
    ev.parent_session,
    ev.ts,
    ev.kind,
    ev.text,
    ev.tool_name,
    ev.tool_input,
    ev.tool_output,
    ev.tool_error,
    ev.tool_call_id,
    ev.is_boilerplate,
    sensitive,
    ev.raw,
  );
  return Number(info.lastInsertRowid);
}

function insertUsage(stmt: ReturnType<Db["prepare"]>, u: NormalizedUsage): void {
  stmt.run(
    u.session_id,
    u.project_path,
    u.ts,
    u.model_id,
    u.input_tokens,
    u.output_tokens,
    u.cached_read_tokens,
    u.reasoning_tokens,
    u.total_tokens,
    u.num_turns,
    u.model_calls,
    u.raw,
  );
}

function rebuildSessions(db: Db): void {
  db.run("DELETE FROM sessions");
  db.run(`
    INSERT INTO sessions (
      id, project_path, agent, parent_session, model_id,
      started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
    )
    SELECT
      e.session_id,
      MIN(e.project_path),
      MIN(e.agent),
      MIN(e.parent_session),
      (SELECT u.model_id FROM usage u WHERE u.session_id = e.session_id AND u.model_id IS NOT NULL LIMIT 1),
      MIN(e.ts),
      MAX(e.ts),
      COUNT(*),
      SUM(CASE WHEN e.kind = 'user' AND e.is_boilerplate = 0 THEN 1 ELSE 0 END),
      SUM(CASE WHEN e.kind = 'tool_use' THEN 1 ELSE 0 END),
      SUM(CASE WHEN e.kind = 'tool_result' AND e.tool_error = 1 THEN 1 ELSE 0 END)
    FROM events e
    GROUP BY e.session_id
  `);
}

interface SessionDir {
  sessionDir: string;
  sessionId: string;
  projectPath: string;
  updatesPath: string;
  summaryPath: string;
  subagentsDir: string;
}

/**
 * Walk sessions root → list session directories that contain updates.jsonl.
 */
export function listSessionDirs(root: string): SessionDir[] {
  const out: SessionDir[] = [];
  if (!existsSync(root)) return out;

  let cwdGroups: string[];
  try {
    cwdGroups = readdirSync(root);
  } catch {
    return out;
  }

  for (const cwdEnc of cwdGroups) {
    const cwdPath = join(root, cwdEnc);
    let st;
    try {
      st = statSync(cwdPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const projectPath = decodeCwdDirName(cwdEnc);
    let sessionIds: string[];
    try {
      sessionIds = readdirSync(cwdPath);
    } catch {
      continue;
    }

    for (const sessionId of sessionIds) {
      const sessionDir = join(cwdPath, sessionId);
      let sst;
      try {
        sst = statSync(sessionDir);
      } catch {
        continue;
      }
      if (!sst.isDirectory()) continue;

      const updatesPath = join(sessionDir, "updates.jsonl");
      if (!existsSync(updatesPath)) continue;

      out.push({
        sessionDir,
        sessionId,
        projectPath,
        updatesPath,
        summaryPath: join(sessionDir, "summary.json"),
        subagentsDir: join(sessionDir, "subagents"),
      });
    }
  }
  return out;
}

function loadParentLinks(sessionDir: SessionDir): Map<string, string> {
  /** childSessionId → parentSessionId */
  const links = new Map<string, string>();
  if (!existsSync(sessionDir.subagentsDir)) return links;
  let kids: string[];
  try {
    kids = readdirSync(sessionDir.subagentsDir);
  } catch {
    return links;
  }
  for (const kid of kids) {
    const metaPath = join(sessionDir.subagentsDir, kid, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = parseSubagentMeta(readFileSync(metaPath, "utf-8"));
      if (meta) links.set(meta.childSessionId, meta.parentSessionId);
    } catch {
      // tolerate
    }
  }
  return links;
}

/** Global parent map built while scanning (subagent meta lives under parent dir). */
function buildParentMap(sessions: SessionDir[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sessions) {
    for (const [child, parent] of loadParentLinks(s)) {
      map.set(child, parent);
    }
  }
  return map;
}

function resolveAgent(
  sessionId: string,
  parentMap: Map<string, string>,
): { agent: AgentRole; parentSession: string | null } {
  const parent = parentMap.get(sessionId) ?? null;
  return parent ? { agent: "subagent", parentSession: parent } : { agent: "primary", parentSession: null };
}

function parseUpdatesFromOffset(
  filePath: string,
  startOffset: number,
  ctx: {
    sessionId: string;
    projectPath: string;
    agent: AgentRole;
    parentSession: string | null;
  },
): {
  events: NormalizedEvent[];
  usage: NormalizedUsage[];
  linesSeen: number;
  linesParsed: number;
  linesSkipped: number;
  bytesProcessed: number;
  sizeBytes: number;
  mtimeIso: string;
} {
  const stat = statSync(filePath);
  const sizeBytes = stat.size;
  const mtimeIso = new Date(stat.mtimeMs).toISOString();
  const buf = readFileSync(filePath);
  const slice = startOffset > 0 ? buf.subarray(startOffset) : buf;

  const rawEvents: NormalizedEvent[] = [];
  const usage: NormalizedUsage[] = [];
  let linesSeen = 0;
  let linesParsed = 0;
  let linesSkipped = 0;
  let bytesProcessed = startOffset;
  let lineStart = 0;

  for (let i = 0; i < slice.length; i++) {
    if (slice[i] !== 0x0a) continue;
    const lineBytes = slice.subarray(lineStart, i);
    const lineStr = lineBytes.toString("utf-8");
    lineStart = i + 1;
    bytesProcessed = startOffset + i + 1;

    if (!lineStr.replace(/\r$/, "").trim()) continue;
    linesSeen++;
    const result = normalizeUpdatesLine(lineStr, ctx);
    if (!result) {
      linesSkipped++;
      continue;
    }
    linesParsed++;
    if (result.event) rawEvents.push(result.event);
    if (result.usage) usage.push(result.usage);
  }

  // Trailing line without newline
  if (lineStart < slice.length) {
    const lineStr = slice.subarray(lineStart).toString("utf-8");
    bytesProcessed = startOffset + slice.length;
    if (lineStr.replace(/\r$/, "").trim()) {
      linesSeen++;
      const result = normalizeUpdatesLine(lineStr, ctx);
      if (!result) linesSkipped++;
      else {
        linesParsed++;
        if (result.event) rawEvents.push(result.event);
        if (result.usage) usage.push(result.usage);
      }
    }
  }

  return {
    events: coalesceMessageChunks(rawEvents),
    usage,
    linesSeen,
    linesParsed,
    linesSkipped,
    bytesProcessed,
    sizeBytes,
    mtimeIso,
  };
}

export function ingest(db: Db, opts: IngestOptions = {}): IngestStats {
  const started = Date.now();
  const root = opts.sessionsDir ?? sessionsRoot();
  const dryRun = opts.dryRun === true;
  const full = opts.full === true;
  // WU-04
  const onProgress = opts.onProgress;

  const stats: IngestStats = {
    sessionDirsScanned: 0,
    sessionDirsIngested: 0,
    sessionDirsSkippedUnchanged: 0,
    sessionDirsSkippedForgotten: 0,
    eventsAppended: 0,
    usageRowsAppended: 0,
    linesSeen: 0,
    linesParsed: 0,
    linesSkipped: 0,
    errors: 0,
    durationMs: 0,
    dryRun,
    // WU-04
    listMs: 0,
    parseMs: 0,
    writeMs: 0,
    rebuildMs: 0,
  };

  // WU-04: progress emitter (no-op when callback absent)
  const emit = (
    phase: IngestPhase,
    sessionsDone: number,
    sessionsTotal: number,
  ): void => {
    if (!onProgress) return;
    const pct =
      phase === "done"
        ? 100
        : sessionsTotal > 0
          ? Math.min(100, Math.floor((sessionsDone / sessionsTotal) * 100))
          : 0;
    onProgress({
      phase,
      sessionsDone,
      sessionsTotal,
      eventsAppended: stats.eventsAppended,
      pct,
    });
  };

  if (!existsSync(root)) {
    stats.durationMs = Date.now() - started;
    emit("done", 0, 0);
    return stats;
  }

  // WU-04: list stage
  const tList0 = Date.now();
  let sessions = listSessionDirs(root);
  if (typeof opts.limit === "number" && opts.limit >= 0) {
    sessions = sessions.slice(0, opts.limit);
  }

  const parentMap = buildParentMap(sessions);
  stats.listMs = Date.now() - tList0;
  const sessionsTotal = sessions.length;
  emit("list", 0, sessionsTotal);

  const insertEventStmt = dryRun ? null : db.prepare(INSERT_EVENT);
  const insertUsageStmt = dryRun ? null : db.prepare(INSERT_USAGE);

  if (!dryRun && full) {
    // Wipe all events/usage for a clean rebuild (respect forgotten cursors still).
    db.run("DELETE FROM events");
    db.run("DELETE FROM usage");
    db.run("DELETE FROM sessions");
    // Reset byte offsets so every non-forgotten file re-reads from 0.
    db.run("UPDATE ingest_state SET byte_offset = 0, size_bytes = 0 WHERE forgotten = 0");
    // WU-11: clear FTS with the events wipe so --full rebuilds the sparse index too.
    clearEventsFts(db);
  }

  const tx = dryRun
    ? null
    : db.transaction((work: () => void) => {
        work();
      });

  const processAll = () => {
    for (const s of sessions) {
      stats.sessionDirsScanned++;

      let projectPath = s.projectPath;
      let modelId: string | null = null;
      if (existsSync(s.summaryPath)) {
        try {
          const meta = parseSummaryJson(readFileSync(s.summaryPath, "utf-8"), s.sessionId, s.projectPath);
          projectPath = meta.projectPath || projectPath;
          modelId = meta.modelId;
          void modelId;
        } catch {
          // tolerate
        }
      }

      const { agent, parentSession } = resolveAgent(s.sessionId, parentMap);
      const ctx = {
        sessionId: s.sessionId,
        projectPath,
        agent,
        parentSession,
      };

      let cursor: FileCursor | null = null;
      if (!dryRun) {
        cursor = getCursor(db, s.updatesPath);
        if (cursor?.forgotten === 1) {
          stats.sessionDirsSkippedForgotten++;
          // WU-04
          emit("session", stats.sessionDirsScanned, sessionsTotal);
          continue;
        }
      }

      let startOffset = 0;
      if (!dryRun && !full && cursor) {
        try {
          const st = statSync(s.updatesPath);
          const mtimeIso = new Date(st.mtimeMs).toISOString();
          if (cursor.size_bytes === st.size && cursor.mtime === mtimeIso) {
            stats.sessionDirsSkippedUnchanged++;
            // WU-04
            emit("session", stats.sessionDirsScanned, sessionsTotal);
            continue;
          }
          if (cursor.size_bytes <= st.size) {
            startOffset = cursor.byte_offset;
          }
          // shrunk → startOffset 0
        } catch {
          stats.errors++;
          // WU-04
          emit("session", stats.sessionDirsScanned, sessionsTotal);
          continue;
        }
      }

      if (!dryRun && startOffset === 0 && cursor && !full) {
        // Re-read from start: wipe prior rows for this session.
        // WU-11: drop FTS rows for this session before events DELETE.
        deleteSessionFromFts(db, s.sessionId);
        db.prepare("DELETE FROM events WHERE session_id = ?").run(s.sessionId);
        db.prepare("DELETE FROM usage WHERE session_id = ?").run(s.sessionId);
      }

      try {
        // WU-04: parse stage accumulator
        const tParse0 = Date.now();
        const parsed = parseUpdatesFromOffset(s.updatesPath, startOffset, ctx);
        stats.parseMs += Date.now() - tParse0;
        stats.linesSeen += parsed.linesSeen;
        stats.linesParsed += parsed.linesParsed;
        stats.linesSkipped += parsed.linesSkipped;

        if (!dryRun && insertEventStmt && insertUsageStmt) {
          // WU-04: write stage accumulator
          const tWrite0 = Date.now();
          for (const ev of parsed.events) {
            const eventId = insertEvent(insertEventStmt, ev);
            // WU-11: keep events_fts in sync with each inserted event row.
            upsertEventFts(db, eventId, {
              text: ev.text,
              tool_name: ev.tool_name,
              tool_input: ev.tool_input,
              tool_output: ev.tool_output,
            });
            stats.eventsAppended++;
          }
          for (const u of parsed.usage) {
            // Prefer summary model when usage lacks modelUsage keys.
            if (!u.model_id && modelId) u.model_id = modelId;
            insertUsage(insertUsageStmt, u);
            stats.usageRowsAppended++;
          }
          setCursor(db, s.updatesPath, parsed.sizeBytes, parsed.mtimeIso, parsed.bytesProcessed);
          stats.writeMs += Date.now() - tWrite0;
        } else {
          stats.eventsAppended += parsed.events.length;
          stats.usageRowsAppended += parsed.usage.length;
        }
        stats.sessionDirsIngested++;
      } catch {
        stats.errors++;
      }
      // WU-04
      emit("session", stats.sessionDirsScanned, sessionsTotal);
    }

    if (!dryRun) {
      // WU-04: rebuild stage
      emit("rebuild", sessionsTotal, sessionsTotal);
      const tRebuild0 = Date.now();
      rebuildSessions(db);
      // WU-14: re-derive event_links + decisions after events/sessions settle.
      // Single ordered scan → wipe + bulk insert; never hand-maintained.
      rebuildEventLinksAndDecisions(db);
      stats.rebuildMs = Date.now() - tRebuild0;
    }
  };

  if (tx) tx(processAll);
  else processAll();

  stats.durationMs = Date.now() - started;
  // WU-04
  emit("done", sessionsTotal, sessionsTotal);
  return stats;
}

/** Ensure instrument data dir exists (for first-run store creation). */
export function ensureInstrumentHome(home: string): void {
  mkdirSync(home, { recursive: true });
}

export {
  normalizeUpdatesLine,
  parseUpdatesJsonl,
  parseSummaryJson,
  parseSubagentMeta,
  extractContentText,
  coalesceMessageChunks,
} from "./parser";
