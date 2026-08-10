/**
 * Forget a session from the derived index. Source session files on disk are
 * untouched; only the sqlite index is purged, and ingest_state is marked so
 * a later ingest will not re-index the forgotten updates.jsonl.
 *
 * Accepts a full session id or a unique prefix (brief: forget <session-prefix>).
 *
 * Every successful purge appends one record to the forget audit JSONL
 * (sibling of the lens audit — never mixed into lens hygiene metrics).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "../store/db";
import { defaultForgetAuditPath } from "../paths";

export interface ForgetResult {
  ok: boolean;
  sessionId: string;
  matchedSessions: string[];
  found: boolean;
  eventsDeleted: number;
  usageDeleted: number;
  sessionRowsDeleted: number;
  filesMarkedForgotten: number;
  message: string;
}

/** One append-only forget-audit.jsonl record. */
export interface ForgetAuditRecord {
  ts: string;
  action: "forget";
  sessionPrefix: string;
  sessionId: string | null;
  found: boolean;
  eventsDeleted: number;
  usageDeleted: number;
  sessionRowsDeleted: number;
  filesMarkedForgotten: number;
  /** Source file sizes from ingest_state when available (no content hash stored). */
  sources: Array<{ filePath: string; sizeBytes: number; mtime: string }>;
}

export interface ForgetOpts {
  /** Override forget-audit.jsonl path (tests). Default: defaultForgetAuditPath(). */
  auditPath?: string;
  /** Skip ledger append (tests that only assert purge identity). */
  skipAudit?: boolean;
}

const WILDCARD_CHARS = /[%_*]/;

function collectSourceMeta(
  db: Db,
  sessionKey: string,
): Array<{ filePath: string; sizeBytes: number; mtime: string }> {
  try {
    const rows = db
      .query<{ file_path: string; size_bytes: number; mtime: string }, [string]>(
        "SELECT file_path, size_bytes, mtime FROM ingest_state WHERE file_path LIKE '%' || ? || '%' ORDER BY file_path",
      )
      .all(sessionKey);
    return rows.map((r) => ({
      filePath: r.file_path,
      sizeBytes: r.size_bytes,
      mtime: r.mtime,
    }));
  } catch {
    return [];
  }
}

export function appendForgetAuditRecord(
  record: ForgetAuditRecord,
  path: string = defaultForgetAuditPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

function writeAudit(
  sessionPrefix: string,
  result: ForgetResult,
  sources: Array<{ filePath: string; sizeBytes: number; mtime: string }>,
  opts: ForgetOpts,
): void {
  if (opts.skipAudit || !result.ok) return;
  const record: ForgetAuditRecord = {
    ts: new Date().toISOString(),
    action: "forget",
    sessionPrefix,
    sessionId: result.found ? result.sessionId : null,
    found: result.found,
    eventsDeleted: result.eventsDeleted,
    usageDeleted: result.usageDeleted,
    sessionRowsDeleted: result.sessionRowsDeleted,
    filesMarkedForgotten: result.filesMarkedForgotten,
    sources,
  };
  try {
    appendForgetAuditRecord(record, opts.auditPath ?? defaultForgetAuditPath());
  } catch {
    // Ledger is best-effort: never reverse a completed purge because audit I/O failed.
  }
}

export function forgetSession(
  db: Db,
  sessionPrefix: string,
  opts: ForgetOpts = {},
): ForgetResult {
  if (WILDCARD_CHARS.test(sessionPrefix)) {
    return {
      ok: false,
      sessionId: sessionPrefix,
      matchedSessions: [],
      found: false,
      eventsDeleted: 0,
      usageDeleted: 0,
      sessionRowsDeleted: 0,
      filesMarkedForgotten: 0,
      message: `refusing: '${sessionPrefix}' contains a wildcard character — pass an explicit session id or unique prefix`,
    };
  }

  // Exact match first, then unique prefix.
  const exact = db
    .query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id = ?")
    .get(sessionPrefix);

  let matched: string[] = [];
  if (exact) {
    matched = [exact.id];
  } else {
    const rows = db
      .query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id LIKE ? || '%' ORDER BY id")
      .all(sessionPrefix);
    matched = rows.map((r) => r.id);
    // Also consider events-only sessions (no sessions row yet).
    if (matched.length === 0) {
      const fromEvents = db
        .query<{ session_id: string }, [string]>(
          "SELECT DISTINCT session_id FROM events WHERE session_id LIKE ? || '%' ORDER BY session_id",
        )
        .all(sessionPrefix);
      matched = fromEvents.map((r) => r.session_id);
    }
  }

  if (matched.length === 0) {
    // Capture source meta before the mark so size/mtime remain accurate.
    const sources = collectSourceMeta(db, sessionPrefix);
    const mark = db
      .prepare(
        "UPDATE ingest_state SET forgotten = 1 WHERE file_path LIKE '%' || ? || '%' AND forgotten = 0",
      )
      .run(sessionPrefix);
    const result: ForgetResult = {
      ok: true,
      sessionId: sessionPrefix,
      matchedSessions: [],
      found: false,
      eventsDeleted: 0,
      usageDeleted: 0,
      sessionRowsDeleted: 0,
      filesMarkedForgotten: mark.changes,
      message: `no session matching '${sessionPrefix}' in index; marked ${mark.changes} ingest_state path(s) forgotten`,
    };
    writeAudit(sessionPrefix, result, sources, opts);
    return result;
  }

  if (matched.length > 1) {
    return {
      ok: false,
      sessionId: sessionPrefix,
      matchedSessions: matched,
      found: true,
      eventsDeleted: 0,
      usageDeleted: 0,
      sessionRowsDeleted: 0,
      filesMarkedForgotten: 0,
      message: `prefix '${sessionPrefix}' matches ${matched.length} sessions; pass a longer unique prefix`,
    };
  }

  const sessionId = matched[0]!;
  // Capture source file sizes before forgotten flag flips.
  const sources = collectSourceMeta(db, sessionId);

  const delEvents = db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
  const delUsage = db.prepare("DELETE FROM usage WHERE session_id = ?").run(sessionId);
  const delSession = db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  const markForgotten = db
    .prepare(
      "UPDATE ingest_state SET forgotten = 1 WHERE file_path LIKE '%' || ? || '%' ",
    )
    .run(sessionId);

  const result: ForgetResult = {
    ok: true,
    sessionId,
    matchedSessions: [sessionId],
    found: true,
    eventsDeleted: delEvents.changes,
    usageDeleted: delUsage.changes,
    sessionRowsDeleted: delSession.changes,
    filesMarkedForgotten: markForgotten.changes,
    message: `forgot session ${sessionId}: ${delEvents.changes} event(s), ${delUsage.changes} usage row(s) deleted; ${markForgotten.changes} source file(s) marked forgotten`,
  };

  writeAudit(sessionPrefix, result, sources, opts);
  return result;
}
