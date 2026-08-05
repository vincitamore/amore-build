#!/usr/bin/env bun
/**
 * Speculum CLI — local mirror over Amore Build agent sessions.
 */

import { ingestCommand } from "./commands/ingest";
import { statusCommand } from "./commands/status";
import { forgetCommand } from "./commands/forget";
import { scanCommand } from "./commands/scan";
import { usageCommand } from "./commands/usage";

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

  forget <session-prefix>
                        Delete one session's rows from the index completely
                        and mark its source forgotten (disk files untouched)
                        --json

  scan                  Run heuristic probes over the index
                        --probe <name> Limit to one probe
                        --project P    Filter by project path
                        --since D      ISO / YYYY-MM-DD floor
                        --until D      ISO / YYYY-MM-DD ceiling
                        --json

  usage                 Per-model token and turn aggregation (no prices)
                        --since D      Inclusive lower bound
                        --until D      Inclusive upper bound
                        --model M      Substring filter on model id
                        --json

  --help, -h            Show this message

Privacy: everything is local. Nothing leaves the machine. Ingest is explicit
(\`speculum ingest\`). \`forget\` removes a session from the derived index only.

Probe rates are heuristic — pattern banks are unvalidated on this corpus.
`);
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  ingest: ingestCommand,
  status: statusCommand,
  forget: forgetCommand,
  scan: scanCommand,
  usage: usageCommand,
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
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
