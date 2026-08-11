/**
 * Evidence-only cross-session links (resumed_from, shared_artifact) into
 * session_links. Links are extracted from what the session record actually
 * states — never inferred from similarity or proximity.
 * Re-derived on every ingest rebuild; heuristic methods carry banners.
 */

import type { Db } from "../store/db";

/** Wipe + re-derive session_links from the settled index. */
export function rebuildSessionLinks(_db: Db): void {
  // Link extraction lands with the session-links surface.
}
