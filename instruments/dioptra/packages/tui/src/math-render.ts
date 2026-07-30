/**
 * Terminal math for the Vitrum doc viewer — KaTeX parse tree → Unicode text.
 *
 * OpenTUI fixed `<text>` slots cannot host KaTeX HTML/CSS. We use KaTeX only as the
 * **parser** (`katex.__parse`), then walk the parse tree into a readable Unicode string.
 * That keeps TeX correctness (grouping, cases, frac, macros KaTeX knows) without
 * re-implementing a TeX tokenizer.
 *
 * Delimiter extraction for markdown stays here; conversion is KaTeX-owned.
 */

import katex from 'katex';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// ── KaTeX symbol table (replace map: "\\theta" → "θ") ────────────────────────

type CharInfo = { font: string; group: string; replace?: string | null };
type SymbolTable = { math: Record<string, CharInfo>; text: Record<string, CharInfo> };

function loadSymbols(): SymbolTable {
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('katex/package.json'));
    for (const rel of ['src/symbols.js', 'src/symbols.ts']) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(`${root}/${rel}`);
        const table = (mod.default ?? mod) as SymbolTable;
        if (table?.math) return table;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* empty */
  }
  return { math: {}, text: {} };
}

const SYMBOLS = loadSymbols();

function symbolText(raw: string | undefined | null, mode: 'math' | 'text' = 'math'): string {
  if (raw == null || raw === '') return '';
  if (!raw.startsWith('\\')) return raw;
  const info = SYMBOLS[mode]?.[raw] ?? SYMBOLS.math[raw] ?? SYMBOLS.text[raw];
  if (info?.replace) return info.replace;
  if (/^\\[A-Za-z]+$/.test(raw)) return raw.slice(1);
  if (raw.length === 2) return raw[1];
  return raw.slice(1);
}

// ── Display mode ─────────────────────────────────────────────────────────────

let displayMode = false;

const REL_CMDS: Record<string, true> = {
  '\\le': true,
  '\\leq': true,
  '\\ge': true,
  '\\geq': true,
  '\\neq': true,
  '\\ne': true,
  '\\approx': true,
  '\\sim': true,
  '\\simeq': true,
  '\\cong': true,
  '\\equiv': true,
  '\\propto': true,
  '\\in': true,
  '\\notin': true,
  '\\subset': true,
  '\\supset': true,
  '\\subseteq': true,
  '\\supseteq': true,
  '\\to': true,
  '\\rightarrow': true,
  '\\leftarrow': true,
  '\\mapsto': true,
  '\\perp': true,
  '\\mid': true,
  '\\parallel': true,
  '\\ni': true,
};

// ── Sub/superscript unicode maps ─────────────────────────────────────────────

const SUB: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
};

const SUP: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
  a: 'ᵃ',
  b: 'ᵇ',
  c: 'ᶜ',
  d: 'ᵈ',
  e: 'ᵉ',
  f: 'ᶠ',
  g: 'ᵍ',
  h: 'ʰ',
  j: 'ʲ',
  k: 'ᵏ',
  l: 'ˡ',
  m: 'ᵐ',
  o: 'ᵒ',
  p: 'ᵖ',
  r: 'ʳ',
  s: 'ˢ',
  t: 'ᵗ',
  u: 'ᵘ',
  v: 'ᵛ',
  w: 'ʷ',
  x: 'ˣ',
  y: 'ʸ',
  z: 'ᶻ',
};

function toScript(s: string, kind: 'sub' | 'sup'): string {
  const table = kind === 'sub' ? SUB : SUP;
  const compact = s.replace(/\s+/g, '');
  let out = '';
  for (const ch of compact) {
    const m = table[ch];
    if (!m) {
      if (compact.length <= 1) return kind === 'sub' ? `_${compact}` : `^${compact}`;
      return kind === 'sub' ? `_{${compact}}` : `^{${compact}}`;
    }
    out += m;
  }
  return out || (kind === 'sub' ? `_${compact}` : `^${compact}`);
}

// ── Tree walk ────────────────────────────────────────────────────────────────

type AnyNode = {
  type: string;
  mode?: string;
  text?: string;
  body?: AnyNode | AnyNode[] | AnyNode[][];
  base?: AnyNode;
  sup?: AnyNode;
  sub?: AnyNode;
  numer?: AnyNode;
  denom?: AnyNode;
  index?: AnyNode;
  accent?: string;
  label?: string;
  name?: string;
  family?: string;
  symbol?: boolean;
  left?: string;
  right?: string;
  delim?: string;
  [k: string]: unknown;
};

interface WalkCtx {
  tight: boolean;
}

function walkList(nodes: AnyNode[] | undefined, ctx: WalkCtx): string {
  if (!nodes?.length) return '';
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];

    // Join colon-equals atoms into :=
    if (n.type === 'atom' && n.text === ':' && nodes[i + 1]?.type === 'atom' && nodes[i + 1]?.text === '=') {
      out += displayMode && !ctx.tight ? ' := ' : ':=';
      i++;
      continue;
    }

    // Space after function ops (\log, \sin, …) before alphanumeric
    if (n.type === 'op' && !n.symbol && n.name) {
      const word = n.name.startsWith('\\') ? n.name.slice(1) : n.name;
      const next = nodes[i + 1];
      if (next) {
        const peek = walk(next, ctx);
        if (peek && /^[A-Za-z0-9(]/.test(peek)) {
          out += word + ' ';
          continue;
        }
      }
      out += word;
      continue;
    }

    const piece = walk(n, ctx);

    // Thin space after integral/sum with limits before following letter
    if (n.type === 'supsub' && n.base?.type === 'op' && nodes[i + 1]) {
      const next = walk(nodes[i + 1], ctx);
      if (next && /^[A-Za-zα-ω]/.test(next)) {
        out += piece + ' ';
        continue;
      }
    }

    out += piece;
  }
  return out;
}

function walk(node: AnyNode | AnyNode[] | undefined | null, ctx: WalkCtx): string {
  if (node == null) return '';
  if (Array.isArray(node)) return walkList(node, ctx);

  switch (node.type) {
    case 'mathord':
    case 'textord':
    case 'atom': {
      const raw = node.text ?? '';
      const mode = (node.mode as 'math' | 'text') ?? 'math';
      const t = symbolText(raw, mode);
      // Pad only known relation commands (\\le, \\in, …) — not ASCII `:` / `=`.
      if (!ctx.tight && displayMode && REL_CMDS[raw]) return ` ${t} `;
      return t;
    }

    case 'op': {
      const name = node.name ?? '';
      if (node.symbol) return symbolText(name);
      return name.startsWith('\\') ? name.slice(1) : name;
    }

    case 'delimsizing': {
      // \bigl( \bigr) — sizing wrapper; emit the delimiter only
      const delim = String(node.delim ?? node.text ?? '');
      return symbolText(delim) || delim;
    }

    case 'ordgroup':
    case 'styling':
    case 'font':
    case 'color':
    case 'mclass':
    case 'phantom':
    case 'hphantom':
    case 'vphantom':
    case 'smash':
    case 'text':
    case 'html':
    case 'enclose':
    case 'url':
    case 'href':
    case 'pmb':
    case 'middle':
      return walk(node.body as AnyNode | AnyNode[], ctx);

    case 'supsub': {
      const base = walk(node.base, ctx);
      const tight: WalkCtx = { tight: true };
      let out = base;
      if (node.sub) out += toScript(walk(node.sub, tight).trim(), 'sub');
      if (node.sup) out += toScript(walk(node.sup, tight).trim(), 'sup');
      return out;
    }

    case 'genfrac': {
      const num = walk(node.numer, ctx).trim();
      const den = walk(node.denom, ctx).trim();
      if (num === '1' && den === '2') return '½';
      if (num === '1' && den === '3') return '⅓';
      if (num === '2' && den === '3') return '⅔';
      if (num === '1' && den === '4') return '¼';
      if (num === '3' && den === '4') return '¾';
      const nNeeds = /[+\-≤≥<>={} ]/.test(num) || num.length > 6;
      const dNeeds = /[+\-≤≥<>={} ]/.test(den) || den.length > 6;
      return `${nNeeds ? `(${num})` : num}/${dNeeds ? `(${den})` : den}`;
    }

    case 'sqrt': {
      const body = walk(node.body as AnyNode, ctx).trim();
      const idx = node.index ? walk(node.index, { tight: true }).trim() : '';
      const root = idx && idx !== '2' ? toScript(idx, 'sup') : '';
      if ([...body].length === 1) return `${root}√${body}`;
      if (/^[A-Za-z0-9α-ωΑ-Ωθδπσμλ½⅓¼]+$/.test(body) && body.length <= 3) return `${root}√${body}`;
      return `${root}√(${body})`;
    }

    case 'overline': {
      const body = walk(node.body as AnyNode, ctx);
      if (!body) return '';
      const chars = [...body];
      let k = chars.length - 1;
      while (k > 0 && /\s/.test(chars[k])) k--;
      chars[k] = chars[k] + '\u0305';
      return chars.join('');
    }

    case 'underline': {
      const body = walk(node.body as AnyNode, ctx);
      if ([...body].length === 1) return body + '\u0332';
      return `_${body}_`;
    }

    case 'accent':
    case 'accentUnder': {
      const body = walk(node.base ?? (node.body as AnyNode), ctx);
      const label = String(node.label ?? node.accent ?? '');
      const map: Record<string, string> = {
        '\\hat': '\u0302',
        '\\widehat': '\u0302',
        '\\tilde': '\u0303',
        '\\widetilde': '\u0303',
        '\\vec': '\u20D7',
        '\\dot': '\u0307',
        '\\ddot': '\u0308',
        '\\bar': '\u0305',
        '\\check': '\u030C',
      };
      const comb = map[label];
      if (comb && body.length) {
        const chars = [...body];
        chars[0] = chars[0] + comb;
        return chars.join('');
      }
      return body;
    }

    case 'leftright': {
      const left = node.left && node.left !== '.' ? symbolText(node.left) : '';
      const right = node.right && node.right !== '.' ? symbolText(node.right) : '';
      const body = node.body as AnyNode | AnyNode[];
      if (Array.isArray(body) && body[0]?.type === 'array' && left === '{') {
        return formatCasesArray(body[0], ctx);
      }
      return left + walk(body, ctx) + right;
    }

    case 'array':
      return formatMatrixArray(node, ctx);

    case 'kern':
    case 'mkern':
      return ' ';

    case 'spacing':
      return ' ';

    case 'rule':
    case 'sizing':
    case 'internal':
    case 'tag':
      return '';

    case 'verb':
      return String(node.body ?? node.text ?? '');

    default: {
      if (node.body) return walk(node.body as AnyNode | AnyNode[], ctx);
      if (node.base) return walk(node.base, ctx);
      if (node.text) return symbolText(node.text, (node.mode as 'math' | 'text') ?? 'math');
      return '';
    }
  }
}

function formatCasesArray(arr: AnyNode, ctx: WalkCtx): string {
  const rows = (arr.body as AnyNode[][]) ?? [];
  if (!rows.length) return '{ }';
  const parsed = rows.map((row) => (row ?? []).map((cell) => walk(cell, ctx).trim()));
  const lefts = parsed.map((c) => c[0] ?? '');
  const rights = parsed.map((c) => {
    const r = (c[1] ?? '').trim();
    if (!r) return '';
    if (/^(if|when|for)\b/i.test(r)) return r;
    return `if ${r}`;
  });
  const lw = Math.max(...lefts.map((x) => x.length), 1);
  if (parsed.length === 1) {
    const R = rights[0];
    return R ? `{ ${lefts[0]}    ${R} }` : `{ ${lefts[0]} }`;
  }
  return parsed
    .map((_, idx) => {
      const L = lefts[idx].padEnd(lw);
      const R = rights[idx];
      const mid = R ? `${L}    ${R}` : L;
      if (idx === 0) return `{ ${mid}`;
      if (idx === parsed.length - 1) return `  ${mid} }`;
      return `  ${mid}`;
    })
    .join('\n');
}

function formatMatrixArray(arr: AnyNode, ctx: WalkCtx): string {
  const rows = (arr.body as AnyNode[][]) ?? [];
  return rows.map((row) => (row ?? []).map((cell) => walk(cell, ctx).trim()).join('  ')).join('\n');
}

/** Align continuation lines under the first `{` (cases after `g(t) = `). */
function indentMultiline(s: string): string {
  const lines = s.split('\n');
  if (lines.length <= 1) return s;
  const first = lines[0];
  const brace = first.indexOf('{');
  if (brace < 0) return s;
  // Content after `{ ` starts at brace+2; place continuations there.
  const pad = ' '.repeat(brace + 2);
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      return pad + line.trimStart();
    })
    .join('\n');
}

/**
 * Convert a full math fragment (no surrounding delimiters) to Unicode via KaTeX.
 * Pass `display: true` for block math (relation spacing, `=` padding).
 */
export function latexToUnicode(src: string, opts: { display?: boolean } = {}): string {
  const prev = displayMode;
  displayMode = !!opts.display;
  try {
    // Soft-join TeX source newlines (TeX ignores them; only \\ breaks).
    const normalized = src
      .replace(/\r\n/g, '\n')
      .replace(/\\\\/g, '\uE000')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\uE000/g, '\\\\')
      .replace(/[ \t]+/g, ' ')
      .trim();

    let tree: AnyNode[];
    try {
      tree = katex.__parse(normalized, {
        throwOnError: false,
        strict: false,
        trust: true,
        displayMode: !!opts.display,
      }) as AnyNode[];
    } catch {
      return normalized.replace(/\\([A-Za-z]+)/g, '$1');
    }

    let out = walkList(tree, { tight: false });
    out = indentMultiline(out);

    out = out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => {
        const m = /^(\s*)(.*)$/.exec(line)!;
        return m[1] + m[2].replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;])/g, '$1');
      })
      .join('\n')
      .trim();

    if (opts.display) {
      // Only pad bare `=` that isn't already part of `:=` / `≠` etc.
      out = out
        .replace(/([^:<>=\s])=([^=\n])/g, '$1 = $2')
        .replace(/[ \t]{2,}/g, ' ');
      out = indentMultiline(out);
    }

    return out;
  } finally {
    displayMode = prev;
  }
}

// ── Delimiter extraction (for md-render) ─────────────────────────────────────

export const DISPLAY_MATH_OPEN = /^\s*(\\\[|\$\$)\s*(.*)$/;

/** Extract the next inline math span: `\(...\)` or single `$...$` (not `$$`). */
export function findInlineMath(text: string): { start: number; end: number; body: string } | null {
  const paren = /\\\(([\s\S]+?)\\\)/.exec(text);
  const dollar = /(?<!\$)\$(?!\$)((?:[^$\n\\]|\\.?)+?)\$(?!\$)/.exec(text);

  let best: { start: number; end: number; body: string } | null = null;
  if (paren) {
    best = { start: paren.index, end: paren.index + paren[0].length, body: paren[1] };
  }
  if (dollar) {
    const cand = { start: dollar.index, end: dollar.index + dollar[0].length, body: dollar[1] };
    if (
      /\\|[A-Za-z]\^|[A-Za-z]_|\^[{0-9]|_[{0-9]|[{}\\]/.test(cand.body) ||
      /[θαβγδλμπσφω∞∫∑≤≥≠∈]/.test(cand.body)
    ) {
      if (!best || cand.start < best.start) best = cand;
    }
  }
  return best;
}

/** Consume a display-math block starting at `lines[i]`. */
export function consumeDisplayMath(lines: string[], i: number): { body: string; next: number } | null {
  const open = lines[i].match(DISPLAY_MATH_OPEN);
  if (!open) return null;
  const delim = open[1];
  const firstRest = open[2] ?? '';

  if (delim === '\\[') {
    if (firstRest.includes('\\]')) {
      const same = firstRest.match(/^(.*?)\\\]\s*$/);
      if (same) return { body: same[1], next: i + 1 };
    }
    const parts: string[] = [];
    if (firstRest.trim()) parts.push(firstRest);
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      const closeIdx = line.indexOf('\\]');
      if (closeIdx >= 0) {
        const before = line.slice(0, closeIdx);
        if (before.trim()) parts.push(before);
        return { body: parts.join('\n'), next: j + 1 };
      }
      parts.push(line);
      j++;
    }
    return { body: parts.join('\n'), next: lines.length };
  }

  if (firstRest.includes('$$')) {
    return { body: firstRest.slice(0, firstRest.indexOf('$$')), next: i + 1 };
  }
  const parts: string[] = [];
  if (firstRest.trim()) parts.push(firstRest);
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    const closeIdx = line.indexOf('$$');
    if (closeIdx >= 0) {
      const before = line.slice(0, closeIdx);
      if (before.trim()) parts.push(before);
      return { body: parts.join('\n'), next: j + 1 };
    }
    parts.push(line);
    j++;
  }
  return { body: parts.join('\n'), next: lines.length };
}

export function isDisplayMathOpenLine(line: string): boolean {
  return DISPLAY_MATH_OPEN.test(line);
}
