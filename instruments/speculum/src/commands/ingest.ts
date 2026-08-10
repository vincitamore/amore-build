import { openDb } from "../store/db";
import { ingest, type IngestProgress, type IngestStats } from "../ingest";
import { sessionsRoot } from "../paths";

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function ingestCommand(args: string[]): Promise<void> {
  const json = flag(args, "--json");
  const dryRun = flag(args, "--dry-run");
  const full = flag(args, "--full");
  const limitStr = opt(args, "--limit");
  const limit = limitStr ? Number(limitStr) : undefined;
  const sessionsDir = opt(args, "--sessions-dir") ?? sessionsRoot();

  // WU-04: live progress only on interactive TTY when not dumping JSON.
  // Non-TTY and --json already suppress human output via printStats.
  const onProgress =
    !json && process.stderr.isTTY ? makeProgressPrinter() : undefined;

  // Dry-run still opens an ephemeral in-memory DB only if we need schema helpers;
  // ingest with dryRun never writes. We pass a real openDb only when not dry-run.
  if (dryRun) {
    const db = openDb(":memory:");
    try {
      const stats = ingest(db, {
        dryRun: true,
        full,
        sessionsDir,
        limit: Number.isFinite(limit) ? limit : undefined,
        onProgress,
      });
      printStats(stats, json, true);
    } finally {
      db.close();
    }
    return;
  }

  const db = openDb();
  try {
    const stats = ingest(db, {
      full,
      sessionsDir,
      limit: Number.isFinite(limit) ? limit : undefined,
      onProgress,
    });
    printStats(stats, json, false);
  } finally {
    db.close();
  }
}

// WU-04
function makeProgressPrinter(): (p: IngestProgress) => void {
  return (p: IngestProgress) => {
    if (p.phase === "done") {
      process.stderr.write(`\r${" ".repeat(72)}\r`);
      return;
    }
    const line =
      p.phase === "list"
        ? `  ingest listing ${p.sessionsTotal} session dir(s)…`
        : p.phase === "rebuild"
          ? `  ingest rebuild sessions…`
          : `  ingest ${p.sessionsDone}/${p.sessionsTotal} (${p.pct}%)  events=${p.eventsAppended}`;
    process.stderr.write(`\r${line.padEnd(72)}`);
  };
}

function printStats(stats: IngestStats, json: boolean, dry: boolean): void {
  if (json || !process.stdout.isTTY) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  console.log("");
  console.log(dry ? "speculum ingest --dry-run" : "speculum ingest");
  console.log("─".repeat(60));
  console.log(`  session dirs scanned:     ${stats.sessionDirsScanned}`);
  console.log(`  session dirs ingested:    ${stats.sessionDirsIngested}`);
  console.log(`  skipped (unchanged):      ${stats.sessionDirsSkippedUnchanged}`);
  console.log(`  skipped (forgotten):      ${stats.sessionDirsSkippedForgotten}`);
  console.log(`  lines seen / parsed / skipped: ${stats.linesSeen} / ${stats.linesParsed} / ${stats.linesSkipped}`);
  console.log(`  events ${dry ? "would append" : "appended"}:      ${stats.eventsAppended}`);
  console.log(`  usage rows ${dry ? "would append" : "appended"}:  ${stats.usageRowsAppended}`);
  console.log(`  errors:                   ${stats.errors}`);
  console.log(`  duration:                 ${stats.durationMs}ms`);
  // WU-04
  console.log(
    `  stages:                   list ${stats.listMs}ms · parse ${stats.parseMs}ms · write ${stats.writeMs}ms · rebuild ${stats.rebuildMs}ms`,
  );
  if (dry) console.log("  (no writes — dry run)");
  console.log("");
}
