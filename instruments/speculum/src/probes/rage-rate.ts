import type { Db } from "../store/db";
import { userTurns } from "../store/queries";
import { wilson95 } from "../stats";
import type { Probe, ProbeOptions, ProbeResult, HitDetail } from "./types";
import { queryOptsFromProbe } from "./types";
import { detect } from "./rage/detector";

export const rageRate: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  let totalMessages = 0;
  let totalRageMessages = 0;
  let composureLoss = 0;
  const hits: HitDetail[] = [];
  const bySeverity = { mild: 0, moderate: 0, strong: 0 };

  for (const t of userTurns(db, queryOptsFromProbe(opts))) {
    if (t.isBoilerplate) continue;
    totalMessages++;
    const result = detect(t.text);
    if (result.count === 0) continue;
    totalRageMessages++;
    let strongInMsg = 0;
    for (const match of result.matches) {
      bySeverity[match.severity]++;
      if (match.severity === "strong") strongInMsg++;
    }
    if (strongInMsg >= 2) composureLoss++;
    hits.push({
      sessionId: t.sessionId,
      ts: t.ts,
      evidence: result.matches.map((m) => m.word).slice(0, 5).join(", "),
      category: strongInMsg > 0 ? "strong" : "mild-or-moderate",
      eventId: t.id,
    });
  }

  const ci = wilson95(totalRageMessages, totalMessages);
  return {
    probe: "rage-rate",
    value: totalMessages === 0 ? 0 : totalRageMessages / totalMessages,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: totalMessages,
    partial: false,
    unit: "msg",
    summary: `${totalRageMessages} rage messages / ${totalMessages} total (${composureLoss} composure-loss episodes) [heuristic]`,
    data: { bySeverity, composureLossEpisodes: composureLoss, rageMessages: totalRageMessages },
    hits,
    heuristic: true,
  };
};
