import { openDb } from "../store/db";
import {
  listProbeNames,
  runAllProbes,
  runProbe,
  type ProbeOptions,
  type ProbeResult,
  type HitDetail,
} from "../probes";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  formatPolicyReport,
  type PolicyResult,
  type PolicyTable,
} from "../policy";
import {
  formatSeriesLine,
  runProbeSeries,
  type SeriesGranularity,
} from "../probes/series";
import { readFileSync } from "node:fs";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Parse --policy flag. Bare `--policy` (no path, or next token is another
 * flag) uses the built-in default table. `--policy path.json` loads a table.
 */
function resolvePolicyTable(args: string[]): PolicyTable | null {
  const i = args.indexOf("--policy");
  if (i < 0) return null;
  const next = args[i + 1];
  if (!next || next.startsWith("-")) {
    return DEFAULT_POLICY;
  }
  return loadPolicyFile(next);
}

function loadPolicyFile(path: string): PolicyTable {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`failed to read policy file: ${path}\n${msg}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`invalid policy JSON: ${path}\n${msg}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`policy file must be a JSON object keyed by probe name: ${path}`);
    process.exit(1);
  }
  return parsed as PolicyTable;
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

const SERIES_DEFAULT_WINDOWS = 12;
const SERIES_MAX_WINDOWS = 52;

function parseSeriesGranularity(raw: string | undefined): SeriesGranularity | null {
  if (!raw) return null;
  if (raw === "weekly" || raw === "daily") return raw;
  return null;
}

function parseWindowsCount(raw: string | undefined): number {
  if (!raw) return SERIES_DEFAULT_WINDOWS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return SERIES_DEFAULT_WINDOWS;
  return Math.min(SERIES_MAX_WINDOWS, Math.floor(n));
}

export async function scanCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const showHits = args.includes("--hits") || args.includes("--verbose");
  const policyReportOnly = args.includes("--policy-report");
  const policyTable = resolvePolicyTable(args);
  // --policy-report without --policy still evaluates the default table.
  const wantPolicy = policyTable !== null || policyReportOnly;
  const table: PolicyTable | null = wantPolicy
    ? (policyTable ?? DEFAULT_POLICY)
    : null;
  // Exit 1 on violations only when --policy is present (not report-only).
  const failOnViolations = policyTable !== null;

  const seriesRaw = opt(args, "--series");
  const seriesGranularity = parseSeriesGranularity(seriesRaw);

  // Policy gates evaluate the corpus scan, not a windowed series.
  if (seriesRaw !== undefined && wantPolicy) {
    console.error(
      "scan: --series cannot be combined with --policy / --policy-report",
    );
    process.exit(64);
  }

  if (seriesRaw !== undefined && seriesGranularity === null) {
    console.error(
      `scan: --series requires weekly|daily (got ${JSON.stringify(seriesRaw)})`,
    );
    process.exit(64);
  }

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
    // ── Windowed series path ──────────────────────────────────────────
    if (seriesGranularity) {
      const windowCount = parseWindowsCount(opt(args, "--windows"));
      const names = probeName ? [probeName] : listProbeNames();
      if (probeName && !listProbeNames().includes(probeName)) {
        console.error(
          `unknown probe: ${probeName}\navailable: ${listProbeNames().join(", ")}`,
        );
        process.exit(1);
      }

      const seriesOpts = {
        granularity: seriesGranularity,
        windows: windowCount,
        project: project || undefined,
        until: untilStr ? new Date(untilStr) : undefined,
      };

      const series = runProbeSeries(db, names, seriesOpts);

      if (json || !process.stdout.isTTY) {
        console.log(JSON.stringify(series, null, 2));
        return;
      }

      console.log("");
      console.log(
        `speculum scan --series ${seriesGranularity}  windows=${windowCount}`,
      );
      console.log("─".repeat(60));
      for (const s of series) {
        console.log(formatSeriesLine(s));
      }
      console.log("");
      return;
    }

    // ── Standard scan path ────────────────────────────────────────────
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

    let policyResult: PolicyResult | null = null;
    if (table) {
      policyResult = evaluatePolicy(results, table);
    }

    // --json always: stable machine shape for probes; policy is an envelope
    // only when a policy flag is active (plain --json stays a bare array).
    if (json) {
      if (policyResult) {
        console.log(
          JSON.stringify(
            { probes: results, policy: policyResult },
            null,
            2,
          ),
        );
      } else {
        console.log(JSON.stringify(results, null, 2));
      }
      if (failOnViolations && policyResult && policyResult.violations > 0) {
        process.exit(1);
      }
      return;
    }

    // Pipe default (non-TTY, no hits/policy-report flag): keep auto-JSON.
    // --hits / --verbose / --policy-report force human-style output when piped.
    const forceHuman = showHits || policyReportOnly || failOnViolations;
    if (!process.stdout.isTTY && !forceHuman) {
      if (policyResult) {
        console.log(
          JSON.stringify(
            { probes: results, policy: policyResult },
            null,
            2,
          ),
        );
      } else {
        console.log(JSON.stringify(results, null, 2));
      }
      if (failOnViolations && policyResult && policyResult.violations > 0) {
        process.exit(1);
      }
      return;
    }

    printHumanResults(results, showHits);
    if (policyResult) {
      process.stdout.write(formatPolicyReport(policyResult));
    }
    if (failOnViolations && policyResult && policyResult.violations > 0) {
      process.exit(1);
    }
  } finally {
    db.close();
  }
}
