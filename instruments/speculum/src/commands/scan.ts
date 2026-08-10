import { openDb } from "../store/db";
import {
  listProbeNames,
  runAllProbes,
  runProbe,
  type ProbeOptions,
  type ProbeResult,
  type HitDetail,
} from "../probes";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Format one hit for TTY — fields only from HitDetail, never invented. */
function formatHit(h: HitDetail): string {
  const parts: string[] = [`session=${h.sessionId}`];
  if (h.ts !== undefined) parts.push(`ts=${h.ts}`);
  if (h.category !== undefined) parts.push(`category=${h.category}`);
  parts.push(`evidence=${h.evidence}`);
  return parts.join("  ");
}

function printHits(hits: HitDetail[] | undefined): void {
  if (!hits || hits.length === 0) {
    console.log("    hits: (none)");
    return;
  }
  console.log(`    hits (${hits.length}):`);
  for (const h of hits) {
    console.log(`      · ${formatHit(h)}`);
  }
}

function printHumanResults(results: ProbeResult[], showHits: boolean): void {
  console.log("");
  console.log("speculum scan");
  console.log("─".repeat(60));
  console.log(
    "  Rates are heuristic — pattern banks are unvalidated on this corpus.",
  );
  for (const r of results) {
    console.log("");
    console.log(`  ▌ ${r.probe}  [heuristic]`);
    if (r.summary) console.log(`    ${r.summary}`);
    if (r.value <= 1 && r.n > 0 && (r.unit === "msg" || r.unit === "session")) {
      console.log(
        `    rate: ${(r.value * 100).toFixed(2)}%  ci95: [${(r.ciLow * 100).toFixed(2)}%, ${(r.ciHigh * 100).toFixed(2)}%]  n=${r.n} ${r.unit}s`,
      );
    } else {
      console.log(
        `    value: ${r.value}  ci95: [${r.ciLow.toFixed(4)}, ${r.ciHigh.toFixed(4)}]  n=${r.n} ${r.unit}s`,
      );
    }
    const data = r.data as
      | {
          categories?: Array<{ category: string; count: number }>;
          byTool?: Array<{ tool: string; count?: number; loops?: number }>;
        }
      | undefined;
    if (data?.categories?.length) {
      console.log(
        `    categories: ${data.categories
          .slice(0, 6)
          .map((c) => `${c.category}=${c.count}`)
          .join(", ")}`,
      );
    }
    if (data?.byTool?.length) {
      console.log(
        `    by tool: ${data.byTool
          .slice(0, 8)
          .map((t) => `${t.tool}=${t.count ?? t.loops ?? 0}`)
          .join(", ")}`,
      );
    }
    if (showHits) {
      printHits(r.hits);
    }
  }
  console.log("");
}

export async function scanCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const showHits = args.includes("--hits") || args.includes("--verbose");
  const project = opt(args, "--project");
  const sinceStr = opt(args, "--since");
  const untilStr = opt(args, "--until");
  const probeName = opt(args, "--probe");

  const opts: ProbeOptions = {};
  if (project) opts.project = project;
  if (sinceStr) opts.since = new Date(sinceStr);
  if (untilStr) opts.until = new Date(untilStr);

  const db = openDb();
  try {
    let results: ProbeResult[];
    if (probeName) {
      const one = runProbe(db, probeName, opts);
      if (!one) {
        console.error(
          `unknown probe: ${probeName}\navailable: ${listProbeNames().join(", ")}`,
        );
        process.exit(1);
      }
      results = [one];
    } else {
      results = runAllProbes(db, opts);
    }

    // --json always: stable machine shape (includes hits[]). Do not alter.
    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    // Pipe default (non-TTY, no hits flag): keep auto-JSON for scripting.
    // --hits / --verbose force human TTY-style output even when piped (tests, logs).
    if (!process.stdout.isTTY && !showHits) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    printHumanResults(results, showHits);
  } finally {
    db.close();
  }
}
