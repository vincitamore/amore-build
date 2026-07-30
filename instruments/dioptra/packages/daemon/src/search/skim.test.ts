// ─────────────────────────────────────────────────────────────────────────────
// skim.test.ts — the crate's OWN #[test] cases, ported verbatim from
// fuzzy-matcher-0.3.7/src/skim.rs (and the simple_match test), run against the
// TypeScript port. This is the primary mechanical parity gate: every assertion
// the Rust crate makes about SkimMatcherV2 must hold here.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from 'bun:test';
import {
  fuzzyMatch,
  fuzzyIndices,
  makeMatcher,
  simpleMatchForTest,
} from './skim.ts';

type Matcher = {
  fuzzyMatch(text: string, pattern: string): number | null;
  fuzzyIndices(text: string, pattern: string): { score: number; indices: number[] } | null;
};

const defaultMatcher: Matcher = { fuzzyMatch, fuzzyIndices };

// util.rs::wrap_matches — bracket each matched code point.
function wrapMatches(line: string, indices: number[]): string {
  let ret = '';
  let peek = 0;
  const chars = [...line];
  const lineLen = chars.length;
  for (let idx = 0; idx < chars.length; idx++) {
    const nextId = peek < indices.length ? indices[peek] : lineLen;
    if (nextId === idx) {
      ret += `[${chars[idx]}]`;
      peek++;
    } else {
      ret += chars[idx];
    }
  }
  return ret;
}

function wrapFuzzyMatch(m: Matcher, line: string, pattern: string): string | null {
  const r = m.fuzzyIndices(line, pattern);
  if (r === null) return null;
  return wrapMatches(line, r.indices);
}

// util.rs::assert_order — filter_and_sort must return `choices` unchanged
// (i.e. the choices are already in best→worst score order, stable on ties).
function assertOrder(m: Matcher, pattern: string, choices: string[]): void {
  const scored = choices
    .map((s, i) => ({ s, i, score: m.fuzzyMatch(s, pattern) }))
    .filter((x): x is { s: string; i: number; score: number } => x.score !== null);
  // sort_by_key(|(score,_)| -score) — stable, descending by score.
  scored.sort((a, b) => b.score - a.score);
  const result = scored.map((x) => x.s);
  expect(result).toEqual(choices);
}

// ── test_match_or_not (V1-era assertions; SkimMatcherV2::default here) ────────
describe('test_match_or_not', () => {
  const m = defaultMatcher;
  test('score presence', () => {
    expect(m.fuzzyMatch('', '')).toBe(0);
    expect(m.fuzzyMatch('abcdefaghi', '')).toBe(0);
    expect(m.fuzzyMatch('', 'a')).toBe(null);
    expect(m.fuzzyMatch('abcdefaghi', '中')).toBe(null);
    expect(m.fuzzyMatch('abc', 'abx')).toBe(null);
    expect(m.fuzzyMatch('axbycz', 'abc')).not.toBe(null);
    expect(m.fuzzyMatch('axbycz', 'xyz')).not.toBe(null);
  });
  test('wrap', () => {
    expect(wrapFuzzyMatch(m, 'axbycz', 'abc')).toBe('[a]x[b]y[c]z');
    expect(wrapFuzzyMatch(m, 'axbycz', 'xyz')).toBe('a[x]b[y]c[z]');
    expect(wrapFuzzyMatch(m, 'Hello, 世界', 'H世')).toBe('[H]ello, [世]界');
  });
});

// ── test_match_quality (matcher = .ignore_case()) ────────────────────────────
describe('test_match_quality', () => {
  const m = makeMatcher('ignore');
  test('order', () => {
    assertOrder(m, 'ab', ['ab', 'aoo_boo', 'acb']);
    assertOrder(m, 'CC', ['CamelCase', 'camelCase', 'camelcase']);
    assertOrder(m, 'cC', ['camelCase', 'CamelCase', 'camelcase']);
    assertOrder(m, 'cc', ['camel case', 'camelCase', 'CamelCase', 'camelcase', 'camel ace']);
    assertOrder(m, 'Da.Te', ['Data.Text', 'Data.Text.Lazy', 'Data.Aeson.Encoding.text']);
    assertOrder(m, 'is', ['isIEEE', 'inSuf']);
    assertOrder(m, 'ma', ['map', 'many', 'maximum']);
    assertOrder(m, 'print', ['printf', 'sprintf']);
    assertOrder(m, 'ast', ['ast', 'AST', 'INT_FAST16_MAX']);
    assertOrder(m, 'Int', ['int', 'INT', 'PRINT']);
  });
});

// ── test_match_or_not_simple (exercises simple_match directly) ────────────────
describe('test_match_or_not_simple', () => {
  test('simple_match', () => {
    expect(simpleMatchForTest('axbycz', 'xyz', false, true)!.indices).toEqual([1, 3, 5]);
    expect(simpleMatchForTest('', '', false, false)).toEqual({ score: 0, indices: [] });
    expect(simpleMatchForTest('abcdefaghi', '', false, false)).toEqual({ score: 0, indices: [] });
    expect(simpleMatchForTest('', 'a', false, false)).toBe(null);
    expect(simpleMatchForTest('abcdefaghi', '中', false, false)).toBe(null);
    expect(simpleMatchForTest('abc', 'abx', false, false)).toBe(null);
    expect(simpleMatchForTest('axbycz', 'abc', false, true)!.indices).toEqual([0, 2, 4]);
    expect(simpleMatchForTest('axbycz', 'xyz', false, true)!.indices).toEqual([1, 3, 5]);
    expect(simpleMatchForTest('Hello, 世界', 'H世', false, true)!.indices).toEqual([0, 7]);
  });
});

// ── test_match_or_not_v2 (SkimMatcherV2::default) ─────────────────────────────
describe('test_match_or_not_v2', () => {
  const m = defaultMatcher;
  test('score presence', () => {
    expect(m.fuzzyMatch('', '')).toBe(0);
    expect(m.fuzzyMatch('abcdefaghi', '')).toBe(0);
    expect(m.fuzzyMatch('', 'a')).toBe(null);
    expect(m.fuzzyMatch('abcdefaghi', '中')).toBe(null);
    expect(m.fuzzyMatch('abc', 'abx')).toBe(null);
    expect(m.fuzzyMatch('axbycz', 'abc')).not.toBe(null);
    expect(m.fuzzyMatch('axbycz', 'xyz')).not.toBe(null);
  });
  test('wrap', () => {
    expect(wrapFuzzyMatch(m, 'axbycz', 'abc')).toBe('[a]x[b]y[c]z');
    expect(wrapFuzzyMatch(m, 'axbycz', 'xyz')).toBe('a[x]b[y]c[z]');
    expect(wrapFuzzyMatch(m, 'Hello, 世界', 'H世')).toBe('[H]ello, [世]界');
  });
});

// ── test_case_option_v2 (ignore / respect / smart) ───────────────────────────
describe('test_case_option_v2', () => {
  test('ignore_case', () => {
    const m = makeMatcher('ignore');
    expect(m.fuzzyMatch('aBc', 'abc')).not.toBe(null);
    expect(m.fuzzyMatch('aBc', 'aBc')).not.toBe(null);
    expect(m.fuzzyMatch('aBc', 'aBC')).not.toBe(null);
  });
  test('respect_case', () => {
    const m = makeMatcher('respect');
    expect(m.fuzzyMatch('aBc', 'abc')).toBe(null);
    expect(m.fuzzyMatch('aBc', 'aBc')).not.toBe(null);
    expect(m.fuzzyMatch('aBc', 'aBC')).toBe(null);
  });
  test('smart_case', () => {
    const m = makeMatcher('smart');
    expect(m.fuzzyMatch('aBc', 'abc')).not.toBe(null);
    expect(m.fuzzyMatch('aBc', 'aBc')).not.toBe(null);
    expect(m.fuzzyMatch('aBc', 'aBC')).toBe(null);
  });
});

// ── test_matcher_quality_v2 (SkimMatcherV2::default) ──────────────────────────
describe('test_matcher_quality_v2', () => {
  const m = defaultMatcher;
  test('order', () => {
    assertOrder(m, 'ab', ['ab', 'aoo_boo', 'acb']);
    assertOrder(m, 'cc', ['camel case', 'camelCase', 'CamelCase', 'camelcase', 'camel ace']);
    assertOrder(m, 'Da.Te', ['Data.Text', 'Data.Text.Lazy', 'Data.Aeson.Encoding.Text']);
    assertOrder(m, 'is', ['isIEEE', 'inSuf']);
    assertOrder(m, 'ma', ['map', 'many', 'maximum']);
    assertOrder(m, 'print', ['printf', 'sprintf']);
    assertOrder(m, 'ast', ['ast', 'AST', 'INT_FAST16_MAX']);
    assertOrder(m, 'int', ['int', 'INT', 'PRINT']);
  });
});

// ── test_reuse_should_not_affect_indices ─────────────────────────────────────
describe('test_reuse_should_not_affect_indices', () => {
  test('reuse', () => {
    const pattern = '139';
    for (let num = 0; num < 10000; num++) {
      const choice = String(num);
      const r = defaultMatcher.fuzzyIndices(choice, pattern);
      if (r !== null) {
        expect(r.indices.length).toBe(3);
      }
    }
  });
});
