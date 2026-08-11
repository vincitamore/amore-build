#!/usr/bin/env bun
/**
 * Speculum CLI — local mirror over Amore Build agent sessions.
 */

import { ingestCommand } from "./commands/ingest";
import { sessionsCommand } from "./commands/sessions";
import { statusCommand } from "./commands/status";
import { summarizeCommand } from "./commands/summarize";
import { doctorCommand } from "./commands/doctor";
import { forgetCommand } from "./commands/forget";
import { scanCommand } from "./commands/scan";
import { usageCommand } from "./commands/usage";
import { lensCommand, lensHelpText } from "./commands/lens";
import { lensesCommand } from "./commands/lenses";
import { auditCommand } from "./commands/audit";
import { searchCommand } from "./commands/search";
import { exportCommand } from "./commands/export";
import { graphCommand } from "./commands/graph";
import { decisionsCommand } from "./commands/decisions";
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

  sessions              List sessions with filters and paging (local only)
                        --class C      operator|experiment|harness|unknown
                        --agent A      primary|subagent
                        --project P    Substring filter on project path
                        --since D      ISO / YYYY-MM-DD floor
                        --until D      Inclusive ceiling
                        --title T      Substring filter on resolved title
                        --sort S       recent|turns|errors (default recent)
                        --limit N      Page size (default 50)
                        --offset N     Page start (default 0)
                        --count        Print the matching total only
                        --json         Machine-readable rows + total

  status                Corpus counts, ingest freshness, probe registry
                        --json

  doctor                Operational health checks on the local index
                        --json

  forget <session-prefix>
                        Delete one session's rows from the index completely
                        and mark its source forgotten (disk files untouched)
                        --json

  scan                  Run heuristic probes over the index (local only)
                        --probe <names> Limit to one or more probes (comma-list)
                        --project P    Filter by project path
                        --since D      ISO / YYYY-MM-DD floor
                        --until D      ISO / YYYY-MM-DD ceiling
                        --hits         Print probe hit evidence on TTY
                        --verbose      Same as --hits
                        --policy [path] Evaluate threshold gates (default table;
                                        optional JSON path). Exit 1 on violations
                        --policy-report Print policy verdict table; always exit 0
                        --series W     Windowed rates over time: weekly|daily
                        --windows N    Cap window count for --series (default 12)
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

  summarize             Generate one-line titles for untitled sessions through
                        the local amore binary (opt-in egress, scrubbed digest)
                        --limit N      Cap sessions per run (default 25)
                        --session ID   One session (regenerates its title)
                        --all          Remove the cap
                        --force        Regenerate model-generated titles too
                        --dry-run      Selection + scrub + cost plan; no calls
                        --json         Machine-readable results

  audit                 Tail the append-only lens audit log
                        -n N           Last N records (default 20)

  search <query>        Sparse FTS5 search over the local derived index
                        --limit N      Max hits (default 20)
                        --since D      Inclusive lower bound (YYYY-MM-DD / ISO)
                        --until D      Inclusive upper bound
                        --project P    Substring filter on project path
                        --session ID   Exact session id
                        --fts-only     Pure BM25 (skip recency RRF fusion)
                        --json         Machine-readable hits

  export <surface>      Durable snapshot of a local index surface
                        surfaces: scan | status | usage | session
                        --format json|csv|md  (default json)
                        --output <path>  Write to file (default stdout)
                        --project P    --since D  --until D
                        --probe <names> (scan, comma-list)  --model M (usage)
                        --session <id> (session surface)
                        --json         Alias for --format json

  graph                 Query-time graph over the derived index
                        summary | neighbors | path | degree | state-at
                        --session ID  --project P  --at ISO  --json

  decisions             Derived decisions + chain/impact over event_links
                        list | chain | impact | summary
                        --session ID  --category C  --since D  --json
                        HEURISTIC — method banner on every row

  --help, -h            Show this message
  --version, -V, version  Print package version and exit

Privacy (dual posture): ingest, sessions, status, doctor, forget, scan, search,
export, graph, decisions, and usage NEVER egress — local only. The ONLY egress
is opt-in \`lens\` and \`summarize\`: each sends a scrubbed slice or digest to the
model the local amore configuration routes to. Scrub fails closed; every
invocation is audited.
Audit log: ${defaultAuditPath()}

Probe rates and extracted decisions are heuristic — pattern banks are unvalidated
on this corpus; every decision/link method field is a required banner.
`);
}

function printVersion(): void {
  console.log(versionLine());
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  ingest: ingestCommand,
  sessions: sessionsCommand,
  status: statusCommand,
  summarize: summarizeCommand,
  doctor: doctorCommand,
  forget: forgetCommand,
  scan: scanCommand,
  usage: usageCommand,
  search: searchCommand,
  export: exportCommand,
  graph: graphCommand,
  decisions: decisionsCommand,
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
