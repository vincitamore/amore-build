/**
 * Session facet fill: cwd_class from project_path, plus agent_name /
 * subagent_type / description joined from the session_meta side store.
 * Runs after rebuildSessions so the columns are set on every rebuild.
 */

import type { Db } from "../store/db";

/**
 * Fill the sessions facet columns for every row.
 * Columns default to '' until this pass runs.
 */
export function applySessionFacets(_db: Db): void {
  // Facet fill lands with the session-navigation surface.
}
