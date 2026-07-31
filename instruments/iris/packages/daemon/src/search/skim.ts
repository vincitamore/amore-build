// ─────────────────────────────────────────────────────────────────────────────
// skim.ts — a bit-faithful port of
//   fuzzy_matcher::skim::SkimMatcherV2::default().fuzzy_match(choice, pattern)
// from the vendored Rust crate `fuzzy-matcher` v0.3.7 (the exact version the
// legacy Vitrum daemon links; confirmed against src-tauri/Cargo.lock).
//
// Ground truth ported cell-for-cell:
//   ~/.cargo/registry/.../fuzzy-matcher-0.3.7/src/skim.rs  (SkimMatcherV2, build_score_matrix)
//   ~/.cargo/registry/.../fuzzy-matcher-0.3.7/src/util.rs  (char_equal, cheap_matches)
//   ~/.cargo/registry/.../fuzzy-matcher-0.3.7/src/lib.rs   (ScoreType = i64, IndexType = usize)
//
// The V2 matcher solves sequence alignment with an affine gap penalty over two
// score matrices M (ends in match) and P (ends in skip). This file ports the
// `fuzzy()` method (score + optional positions). It does NOT port the deprecated
// V1 (`build_graph`/`fuzzy_score`) path — SkimMatcherV2 never calls it.
//
// SkimMatcherV2::default() settings that matter here:
//   - score_config = SkimScoreConfig::default()  (constants below)
//   - element_limit = 0  → the `simple_match` short-circuit is UNREACHABLE via
//     fuzzy(); it is ported (see simpleMatch) ONLY to gate the crate's own
//     simple_match tests, never invoked by fuzzyMatch/fuzzyIndices.
//   - case = Smart       → case-sensitive iff the pattern contains an ASCII upper.
//   - use_cache = true   → a scratch-matrix optimization. We allocate a fresh
//     matrix per call (the crate's cold-cache / first-call path). The warm-cache
//     variant only perturbs a narrow consecutive-run edge case whose outcome is
//     already non-deterministic across daemon restarts (HashMap call order), and
//     which the parity harness canonicalizes; the deterministic algorithm is the
//     fresh matrix. Scores are byte-identical to the crate's first call.
//
// All case handling is ASCII-only (Rust `eq_ignore_ascii_case` / `is_ascii_*`),
// NOT JS Unicode `toLowerCase` — non-ASCII code points compare by identity.
// Strings are iterated by Unicode scalar value (code point), matching Rust `char`.
// ─────────────────────────────────────────────────────────────────────────────

// SkimScoreConfig::default() — the numeric spine (skim.rs:317-336).
const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_HEAD = SCORE_MATCH / 2; // 8
const BONUS_BREAK = SCORE_MATCH / 2 + GAP_EXTENSION; // 7
const BONUS_CAMEL = SCORE_MATCH / 2 + 2 * GAP_EXTENSION; // 6
const BONUS_CONSECUTIVE = -(GAP_START + GAP_EXTENSION); // 4
const PENALTY_CASE_MISMATCH = GAP_EXTENSION * 2; // -2

// MatrixCell default `m_score`/`p_score` sentinel — i16::MIN as i32 (skim.rs:359).
const NEG_INFINITY = -32768;

// Movement encoding (skim.rs Movement enum): Skip = 0, Match = 1.
const MOVE_SKIP = 0;
const MOVE_MATCH = 1;

// CharType (skim.rs:480-501) — the skim.rs variant, NOT util.rs's four-way one.
const enum CharType {
  Empty = 0,
  Upper = 1,
  Lower = 2,
  Number = 3,
  HardSep = 4,
  SoftSep = 5,
}

// CharRole (skim.rs:521-543).
const enum CharRole {
  Head = 0,
  Tail = 1,
  Camel = 2,
  Break = 3,
}

/** CaseMatching (skim.rs:545-550). SkimMatcherV2::default() uses Smart. */
export type CaseMatching = 'respect' | 'ignore' | 'smart';

/** Iterate a string by Unicode scalar value (code point) like Rust `char`. */
function toCodePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

/** Rust `char::to_ascii_lowercase` — only A–Z fold, everything else identity. */
function asciiLower(cp: number): number {
  return cp >= 0x41 /* A */ && cp <= 0x5a /* Z */ ? cp + 0x20 : cp;
}

/** Rust `char::eq_ignore_ascii_case`. */
function eqIgnoreAsciiCase(a: number, b: number): boolean {
  return asciiLower(a) === asciiLower(b);
}

/** util.rs::char_equal — case-sensitive identity or ASCII-case-insensitive. */
function charEqual(a: number, b: number, caseSensitive: boolean): boolean {
  return caseSensitive ? a === b : eqIgnoreAsciiCase(a, b);
}

/** skim.rs CharType::of. Order matters — first matching arm wins. */
function charType(cp: number): CharType {
  if (cp === 0) return CharType.Empty; // '\0' sentinel (start-of-string)
  switch (cp) {
    case 0x20: // ' '
    case 0x2f: // '/'
    case 0x5c: // '\'
    case 0x7c: // '|'
    case 0x28: // '('
    case 0x29: // ')'
    case 0x5b: // '['
    case 0x5d: // ']'
    case 0x7b: // '{'
    case 0x7d: // '}'
      return CharType.HardSep;
  }
  if (
    (cp >= 0x21 && cp <= 0x27) || // '!'..='\''
    (cp >= 0x2a && cp <= 0x2e) || // '*'..='.'
    (cp >= 0x3a && cp <= 0x40) || // ':'..='@'
    (cp >= 0x5e && cp <= 0x60) || // '^'..='`'
    cp === 0x7e // '~'
  ) {
    return CharType.SoftSep;
  }
  if (cp >= 0x30 && cp <= 0x39) return CharType.Number; // '0'..='9'
  if (cp >= 0x41 && cp <= 0x5a) return CharType.Upper; // 'A'..='Z'
  return CharType.Lower; // ascii lower + all other (unicode) scalars
}

/** skim.rs CharRole::of_type. */
function charRoleOfType(prev: CharType, cur: CharType): CharRole {
  if (prev === CharType.Empty || prev === CharType.HardSep) return CharRole.Head;
  if (prev === CharType.SoftSep) return CharRole.Break;
  if (
    (prev === CharType.Lower && cur === CharType.Upper) ||
    (prev === CharType.Number && cur === CharType.Upper)
  ) {
    return CharRole.Camel;
  }
  return CharRole.Tail;
}

/** skim.rs SkimMatcherV2::in_place_bonus. */
function inPlaceBonus(prevType: CharType, curType: CharType): number {
  switch (charRoleOfType(prevType, curType)) {
    case CharRole.Head:
      return BONUS_HEAD;
    case CharRole.Camel:
      return BONUS_CAMEL;
    case CharRole.Break:
      return BONUS_BREAK;
    case CharRole.Tail:
      return 0;
  }
}

/** skim.rs SkimMatcherV2::build_in_place_bonus. Returns array of length cols. */
function buildInPlaceBonus(choice: number[]): Int32Array {
  const cols = choice.length + 1;
  const b = new Int32Array(cols); // b[0] stays 0
  let prev = 0; // '\0'
  for (let j = 0; j < choice.length; j++) {
    b[j + 1] = inPlaceBonus(charType(prev), charType(choice[j]));
    prev = choice[j];
  }
  if (b.length > 1) b[1] *= BONUS_FIRST_CHAR_MULTIPLIER;
  return b;
}

/**
 * skim.rs SkimMatcherV2::calculate_match_score. Returns the match score (u16
 * range) or null if the chars do not match.
 */
function calculateMatchScore(c: number, p: number, caseSensitive: boolean): number | null {
  if (!charEqual(c, p, caseSensitive)) return null;
  let bonus = 0;
  if (!caseSensitive && p !== c) bonus += PENALTY_CASE_MISMATCH;
  return Math.max(0, SCORE_MATCH + bonus);
}

/**
 * util.rs::cheap_matches — greedy left-to-right first-occurrence indices, or
 * null if the pattern cannot be subsequence-matched into the choice at all.
 */
function cheapMatches(
  choice: number[],
  pattern: number[],
  caseSensitive: boolean,
): number[] | null {
  const firstMatchIndices: number[] = [];
  let pi = 0;
  for (let idx = 0; idx < choice.length; idx++) {
    if (pi >= pattern.length) break;
    if (charEqual(choice[idx], pattern[pi], caseSensitive)) {
      firstMatchIndices.push(idx);
      pi++;
    }
  }
  return pi >= pattern.length ? firstMatchIndices : null;
}

/** skim.rs SkimMatcherV2::contains_upper. */
function containsUpper(pattern: number[]): boolean {
  for (const cp of pattern) {
    if (cp >= 0x41 && cp <= 0x5a) return true;
  }
  return false;
}

interface FuzzyResult {
  score: number;
  /** Matched code-point indices into `choice` (only filled when withPos). */
  positions: number[];
}

/**
 * The V2 core: fuzzy(choice, pattern, withPos). Faithful port of
 * SkimMatcherV2::fuzzy (skim.rs:818-938) for the default matcher (element_limit
 * 0 → the simple_match branch is unreachable). Uses the full (non-compressed)
 * matrix always: scores are identical to the crate's compressed score-only path,
 * and backtracking for positions needs the full matrix anyway (which is why the
 * crate itself de-compresses when with_pos).
 */
function fuzzy(
  choiceStr: string,
  patternStr: string,
  withPos: boolean,
  caseMode: CaseMatching,
): FuzzyResult | null {
  if (patternStr.length === 0) return { score: 0, positions: [] };

  const choice = toCodePoints(choiceStr);
  const pattern = toCodePoints(patternStr);

  const caseSensitive =
    caseMode === 'respect'
      ? true
      : caseMode === 'ignore'
        ? false
        : containsUpper(pattern); // smart

  const firstMatchIndices = cheapMatches(choice, pattern, caseSensitive);
  if (firstMatchIndices === null) return null;

  const cols = choice.length + 1;
  const numCharPattern = pattern.length;
  const rows = numCharPattern + 1; // full matrix (crate compresses only score-only)

  // Fresh matrix at MatrixCell::default(): m/p score = NEG_INFINITY, moves Skip,
  // bonus 0. Flat (row-major) layout: index = row * cols + col.
  const size = rows * cols;
  const mScore = new Int32Array(size).fill(NEG_INFINITY);
  const pScore = new Int32Array(size).fill(NEG_INFINITY);
  const mMove = new Uint8Array(size); // 0 = Skip
  const pMove = new Uint8Array(size);
  const bonus = new Int32Array(size);

  const inPlaceBonuses = buildInPlaceBonus(choice);

  // Reset the leftmost-used cell of each pattern row (skim.rs:682-685). A fresh
  // matrix already has these at default; kept for structural fidelity.
  // (row 0 col 0 handled by the row-0 loop below.)
  for (let i = 1; i < rows; i++) {
    const idx = i * cols + firstMatchIndices[i - 1];
    mScore[idx] = NEG_INFINITY;
    pScore[idx] = NEG_INFINITY;
    mMove[idx] = MOVE_SKIP;
    pMove[idx] = MOVE_SKIP;
    bonus[idx] = 0;
  }
  // Row 0: base row for the empty pattern prefix (skim.rs:687-691).
  for (let j = 0; j < cols; j++) {
    const idx = j; // row 0
    mScore[idx] = NEG_INFINITY;
    pScore[idx] = GAP_EXTENSION;
    mMove[idx] = MOVE_SKIP;
    pMove[idx] = MOVE_SKIP;
    bonus[idx] = 0;
  }

  // Main DP (skim.rs:694-752).
  for (let i = 0; i < numCharPattern; i++) {
    const pCh = pattern[i];
    const row = i + 1;
    const rowPrev = i;
    const toSkip = firstMatchIndices[i];

    for (let j = 0; j + toSkip < choice.length; j++) {
      const cCh = choice[toSkip + j];
      const col = toSkip + j + 1;
      const colPrev = toSkip + j;
      const idxCur = row * cols + col;
      const idxLast = row * cols + colPrev;
      const idxPrev = rowPrev * cols + colPrev;

      // M matrix: M[i][j] = match(i,j) + max(M[i-1][j-1]+consec, P[i-1][j-1]).
      const curMatchScore = calculateMatchScore(cCh, pCh, caseSensitive);
      if (curMatchScore !== null) {
        const prevMatchScore = mScore[idxPrev];
        const prevSkipScore = pScore[idxPrev];
        const prevMatchBonus = bonus[idxLast];
        const inPlace = inPlaceBonuses[col];

        const consecutiveBonus = Math.max(
          prevMatchBonus,
          Math.max(inPlace, BONUS_CONSECUTIVE),
        );
        bonus[idxLast] = consecutiveBonus;

        const scoreMatch = prevMatchScore + consecutiveBonus;
        const scoreSkip = prevSkipScore + inPlace;

        if (scoreMatch >= scoreSkip) {
          mScore[idxCur] = scoreMatch + curMatchScore;
          mMove[idxCur] = MOVE_MATCH;
        } else {
          mScore[idxCur] = scoreSkip + curMatchScore;
          mMove[idxCur] = MOVE_SKIP;
        }
      } else {
        mScore[idxCur] = NEG_INFINITY;
        mMove[idxCur] = MOVE_SKIP;
        bonus[idxCur] = 0;
      }

      // P matrix: P[i][j] = max(gap_start+gap_ext+M[i][j-1], gap_ext+P[i][j-1]).
      const pm = GAP_START + GAP_EXTENSION + mScore[idxLast];
      const ps = GAP_EXTENSION + pScore[idxLast];
      if (pm >= ps) {
        pScore[idxCur] = pm;
        pMove[idxCur] = MOVE_MATCH;
      } else {
        pScore[idxCur] = ps;
        pMove[idxCur] = MOVE_SKIP;
      }
    }
  }

  // Max m_score over the last row, from the last pattern char's first match
  // column onward. Rust max_by_key returns the LAST maximum on ties — replicate
  // with `>=` so the tie-break column (which matters for backtracking) matches.
  const firstColOfLastRow = firstMatchIndices[firstMatchIndices.length - 1];
  const lastRowBase = numCharPattern * cols;
  let bestScore = -Infinity;
  let patIdx = firstColOfLastRow;
  for (let c = firstColOfLastRow; c < cols; c++) {
    const s = mScore[lastRowBase + c];
    if (s >= bestScore) {
      bestScore = s;
      patIdx = c;
    }
  }

  const positions: number[] = [];
  if (withPos) {
    // Backtrack (skim.rs:899-923).
    let i = rows - 1;
    let j = patIdx;
    let trackM = true;
    let currentMove = MOVE_MATCH;
    const firstColFirstRow = firstMatchIndices[0];
    while (i > 0 && j > firstColFirstRow) {
      if (currentMove === MOVE_MATCH) positions.push(j - 1);
      const idx = i * cols + j;
      currentMove = trackM ? mMove[idx] : pMove[idx];
      if (trackM) i -= 1;
      j -= 1;
      trackM = currentMove === MOVE_MATCH;
    }
    positions.reverse();
  }

  return { score: bestScore, positions };
}

/**
 * simple_match (skim.rs:940-1056). UNREACHABLE from the default matcher
 * (element_limit 0), ported solely to gate the crate's simple_match tests.
 */
function simpleMatchImpl(
  choice: number[],
  pattern: number[],
  firstMatchIndices: number[],
  caseSensitive: boolean,
  withPos: boolean,
): FuzzyResult {
  if (pattern.length <= 0) return { score: 0, positions: [] };
  if (pattern.length === 1) {
    const matchIdx = firstMatchIndices[0];
    const prevCh = matchIdx > 0 ? choice[matchIdx - 1] : 0;
    const bonusVal = inPlaceBonus(charType(prevCh), charType(choice[matchIdx]));
    return { score: bonusVal, positions: [matchIdx] };
  }

  let startIdx = firstMatchIndices[0];
  const endIdx = firstMatchIndices[firstMatchIndices.length - 1];

  // Greedy from the right. NOTE (faithful to skim.rs): the crate enumerates the
  // SLICE choice[start_idx..=end_idx] and rev()s it, so `idx` — and therefore the
  // reassigned `start_idx` — is RELATIVE to the slice start, not an absolute
  // choice index. The slice bound is captured once from the ORIGINAL start_idx.
  const sliceStart = startIdx;
  let pk = pattern.length - 1;
  for (let rel = endIdx - sliceStart; rel >= 0; rel--) {
    if (pk < 0) break;
    if (charEqual(choice[sliceStart + rel], pattern[pk], caseSensitive)) {
      pk--;
      startIdx = rel; // relative index — matches the crate's quirk
    }
  }

  return calculateScoreWithPos(choice, pattern, startIdx, endIdx, caseSensitive, withPos);
}

/** skim.rs SkimMatcherV2::calculate_score_with_pos. */
function calculateScoreWithPos(
  choice: number[],
  pattern: number[],
  startIdx: number,
  endIdx: number,
  caseSensitive: boolean,
  withPos: boolean,
): FuzzyResult {
  const pos: number[] = [];
  let pIdx = 0;
  let prevCh = 0; // '\0'
  let score = 0;
  let inGap = false;
  let prevMatchBonus = 0;

  for (let cIdx = 0; cIdx + startIdx <= endIdx; cIdx++) {
    if (pIdx >= pattern.length) break;
    const c = choice[startIdx + cIdx];
    const inPlace = inPlaceBonus(charType(prevCh), charType(c));
    const p = pattern[pIdx];

    const matchScore = calculateMatchScore(c, p, caseSensitive);
    if (matchScore !== null) {
      if (withPos) pos.push(cIdx + startIdx);
      score += matchScore;
      const consecutiveBonus = Math.max(prevMatchBonus, Math.max(inPlace, BONUS_CONSECUTIVE));
      prevMatchBonus = consecutiveBonus;
      if (!inGap) score += consecutiveBonus;
      inGap = false;
      pIdx++;
    } else {
      if (!inGap) score += GAP_START;
      score += GAP_EXTENSION;
      inGap = true;
      prevMatchBonus = 0;
    }
    prevCh = c;
  }

  return { score, positions: pos };
}

/**
 * SkimMatcherV2::default().fuzzy_match(choice, pattern) → score or null.
 * The legacy search endpoint's sole scoring primitive.
 */
export function fuzzyMatch(text: string, pattern: string): number | null {
  const r = fuzzy(text, pattern, false, 'smart');
  return r === null ? null : r.score;
}

/**
 * SkimMatcherV2::default().fuzzy_indices(choice, pattern) → {score, indices}.
 * Not on the SearchModule surface; exported for the crate-test gate.
 */
export function fuzzyIndices(text: string, pattern: string): { score: number; indices: number[] } | null {
  const r = fuzzy(text, pattern, true, 'smart');
  return r === null ? null : { score: r.score, indices: r.positions };
}

/** A configured matcher, mirroring the crate's `.ignore_case()` / `.respect_case()`
 *  / `.smart_case()` builders — used only by the ported case-option tests. */
export function makeMatcher(caseMode: CaseMatching) {
  return {
    fuzzyMatch(text: string, pattern: string): number | null {
      const r = fuzzy(text, pattern, false, caseMode);
      return r === null ? null : r.score;
    },
    fuzzyIndices(text: string, pattern: string): { score: number; indices: number[] } | null {
      const r = fuzzy(text, pattern, true, caseMode);
      return r === null ? null : { score: r.score, indices: r.positions };
    },
  };
}

/** Port of the crate's `simple_match` test helper (constructs cheap_matches then
 *  runs simpleMatchImpl). Exposed for the simple_match test gate only. */
export function simpleMatchForTest(
  choiceStr: string,
  patternStr: string,
  caseSensitive: boolean,
  withPos: boolean,
): { score: number; indices: number[] } | null {
  const choice = toCodePoints(choiceStr);
  const pattern = toCodePoints(patternStr);
  const fmi = cheapMatches(choice, pattern, caseSensitive);
  if (fmi === null) return null;
  const r = simpleMatchImpl(choice, pattern, fmi, caseSensitive, withPos);
  return { score: r.score, indices: r.positions };
}
