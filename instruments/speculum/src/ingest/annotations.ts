/**
 * Per-session derived annotations (phase class, error density, probe-hit
 * counts, usage rollups, duration) into session_annotations.
 * Re-derived on every ingest rebuild; every row carries a method banner.
 */

import type { Db } from "../store/db";

/** Wipe + re-derive session_annotations from the settled index. */
export function rebuildSessionAnnotations(_db: Db): void {
  // Annotation derivation lands with the annotations surface.
}
