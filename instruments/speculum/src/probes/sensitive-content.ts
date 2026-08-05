/**
 * Sensitive-content probe. Pattern bank includes xAI / OpenRouter / Amore /
 * GitHub / AWS / SSH shapes. Best-effort regex — not a guarantee.
 */

import type { Db } from "../store/db";
import { wilson95 } from "../stats";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";

export const SENSITIVE_PATTERNS: Array<{ name: string; re: RegExp; weight: number }> = [
  { name: "ssh-private-key", re: /-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/, weight: 10 },
  { name: "ssh-private-key-generic", re: /-----BEGIN PRIVATE KEY-----/, weight: 10 },
  {
    name: "anthropic-api-key",
    re: /(?<![A-Za-z0-9_-])sk-ant-api03-[A-Za-z0-9_-]{86,120}(?![A-Za-z0-9_-])/,
    weight: 10,
  },
  { name: "openai-api-key", re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/, weight: 10 },
  // xAI keys (xai-…); OpenRouter keys (sk-or-…); Amore env-style tokens.
  { name: "xai-api-key", re: /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/, weight: 10 },
  {
    name: "openrouter-api-key",
    re: /(?<![A-Za-z0-9_-])sk-or-v1-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    weight: 10,
  },
  {
    name: "amore-env-secret",
    re: /\bAMORE_(API_KEY|TOKEN|SECRET|KEY)=["']?[A-Za-z0-9_\-./+=]{16,}/,
    weight: 8,
  },
  {
    name: "xai-env-secret",
    re: /\bXAI_(API_KEY|TOKEN|SECRET)=["']?[A-Za-z0-9_\-./+=]{16,}/,
    weight: 8,
  },
  {
    name: "openrouter-env-secret",
    re: /\bOPENROUTER_(API_KEY|TOKEN)=["']?[A-Za-z0-9_\-./+=]{16,}/,
    weight: 8,
  },
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{36}\b/, weight: 10 },
  { name: "github-app-token", re: /\bghs_[A-Za-z0-9]{36}\b/, weight: 10 },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{36}\b/, weight: 10 },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/, weight: 10 },
  { name: "vercel-token", re: /\bvercel_[A-Za-z0-9_]{24,}\b/, weight: 8 },
];

export const sensitiveContent: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  const wheres: string[] = ["text IS NOT NULL"];
  const params: (string | number)[] = [];
  if (opts.project) {
    wheres.push("project_path = ?");
    params.push(opts.project);
  }
  if (opts.since) {
    wheres.push("ts >= ?");
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    wheres.push("ts < ?");
    params.push(opts.until.toISOString());
  }

  // Scan message text and tool_input (commands / file writes can leak secrets).
  const rows = db
    .query<{ session_id: string; project_path: string; text: string | null; tool_input: string | null }, (string | number)[]>(
      `SELECT session_id, project_path, text, tool_input FROM events
       WHERE (text IS NOT NULL OR tool_input IS NOT NULL)
       ${opts.project || opts.since || opts.until ? `AND ${wheres.filter((w) => w !== "text IS NOT NULL").join(" AND ")}` : ""}`,
    )
    .all(...params);

  const bySession = new Map<string, { project: string; patterns: Map<string, number> }>();
  for (const r of rows) {
    const blob = `${r.text ?? ""}\n${r.tool_input ?? ""}`;
    for (const p of SENSITIVE_PATTERNS) {
      const flags = p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g";
      const matches = blob.match(new RegExp(p.re.source, flags));
      if (matches && matches.length > 0) {
        let entry = bySession.get(r.session_id);
        if (!entry) {
          entry = { project: r.project_path, patterns: new Map() };
          bySession.set(r.session_id, entry);
        }
        entry.patterns.set(p.name, (entry.patterns.get(p.name) ?? 0) + matches.length);
      }
    }
  }

  const totalSessions =
    db.query<{ n: number }, []>("SELECT COUNT(DISTINCT id) AS n FROM sessions").get()?.n ?? 0;
  const flagged = bySession.size;

  const items: Array<{
    sessionId: string;
    project: string;
    patternsMatched: Array<{ pattern: string; count: number }>;
    severity: "info" | "warning" | "alert";
  }> = [];
  let alertCount = 0;
  for (const [sessionId, entry] of bySession) {
    const patternsMatched = Array.from(entry.patterns.entries()).map(([pattern, count]) => ({
      pattern,
      count,
    }));
    const hasHigh = patternsMatched.some((p) => {
      const def = SENSITIVE_PATTERNS.find((sp) => sp.name === p.pattern);
      return def && def.weight >= 10;
    });
    const severity = hasHigh ? "alert" : "warning";
    if (severity === "alert") alertCount++;
    items.push({ sessionId, project: entry.project, patternsMatched, severity });
  }

  const ci = wilson95(flagged, totalSessions);
  const message =
    flagged === 0
      ? "no sensitive content detected"
      : `${flagged} session(s) contain sensitive content (${alertCount} alert-level) [heuristic]`;

  return {
    probe: "sensitive-content",
    value: flagged,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: totalSessions,
    partial: false,
    unit: "session",
    summary: message,
    data: {
      totalSessions,
      flaggedSessions: flagged,
      bySessionId: items.slice(0, 20),
      severity: alertCount > 0 ? "alert" : flagged > 0 ? "warning" : "info",
      message,
    },
    hits: items.map<HitDetail>((i) => ({
      sessionId: i.sessionId,
      evidence: i.patternsMatched.map((p) => `${p.pattern}×${p.count}`).join(", "),
      category: i.severity,
    })),
    heuristic: true,
  };
};
