import { openDb } from "../store/db";
import { listProbeNames, runAllProbes, runProbe, type ProbeOptions, type ProbeResult } from "../probes";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function scanCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
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

    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

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
      const data = r.data as { categories?: Array<{ category: string; count: number }>; byTool?: Array<{ tool: string; count?: number; loops?: number }> } | undefined;
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
    }
    console.log("");
  } finally {
    db.close();
  }
}
