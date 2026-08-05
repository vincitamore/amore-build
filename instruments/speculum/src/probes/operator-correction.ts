import type { Db } from "../store/db";
import { userTurns } from "../store/queries";
import { wilson95 } from "../stats";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";
import { queryOptsFromProbe } from "./types";

export type OperatorCorrectionCategory =
  | "nope-prefix"
  | "pivot-actually-wait"
  | "i-said-told"
  | "caps-correction"
  | "frustration-markers"
  | "still-recurrence"
  | "you-accusation"
  | "interruption-apology"
  | "i-wanted-asked";

export interface CategoryMatch {
  category: OperatorCorrectionCategory;
  evidence: string;
}

interface CategoryRule {
  category: OperatorCorrectionCategory;
  regex: RegExp;
  exclude?: RegExp;
}

const RULES: CategoryRule[] = [
  { category: "nope-prefix", regex: /^[ ]*([Nn]ope|[Nn]ah)[, .]/ },
  {
    category: "pivot-actually-wait",
    regex: /^[ ]*([Aa]ctually|[Aa]ctaully|[Ww]ait[, ]|[Hh]old (on|up))/,
    exclude:
      /\b(lets continue|before starting|while you'?re here|actually not [a-z]+,? it was|to (wrap up|wrap things up))\b/i,
  },
  {
    category: "i-said-told",
    regex: /\b(I (literally |already |just )?(said|told you|asked|meant)|[Ll]iterally (told|said))/,
    exclude: /\bI meant to (give|send|tell|do|run|check|share|ask|update|attach)/i,
  },
  {
    category: "caps-correction",
    regex: /\b[A-Z]{2,}([ /\\-]+[A-Z]{2,}){3,}\b/,
  },
  {
    category: "frustration-markers",
    regex: /(\?\?\?|!!!|\bwtf\b|\bffs\b|\bwth\b|\bgd\b|what the (hell|fuck|heck))/i,
  },
  {
    category: "still-recurrence",
    regex: /^[ ]*[Ss]till\b|\b(its still|it'?s still|this is still) (not|broken|wrong|doing|fucked|showing)/,
  },
  {
    category: "you-accusation",
    regex:
      /\byou (fail(ed|ing)?|miss(ed|ing)?|misread|didn'?t|haven'?t|forgot|lumped|skipped|ignored|hallucinat|are wrong|are blind|just (changed|did|broke|killed)|need to|should have|have to|cannot)/i,
    exclude: /\byou should be able to\b/i,
  },
  {
    category: "interruption-apology",
    regex: /^[ ]*[Ss]orry[, ]+(didn'?t|didnt) mean to (interrupt|interupt)/,
  },
  {
    category: "i-wanted-asked",
    regex: /^[ ]*I (wanted|want|asked|need|requested|expected) you to|\bI (just )?stopped you\b/,
  },
];

export function detectOperatorCorrection(text: string): CategoryMatch[] {
  const matches: CategoryMatch[] = [];
  for (const rule of RULES) {
    if (rule.exclude && rule.exclude.test(text)) continue;
    const m = rule.regex.exec(text);
    if (!m) continue;
    matches.push({ category: rule.category, evidence: m[0]! });
  }
  return matches;
}

export const operatorCorrection: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  let total = 0;
  let hitsCount = 0;
  const categoryCounts = new Map<string, number>();
  const hits: HitDetail[] = [];

  for (const t of userTurns(db, queryOptsFromProbe(opts))) {
    if (t.isBoilerplate) continue;
    total++;
    const matches = detectOperatorCorrection(t.text);
    if (matches.length === 0) continue;
    hitsCount++;
    const primary = matches[0]!;
    categoryCounts.set(primary.category, (categoryCounts.get(primary.category) ?? 0) + 1);
    hits.push({
      sessionId: t.sessionId,
      ts: t.ts,
      evidence: primary.evidence,
      category: primary.category,
    });
  }

  const ci = wilson95(hitsCount, total);
  return {
    probe: "operator-correction",
    value: total === 0 ? 0 : hitsCount / total,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: total,
    partial: false,
    unit: "msg",
    summary: `${hitsCount} operator corrections / ${total} operator messages [heuristic]`,
    data: {
      categories: Array.from(categoryCounts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
    },
    hits,
    heuristic: true,
  };
};
