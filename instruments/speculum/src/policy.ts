/**
 * Policy gates over probe results — a hand-written threshold table, not a
 * rule network. Evaluates each configured probe against min/max bounds and
 * returns a structured verdict list plus a violations count.
 */

import type { ProbeResult } from "./probes/types";

/** One probe's threshold. Omitted bounds are not checked. */
export interface PolicyThreshold {
  /** Fail when observed value is strictly greater than max. */
  max?: number;
  /** Fail when observed value is strictly less than min. */
  min?: number;
  /** Documentary unit (session | msg); not enforced against ProbeResult.unit. */
  unit?: "session" | "msg" | string;
  /**
   * Which number to compare:
   * - rate (default): ProbeResult.value
   * - count: hit count when hits are present, else value
   */
  mode?: "rate" | "count";
}

/** Threshold dict keyed by probe name. */
export type PolicyTable = Record<string, PolicyThreshold>;

export interface PolicyVerdict {
  /** Policy key (probe name in the table). */
  policy: string;
  /** Probe name that was evaluated (same as policy when found). */
  probe: string;
  /** Observed value under the gate's mode. */
  value: number;
  pass: boolean;
  threshold: PolicyThreshold;
  /** Short reason when failed or skipped. */
  detail: string;
}

export interface PolicyResult {
  verdicts: PolicyVerdict[];
  /** Number of non-passing verdicts (failed thresholds + missing probes). */
  violations: number;
  compliant: boolean;
  /** The table that was applied. */
  policy: PolicyTable;
}

/**
 * Default gates for `scan --policy` with no custom table.
 * Tight on secrets; loose on heuristic language rates so clean corpora pass
 * and tripwire-style fixtures exercise FAIL paths.
 */
export const DEFAULT_POLICY: PolicyTable = {
  "sensitive-content": { max: 0, mode: "count", unit: "session" },
  "rage-rate": { max: 0.15, mode: "rate", unit: "msg" },
  "stuck-loop": { max: 0.25, mode: "rate", unit: "session" },
  "apology-rate": { max: 0.5, mode: "rate", unit: "msg" },
  "operator-correction": { max: 0.5, mode: "rate", unit: "msg" },
};

function observedValue(result: ProbeResult, threshold: PolicyThreshold): number {
  if (threshold.mode === "count") {
    if (result.hits !== undefined) return result.hits.length;
    return result.value;
  }
  return result.value;
}

function formatBound(threshold: PolicyThreshold): string {
  const parts: string[] = [];
  if (threshold.min !== undefined) parts.push(`min=${threshold.min}`);
  if (threshold.max !== undefined) parts.push(`max=${threshold.max}`);
  if (threshold.mode) parts.push(`mode=${threshold.mode}`);
  if (threshold.unit) parts.push(`unit=${threshold.unit}`);
  return parts.join(" ");
}

/**
 * Evaluate a threshold table against a set of probe results.
 * Pure: no I/O, no model calls. Missing probes count as violations.
 */
export function evaluatePolicy(
  results: readonly ProbeResult[],
  policy: PolicyTable = DEFAULT_POLICY,
): PolicyResult {
  const byName = new Map(results.map((r) => [r.probe, r]));
  const verdicts: PolicyVerdict[] = [];

  for (const [name, threshold] of Object.entries(policy)) {
    const result = byName.get(name);
    if (!result) {
      verdicts.push({
        policy: name,
        probe: name,
        value: Number.NaN,
        pass: false,
        threshold,
        detail: "probe not in results",
      });
      continue;
    }

    const value = observedValue(result, threshold);
    let pass = true;
    const reasons: string[] = [];

    if (threshold.max !== undefined && value > threshold.max) {
      pass = false;
      reasons.push(`${value} > max ${threshold.max}`);
    }
    if (threshold.min !== undefined && value < threshold.min) {
      pass = false;
      reasons.push(`${value} < min ${threshold.min}`);
    }

    verdicts.push({
      policy: name,
      probe: result.probe,
      value,
      pass,
      threshold,
      detail: pass
        ? `ok (${formatBound(threshold)})`
        : reasons.join("; ") || "failed",
    });
  }

  const violations = verdicts.filter((v) => !v.pass).length;
  return {
    verdicts,
    violations,
    compliant: violations === 0,
    policy,
  };
}

/** Human-readable policy table for TTY / --policy-report. */
export function formatPolicyReport(result: PolicyResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("speculum policy");
  lines.push("─".repeat(60));
  lines.push("  Threshold gates over probe results (heuristic probes).");
  for (const v of result.verdicts) {
    const glyph = v.pass ? "PASS" : "FAIL";
    const val = Number.isFinite(v.value) ? String(v.value) : "n/a";
    lines.push(`  ▌ ${v.policy}  [${glyph}]  value=${val}  ${v.detail}`);
  }
  lines.push("");
  lines.push(
    `  violations: ${result.violations}  compliant: ${result.compliant ? "yes" : "no"}`,
  );
  lines.push("");
  return lines.join("\n");
}
