/**
 * Probe registry. Every probe returns a Wilson-wrapped result and is labeled
 * heuristic — pattern banks are unvalidated on the Amore session corpus.
 */

import type { Db } from "../store/db";
import { rageRate } from "./rage-rate";
import { frustrationMarkers } from "./frustration-markers";
import { toolMix } from "./tool-mix";
import { stuckLoop } from "./stuck-loop";
import { apologyRate } from "./apology-rate";
import { operatorCorrection } from "./operator-correction";
import { sensitiveContent } from "./sensitive-content";
import { staleCorpus } from "./stale-corpus";
import type { Probe, ProbeOptions, ProbeResult } from "./types";

export type { Probe, ProbeOptions, ProbeResult, HitDetail } from "./types";

export const PROBES: Record<string, Probe> = {
  "rage-rate": rageRate,
  "frustration-markers": frustrationMarkers,
  "tool-mix": toolMix,
  "stuck-loop": stuckLoop,
  "apology-rate": apologyRate,
  "operator-correction": operatorCorrection,
  "sensitive-content": sensitiveContent,
  "stale-corpus": staleCorpus,
};

export function runAllProbes(db: Db, opts: ProbeOptions = {}): ProbeResult[] {
  return Object.values(PROBES).map((probe) => probe(db, opts));
}

export function runProbe(db: Db, name: string, opts: ProbeOptions = {}): ProbeResult | null {
  const probe = PROBES[name];
  if (!probe) return null;
  return probe(db, opts);
}

export function listProbeNames(): string[] {
  return Object.keys(PROBES);
}
