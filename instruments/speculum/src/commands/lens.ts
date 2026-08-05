/**
 * `speculum lens <name> [selection flags]`
 * `speculum lens --help` prints selection flags and the audit log path.
 */

import { openDb } from "../store/db";
import { defaultAuditPath } from "../paths";
import {
  runLens,
  formatScrubReport,
  type LensRunOptions,
  type LensRunResult,
} from "../lens-runner";
import { getLens, listLenses } from "../lenses";

export function lensHelpText(): string {
  const names = listLenses()
    .map((l) => `    ${l.name.padEnd(22)} ${l.summary}`)
    .join("\n");
  return `speculum lens: run an agentic lens over a scrubbed session slice

Usage:
  speculum lens <name> [selection] [options]
  speculum lens --help

Lenses:
${names}

Selection:
  --session <id>       Single session id (or unique prefix match not required; exact id)
  --last-n N           N most-recent primary sessions
  --project <path>     Filter by project path
  --since <date>       Inclusive lower bound (ISO / YYYY-MM-DD)
  --until <date>       Exclusive upper bound
  --probe-hit <name>   Sessions flagged by a local probe (e.g. stuck-loop)
  --no-subagents       Exclude subagent transcripts

Options:
  --dry-run            Selection + scrub + audit only; never invoke the model
  --json               Machine-readable result
  --max-turns N        Amore max-turns (default 4)
  --audit-path <path>  Override audit log path

Privacy:
  The selected slice is scrubbed locally before any model call. Fail-closed:
  residual secrets or oversize payloads abort the lens; nothing partial is sent.
  Lenses send scrubbed content to the model the local amore configuration routes
  to. Nothing is sent without an explicit lens command.

Audit log (append-only JSONL):
  ${defaultAuditPath()}
`;
}

function parseArgs(args: string[]): { name: string; opts: LensRunOptions; json: boolean } {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(lensHelpText());
    process.exit(0);
  }

  const name = args[0];
  if (!name || name.startsWith("--")) {
    console.error("usage: speculum lens <name> [flags]  (see: speculum lens --help)");
    process.exit(1);
  }

  if (!getLens(name)) {
    console.error(`unknown lens: ${name}`);
    console.error(`known: ${listLenses().map((l) => l.name).join(", ")}`);
    process.exit(1);
  }

  const opts: LensRunOptions = {};
  const json = args.includes("--json");

  const sessionIdx = args.indexOf("--session");
  if (sessionIdx >= 0 && args[sessionIdx + 1]) opts.sessionId = args[sessionIdx + 1];

  const projectIdx = args.indexOf("--project");
  if (projectIdx >= 0 && args[projectIdx + 1]) opts.projectPath = args[projectIdx + 1];

  const sinceIdx = args.indexOf("--since");
  if (sinceIdx >= 0 && args[sinceIdx + 1]) opts.since = new Date(args[sinceIdx + 1]!);

  const untilIdx = args.indexOf("--until");
  if (untilIdx >= 0 && args[untilIdx + 1]) opts.until = new Date(args[untilIdx + 1]!);

  const lastNIdx = args.indexOf("--last-n");
  if (lastNIdx >= 0 && args[lastNIdx + 1]) {
    const n = Number.parseInt(args[lastNIdx + 1]!, 10);
    if (Number.isFinite(n) && n > 0) opts.lastN = n;
  }

  const probeIdx = args.indexOf("--probe-hit");
  if (probeIdx >= 0 && args[probeIdx + 1]) opts.probeHit = args[probeIdx + 1];

  if (args.includes("--no-subagents")) opts.includeSubagents = false;
  if (args.includes("--dry-run")) opts.dryRun = true;

  const maxTurnsIdx = args.indexOf("--max-turns");
  if (maxTurnsIdx >= 0 && args[maxTurnsIdx + 1]) {
    const n = Number.parseInt(args[maxTurnsIdx + 1]!, 10);
    if (Number.isFinite(n) && n > 0) opts.maxTurns = n;
  }

  const auditIdx = args.indexOf("--audit-path");
  if (auditIdx >= 0 && args[auditIdx + 1]) opts.auditPath = args[auditIdx + 1];

  // Default selection: last primary session if nothing specified.
  if (
    !opts.sessionId &&
    !opts.sessionIds &&
    !opts.lastN &&
    !opts.probeHit &&
    !opts.since &&
    !opts.until &&
    !opts.projectPath
  ) {
    opts.lastN = 1;
  }

  return { name, opts, json };
}

function renderHuman(result: LensRunResult): void {
  console.log("");
  console.log(`speculum lens ${result.lens}`);
  console.log("─".repeat(60));
  console.log(`  session:        ${result.slice.sessionId ?? "<none>"}`);
  console.log(`  project:        ${result.slice.project ?? "<none>"}`);
  console.log(`  turns:          ${result.slice.turnsRendered}`);
  console.log(`  subagents:      ${result.slice.subagentCount}`);
  console.log(formatScrubReport(result.scrub));
  console.log(`  decision:       ${result.audit.decision}`);
  if (result.refusedReason) {
    console.log(`  reason:         ${result.refusedReason}`);
  }
  if (result.modelId) console.log(`  model:          ${result.modelId}`);
  if (result.reportPath) console.log(`  report:         ${result.reportPath}`);
  console.log(`  audit:          appended (${defaultAuditPath()})`);
  console.log("");

  if (result.dryRun) {
    console.log("dry-run complete: model was not invoked");
    console.log("");
    return;
  }

  if (result.refused) {
    console.log(`REFUSED: ${result.refusedReason}`);
    console.log("");
    return;
  }

  if (result.text) {
    console.log("─── output ───");
    console.log("");
    console.log(result.text);
    console.log("");
  }
}

export async function lensCommand(args: string[]): Promise<void> {
  const { name, opts, json } = parseArgs(args);
  const db = openDb();
  try {
    const result = await runLens(db, name, opts);
    if (json || !process.stdout.isTTY) {
      // Avoid dumping full scrubbed transcript in JSON by default.
      const out = {
        lens: result.lens,
        refused: result.refused,
        refusedReason: result.refusedReason,
        dryRun: result.dryRun,
        spawned: result.spawned,
        modelId: result.modelId,
        reportPath: result.reportPath,
        durationMs: result.durationMs,
        scrub: {
          ok: result.scrub.ok,
          counts: result.scrub.counts,
          bytes: result.scrub.bytes,
          refuseReason: result.scrub.refuseReason,
        },
        slice: {
          sessionId: result.slice.sessionId,
          project: result.slice.project,
          turnsRendered: result.slice.turnsRendered,
          subagentCount: result.slice.subagentCount,
          selectionSessionIds: result.slice.selectionSessionIds,
        },
        audit: result.audit,
        text: result.text,
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      renderHuman(result);
    }
    // Exit 0 for dry-run and accepted; 2 for refuse; 1 for hard errors already thrown.
    if (result.dryRun) process.exit(0);
    process.exit(result.refused ? 2 : 0);
  } finally {
    db.close();
  }
}
