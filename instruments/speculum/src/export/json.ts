/**
 * Canonical JSON renderer for export documents.
 * Pure: structured report in → serialized string out.
 */

import type { ExportDocument } from "./types";

/** Pretty-print the export document. Stable key order follows object construction. */
export function renderJson(doc: ExportDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}
