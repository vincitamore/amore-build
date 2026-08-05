import type { Db } from "../store/db";
import { assistantTurns } from "../store/queries";
import { wilson95 } from "../stats";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";
import { queryOptsFromProbe } from "./types";

export type AgentSelfCorrectionCategory =
  | "youre-right"
  | "good-catch"
  | "self-redirect"
  | "owned-error"
  | "correction-opener"
  | "fair-X"
  | "i-error-spec"
  | "wait-self-interrupt"
  | "quick-assent-with-reversal"
  | "sorry-apology";

export interface AgentSelfCorrectionMatch {
  category: AgentSelfCorrectionCategory;
  evidence: string;
}

interface CategoryRule {
  category: AgentSelfCorrectionCategory;
  regex: RegExp;
  exclude?: RegExp;
}

const RULES: CategoryRule[] = [
  {
    category: "i-error-spec",
    regex:
      /\bi (got sloppy|conflated|misread|misunderstood|overreached|over-?engineer(ed|ing)?|projected|under(estimat|weight)(ed|ing)?|burned (an? )?(hour|cycle|time)|was reaching|(have )?been (guessing|flailing|pattern-matching)|had (it|that|the) (wrong|backwards)|should('?ve| have) (caught|weighted|answered|checked)|own (this|it))\b/i,
  },
  {
    category: "owned-error",
    regex:
      /\b(i was wrong|that'?s on me|the error is mine|it'?s a real error on my part|my mistake|was me (stating|crediting|parroting|reaching)|i propagated it too confidently|that (was|finding was) (sloppy|overstated)|(is|was|exactly) the wrong (call|reflex|shape|thing)|fundamental misunderstanding|was a workaround|i shouldn'?t have (made|done)|i didn'?t follow through|it was dumb)\b/i,
  },
  {
    category: "correction-opener",
    regex: /(^|[.!?\n]\s+)(important )?correction[:.,—]|fair correction\b/im,
  },
  {
    category: "youre-right",
    regex: /(^|[.!?]\s+)you'?re right\b[\s,—.:]/im,
    exclude:
      /(^|[.!?]\s+)you'?re right (that|about|on)\b|(^|[.!?]\s+)you'?re right[\s,—]+and (the|it|this|that|yes|i've|i'd)\b/im,
  },
  {
    category: "good-catch",
    regex: /\bgood catch\b/i,
    exclude: /\bgood catch (by|baked)\b/i,
  },
  {
    category: "self-redirect",
    regex: /\blet me (actually|stop)\b/i,
  },
  {
    category: "fair-X",
    regex: /\bfair (point|points|correction|enough|question|questions|—)/i,
    exclude: /\bfair question,? and\b/i,
  },
  {
    category: "wait-self-interrupt",
    regex: /(^|[.!?—]\s+)(but )?wait\s*[—,]/im,
    exclude:
      /\b(let me wait|i'?ll wait|wait for (the |a |another |this )?(build|monitor|run|test|deploy|notification|response))\b/i,
  },
  {
    category: "quick-assent-with-reversal",
    regex: /^\s*Yes\.(\s|$)/m,
  },
  {
    category: "sorry-apology",
    regex: /\b(sorry|apolog(y|ies|ize|ized))\b/i,
    exclude: /\bno (need to apologize|apology needed)\b|\bno worries\b/i,
  },
];

export function detectAgentSelfCorrection(text: string): AgentSelfCorrectionMatch[] {
  const matches: AgentSelfCorrectionMatch[] = [];
  for (const rule of RULES) {
    if (rule.exclude && rule.exclude.test(text)) continue;
    const m = rule.regex.exec(text);
    if (!m) continue;
    matches.push({ category: rule.category, evidence: m[0]!.trim() });
  }
  return matches;
}

export const apologyRate: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  let total = 0;
  let hitsCount = 0;
  const categoryCounts = new Map<string, number>();
  const hits: HitDetail[] = [];

  for (const t of assistantTurns(db, queryOptsFromProbe(opts))) {
    if (t.isBoilerplate) continue;
    total++;
    const matches = detectAgentSelfCorrection(t.text);
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
    probe: "apology-rate",
    value: total === 0 ? 0 : hitsCount / total,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: total,
    partial: false,
    unit: "msg",
    summary: `${hitsCount} self-corrections / ${total} assistant messages [heuristic]`,
    data: {
      categories: Array.from(categoryCounts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
    },
    hits,
    heuristic: true,
  };
};
