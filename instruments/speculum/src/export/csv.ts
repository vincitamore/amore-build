/**
 * CSV projection of an export document.
 * Pure: structured report in → serialized string out.
 *
 * Layout is surface-specific but always starts with envelope comment rows
 * (# key,value) so consumers can recover provenance without parsing JSON.
 */

import type { ExportDocument, ExportSurface } from "./types";
import type { ProbeResult, HitDetail } from "../probes/types";
import type { StatusReport } from "../commands/status";
import type { UsageReport } from "../commands/usage";
import type { SessionExportData } from "./session-data";

function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(cells: unknown[]): string {
  return cells.map(esc).join(",");
}

function envelopeComments(doc: ExportDocument): string[] {
  return [
    `# exportedAt,${esc(doc.exportedAt)}`,
    `# speculumVersion,${esc(doc.speculumVersion)}`,
    `# surface,${esc(doc.surface)}`,
    `# containsSensitive,${doc.containsSensitive ? "true" : "false"}`,
    `# window.since,${esc(doc.window.since)}`,
    `# window.until,${esc(doc.window.until)}`,
    `# window.project,${esc(doc.window.project)}`,
    `# source.db,${esc(doc.source.db)}`,
    `# source.auditPath,${esc(doc.source.auditPath)}`,
  ];
}

function renderScanCsv(data: ProbeResult[]): string[] {
  const lines: string[] = [
    row([
      "probe",
      "value",
      "ciLow",
      "ciHigh",
      "n",
      "unit",
      "partial",
      "heuristic",
      "summary",
      "hitSessionId",
      "hitEventId",
      "hitTs",
      "hitCategory",
      "hitEvidence",
    ]),
  ];

  for (const p of data) {
    const hits: HitDetail[] = p.hits ?? [];
    if (hits.length === 0) {
      lines.push(
        row([
          p.probe,
          p.value,
          p.ciLow,
          p.ciHigh,
          p.n,
          p.unit,
          p.partial,
          p.heuristic,
          p.summary ?? "",
          "",
          "",
          "",
          "",
          "",
        ]),
      );
      continue;
    }
    for (const h of hits) {
      lines.push(
        row([
          p.probe,
          p.value,
          p.ciLow,
          p.ciHigh,
          p.n,
          p.unit,
          p.partial,
          p.heuristic,
          p.summary ?? "",
          h.sessionId,
          h.eventId ?? (h.eventIds?.[0] ?? ""),
          h.ts ?? "",
          h.category ?? "",
          h.evidence,
        ]),
      );
    }
  }
  return lines;
}

function renderStatusCsv(data: StatusReport): string[] {
  const lines: string[] = [row(["key", "value"])];
  const flat: Array<[string, unknown]> = [
    ["generatedAt", data.generatedAt],
    ["db.path", data.db.path],
    ["db.sizeBytes", data.db.sizeBytes],
    ["counts.sessions", data.counts.sessions],
    ["counts.events", data.counts.events],
    ["counts.usageRows", data.counts.usageRows],
    ["counts.sensitiveEvents", data.counts.sensitiveEvents],
    ["counts.sensitiveSessions", data.counts.sensitiveSessions],
    ["ingest.trackedFiles", data.ingest.trackedFiles],
    ["ingest.forgottenFiles", data.ingest.forgottenFiles],
    ["ingest.lastIngestedAt", data.ingest.lastIngestedAt],
    ["ingest.oldestSessionStartedAt", data.ingest.oldestSessionStartedAt],
    ["ingest.newestSessionStartedAt", data.ingest.newestSessionStartedAt],
    ["probes.registered", data.probes.registered],
    ["probes.names", data.probes.names.join("|")],
    ["staleness.thresholdHours", data.staleness.thresholdHours],
    ["staleness.hoursSinceNewestSession", data.staleness.hoursSinceNewestSession],
    ["staleness.stale", data.staleness.stale],
    ["staleness.message", data.staleness.message],
  ];
  for (const [k, n] of Object.entries(data.counts.eventsByKind)) {
    flat.push([`counts.eventsByKind.${k}`, n]);
  }
  for (const [k, v] of flat) {
    lines.push(row([k, v]));
  }
  return lines;
}

function renderUsageCsv(data: UsageReport): string[] {
  const lines: string[] = [
    row([
      "model",
      "turns",
      "sessions",
      "tokens.input",
      "tokens.output",
      "tokens.cachedRead",
      "tokens.reasoning",
      "tokens.total",
    ]),
  ];
  for (const m of data.models) {
    lines.push(
      row([
        m.model,
        m.turns,
        m.sessions,
        m.tokens.input,
        m.tokens.output,
        m.tokens.cachedRead,
        m.tokens.reasoning,
        m.tokens.total,
      ]),
    );
  }
  lines.push(
    row([
      "(totals)",
      data.totals.turns,
      data.totals.sessions,
      data.totals.tokens.input,
      data.totals.tokens.output,
      data.totals.tokens.cachedRead,
      data.totals.tokens.reasoning,
      data.totals.tokens.total,
    ]),
  );
  return lines;
}

function renderSessionCsv(data: SessionExportData): string[] {
  const lines: string[] = [
    row([
      "sessionId",
      "eventId",
      "ts",
      "kind",
      "agent",
      "sensitive",
      "toolName",
      "text",
    ]),
  ];
  for (const e of data.events) {
    lines.push(
      row([
        data.sessionId,
        e.id,
        e.ts,
        e.kind,
        e.agent,
        e.sensitive,
        e.toolName ?? "",
        e.text ?? "",
      ]),
    );
  }
  return lines;
}

function bodyLines(doc: ExportDocument): string[] {
  const surface = doc.surface as ExportSurface;
  switch (surface) {
    case "scan":
      return renderScanCsv(doc.data as ProbeResult[]);
    case "status":
      return renderStatusCsv(doc.data as StatusReport);
    case "usage":
      return renderUsageCsv(doc.data as UsageReport);
    case "session":
      return renderSessionCsv(doc.data as SessionExportData);
    default:
      return [row(["error", `unsupported surface for csv: ${String(surface)}`])];
  }
}

/** Serialize an export document as CSV with envelope comments. */
export function renderCsv(doc: ExportDocument): string {
  return [...envelopeComments(doc), ...bodyLines(doc)].join("\n") + "\n";
}
