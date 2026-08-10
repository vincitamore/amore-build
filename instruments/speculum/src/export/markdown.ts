/**
 * Markdown projection of an export document.
 * Pure: structured report in → serialized string out.
 * Emits a sensitive-content warning line when the envelope flag is set.
 */

import type { ExportDocument, ExportSurface } from "./types";
import { SENSITIVE_EXPORT_WARNING } from "./types";
import type { ProbeResult } from "../probes/types";
import type { StatusReport } from "../commands/status";
import type { UsageReport } from "../commands/usage";
import type { SessionExportData } from "./session-data";

function header(doc: ExportDocument): string[] {
  const lines: string[] = [
    `# Speculum export — ${doc.surface}`,
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| exportedAt | ${doc.exportedAt} |`,
    `| speculumVersion | ${doc.speculumVersion} |`,
    `| surface | ${doc.surface} |`,
    `| containsSensitive | ${doc.containsSensitive} |`,
    `| window.since | ${doc.window.since ?? "—"} |`,
    `| window.until | ${doc.window.until ?? "—"} |`,
    `| window.project | ${doc.window.project ?? "—"} |`,
    `| source.db | ${doc.source.db} |`,
    `| source.auditPath | ${doc.source.auditPath} |`,
    "",
  ];
  if (doc.containsSensitive) {
    lines.push(`**${SENSITIVE_EXPORT_WARNING}**`, "");
  }
  return lines;
}

function renderScanMd(data: ProbeResult[]): string[] {
  const lines: string[] = [
    "## Probes",
    "",
    "Rates are heuristic — pattern banks are unvalidated on this corpus.",
    "",
  ];
  for (const p of data) {
    lines.push(`### ${p.probe} \`[heuristic]\``);
    if (p.summary) lines.push("", p.summary);
    lines.push(
      "",
      `- value: ${p.value}`,
      `- ci95: [${p.ciLow}, ${p.ciHigh}]`,
      `- n: ${p.n} ${p.unit}s`,
      `- partial: ${p.partial}`,
    );
    const hits = p.hits ?? [];
    if (hits.length === 0) {
      lines.push("- hits: (none)", "");
      continue;
    }
    lines.push(`- hits (${hits.length}):`, "");
    for (const h of hits) {
      const parts = [`session=${h.sessionId}`];
      if (h.eventId !== undefined) parts.push(`eventId=${h.eventId}`);
      if (h.ts) parts.push(`ts=${h.ts}`);
      if (h.category) parts.push(`category=${h.category}`);
      parts.push(`evidence=${h.evidence}`);
      lines.push(`  - ${parts.join("  ")}`);
    }
    lines.push("");
  }
  return lines;
}

function renderStatusMd(data: StatusReport): string[] {
  return [
    "## Status",
    "",
    `- db: ${data.db.path} (${data.db.sizeBytes} bytes)`,
    `- sessions: ${data.counts.sessions}`,
    `- events: ${data.counts.events}`,
    `- usage rows: ${data.counts.usageRows}`,
    `- sensitive events: ${data.counts.sensitiveEvents}`,
    `- sensitive sessions: ${data.counts.sensitiveSessions}`,
    `- ingest tracked: ${data.ingest.trackedFiles} forgotten: ${data.ingest.forgottenFiles}`,
    `- last ingested: ${data.ingest.lastIngestedAt ?? "(never)"}`,
    `- probes: ${data.probes.registered} (${data.probes.names.join(", ")})`,
    `- ${data.staleness.message}`,
    "",
  ];
}

function renderUsageMd(data: UsageReport): string[] {
  const lines: string[] = [
    "## Usage",
    "",
    data.note,
    "",
    `- window: ${data.window.since ?? "…"} → ${data.window.until ?? "…"}`,
    `- totals: turns=${data.totals.turns} sessions=${data.totals.sessions} tokens=${data.totals.tokens.total}`,
    "",
  ];
  if (data.models.length === 0) {
    lines.push("(no usage rows)", "");
    return lines;
  }
  lines.push("| Model | Turns | Sessions | Tokens |", "| --- | ---: | ---: | ---: |");
  for (const m of data.models) {
    lines.push(`| ${m.model} | ${m.turns} | ${m.sessions} | ${m.tokens.total} |`);
  }
  lines.push("");
  return lines;
}

function renderSessionMd(data: SessionExportData): string[] {
  const lines: string[] = [
    "## Session",
    "",
    `- sessionId: ${data.sessionId}`,
    `- project: ${data.projectPath ?? "—"}`,
    `- events: ${data.events.length}`,
    "",
  ];
  if (data.events.length === 0) {
    lines.push("(no events)", "");
    return lines;
  }
  lines.push("| id | ts | kind | agent | sensitive | evidence |", "| ---: | --- | --- | --- | ---: | --- |");
  for (const e of data.events) {
    const evidence = e.toolName
      ? `tool=${e.toolName}`
      : (e.text ?? "").slice(0, 80).replace(/\|/g, "\\|");
    lines.push(
      `| ${e.id} | ${e.ts} | ${e.kind} | ${e.agent} | ${e.sensitive} | ${evidence} |`,
    );
  }
  lines.push("");
  return lines;
}

function body(doc: ExportDocument): string[] {
  const surface = doc.surface as ExportSurface;
  switch (surface) {
    case "scan":
      return renderScanMd(doc.data as ProbeResult[]);
    case "status":
      return renderStatusMd(doc.data as StatusReport);
    case "usage":
      return renderUsageMd(doc.data as UsageReport);
    case "session":
      return renderSessionMd(doc.data as SessionExportData);
    default:
      return [`(unsupported surface: ${String(surface)})`, ""];
  }
}

/** Serialize an export document as Markdown. */
export function renderMarkdown(doc: ExportDocument): string {
  return [...header(doc), ...body(doc)].join("\n");
}
