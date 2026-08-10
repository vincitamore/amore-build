/**
 * Session-surface payload shape shared by export renderers.
 * Kept separate so csv/md/json stay free of circular command imports.
 */

export interface SessionExportEvent {
  id: number;
  ts: string;
  kind: string;
  agent: string;
  sensitive: number;
  toolName: string | null;
  text: string | null;
}

export interface SessionExportData {
  sessionId: string;
  projectPath: string | null;
  startedAt: string | null;
  events: SessionExportEvent[];
}
