/**
 * Shared export document shape. JSON is the canonical form; CSV and Markdown
 * are projections of the same envelope + payload.
 */

/** Filter scope recorded on every export (null = unbounded). */
export interface ExportWindow {
  since: string | null;
  until: string | null;
  project: string | null;
  /** Scan: limit to one probe name. */
  probe?: string | null;
  /** Usage: model id substring filter. */
  model?: string | null;
  /** Session surface: single session id. */
  sessionId?: string | null;
}

export interface ExportSource {
  db: string;
  auditPath: string;
}

/** Surfaces the export verb can materialize from the local index. */
export type ExportSurface = "scan" | "status" | "usage" | "session";

export type ExportFormat = "json" | "csv" | "md";

/**
 * Envelope + payload. Every export carries provenance metadata and a
 * flag-only sensitive marker (never mutates the payload).
 */
export interface ExportDocument<T = unknown> {
  exportedAt: string;
  speculumVersion: string;
  surface: ExportSurface;
  window: ExportWindow;
  source: ExportSource;
  /** True when any events.sensitive=1 row falls in the export window. */
  containsSensitive: boolean;
  data: T;
}

/** Human-facing warning when containsSensitive is true (md / tty notes). */
export const SENSITIVE_EXPORT_WARNING =
  "WARNING: This export window includes events flagged as sensitive. Review before sharing.";
