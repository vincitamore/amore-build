/**
 * Match-time text prep for pattern banks.
 * NFC + typographic punctuation fold only — no case fold, no store mutation.
 * Call on a match buffer; keep original text for evidence strings.
 */

const TYPOGRAPHIC_FOLD: Record<string, string> = {
  "\u2018": "'", // left single quotation mark
  "\u2019": "'", // right single quotation mark
  "\u201A": "'", // single low-9 quotation mark
  "\u201B": "'", // single high-reversed-9 quotation mark
  "\u2032": "'", // prime
  "\u201C": '"', // left double quotation mark
  "\u201D": '"', // right double quotation mark
  "\u201E": '"', // double low-9 quotation mark
  "\u201F": '"', // double high-reversed-9 quotation mark
  "\u2033": '"', // double prime
  "\u2013": "-", // en dash
  "\u2014": "--", // em dash
  "\u2212": "-", // minus sign
  "\u2026": "...", // horizontal ellipsis
};

export interface FoldedText {
  /** NFC + typographic fold — use for pattern matching only. */
  folded: string;
  /** NFC form of input — evidence slices land here (keeps curly quotes/dashes). */
  source: string;
  /** map[i] = source index of the source char that produced folded[i]. */
  map: number[];
}

/** NFC unicode normalization + smart-quote / typographic-punctuation → ASCII. */
export function normalizeForProbe(text: string): string {
  return foldWithMap(text).folded;
}

/** Fold plus index map so match spans can recover original (NFC) evidence. */
export function foldWithMap(text: string): FoldedText {
  const source = text.normalize("NFC");
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const repl = TYPOGRAPHIC_FOLD[ch] ?? ch;
    for (let j = 0; j < repl.length; j++) {
      map.push(i);
      folded += repl[j]!;
    }
  }
  return { folded, source, map };
}

/**
 * Recover a span of the NFC source text corresponding to a match on `folded`.
 * Prefer this for evidence so operator/agent text keeps its original codepoints.
 */
export function evidenceFromFolded(
  foldedInfo: FoldedText,
  foldIndex: number,
  foldLength: number,
): string {
  const { source, map, folded } = foldedInfo;
  if (foldLength <= 0 || map.length === 0) return "";
  if (foldIndex < 0 || foldIndex >= folded.length) {
    return folded.slice(foldIndex, foldIndex + foldLength);
  }
  const start = map[foldIndex]!;
  const lastFold = Math.min(foldIndex + foldLength - 1, map.length - 1);
  const end = map[lastFold]! + 1;
  return source.slice(start, end);
}
