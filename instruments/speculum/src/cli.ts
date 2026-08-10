#!/usr/bin/env bun
/**
 * Speculum CLI — local mirror over Amore Build agent sessions.
 */

import { ingestCommand } from "./commands/ingest";
import { statusCommand } from "./commands/status";
import { doctorCommand } from "./commands/doctor";
import { forgetCommand } from "./commands/forget";
import { scanCommand } from "./commands/scan";
import { usageCommand } from "./commands/usage";
import { lensCommand, lensHelpText } from "./commands/lens";
import { lensesCommand } from "./commands/lenses";
import { auditCommand } from "./commands/audit";
import { defaultAuditPath } from "./paths";
import { versionLine } from "./version";

function usage(): void {
  console.log(`speculum — mirror for local Amore Build agent sessions

Usage:
  speculum <command> [options]

Commands:
  ingest                Index ~/.amore/sessions into a local sqlite store
                        --dry-run      Walk + parse + count; write nothing
                        --full         Re-ingest from byte 0
                        --sessions-dir Override sessions root
                        --limit N      Cap session dirs (debug)
                        --json         Machine-readable stats

  status                Corpus counts, ingest freshness, probe registry
                        --json

  doctor                Operational health checks on the local index
                        --json

  forget <session-prefix>
                        Delete one session's rows from the index completely
                        and mark its source forgotten (disk files untouched)
                        --json

  scan                  Run heuristic probes over the index (local only)
                        --probe <name> Limit to one probe
                        --project P    Filter by project path
                        --since D      ISO / YYYY-MM-DD floor
                        --until D      ISO / YYYY-MM-DD ceiling
                        --hits         Print probe hit evidence on TTY
                        --verbose      Same as --hits
                        --policy [path] Evaluate threshold gates (default table;
                                        optional JSON path). Exit 1 on violations
                        --policy-report Print policy verdict table; always exit 0
                        --json         Machine-readable (includes hits)

  usage                 Per-model token and turn aggregation (no prices)
                        --since D      Inclusive lower bound
                        --until D      Inclusive upper bound
                        --model M      Substring filter on model id
                        --json

  lens <name>           ONLY egress: agentic lens over a scrubbed session slice
                        --dry-run      Selection + scrub + audit; no model call
                        See: speculum lens --help

  lenses                List available lenses and egress notes

  audit                 Tail the append-only lens audit log
                        -n N           Last N records (default 20)

  --help, -h            Show this message
  --version, -V, version  Print package version and exit

Privacy (dual posture): ingest, status, doctor, forget, scan, and usage NEVER
egress — local only. The ONLY egress is opt-in lens: each \`speculum lens\` command
sends a scrubbed slice to the model the local amore configuration routes to.
Scrub fails closed; every invocation is audited. Audit log: ${defaultAuditPath()}

Probe rates are heuristic — pattern banks are unvalidated on this corpus.
`);
}

function printVersion(): void {
  console.log(versionLine());
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  ingest: ingestCommand,
  status: statusCommand,
  doctor: doctorCommand,
  forget: forgetCommand,
  scan: scanCommand,
  usage: usageCommand,
  lens: lensCommand,
  lenses: lensesCommand,
  audit: auditCommand,
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(0);
  }

  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    printVersion();
    process.exit(0);
  }

  // `speculum lens --help` is handled inside lensCommand via lensHelpText.
  if (cmd === "lens" && (rest[0] === "--help" || rest[0] === "-h")) {
    console.log(lensHelpText());
    process.exit(0);
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(1);
  }

  await handler(rest);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
