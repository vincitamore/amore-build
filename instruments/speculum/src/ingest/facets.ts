/**
 * Session facet fill: cwd_class from project_path, plus agent_name /
 * subagent_type / description joined from the session_meta side store.
 * Runs after rebuildSessions so the columns are set on every rebuild.
 */

import { classifyCwd } from "../cwd-class";
import type { Db } from "../store/db";

/**
 * Fill the sessions facet columns for every row.
 * Columns default to '' until this pass runs. Idempotent.
 */
export function applySessionFacets(db: Db): void {
  // cwd_class: classify each distinct project_path once, then UPDATE by path.
  const paths = db
    .query<{ project_path: string }, []>("SELECT DISTINCT project_path FROM sessions")
    .all();
  const updateClass = db.prepare(
    "UPDATE sessions SET cwd_class = ? WHERE project_path = ?",
  );
  for (const row of paths) {
    updateClass.run(classifyCwd(row.project_path), row.project_path);
  }

  // agent_name / subagent_type / description from harvested session_meta.
  // Sessions with no meta row keep the empty defaults left by rebuildSessions.
  db.run(`
    UPDATE sessions SET
      agent_name = COALESCE(
        (SELECT m.agent_name FROM session_meta m WHERE m.session_id = sessions.id),
        ''
      ),
      subagent_type = COALESCE(
        (SELECT m.subagent_type FROM session_meta m WHERE m.session_id = sessions.id),
        ''
      ),
      description = COALESCE(
        (SELECT m.description FROM session_meta m WHERE m.session_id = sessions.id),
        ''
      )
  `);
}
