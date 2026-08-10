/**
 * Shared severity / evidence-weight helpers for investigative probes.
 * Static tables only — not a scoring framework.
 */

export type Severity = "info" | "warning" | "alert";

/** Ordinal weight for triage severity labels. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 1,
  warning: 2,
  alert: 3,
};

/**
 * Relative credibility of evidence kinds (0–1 scale).
 * Structured outcomes rank above free-text heuristics.
 */
export type EvidenceKind =
  | "usage"
  | "tool-error"
  | "stuck-loop"
  | "session-overlap"
  | "operator-correction"
  | "session-phase"
  | "contradiction"
  | "frustration"
  | "status-claim";

export const EVIDENCE_WEIGHT: Record<EvidenceKind, number> = {
  usage: 1.0,
  "tool-error": 0.9,
  "stuck-loop": 0.8,
  "session-overlap": 0.7,
  "operator-correction": 0.6,
  "session-phase": 0.5,
  contradiction: 0.5,
  frustration: 0.4,
  "status-claim": 0.3,
};

/** Map a severity label to its ordinal weight. */
export function weightForSeverity(severity: Severity): number {
  return SEVERITY_WEIGHT[severity];
}

/** Map an evidence kind to its static credibility weight. */
export function weightForEvidence(kind: EvidenceKind): number {
  return EVIDENCE_WEIGHT[kind];
}

/** Highest severity among a list (empty → info). */
export function maxSeverity(severities: readonly Severity[]): Severity {
  if (severities.length === 0) return "info";
  let best: Severity = "info";
  let bestW = SEVERITY_WEIGHT.info;
  for (const s of severities) {
    const w = SEVERITY_WEIGHT[s];
    if (w > bestW) {
      best = s;
      bestW = w;
    }
  }
  return best;
}

/**
 * Map a raw 0–1 weight into a triage severity band.
 * Bands: ≥0.8 alert, ≥0.5 warning, else info.
 */
export function severityFromWeight(weight: number): Severity {
  if (weight >= 0.8) return "alert";
  if (weight >= 0.5) return "warning";
  return "info";
}

export interface WeightedItem {
  weight: number;
  value: number;
}

/**
 * Weighted mean of values. Returns 0 when total weight is 0.
 * Small aggregation helper for multi-signal rollups — not a probe scorer.
 */
export function weightedAverage(items: readonly WeightedItem[]): number {
  let num = 0;
  let den = 0;
  for (const it of items) {
    if (!Number.isFinite(it.weight) || !Number.isFinite(it.value)) continue;
    if (it.weight <= 0) continue;
    num += it.weight * it.value;
    den += it.weight;
  }
  if (den === 0) return 0;
  return num / den;
}
