import type { Db } from "../store/db";
import { sessionToolMixes, toolUses } from "../store/queries";
import { wilson95 } from "../stats";
import type { Probe, ProbeOptions, ProbeResult } from "./types";
import { queryOptsFromProbe } from "./types";

const OUTLIER_DOMINANCE = 0.7;
const MIN_TOOLS_FOR_OUTLIER = 20;

export const toolMix: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  const queryOpts = queryOptsFromProbe(opts);

  const toolCounts = new Map<string, number>();
  let totalCalls = 0;
  for (const t of toolUses(db, { ...queryOpts, includeSubagents: true })) {
    toolCounts.set(t.toolName, (toolCounts.get(t.toolName) ?? 0) + 1);
    totalCalls++;
  }
  const byTool = Array.from(toolCounts.entries())
    .map(([tool, count]) => ({
      tool,
      count,
      share: totalCalls === 0 ? 0 : count / totalCalls,
    }))
    .sort((a, b) => b.count - a.count);

  const mixes = sessionToolMixes(db, queryOpts);
  const outliers: Array<{
    session: string;
    project: string;
    dominantTool: string;
    dominantShare: number;
    totalTools: number;
  }> = [];

  for (const m of mixes) {
    if (m.totalTools < MIN_TOOLS_FOR_OUTLIER) continue;
    let dominantTool = "";
    let dominantCount = 0;
    for (const [tool, count] of Object.entries(m.toolCounts)) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantTool = tool;
      }
    }
    const share = dominantCount / m.totalTools;
    if (share >= OUTLIER_DOMINANCE) {
      outliers.push({
        session: m.sessionId,
        project: m.projectPath,
        dominantTool,
        dominantShare: share,
        totalTools: m.totalTools,
      });
    }
  }

  const ci = wilson95(outliers.length, mixes.length);
  return {
    probe: "tool-mix",
    value: outliers.length,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: mixes.length,
    partial: false,
    unit: "session",
    summary: `${outliers.length} outlier sessions / ${mixes.length} total (one tool ≥ ${(OUTLIER_DOMINANCE * 100).toFixed(0)}% of calls) [heuristic]`,
    data: {
      totalSessions: mixes.length,
      outlierSessions: outliers.length,
      byTool,
      outliers: outliers.slice(0, 12),
      totalCalls,
    },
    heuristic: true,
  };
};
