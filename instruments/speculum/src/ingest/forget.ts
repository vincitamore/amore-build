/**
 * Forget a session from the derived index. Source session files on disk are
 * untouched; only the sqlite index is purged, and ingest_state is marked so
 * a later ingest will not re-index the forgotten updates.jsonl.
 *
 * Accepts a full session id or a unique prefix (brief: forget <session-prefix>).
 */

import type { Db } from "../store/db";

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

const WILDCARD_CHARS = /[%_*]/;

export function forgetSession(db: Db, sessionPrefix: string): ForgetResult {
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
    // Still mark ingest_state paths containing the prefix so re-ingest stays dark.
    const mark = db
      .prepare(
        "UPDATE ingest_state SET forgotten = 1 WHERE file_path LIKE '%' || ? || '%' AND forgotten = 0",
      )
      .run(sessionPrefix);
    return {
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
  const delEvents = db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
  const delUsage = db.prepare("DELETE FROM usage WHERE session_id = ?").run(sessionId);
  const delSession = db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  const markForgotten = db
    .prepare(
      "UPDATE ingest_state SET forgotten = 1 WHERE file_path LIKE '%' || ? || '%' ",
    )
    .run(sessionId);

  return {
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
}
