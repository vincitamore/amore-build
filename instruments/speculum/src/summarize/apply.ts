/**
 * Persist a generated title: upsert generated_titles and update the sessions
 * row so pickers see the change without a re-ingest. The rebuild chain already
 * prefers generated_titles thereafter.
 */

import type { Db } from "../store/db";

export interface ApplyTitleInput {
  sessionId: string;
  title: string;
  summary: string;
  modelId: string;
  sourceEvents: number;
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
}

export interface AppliedTitle {
  sessionId: string;
  title: string;
  summary: string;
  modelId: string;
  createdAt: string;
  sourceEvents: number;
}

/**
 * Upsert generated_titles and set sessions.title / title_source = 'generated'.
 * No-op on missing session row for the sessions update (generated_titles still
 * lands so a later rebuild can pick it up).
 */
export function applyGeneratedTitle(db: Db, input: ApplyTitleInput): AppliedTitle {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const title = input.title.trim();
  const summary = input.summary ?? "";
  const modelId = input.modelId ?? "";
  const sourceEvents = Math.max(0, Math.trunc(input.sourceEvents));

  if (!title) {
    throw new Error("applyGeneratedTitle: title must be non-empty");
  }

  db.prepare(
    `INSERT INTO generated_titles
       (session_id, title, summary, model_id, created_at, source_events)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       title = excluded.title,
       summary = excluded.summary,
       model_id = excluded.model_id,
       created_at = excluded.created_at,
       source_events = excluded.source_events`,
  ).run(input.sessionId, title, summary, modelId, createdAt, sourceEvents);

  db.prepare(
    `UPDATE sessions
     SET title = ?, title_source = 'generated'
     WHERE id = ?`,
  ).run(title, input.sessionId);

  return {
    sessionId: input.sessionId,
    title,
    summary,
    modelId,
    createdAt,
    sourceEvents,
  };
}

/** Read a generated_titles row (tests / inspection). */
export function getGeneratedTitle(
  db: Db,
  sessionId: string,
): AppliedTitle | null {
  const row = db
    .query<
      {
        session_id: string;
        title: string;
        summary: string;
        model_id: string;
        created_at: string;
        source_events: number;
      },
      [string]
    >(
      `SELECT session_id, title, summary, model_id, created_at, source_events
       FROM generated_titles WHERE session_id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    modelId: row.model_id,
    createdAt: row.created_at,
    sourceEvents: row.source_events,
  };
}
