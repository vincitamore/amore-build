import { describe, expect, test } from "bun:test";
import {
  EVIDENCE_WEIGHT,
  maxSeverity,
  SEVERITY_WEIGHT,
  severityFromWeight,
  weightForEvidence,
  weightForSeverity,
  weightedAverage,
} from "./weights";

describe("weights helper", () => {
  test("severity ordinals order info < warning < alert", () => {
    expect(SEVERITY_WEIGHT.info).toBeLessThan(SEVERITY_WEIGHT.warning);
    expect(SEVERITY_WEIGHT.warning).toBeLessThan(SEVERITY_WEIGHT.alert);
    expect(weightForSeverity("alert")).toBe(3);
  });

  test("evidence weights: structured > free-text status claim", () => {
    expect(weightForEvidence("usage")).toBeGreaterThan(weightForEvidence("status-claim"));
    expect(weightForEvidence("tool-error")).toBeGreaterThan(weightForEvidence("frustration"));
    expect(EVIDENCE_WEIGHT.contradiction).toBe(0.5);
  });

  test("maxSeverity picks highest", () => {
    expect(maxSeverity([])).toBe("info");
    expect(maxSeverity(["info", "warning"])).toBe("warning");
    expect(maxSeverity(["alert", "info", "warning"])).toBe("alert");
  });

  test("severityFromWeight bands", () => {
    expect(severityFromWeight(0.9)).toBe("alert");
    expect(severityFromWeight(0.8)).toBe("alert");
    expect(severityFromWeight(0.5)).toBe("warning");
    expect(severityFromWeight(0.3)).toBe("info");
  });

  test("weightedAverage aggregates", () => {
    expect(weightedAverage([])).toBe(0);
    expect(weightedAverage([{ weight: 0, value: 99 }])).toBe(0);
    expect(
      weightedAverage([
        { weight: 1, value: 0 },
        { weight: 1, value: 1 },
      ]),
    ).toBe(0.5);
    expect(
      weightedAverage([
        { weight: 3, value: 1 },
        { weight: 1, value: 0 },
      ]),
    ).toBe(0.75);
  });
});
