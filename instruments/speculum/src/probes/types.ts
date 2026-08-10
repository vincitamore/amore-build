import type { Db } from "../store/db";

export interface ProbeOptions {
  project?: string;
  since?: Date;
  until?: Date;
  includePartial?: boolean;
  unit?: "session" | "msg";
}

export interface HitDetail {
  sessionId: string;
  ts?: string;
  evidence: string;
  category?: string;
  /** events.id the finding came from (when the probe has a single source row). */
  eventId?: number;
  /** Multiple source event ids (e.g. session-aggregated sensitive hits). */
  eventIds?: number[];
  /** Optional quote from the source event text/channel. */
  sourceQuote?: string;
  /** tool_call_id when the finding is bound to a tool call. */
  toolCallId?: string;
}

export interface ProbeResult {
  probe: string;
  value: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  partial: boolean;
  unit: "session" | "msg";
  summary?: string;
  data?: unknown;
  hits?: HitDetail[];
  /** Always true for v1 — pattern banks are unvalidated on this corpus. */
  heuristic: true;
}

export type Probe = (db: Db, opts: ProbeOptions) => ProbeResult;

export function queryOptsFromProbe(opts: ProbeOptions): {
  projectPath?: string;
  since?: Date;
  until?: Date;
} {
  const out: { projectPath?: string; since?: Date; until?: Date } = {};
  if (opts.project) out.projectPath = opts.project;
  if (opts.since) out.since = opts.since;
  if (opts.until) out.until = opts.until;
  return out;
}
