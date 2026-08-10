/**
 * Shared category/pattern matcher for probe pattern banks.
 *
 * Compile-time caps keep banks ReDoS-safe: pattern source length, bank size,
 * and input scan length. Patterns should stay linear-time (no nested unbounded
 * quantifiers). Match on folded text; evidence recovers original codepoints.
 */

import { evidenceFromFolded, foldWithMap } from "./normalize";

/** Max source length for one pattern or exclude (chars). */
export const RULE_MATCH_MAX_PATTERN_LENGTH = 512;
/** Max rules in a single compiled bank. */
export const RULE_MATCH_MAX_BANK_SIZE = 256;
/** Max characters scanned per match call (fold buffer capped). */
export const RULE_MATCH_MAX_TEXT_LENGTH = 256_000;

export interface RuleDef {
  /** Stable pattern / category name. */
  name: string;
  /** Regex source string or prebuilt RegExp (flags taken from the object). */
  pattern: string | RegExp;
  /** Flags when `pattern` is a string (default "i" only if caller passes them). */
  flags?: string;
  /** Optional exclude: if it matches the folded text, the rule does not fire. */
  exclude?: string | RegExp;
  excludeFlags?: string;
  /** Relative weight for ranking / reporting (default 1). */
  weight?: number;
}

export interface CompiledRule {
  name: string;
  regex: RegExp;
  exclude?: RegExp;
  weight: number;
}

/** One match from a bank against a single text. */
export interface RuleMatch {
  name: string;
  /** Original-text evidence span (NFC source), not the folded buffer. */
  evidence: string;
  weight: number;
}

export class RuleCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleCompileError";
  }
}

/**
 * Classic catastrophic-backtracking shape: a group whose body ends with an
 * unbounded quantifier, itself immediately quantified with + or *.
 * Bounded repeats like (?:[A-Z]{2,}){3,} are allowed.
 */
const NESTED_UNBOUNDED =
  /\((?:[^()\\]|\\.|\[(?:[^\]\\]|\\.)*\])*?[+*]\)[+*]/;

function patternSource(p: string | RegExp): string {
  return typeof p === "string" ? p : p.source;
}

function patternFlags(p: string | RegExp, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  if (typeof p !== "string") return p.flags;
  return "";
}

function assertSafeSource(label: string, source: string): void {
  if (source.length === 0) {
    throw new RuleCompileError(`${label}: empty pattern`);
  }
  if (source.length > RULE_MATCH_MAX_PATTERN_LENGTH) {
    throw new RuleCompileError(
      `${label}: pattern length ${source.length} exceeds cap ${RULE_MATCH_MAX_PATTERN_LENGTH}`,
    );
  }
  if (NESTED_UNBOUNDED.test(source)) {
    throw new RuleCompileError(
      `${label}: pattern rejected (nested unbounded quantifier)`,
    );
  }
}

function compileOne(def: RuleDef): CompiledRule {
  if (!def.name || def.name.trim().length === 0) {
    throw new RuleCompileError("rule name is required");
  }
  const src = patternSource(def.pattern);
  assertSafeSource(def.name, src);
  const flags = patternFlags(def.pattern, def.flags);
  let regex: RegExp;
  try {
    regex = new RegExp(src, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RuleCompileError(`${def.name}: invalid pattern: ${msg}`);
  }

  let exclude: RegExp | undefined;
  if (def.exclude !== undefined) {
    const exSrc = patternSource(def.exclude);
    assertSafeSource(`${def.name}.exclude`, exSrc);
    const exFlags = patternFlags(def.exclude, def.excludeFlags);
    try {
      exclude = new RegExp(exSrc, exFlags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RuleCompileError(`${def.name}: invalid exclude: ${msg}`);
    }
  }

  const weight = def.weight ?? 1;
  if (!Number.isFinite(weight) || weight < 0) {
    throw new RuleCompileError(`${def.name}: weight must be a non-negative number`);
  }

  return { name: def.name, regex, exclude, weight };
}

/**
 * Compile a rule bank with size and pattern-safety caps.
 * Throws RuleCompileError on unsafe or invalid definitions.
 */
export function compileRuleBank(defs: readonly RuleDef[]): CompiledRule[] {
  if (defs.length > RULE_MATCH_MAX_BANK_SIZE) {
    throw new RuleCompileError(
      `bank size ${defs.length} exceeds cap ${RULE_MATCH_MAX_BANK_SIZE}`,
    );
  }
  return defs.map(compileOne);
}

/**
 * Match every rule once against text (first exec hit per rule, not global).
 * Folds typographic punctuation for matching; evidence uses original text.
 * Input longer than RULE_MATCH_MAX_TEXT_LENGTH is truncated for the match
 * buffer only — evidence still maps into the truncated prefix of the source.
 */
export function matchRules(text: string, rules: readonly CompiledRule[]): RuleMatch[] {
  const capped =
    text.length > RULE_MATCH_MAX_TEXT_LENGTH
      ? text.slice(0, RULE_MATCH_MAX_TEXT_LENGTH)
      : text;
  const foldedInfo = foldWithMap(capped);
  const folded = foldedInfo.folded;
  const out: RuleMatch[] = [];

  for (const rule of rules) {
    if (rule.exclude && rule.exclude.test(folded)) continue;
    const m = rule.regex.exec(folded);
    if (!m) continue;
    const raw = evidenceFromFolded(foldedInfo, m.index, m[0]!.length);
    out.push({
      name: rule.name,
      evidence: raw || m[0]!,
      weight: rule.weight,
    });
  }
  return out;
}

/**
 * Compile from string sources with explicit flags (JSON bank friendly).
 * Equivalent to compileRuleBank with string patterns.
 */
export function compileRuleBankFromJson(
  defs: ReadonlyArray<{
    name: string;
    pattern: string;
    flags?: string;
    exclude?: string;
    excludeFlags?: string;
    weight?: number;
  }>,
): CompiledRule[] {
  return compileRuleBank(
    defs.map((d) => ({
      name: d.name,
      pattern: d.pattern,
      flags: d.flags,
      exclude: d.exclude,
      excludeFlags: d.excludeFlags,
      weight: d.weight,
    })),
  );
}
