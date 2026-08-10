import { describe, expect, test } from "bun:test";
import {
  compileRuleBank,
  compileRuleBankFromJson,
  matchRules,
  RULE_MATCH_MAX_BANK_SIZE,
  RULE_MATCH_MAX_PATTERN_LENGTH,
  RuleCompileError,
} from "./rule-match";
import { APOLOGY_RULE_DEFS } from "./apology-rate";
import { OPERATOR_CORRECTION_RULE_DEFS } from "./operator-correction";

describe("compileRuleBank", () => {
  test("compiles production apology and operator banks", () => {
    const a = compileRuleBank(APOLOGY_RULE_DEFS);
    const o = compileRuleBank(OPERATOR_CORRECTION_RULE_DEFS);
    expect(a.length).toBe(APOLOGY_RULE_DEFS.length);
    expect(o.length).toBe(OPERATOR_CORRECTION_RULE_DEFS.length);
    expect(a.every((r) => r.regex instanceof RegExp)).toBe(true);
  });

  test("rejects empty pattern", () => {
    expect(() => compileRuleBank([{ name: "x", pattern: "" }])).toThrow(
      RuleCompileError,
    );
  });

  test("rejects over-long pattern source", () => {
    const long = "a".repeat(RULE_MATCH_MAX_PATTERN_LENGTH + 1);
    expect(() =>
      compileRuleBank([{ name: "long", pattern: long }]),
    ).toThrow(RuleCompileError);
  });

  test("rejects bank over size cap", () => {
    const defs = Array.from({ length: RULE_MATCH_MAX_BANK_SIZE + 1 }, (_, i) => ({
      name: `r${i}`,
      pattern: /x/,
    }));
    expect(() => compileRuleBank(defs)).toThrow(RuleCompileError);
  });

  test("rejects nested unbounded quantifier shape", () => {
    expect(() =>
      compileRuleBank([{ name: "bad", pattern: "(a+)+" }]),
    ).toThrow(RuleCompileError);
  });

  test("allows bounded repeat groups used by caps-correction", () => {
    const bank = compileRuleBank([
      {
        name: "caps",
        pattern: /\b[A-Z]{2,}([ /\\-]+[A-Z]{2,}){3,}\b/,
      },
    ]);
    expect(bank.length).toBe(1);
  });

  test("compileRuleBankFromJson uses string sources + flags", () => {
    const bank = compileRuleBankFromJson([
      { name: "hi", pattern: "\\bhello\\b", flags: "i" },
    ]);
    const hits = matchRules("Say Hello there", bank);
    expect(hits.length).toBe(1);
    expect(hits[0]!.name).toBe("hi");
    expect(hits[0]!.evidence.toLowerCase()).toContain("hello");
  });
});

describe("matchRules", () => {
  test("returns name, evidence, weight; exclude skips", () => {
    const bank = compileRuleBank([
      {
        name: "greet",
        pattern: /\bhello\b/i,
        exclude: /\bhello world\b/i,
        weight: 3,
      },
    ]);
    expect(matchRules("hello world", bank)).toEqual([]);
    const hits = matchRules("hello there", bank);
    expect(hits).toEqual([
      { name: "greet", evidence: "hello", weight: 3 },
    ]);
  });

  test("evidence keeps curly apostrophe via fold map", () => {
    const bank = compileRuleBank([
      {
        name: "youre-right",
        pattern: /(^|[.!?]\s+)you'?re right\b[\s,—.:]/im,
      },
    ]);
    const hits = matchRules("You\u2019re right. Done.", bank);
    expect(hits.length).toBe(1);
    expect(hits[0]!.evidence).toContain("\u2019");
  });

  test("weight defaults to 1", () => {
    const bank = compileRuleBank([{ name: "x", pattern: /x/ }]);
    expect(matchRules("x", bank)[0]!.weight).toBe(1);
  });
});
