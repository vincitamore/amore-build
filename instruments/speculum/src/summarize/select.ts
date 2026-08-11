/**
 * Session selection for summarize: untitled operator sessions by default.
 */

import type { Db } from "../store/db";

export const DEFAULT_SUMMARIZE_LIMIT = 25;

export interface SelectOptions {
  /** Target one session (regenerates; ignores class/title filters). */
  sessionId?: string;
  /** Cap results; ignored when all=true or sessionId is set. Default 25. */
  limit?: number;
  /** Remove the limit cap. */
  all?: boolean;
  /** Also include sessions whose title_source is already 'generated'. */
  force?: boolean;
  /**
   * When true, drop the cwd_class = 'operator' filter. Used for live dry-run
   * diagnostics on pre-facet indexes where cwd_class is still empty.
   */
  ignoreCwdClass?: boolean;
}

export interface SelectedSession {
  id: string;
  projectPath: string;
  startedAt: string;
  title: string;
  titleSource: string;
  cwdClass: string;
}

/**
 * Select sessions for summarization.
 *
 * Default: title_source = '' AND cwd_class = 'operator', newest first, limit 25.
 * --force widens title_source to '' | 'generated'.
 * --session ID returns that row alone (if present), regardless of filters.
 */
export function selectSessionsForSummarize(
  db: Db,
  opts: SelectOptions = {},
): SelectedSession[] {
  if (opts.sessionId) {
    const row = db
      .query<
        {
          id: string;
          project_path: string;
          started_at: string;
          title: string;
          title_source: string;
          cwd_class: string;
        },
        [string]
      >(
        `SELECT id, project_path, started_at, title, title_source, cwd_class
         FROM sessions WHERE id = ?`,
      )
      .get(opts.sessionId);
    if (!row) return [];
    return [
      {
        id: row.id,
        projectPath: row.project_path,
        startedAt: row.started_at,
        title: row.title,
        titleSource: row.title_source,
        cwdClass: row.cwd_class,
      },
    ];
  }

  const wheres: string[] = [];
  const params: (string | number)[] = [];

  if (opts.force) {
    wheres.push(`(title_source = '' OR title_source = 'generated')`);
  } else {
    wheres.push(`title_source = ''`);
  }

  if (!opts.ignoreCwdClass) {
    wheres.push(`cwd_class = 'operator'`);
  }

  // Primary sessions only — titles surface on the operator picker.
  wheres.push(`agent = 'primary'`);

  let sql = `
    SELECT id, project_path, started_at, title, title_source, cwd_class
    FROM sessions
    WHERE ${wheres.join(" AND ")}
    ORDER BY started_at DESC
  `;

  if (!opts.all) {
    const limit = opts.limit ?? DEFAULT_SUMMARIZE_LIMIT;
    sql += ` LIMIT ?`;
    params.push(Math.max(1, Math.trunc(limit)));
  }

  const rows = db
    .query<
      {
        id: string;
        project_path: string;
        started_at: string;
        title: string;
        title_source: string;
        cwd_class: string;
      },
      (string | number)[]
    >(sql)
    .all(...params);

  return rows.map((r) => ({
    id: r.id,
    projectPath: r.project_path,
    startedAt: r.started_at,
    title: r.title,
    titleSource: r.title_source,
    cwdClass: r.cwd_class,
  }));
}

/** Rough token estimate from UTF-8 bytes (~4 chars/token). */
export function estimateTokens(bytes: number): number {
  return Math.max(0, Math.ceil(bytes / 4));
}
