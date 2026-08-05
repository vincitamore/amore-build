import { describe, expect, test } from "bun:test";
import { openDb } from "./store/db";
import { ingest } from "./ingest";
import { PROBES, runAllProbes } from "./probes";
import { detect } from "./probes/rage/detector";
import { detectFrustrationMarkers } from "./probes/frustration-markers";
import { detectOperatorCorrection } from "./probes/operator-correction";
import { detectAgentSelfCorrection } from "./probes/apology-rate";
import { computeFingerprint } from "./probes/stuck-loop";
import { cleanCorpus, writeCorpus, writeTripwireCorpus } from "./test/fixtures";
import { wilson95 } from "./stats";

describe("wilson95", () => {
  test("empty n", () => {
    expect(wilson95(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
  test("zero successes", () => {
    const ci = wilson95(0, 10);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
  });
  test("mid proportion", () => {
    const ci = wilson95(5, 10);
    expect(ci.lower).toBeLessThan(0.5);
    expect(ci.upper).toBeGreaterThan(0.5);
  });
});

describe("pure detectors", () => {
  test("rage detects strong words", () => {
    expect(detect("this is fucking broken").count).toBeGreaterThan(0);
    expect(detect("please list files").count).toBe(0);
  });

  test("frustration markers", () => {
    expect(detectFrustrationMarkers("why is this still failing??").length).toBeGreaterThan(0);
    expect(detectFrustrationMarkers("please continue").length).toBe(0);
  });

  test("operator correction", () => {
    expect(detectOperatorCorrection("Nope, you failed to read that.").length).toBeGreaterThan(0);
    expect(detectOperatorCorrection("Looks good, ship it.").length).toBe(0);
  });

  test("agent self-correction", () => {
    expect(detectAgentSelfCorrection("You're right. I was wrong.").length).toBeGreaterThan(0);
    expect(detectAgentSelfCorrection("Here is the file list.").length).toBe(0);
  });

  test("stuck-loop fingerprint for run_terminal_command", () => {
    const a = computeFingerprint("run_terminal_command", { command: "bun test" });
    const b = computeFingerprint("run_terminal_command", { command: "bun   test" });
    expect(a).toBe(b);
    expect(computeFingerprint("get_command_or_subagent_output", {})).toBeNull();
  });
});

describe("probes against corpora", () => {
  test("tripwire corpus fires each probe", () => {
    const corpus = writeTripwireCorpus();
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      const results = runAllProbes(db);
      const byName = Object.fromEntries(results.map((r) => [r.probe, r]));

      expect(byName["rage-rate"]!.value).toBeGreaterThan(0);
      expect(byName["frustration-markers"]!.value).toBeGreaterThan(0);
      expect(byName["operator-correction"]!.value).toBeGreaterThan(0);
      expect(byName["apology-rate"]!.value).toBeGreaterThan(0);
      expect(byName["stuck-loop"]!.value).toBeGreaterThan(0);
      expect(byName["tool-mix"]!.value).toBeGreaterThan(0);
      expect(byName["sensitive-content"]!.value).toBeGreaterThan(0);
      expect(byName["stale-corpus"]!.value).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.heuristic).toBe(true);
        expect(r.ciLow).toBeGreaterThanOrEqual(0);
        expect(r.ciHigh).toBeLessThanOrEqual(1);
        expect(r.n).toBeGreaterThanOrEqual(0);
      }
    } finally {
      db.close();
      corpus.cleanup();
    }
  });

  test("clean corpus stays quiet on language probes", () => {
    const corpus = writeCorpus(cleanCorpus());
    const db = openDb(":memory:");
    try {
      ingest(db, { sessionsDir: corpus.root });
      expect(PROBES["rage-rate"]!(db, {}).value).toBe(0);
      expect(PROBES["frustration-markers"]!(db, {}).value).toBe(0);
      expect(PROBES["operator-correction"]!(db, {}).value).toBe(0);
      expect(PROBES["apology-rate"]!(db, {}).value).toBe(0);
      expect(PROBES["stuck-loop"]!(db, {}).value).toBe(0);
      expect(PROBES["tool-mix"]!(db, {}).value).toBe(0);
      expect(PROBES["sensitive-content"]!(db, {}).value).toBe(0);
      // stale-corpus may be 0 or 1 depending on fixture timestamps (recent).
      expect(PROBES["stale-corpus"]!(db, {}).value).toBe(0);
    } finally {
      db.close();
      corpus.cleanup();
    }
  });
});
