/**
 * A pure Markdown → styled-lines renderer. We render Markdown OURSELVES instead of OpenTUI's
 * native `<markdown>` renderable, which segfaults the Zig renderer on content changes / long docs
 * (and 0.4.2 is the latest, so there's no upstream fix). This produces a flat array of `MdLine`s
 * (each a list of `MdSeg`s carrying a semantic `tone`), already wrapped to `width` — so the view
 * can render a fixed-slot window over arbitrarily long documents (one `<text>` per visible line,
 * content-only updates, no native markdown renderable = none of that crash class).
 *
 * Block coverage: headings, paragraphs, fenced code, lists (incl. nesting indent), blockquotes,
 * horizontal rules, tables, images (placeholder), links, display math (`\[…\]` / `$$…$$`).
 * Inline: bold, italic, inline code, links, images, inline math (`\(…\)` / `$…$`).
 * Math is converted to Unicode approximations via `math-render` (no KaTeX HTML — terminal only).
 * The renderer (`MarkdownView`) maps each tone to a palette color + attributes.
 */

import {
  consumeDisplayMath,
  findInlineMath,
  isDisplayMathOpenLine,
  latexToUnicode,
} from './math-render';

export type Tone =
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'code'
  | 'codeblock'
  | 'kw'
  | 'str'
  | 'comment'
  | 'num'
  | 'link'
  | 'rule'
  | 'marker'
  | 'qbar'
  | 'quote'
  | 'thead'
  | 'tborder'
  | 'tcell'
  | 'image'
  | 'math';

/**
 * A styled run. `tone` carries the semantic COLOR (heading / link / quote / code / body …); `bold`,
 * `italic`, `underline` are orthogonal ATTRIBUTES that compose with any tone. Decoupling the two is
 * what lets emphasis inside a heading stay heading-colored (`{tone:'h1', italic:true}`) instead of
 * dropping to the body `em` color — the earlier tone-only model couldn't express that.
 */
export interface MdSeg {
  text: string;
  tone: Tone;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** For a `[[target]]` / `[[target|label]]` wikilink: the raw target (before any `|label`),
   *  carried so the view layer can hit-test a click on the segment and follow it. The visible
   *  text is the label (or the target when no label); the follow uses this. */
  wikilink?: string;
}
export type MdLine = MdSeg[];

interface Attrs {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

// ── Inline parsing ───────────────────────────────────────────────────────────

/**
 * Tokenize inline markdown into styled segments. `base` is the surrounding COLOR tone (body,
 * heading, quote…) which flows through unchanged; emphasis toggles the bold/italic ATTRIBUTES on
 * top of it. So bold/italic inside a heading keep the heading color, and code/links keep their own.
 */
export function parseInline(text: string, base: Tone = 'text', attrs: Attrs = {}): MdSeg[] {
  const segs: MdSeg[] = [];
  let rest = text;
  const patterns: Array<{ re: RegExp; make: (m: RegExpExecArray) => MdSeg[] }> = [
    // Wikilinks — `[[target]]` / `[[target|label]]`. Rendered link-toned; every produced segment
    // carries the raw `target` so the view can follow a click. Matched BEFORE the `[label](url)`
    // link so a `[[` is never mis-read as a bracketed inline link. Empty `[[]]` (target requires
    // ≥1 non-`]`/`|` char) falls through to literal text; a `[[…]]` inside code spans loses to the
    // backtick pattern on match index, so it is not linkified.
    {
      re: /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/,
      make: (m) => {
        const target = m[1].trim();
        const label = (m[2] ?? m[1]).trim();
        return parseInline(label, 'link', { ...attrs, underline: true }).map((s) => ({ ...s, wikilink: target }));
      },
    },
    { re: /!\[([^\]]*)\]\(([^)]+)\)/, make: (m) => [{ text: `▣ ${m[1] || 'image'}`, tone: 'image', ...attrs }] },
    { re: /\[([^\]]+)\]\(([^)]+)\)/, make: (m) => parseInline(m[1], 'link', { ...attrs, underline: true }) },
    { re: /`([^`]+)`/, make: (m) => [{ text: m[1], tone: 'code', ...attrs }] },
    // Inline math BEFORE emphasis so `*` inside `$a*b$` / `\(...\)` is never italicized, and so
    // `\(...\)` isn't misread as escaped parens. `findInlineMath` owns delimiter edge cases.
    {
      re: /\\\([\s\S]+?\\\)|(?<!\$)\$(?!\$)(?:[^$\n\\]|\\.?)+?\$(?!\$)/,
      make: (m) => {
        const hit = findInlineMath(m[0]);
        const body = hit?.body ?? m[0];
        const rendered = latexToUnicode(body);
        return [{ text: rendered || body, tone: 'math', ...attrs }];
      },
    },
    { re: /\*\*([^*]+)\*\*/, make: (m) => parseInline(m[1], base, { ...attrs, bold: true }) },
    { re: /__([^_]+)__/, make: (m) => parseInline(m[1], base, { ...attrs, bold: true }) },
    { re: /\*([^*]+)\*/, make: (m) => parseInline(m[1], base, { ...attrs, italic: true }) },
    { re: /(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/, make: (m) => parseInline(m[1], base, { ...attrs, italic: true }) },
  ];
  let guard = 0;
  while (rest.length > 0 && guard++ < 5000) {
    let best: { idx: number; len: number; segs: MdSeg[] } | null = null;
    for (const p of patterns) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.idx)) {
        best = { idx: m.index, len: m[0].length, segs: p.make(m) };
      }
    }
    if (!best) {
      segs.push({ text: rest, tone: base, ...attrs });
      break;
    }
    if (best.idx > 0) segs.push({ text: rest.slice(0, best.idx), tone: base, ...attrs });
    for (const s of best.segs) segs.push(s);
    rest = rest.slice(best.idx + best.len);
  }
  return segs.length ? segs : [{ text, tone: base, ...attrs }];
}

// ── Soft line joining (hard-wrapped source → logical block text) ─────────────

/**
 * Join hard-wrapped source lines into one logical string.
 * Each continuation's leading whitespace collapses to a single join space
 * (so `"failed with\\n  agentic"` → `"failed with agentic"`, not triple spaces).
 */
export function joinSoftWrappedLines(parts: string[]): string {
  if (parts.length === 0) return '';
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    if (i === 0) {
      out.push(p.replace(/[ \t]+$/g, ''));
    } else {
      const t = p.trim();
      if (t.length) out.push(t);
    }
  }
  return out.join(' ');
}

// ── Word wrapping (style-preserving) ─────────────────────────────────────────

/** Flow styled segments into lines ≤ `width`, breaking on spaces; hard-break over-long tokens. */
export function wrapSegs(segs: MdSeg[], width: number, prefix?: MdSeg, hanging = 0): MdLine[] {
  const w = Math.max(4, width);
  const lines: MdLine[] = [];
  const indent = (): MdSeg[] => (hanging > 0 ? [{ text: ' '.repeat(hanging), tone: 'text' }] : []);
  let cur: MdLine = prefix ? [prefix] : [];
  let curW = prefix ? prefix.text.length : 0;
  const flush = () => {
    lines.push(cur);
    cur = indent();
    curW = hanging;
  };
  for (const seg of segs) {
    for (const tok of seg.text.split(/(\s+)/)) {
      if (tok === '') continue;
      const isSpace = /^\s+$/.test(tok);
      if (isSpace) {
        if (curW > hanging && curW < w) {
          cur.push({ ...seg, text: tok });
          curW += tok.length;
        }
        continue;
      }
      if (curW + tok.length > w && curW > hanging) flush();
      if (tok.length > w) {
        let r = tok;
        while (r.length > 0) {
          const take = Math.max(1, w - curW);
          cur.push({ ...seg, text: r.slice(0, take) });
          curW += Math.min(take, r.length);
          r = r.slice(take);
          if (r.length > 0) flush();
        }
      } else {
        cur.push({ ...seg, text: tok });
        curW += tok.length;
      }
    }
  }
  if (cur.length > (hanging > 0 ? 1 : 0)) lines.push(cur);
  else if (cur.length > 0 && lines.length === 0) lines.push(cur);
  return lines.length ? lines : [[{ text: '', tone: 'text' }]];
}

// ── Lightweight code highlighting (regex tokenizer, language-agnostic) ────────

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'fn', 'def', 'return', 'if', 'else', 'elif', 'for', 'while', 'do', 'loop', 'match',
  'switch', 'case', 'break', 'continue', 'class', 'struct', 'enum', 'interface', 'type', 'impl', 'trait', 'import',
  'export', 'from', 'use', 'pub', 'mod', 'async', 'await', 'yield', 'new', 'this', 'self', 'super', 'public', 'private',
  'protected', 'static', 'final', 'void', 'null', 'nil', 'none', 'true', 'false', 'undefined', 'in', 'of', 'as', 'is',
  'and', 'or', 'not', 'try', 'catch', 'finally', 'throw', 'raise', 'with', 'where', 'extends', 'implements', 'package',
]);

/** Tokenize a code line into styled segments (comment / string / number / keyword / plain). */
function highlightCode(line: string): MdSeg[] {
  const segs: MdSeg[] = [];
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d._]*(?:e[+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+|[^\sA-Za-z0-9_$])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    if (m[1]) segs.push({ text: m[1], tone: 'comment' });
    else if (m[2]) segs.push({ text: m[2], tone: 'str' });
    else if (m[3]) segs.push({ text: m[3], tone: 'num' });
    else if (m[4]) segs.push({ text: m[4], tone: KEYWORDS.has(m[4]) ? 'kw' : 'codeblock' });
    else segs.push({ text: m[5] ?? m[0], tone: 'codeblock' });
  }
  return segs.length ? segs : [{ text: line, tone: 'codeblock' }];
}

// ── Tables ───────────────────────────────────────────────────────────────────

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Flatten a cell's markdown/math to plain display text for the fixed-width grid. */
function cellDisplay(raw: string): string {
  // Inline math first, then light emphasis strip so **Proved** doesn't show stars.
  let s = raw;
  // Repeatedly replace inline math spans
  for (let guard = 0; guard < 32; guard++) {
    const hit = findInlineMath(s);
    if (!hit) break;
    const rendered = latexToUnicode(hit.body);
    s = s.slice(0, hit.start) + (rendered || hit.body) + s.slice(hit.end);
  }
  // Strip simple bold/italic markers (table cells are monochrome runs)
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1').replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '$1');
  // Wikilinks → label
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, label?: string) => (label ?? t).trim());
  return s;
}

function renderTable(rows: string[], width: number): MdLine[] {
  const cells = rows.map((row) => splitRow(row).map(cellDisplay));
  const ncol = Math.max(...cells.map((r) => r.length));
  // natural column widths (header + data, excl. the separator row at index 1)
  const natural = new Array(ncol).fill(3);
  cells.forEach((r, ri) => {
    if (ri === 1) return;
    r.forEach((c, ci) => (natural[ci] = Math.max(natural[ci], c.length)));
  });
  // a full grid: each cell is " x " (colW+2), ncol+1 vertical borders. total = ΣcolW + 3·ncol + 1.
  const overhead = 3 * ncol + 1;
  const colW = [...natural];
  const total = () => colW.reduce((a, b) => a + b, 0) + overhead;
  while (total() > width && Math.max(...colW) > 3) {
    colW[colW.indexOf(Math.max(...colW))] -= 1;
  }
  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s.padEnd(n));
  const rule = (l: string, m: string, r: string): MdLine => [
    { text: l + colW.map((n) => '─'.repeat(n + 2)).join(m) + r, tone: 'tborder' },
  ];
  const dataRow = (r: string[], tone: Tone): MdLine => {
    const line: MdLine = [];
    for (let ci = 0; ci < ncol; ci++) {
      line.push({ text: '│', tone: 'tborder' });
      line.push({ text: ` ${pad(r[ci] ?? '', colW[ci])} `, tone });
    }
    line.push({ text: '│', tone: 'tborder' });
    return line;
  };
  const out: MdLine[] = [rule('┌', '┬', '┐'), dataRow(cells[0] ?? [], 'thead'), rule('├', '┼', '┤')];
  for (let ri = 2; ri < cells.length; ri++) out.push(dataRow(cells[ri], 'tcell'));
  out.push(rule('└', '┴', '┘'));
  return out;
}

// ── Block parsing ─────────────────────────────────────────────────────────────

const FENCE = /^\s*```/;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

// A table starts only when a pipe-bearing row is followed by a PIPE-BEARING separator row —
// requiring the '|' in the separator keeps a prose pipe followed by a bare `---` (an hr) from
// rendering as a spurious table.
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-') && next.includes('|');
}

function isBlockStart(line: string, next?: string): boolean {
  // A bare '|' in prose is NOT a block start — mid-paragraph pipes are common in org prose,
  // and treating them as boundaries broke paragraph reflow. Pipes only start a TABLE (with a
  // separator row beneath). Display math openers (`\[` / `$$`) are block starts so they are
  // never joined into the preceding paragraph.
  return (
    FENCE.test(line) ||
    HR.test(line) ||
    HEADING.test(line) ||
    LIST.test(line) ||
    QUOTE.test(line.trimStart()) ||
    isTableStart(line, next) ||
    isDisplayMathOpenLine(line)
  );
}

/** Parse Markdown into wrapped, tone-tagged lines for a fixed-slot windowed view. */
export function renderMarkdown(md: string, width: number): MdLine[] {
  const w = Math.max(8, width);
  const out: MdLine[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push([]); // blank line → spacer slot
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        // code: hard-wrap (don't word-break), syntax-highlight, pad to width so the bg tint fills
        let r = lines[i].replace(/\t/g, '  ');
        if (r === '') {
          out.push([{ text: ' '.repeat(w), tone: 'codeblock' }]);
        } else {
          while (r.length > 0) {
            const chunk = r.slice(0, w);
            r = r.slice(w);
            const segs = highlightCode(chunk);
            if (chunk.length < w) segs.push({ text: ' '.repeat(w - chunk.length), tone: 'codeblock' });
            out.push(segs);
          }
        }
        i++;
      }
      i++; // closing fence
      continue;
    }
    // Display math BEFORE headings/lists so `\[` lines are never paragraph-joined.
    const display = consumeDisplayMath(lines, i);
    if (display) {
      // display:true → soft-join TeX source newlines; readable relation spacing
      const rendered = latexToUnicode(display.body, { display: true });
      const mathLines = rendered.length ? rendered.split('\n') : [''];
      for (const ml of mathLines) {
        if (ml.trim() === '' && mathLines.length > 1) continue;
        // wrapSegs drops leading whitespace tokens when curW===hanging — so peel
        // leading indent into the prefix (2-col display gutter + line's own pad).
        const lead = /^(\s*)/.exec(ml)?.[1] ?? '';
        const content = ml.slice(lead.length);
        const indent = 2 + lead.length;
        const segs: MdSeg[] = [{ text: content.length ? content : ' ', tone: 'math' }];
        for (const l of wrapSegs(segs, w, { text: ' '.repeat(indent), tone: 'math' }, indent)) out.push(l);
      }
      i = display.next;
      continue;
    }
    if (HR.test(line)) {
      out.push([{ text: '─'.repeat(w), tone: 'rule' }]);
      i++;
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      const tone: Tone = h[1].length === 1 ? 'h1' : h[1].length === 2 ? 'h2' : 'h3';
      // Parse with the heading tone as the COLOR base, so emphasis inside the heading stays
      // heading-colored (it toggles bold/italic attributes, not the tone).
      const segs = parseInline(h[2], tone);
      for (const l of wrapSegs(segs, w)) out.push(l);
      i++;
      continue;
    }
    // table: a row with a pipe, followed by a pipe-bearing separator row (---|---)
    if (isTableStart(line, lines[i + 1])) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(lines[i]);
        i++;
      }
      for (const l of renderTable(rows, w)) out.push(l);
      continue;
    }
    if (QUOTE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        q.push((lines[i].match(QUOTE) as RegExpMatchArray)[1]);
        i++;
      }
      // Soft-join quote continuations (collapse leading indent on each line)
      const segs = parseInline(joinSoftWrappedLines(q), 'quote');
      for (const l of wrapSegs(segs, w - 2, { text: '│ ', tone: 'qbar' }, 2)) out.push(l);
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      // Block assembly: list item = marker line + indented continuations (not nested lists).
      const indentN = Math.floor(li[1].replace(/\t/g, '  ').length / 2);
      const ordered = /\d/.test(li[2]);
      const marker = ordered ? `${li[2]} ` : '• ';
      const pad = '  '.repeat(indentN + 1); // +1 = a base indent so lists sit in from the body margin
      const contentParts: string[] = [li[3]];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.trim() === '') break;
        if (isBlockStart(cur, lines[i + 1])) break;
        // Nested list items are separate blocks (handled on the next outer iteration).
        const nested = cur.match(LIST);
        if (nested) {
          const nestIndent = Math.floor(nested[1].replace(/\t/g, '  ').length / 2);
          if (nestIndent > indentN) break;
          break;
        }
        contentParts.push(cur);
        i++;
      }
      const segs = parseInline(joinSoftWrappedLines(contentParts));
      // Hang wrap to the item's text column (pad + marker); nested levels keep deeper pad.
      const hang = pad.length + marker.length;
      for (const l of wrapSegs(segs, w, { text: pad + marker, tone: 'marker' }, hang)) out.push(l);
      continue;
    }
    // paragraph: gather until a blank line or the next block starts, then soft-join
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    for (const l of wrapSegs(parseInline(joinSoftWrappedLines(para)), w)) out.push(l);
  }
  // collapse leading/trailing/multiple blank spacer lines
  return out;
}
