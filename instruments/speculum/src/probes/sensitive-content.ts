/**
 * Sensitive-content probe. Pattern bank includes xAI / OpenRouter / Amore /
 * GitHub / AWS / SSH shapes. Best-effort regex — not a guarantee.
 *
 * The bank is shared with the lens scrubber (`scrub.ts` imports
 * `SENSITIVE_PATTERNS`). One bank, two consumers: the probe flags; the scrubber
 * redacts at lens egress. This probe never mutates stored text.
 */

import type { Db } from "../store/db";
import { wilson95 } from "../stats";
import type { HitDetail, Probe, ProbeOptions, ProbeResult } from "./types";

/**
 * Max characters scanned per channel (text / tool_input / tool_output).
 * Caps ReDoS exposure on pathological tool dumps without dropping short secrets.
 */
export const SENSITIVE_SCAN_MAX_CHARS = 256_000;

/**
 * Shared secret-shaped patterns. Order is stable for scrub placeholder naming.
 * Patterns are linear-time (no nested quantifiers over unbounded input).
 * Weights: ≥10 alert, ≥8 warning when only lower-weight hits fire.
 */
export const SENSITIVE_PATTERNS: Array<{ name: string; re: RegExp; weight: number }> = [
  { name: "ssh-private-key", re: /-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/, weight: 10 },
  { name: "ssh-private-key-generic", re: /-----BEGIN PRIVATE KEY-----/, weight: 10 },
  { name: "ssh-encrypted-private-key", re: /-----BEGIN ENCRYPTED PRIVATE KEY-----/, weight: 10 },
  {
    name: "anthropic-api-key",
    re: /(?<![A-Za-z0-9_-])sk-ant-api03-[A-Za-z0-9_-]{86,120}(?![A-Za-z0-9_-])/,
    weight: 10,
  },
  // OpenAI user keys (sk-… alphanumeric only). Does not match sk-or- / sk-proj- / sk-ant-.
  { name: "openai-api-key", re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/, weight: 10 },
  {
    name: "openai-project-key",
    re: /(?<![A-Za-z0-9_-])sk-proj-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
    weight: 10,
  },
  // xAI keys (xai-…); OpenRouter keys (sk-or-…); Amore / provider env-style tokens.
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
  {
    name: "openai-env-secret",
    re: /\bOPENAI_(API_KEY|TOKEN|SECRET)=["']?[A-Za-z0-9_\-./+=]{16,}/,
    weight: 8,
  },
  {
    name: "anthropic-env-secret",
    re: /\bANTHROPIC_(API_KEY|TOKEN|SECRET)=["']?[A-Za-z0-9_\-./+=]{16,}/,
    weight: 8,
  },
  {
    name: "github-env-secret",
    re: /\b(GITHUB_TOKEN|GH_TOKEN|GH_PAT)=["']?[A-Za-z0-9_\-./+=]{16,}/,
    weight: 8,
  },
  {
    name: "aws-env-secret",
    re: /\bAWS_(SECRET_ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)=["']?[A-Za-z0-9/+=]{16,}/,
    weight: 8,
  },
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]{36}\b/, weight: 10 },
  { name: "github-app-token", re: /\bghs_[A-Za-z0-9]{36}\b/, weight: 10 },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{36}\b/, weight: 10 },
  { name: "github-refresh", re: /\bghr_[A-Za-z0-9]{36}\b/, weight: 10 },
  // Fine-grained PAT: github_pat_ + long suffix (length floor avoids short placeholders).
  {
    name: "github-fine-grained-pat",
    re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    weight: 10,
  },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/, weight: 10 },
  { name: "vercel-token", re: /\bvercel_[A-Za-z0-9_]{24,}\b/, weight: 8 },
];

/** Channels the probe scans for credential-shaped strings. */
export type SensitiveChannel = "text" | "tool_input" | "tool_output";

export interface PatternMatch {
  pattern: string;
  count: number;
  weight: number;
}

/**
 * Clip untrusted input before matching. Prevents catastrophic work on huge
 * tool dumps while preserving prefix content where secrets usually appear.
 */
export function clipForSensitiveScan(s: string, max = SENSITIVE_SCAN_MAX_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/**
 * Match the shared bank against a single string. Pure; used by the probe and
 * by residual-rate fixtures. Does not mutate input.
 */
export function matchSensitivePatterns(text: string): PatternMatch[] {
  if (!text) return [];
  const clipped = clipForSensitiveScan(text);
  const out: PatternMatch[] = [];
  for (const p of SENSITIVE_PATTERNS) {
    const flags = p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`;
    const matches = clipped.match(new RegExp(p.re.source, flags));
    if (matches && matches.length > 0) {
      out.push({ pattern: p.name, count: matches.length, weight: p.weight });
    }
  }
  return out;
}

function accumulate(
  map: Map<string, number>,
  matches: PatternMatch[],
): void {
  for (const m of matches) {
    map.set(m.pattern, (map.get(m.pattern) ?? 0) + m.count);
  }
}

export const sensitiveContent: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  const filterParts: string[] = [];
  const params: (string | number)[] = [];
  if (opts.project) {
    filterParts.push("project_path = ?");
    params.push(opts.project);
  }
  if (opts.since) {
    filterParts.push("ts >= ?");
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    filterParts.push("ts < ?");
    params.push(opts.until.toISOString());
  }

  // Side channels: operator/assistant text, tool_use input, tool_result output.
  // tool_error is a 0|1 flag in schema; error payloads live in tool_output.
  const filterSql = filterParts.length > 0 ? `AND ${filterParts.join(" AND ")}` : "";
  const rows = db
    .query<
      {
        session_id: string;
        project_path: string;
        text: string | null;
        tool_input: string | null;
        tool_output: string | null;
      },
      (string | number)[]
    >(
      `SELECT session_id, project_path, text, tool_input, tool_output FROM events
       WHERE (text IS NOT NULL OR tool_input IS NOT NULL OR tool_output IS NOT NULL)
       ${filterSql}`,
    )
    .all(...params);

  const bySession = new Map<
    string,
    {
      project: string;
      patterns: Map<string, number>;
      /** Channels that contributed at least one hit (for evidence). */
      channels: Set<SensitiveChannel>;
      /** pattern → channels it was seen on */
      patternChannels: Map<string, Set<SensitiveChannel>>;
    }
  >();

  for (const r of rows) {
    const channelBlobs: Array<{ channel: SensitiveChannel; blob: string }> = [];
    if (r.text) channelBlobs.push({ channel: "text", blob: r.text });
    if (r.tool_input) channelBlobs.push({ channel: "tool_input", blob: r.tool_input });
    if (r.tool_output) channelBlobs.push({ channel: "tool_output", blob: r.tool_output });

    for (const { channel, blob } of channelBlobs) {
      const matches = matchSensitivePatterns(blob);
      if (matches.length === 0) continue;

      let entry = bySession.get(r.session_id);
      if (!entry) {
        entry = {
          project: r.project_path,
          patterns: new Map(),
          channels: new Set(),
          patternChannels: new Map(),
        };
        bySession.set(r.session_id, entry);
      }
      entry.channels.add(channel);
      accumulate(entry.patterns, matches);
      for (const m of matches) {
        let ch = entry.patternChannels.get(m.pattern);
        if (!ch) {
          ch = new Set();
          entry.patternChannels.set(m.pattern, ch);
        }
        ch.add(channel);
      }
    }
  }

  const totalSessions =
    db.query<{ n: number }, []>("SELECT COUNT(DISTINCT id) AS n FROM sessions").get()?.n ?? 0;
  const flagged = bySession.size;

  const items: Array<{
    sessionId: string;
    project: string;
    patternsMatched: Array<{ pattern: string; count: number; channels: SensitiveChannel[] }>;
    channels: SensitiveChannel[];
    severity: "info" | "warning" | "alert";
  }> = [];
  let alertCount = 0;
  let toolOutputOnlySessions = 0;
  for (const [sessionId, entry] of bySession) {
    const patternsMatched = Array.from(entry.patterns.entries()).map(([pattern, count]) => ({
      pattern,
      count,
      channels: Array.from(entry.patternChannels.get(pattern) ?? []).sort() as SensitiveChannel[],
    }));
    const hasHigh = patternsMatched.some((p) => {
      const def = SENSITIVE_PATTERNS.find((sp) => sp.name === p.pattern);
      return def && def.weight >= 10;
    });
    const severity = hasHigh ? "alert" : "warning";
    if (severity === "alert") alertCount++;
    const channels = Array.from(entry.channels).sort() as SensitiveChannel[];
    if (channels.length === 1 && channels[0] === "tool_output") toolOutputOnlySessions++;
    items.push({
      sessionId,
      project: entry.project,
      patternsMatched,
      channels,
      severity,
    });
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
      /** Sessions where only tool_output (not text/tool_input) matched. */
      toolOutputOnlySessions,
    },
    hits: items.map<HitDetail>((i) => {
      // Evidence stays human-readable; channel tags are additive (HitDetail shape unchanged).
      const evidence = i.patternsMatched
        .map((p) => {
          const ch = p.channels.length > 0 ? `@${p.channels.join("+")}` : "";
          return `${p.pattern}×${p.count}${ch}`;
        })
        .join(", ");
      return {
        sessionId: i.sessionId,
        evidence,
        category: i.severity,
      };
    }),
    heuristic: true,
  };
};
