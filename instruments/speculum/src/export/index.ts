/**
 * Export renderers — pure projections of the structured export document.
 * File write and DB access live in the command layer.
 */

export type {
  ExportDocument,
  ExportFormat,
  ExportSource,
  ExportSurface,
  ExportWindow,
} from "./types";
export { SENSITIVE_EXPORT_WARNING } from "./types";
export type { SessionExportData, SessionExportEvent } from "./session-data";
export { renderJson } from "./json";
export { renderCsv } from "./csv";
export { renderMarkdown } from "./markdown";

import type { ExportDocument, ExportFormat } from "./types";
import { renderJson } from "./json";
import { renderCsv } from "./csv";
import { renderMarkdown } from "./markdown";

/** Dispatch to the format-specific pure renderer. */
export function renderExport(doc: ExportDocument, format: ExportFormat): string {
  switch (format) {
    case "json":
      return renderJson(doc);
    case "csv":
      return renderCsv(doc);
    case "md":
      return renderMarkdown(doc);
    default: {
      const _exhaustive: never = format;
      throw new Error(`unsupported export format: ${String(_exhaustive)}`);
    }
  }
}
