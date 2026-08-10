import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  formatPolicyReport,
  type PolicyTable,
} from "./policy";
import type { ProbeResult } from "./probes/types";

function probe(
  name: string,
  value: number,
  hits: number = 0,
): ProbeResult {
  return {
    probe: name,
    value,
    ciLow: 0,
    ciHigh: 1,
    n: 10,
    partial: false,
    unit: "msg",
    hits: Array.from({ length: hits }, (_, i) => ({
      sessionId: `s${i}`,
      evidence: "e",
    })),
    heuristic: true,
  };
}

describe("evaluatePolicy", () => {
  test("all pass when under thresholds", () => {
    const results = [
      probe("sensitive-content", 0, 0),
      probe("rage-rate", 0.01),
      probe("stuck-loop", 0),
      probe("apology-rate", 0.1),
      probe("operator-correction", 0.1),
    ];
    const r = evaluatePolicy(results, DEFAULT_POLICY);
    expect(r.compliant).toBe(true);
    expect(r.violations).toBe(0);
    expect(r.verdicts.every((v) => v.pass)).toBe(true);
  });

  test("max violation on rate", () => {
    const table: PolicyTable = { "rage-rate": { max: 0.05, mode: "rate" } };
    const r = evaluatePolicy([probe("rage-rate", 0.2)], table);
    expect(r.compliant).toBe(false);
    expect(r.violations).toBe(1);
    expect(r.verdicts[0]!.pass).toBe(false);
    expect(r.verdicts[0]!.value).toBe(0.2);
    expect(r.verdicts[0]!.detail).toContain(">");
  });

  test("count mode uses hits length", () => {
    const table: PolicyTable = {
      "sensitive-content": { max: 0, mode: "count" },
    };
    const fail = evaluatePolicy([probe("sensitive-content", 1, 3)], table);
    expect(fail.violations).toBe(1);
    expect(fail.verdicts[0]!.value).toBe(3);

    const ok = evaluatePolicy([probe("sensitive-content", 0, 0)], table);
    expect(ok.violations).toBe(0);
  });

  test("min violation", () => {
    const table: PolicyTable = { "tool-mix": { min: 1, mode: "rate" } };
    const r = evaluatePolicy([probe("tool-mix", 0)], table);
    expect(r.violations).toBe(1);
    expect(r.verdicts[0]!.detail).toContain("<");
  });

  test("missing probe is a violation", () => {
    const table: PolicyTable = { "rage-rate": { max: 0.1 } };
    const r = evaluatePolicy([probe("apology-rate", 0)], table);
    expect(r.violations).toBe(1);
    expect(r.verdicts[0]!.pass).toBe(false);
    expect(r.verdicts[0]!.detail).toContain("not in results");
  });

  test("structured verdict shape", () => {
    const table: PolicyTable = {
      "rage-rate": { max: 0.05, unit: "msg", mode: "rate" },
    };
    const r = evaluatePolicy([probe("rage-rate", 0.01)], table);
    const v = r.verdicts[0]!;
    expect(v.policy).toBe("rage-rate");
    expect(v.probe).toBe("rage-rate");
    expect(typeof v.value).toBe("number");
    expect(typeof v.pass).toBe("boolean");
    expect(v.threshold.max).toBe(0.05);
    expect(typeof v.detail).toBe("string");
    expect(r.policy).toBe(table);
  });
});

describe("formatPolicyReport", () => {
  test("includes PASS/FAIL and violations line", () => {
    const r = evaluatePolicy(
      [probe("rage-rate", 0.2)],
      { "rage-rate": { max: 0.05 } },
    );
    const text = formatPolicyReport(r);
    expect(text).toContain("speculum policy");
    expect(text).toContain("FAIL");
    expect(text).toContain("violations: 1");
    expect(text).toContain("compliant: no");
  });
});
