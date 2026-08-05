import type { Db } from "../store/db";
import { userTurns } from "../store/queries";
import { wilson95 } from "../stats";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";
import { queryOptsFromProbe } from "./types";

export type FrustrationMarkerCategory =
  | "caps-span-filtered"
  | "doubled-question"
  | "still-persistence"
  | "wth-acronym"
  | "minced-oath";

export interface FrustrationMarkerMatch {
  category: FrustrationMarkerCategory;
  evidence: string;
}

const TECHNICAL_CAPS_STOPLIST = new Set([
  "HTTP", "HTTPS", "JSON", "JSONL", "API", "MCP", "README", "SPEC", "TODO",
  "SQL", "CSS", "HTML", "DOM", "URL", "URI", "UUID", "CRUD", "REST", "RPC",
  "TLS", "SSH", "SSL", "DNS", "TCP", "UDP", "WAN", "LAN", "VPN", "PDF",
  "CSV", "XML", "YAML", "TOML", "RAM", "CPU", "GPU", "SDK", "CLI", "GUI",
  "OK", "NULL", "GET", "POST", "PUT", "PATCH", "DELETE", "DONE", "AMORE",
]);

function findCapsSpan(text: string): string | null {
  if (!/[a-z]/.test(text)) return null;
  const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const line of stripped.split("\n")) {
    if (line.length === 0 || line.length >= 500) continue;
    if (!/[a-z]/.test(line)) continue;
    const re = /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){3,}\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const span = m[0]!;
      const tokens = span.split(/\s+/);
      const clean = tokens.filter((t) => !TECHNICAL_CAPS_STOPLIST.has(t));
      if (clean.length >= 4) return span;
    }
  }
  return null;
}

const STILL_NEG_FAULT_RE =
  /(n['']?t\b|\bnot\b|\bno\b|\bnever\b|\bnope\b|fail|broke|crash|segfault|messed|stuck|\bwrong\b|thrash|misunderstood|missing|\bsame\b)/i;
const STILL_EXCLUDE_RE =
  /\b(you'?re? still\b|still there\b|still around\b|still needs?\b|still need\b)/i;

function detectStillPersistence(text: string): string | null {
  for (const clause of text.split(/(?<=[.?!\n])/)) {
    if (!/\bstill\b/i.test(clause)) continue;
    if (STILL_EXCLUDE_RE.test(clause)) continue;
    if (!STILL_NEG_FAULT_RE.test(clause)) continue;
    const m = /[^.?!\n]*\bstill\b[^.?!\n]*/i.exec(clause);
    return (m ? m[0]! : clause).trim().slice(0, 80);
  }
  return null;
}

export function detectFrustrationMarkers(text: string): FrustrationMarkerMatch[] {
  const matches: FrustrationMarkerMatch[] = [];

  const capsSpan = findCapsSpan(text);
  if (capsSpan) matches.push({ category: "caps-span-filtered", evidence: capsSpan });

  const stripped = text.replace(/https?:\/\/[^\s)]+/g, "").replace(/```[\s\S]*?```/g, "");
  if (/\?\?/.test(stripped)) {
    const m = /[^\n]*\?\?[^\n]*/.exec(stripped);
    if (m) matches.push({ category: "doubled-question", evidence: m[0]!.slice(0, 80).trim() });
  }

  const stillEvidence = detectStillPersistence(text);
  if (stillEvidence) matches.push({ category: "still-persistence", evidence: stillEvidence });

  if (/\bwth\b/i.test(text)) {
    matches.push({ category: "wth-acronym", evidence: "wth" });
  }

  const mincedRe = /\bwhat the (heck|hell)\b/i;
  const mm = mincedRe.exec(text);
  if (mm) matches.push({ category: "minced-oath", evidence: mm[0]! });

  return matches;
}

export const frustrationMarkers: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  let total = 0;
  let hitsCount = 0;
  const categoryCounts = new Map<string, number>();
  const hits: HitDetail[] = [];

  for (const t of userTurns(db, queryOptsFromProbe(opts))) {
    if (t.isBoilerplate) continue;
    total++;
    const matches = detectFrustrationMarkers(t.text);
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
    probe: "frustration-markers",
    value: total === 0 ? 0 : hitsCount / total,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: total,
    partial: false,
    unit: "msg",
    summary: `${hitsCount} frustration markers / ${total} operator messages [heuristic]`,
    data: {
      categories: Array.from(categoryCounts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
    },
    hits,
    heuristic: true,
  };
};
