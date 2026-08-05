/**
 * Append-only lens audit log.
 *
 * Every lens invocation (accepted, refused, dry-run) appends one JSONL record.
 * Path defaults to ~/.amore/instruments/speculum/lens-audit.jsonl and is
 * printed by `speculum lens --help`.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultAuditPath } from "./paths";
import type { ScrubCounts } from "./scrub";

export type AuditDecision = "accepted" | "refused" | "dry-run";

export interface SelectionDescriptor {
  sessionId?: string | null;
  sessionIds?: string[] | null;
  projectPath?: string | null;
  since?: string | null;
  until?: string | null;
  lastN?: number | null;
  probeHit?: string | null;
  includeSubagents?: boolean;
}

export interface AuditUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  [key: string]: number | undefined;
}

export interface AuditRecord {
  ts: string;
  lens: string;
  selection: SelectionDescriptor;
  payloadBytes: number;
  scrubCounts: ScrubCounts;
  decision: AuditDecision;
  reason: string | null;
  /** Present when the model was invoked. */
  modelId?: string | null;
  usage?: AuditUsage | null;
  sessionIdFromEnvelope?: string | null;
  stopReason?: string | null;
  durationMs?: number | null;
  reportPath?: string | null;
}

export function appendAuditRecord(
  record: AuditRecord,
  path: string = defaultAuditPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

/** Read the last N audit records (oldest of the tail first). */
export function readAuditTail(path: string, n: number): AuditRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const slice = n > 0 ? lines.slice(-n) : lines;
  const out: AuditRecord[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as AuditRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

export { defaultAuditPath };
