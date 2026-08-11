/**
 * `speculum summarize` — generate one-line titles for untitled sessions by
 * sending a scrubbed, compacted digest through the local amore binary.
 * Opt-in egress: scrub fails closed, every run is audited, results land in
 * generated_titles (which ingest --full never wipes).
 */

import { openDb } from "../store/db";
import { defaultAuditPath, defaultDbPath } from "../paths";
import {
  runSummarize,
  toJsonReport,
  DEFAULT_SUMMARIZE_LIMIT,
  type SummarizeRunOptions,
  type SummarizeRunReport,
} from "../summarize";

function parseArgs(args: string[]): SummarizeRunOptions & { json: boolean } {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`speculum summarize: generate titles for untitled sessions

Usage:
  speculum summarize [options]

Selection:
  --limit N        Cap sessions per run (default ${DEFAULT_SUMMARIZE_LIMIT})
  --session ID     One session (regenerates its title)
  --all            Remove the cap
  --force          Regenerate model-generated titles too

Options:
  --dry-run        Selection + scrub + cost plan; never invoke the model
  --json           Machine-readable results
  --audit-path P   Override audit log path

Privacy:
  Opt-in egress. Each session's digest is scrubbed locally before any model
  call. Scrub fails closed per session (other sessions continue). Every
  attempt is recorded in the audit log.

Audit log: ${defaultAuditPath()}
`);
    process.exit(0);
  }

  const opts: SummarizeRunOptions & { json: boolean } = { json: false };

  if (args.includes("--json")) opts.json = true;
  if (args.includes("--dry-run")) opts.dryRun = true;
  if (args.includes("--all")) opts.all = true;
  if (args.includes("--force")) opts.force = true;

  const sessionIdx = args.indexOf("--session");
  if (sessionIdx >= 0 && args[sessionIdx + 1]) {
    opts.sessionId = args[sessionIdx + 1];
  }

  const limitIdx = args.indexOf("--limit");
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    const n = Number.parseInt(args[limitIdx + 1]!, 10);
    if (Number.isFinite(n) && n > 0) opts.limit = n;
  }

  const auditIdx = args.indexOf("--audit-path");
  if (auditIdx >= 0 && args[auditIdx + 1]) {
    opts.auditPath = args[auditIdx + 1];
  }

  return opts;
}

function renderHuman(report: SummarizeRunReport): void {
  console.log("");
  console.log("speculum summarize");
  console.log("─".repeat(60));
  console.log(`  attempted:      ${report.attempted}`);
  console.log(`  generated:      ${report.generated}`);
  console.log(`  refused_scrub:  ${report.refused_scrub}`);
  console.log(`  failed_parse:   ${report.failed_parse}`);
  if (report.failed_spawn > 0) {
    console.log(`  failed_spawn:   ${report.failed_spawn}`);
  }
  if (report.empty_digest > 0) {
    console.log(`  empty_digest:   ${report.empty_digest}`);
  }
  console.log(`  dry-run:        ${report.dry_run ? "yes" : "no"}`);
  console.log("");

  if (report.results.length === 0) {
    console.log("  (no sessions matched selection)");
    console.log("");
    return;
  }

  for (const r of report.results) {
    const titleBit = r.title ? `  → ${r.title}` : "";
    const sizeBit =
      r.digestBytes != null
        ? `  ${r.digestBytes}B` +
          (r.estimatedTokens != null ? ` ~${r.estimatedTokens} tok` : "")
        : "";
    console.log(`  ${r.sessionId.slice(0, 8)}…  ${r.outcome}${sizeBit}${titleBit}`);
    if (r.reason && (r.outcome === "refused_scrub" || r.outcome === "failed_parse")) {
      console.log(`           ${r.reason}`);
    }
  }
  console.log("");

  if (report.dry_run) {
    const totalTok = report.results.reduce(
      (s, r) => s + (r.estimatedTokens ?? 0),
      0,
    );
    console.log(
      `dry-run complete: model was not invoked; est. input ~${totalTok} tokens across ${report.attempted} session(s)`,
    );
    console.log("");
  }
}

export async function summarizeCommand(args: string[]): Promise<void> {
  const { json, ...opts } = parseArgs(args);
  const dbPath = defaultDbPath();
  const db = openDb(dbPath);
  try {
    const report = await runSummarize(db, opts);
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(toJsonReport(report), null, 2));
    } else {
      renderHuman(report);
    }
    // Exit 0 for dry-run and all-success; 2 if any hard refuse/fail (not empty selection).
    if (report.dry_run) process.exit(0);
    const hard =
      report.refused_scrub +
      report.failed_parse +
      report.failed_spawn +
      report.empty_digest;
    if (report.attempted > 0 && hard === report.attempted && report.generated === 0) {
      process.exit(2);
    }
    process.exit(0);
  } finally {
    db.close();
  }
}
