import { test, expect } from 'bun:test';
import { parseInline, renderMarkdown, type MdLine } from './md-render';

const txt = (line: MdLine) => line.map((s) => s.text).join('');

test('parseInline: bold / italic are attributes on the base tone (color decoupled from style)', () => {
  // bold/italic no longer change the tone — they set attributes, so the color base flows through
  expect(parseInline('a **b** c')).toEqual([
    { text: 'a ', tone: 'text' },
    { text: 'b', tone: 'text', bold: true },
    { text: ' c', tone: 'text' },
  ]);
  expect(parseInline('x `code` y').some((s) => s.tone === 'code' && s.text === 'code')).toBe(true);
  expect(parseInline('see [docs](http://x)').some((s) => s.tone === 'link' && s.text === 'docs')).toBe(true);
  const img = parseInline('![a cat](cat.png)');
  expect(img[0].tone).toBe('image');
  expect(img[0].text).toContain('a cat');
  expect(parseInline('_em_ and *em2*').filter((s) => s.italic).length).toBe(2);
});

test('headings carry an h-tone — and emphasis inside a heading STAYS heading-colored', () => {
  const out = renderMarkdown('# Title\n## Sub\n### Small', 80);
  expect(out[0].some((s) => s.tone === 'h1')).toBe(true);
  expect(txt(out[0])).toBe('Title');
  expect(out[1].some((s) => s.tone === 'h2')).toBe(true);
  expect(out[2].some((s) => s.tone === 'h3')).toBe(true);
  // the regression: italic in an h1 keeps tone 'h1' (color) + italic (style), not a body 'em' color
  const emH = renderMarkdown('# *Magnifica* rest', 80);
  const italicSeg = emH[0].find((s) => s.text.includes('Magnifica'));
  expect(italicSeg?.tone).toBe('h1');
  expect(italicSeg?.italic).toBe(true);
});

test('paragraphs word-wrap to width (no line exceeds width)', () => {
  const body = 'word '.repeat(60).trim();
  const out = renderMarkdown(body, 40);
  for (const line of out) expect(txt(line).length).toBeLessThanOrEqual(40);
  // all words preserved
  expect(out.map(txt).join(' ').replace(/\s+/g, ' ').trim().split(' ').length).toBe(60);
});

test('fenced code blocks are highlighted + padded to width (for the bg fill)', () => {
  const out = renderMarkdown('```\nconst x = 1;\n```', 80);
  expect(out[0].some((s) => s.tone === 'kw' && s.text === 'const')).toBe(true);
  expect(txt(out[0]).trimEnd()).toBe('const x = 1;');
  expect(txt(out[0]).length).toBe(80); // padded to width so the code-block bg spans it
});

test('a very long code line hard-wraps without dropping content', () => {
  const long = 'x'.repeat(100);
  const out = renderMarkdown('```\n' + long + '\n```', 40);
  expect(out.map((l) => txt(l).trimEnd()).join('')).toBe(long); // no loss (ignoring the pad)
});

test('lists get a marker tone + hanging indent', () => {
  const out = renderMarkdown('- first\n- second\n  - nested', 80);
  expect(out[0].some((s) => s.tone === 'marker' && s.text.includes('•'))).toBe(true);
  expect(txt(out[0])).toContain('first');
  // nested item is indented
  expect(txt(out[2]).startsWith('  ')).toBe(true);
});

test('ordered lists keep their numbers', () => {
  const out = renderMarkdown('1. a\n2. b', 80);
  expect(txt(out[0])).toContain('1.');
  expect(txt(out[1])).toContain('2.');
});

test('horizontal rule spans the width', () => {
  const out = renderMarkdown('a\n\n---\n\nb', 20);
  const rule = out.find((l) => l[0]?.tone === 'rule');
  expect(rule).toBeTruthy();
  expect(txt(rule!).length).toBe(20);
});

test('blockquotes get a quote bar', () => {
  const out = renderMarkdown('> quoted text here', 80);
  expect(out[0].some((s) => s.tone === 'qbar')).toBe(true);
  expect(txt(out[0])).toContain('quoted');
});

test('tables: full grid (top border, header, separator, rows, bottom border), fit to width', () => {
  const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
  const out = renderMarkdown(md, 40);
  expect(out[0][0].tone).toBe('tborder'); // top border ┌─┬─┐
  expect(txt(out[0])).toMatch(/^┌.*┐$/);
  expect(out[1].some((s) => s.tone === 'thead')).toBe(true); // header row
  expect(txt(out[1])).toContain('Name');
  expect(out[2][0].tone).toBe('tborder'); // header separator ├─┼─┤
  expect(txt(out[3])).toContain('Alice');
  expect(txt(out[out.length - 1])).toMatch(/^└.*┘$/); // bottom border
  for (const line of out) expect(txt(line).length).toBeLessThanOrEqual(40);
});

test('code blocks are syntax-highlighted (keyword / string / comment tones)', () => {
  const out = renderMarkdown('```\nconst x = "hi"; // note\n```', 80);
  const segs = out.flat();
  expect(segs.some((s) => s.tone === 'kw' && s.text === 'const')).toBe(true);
  expect(segs.some((s) => s.tone === 'str')).toBe(true);
  expect(segs.some((s) => s.tone === 'comment')).toBe(true);
});

test('empty / blank lines produce spacer slots (so paragraphs breathe)', () => {
  const out = renderMarkdown('a\n\nb', 80);
  expect(out.some((l) => l.length === 0)).toBe(true);
});

test('a mid-paragraph pipe does NOT break paragraph reflow', () => {
  const lines = renderMarkdown('read/write | index authority\nis split by direction.', 80);
  const joined = lines.map(txt).join('\n');
  expect(joined).toContain('authority is split'); // the two source lines re-joined into one paragraph
  expect(joined).not.toContain('┌'); // and no table box appeared
});

test('prose pipe followed by a bare --- (an hr) is NOT a table', () => {
  const lines = renderMarkdown('some | text\n---\nafter', 80);
  const joined = lines.map(txt).join('\n');
  expect(joined).not.toContain('┌');
  expect(joined).toContain('some | text');
});

test('a real table (pipe-bearing separator) still renders as a grid', () => {
  const lines = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |', 80);
  expect(lines.map(txt).join('\n')).toContain('┌');
});

// ── Wikilinks ──────────────────────────────────────────────────────────────────

test('wikilink [[a]] renders link-toned and carries its target', () => {
  expect(parseInline('[[a]]')).toEqual([{ text: 'a', tone: 'link', underline: true, wikilink: 'a' }]);
});

test('wikilink [[target|label]] renders the LABEL but follows the TARGET', () => {
  expect(parseInline('[[a|b]]')).toEqual([{ text: 'b', tone: 'link', underline: true, wikilink: 'a' }]);
});

test('wikilink target may be a path or contain spaces', () => {
  expect(parseInline('[[knowledge/architecture/foo]]')).toEqual([
    { text: 'knowledge/architecture/foo', tone: 'link', underline: true, wikilink: 'knowledge/architecture/foo' },
  ]);
  const spaced = parseInline('[[a note|see it]]');
  expect(spaced).toEqual([{ text: 'see it', tone: 'link', underline: true, wikilink: 'a note' }]);
});

test('multiple wikilinks on one span each carry their own target, with prose between', () => {
  const segs = parseInline('see [[a]] and [[b|c]] here');
  const links = segs.filter((s) => s.wikilink);
  expect(links.map((s) => ({ text: s.text, wikilink: s.wikilink }))).toEqual([
    { text: 'a', wikilink: 'a' },
    { text: 'c', wikilink: 'b' },
  ]);
  // surrounding prose survives as plain text segments
  expect(segs.map((s) => s.text).join('')).toBe('see a and c here');
});

test('a wikilink inside inline code is NOT linkified (code span wins on match index)', () => {
  const segs = parseInline('`[[a]]`');
  expect(segs.some((s) => s.wikilink)).toBe(false);
  expect(segs.some((s) => s.tone === 'code' && s.text === '[[a]]')).toBe(true);
});

test('empty [[]] and unclosed [[a are literal text, not wikilinks', () => {
  expect(parseInline('[[]]').some((s) => s.wikilink)).toBe(false);
  expect(parseInline('[[]]')[0].text).toBe('[[]]');
  expect(parseInline('an [[a unclosed link').some((s) => s.wikilink)).toBe(false);
});

test('emphasis wrapping a wikilink keeps the target and toggles the attribute', () => {
  const segs = parseInline('**[[a|bold link]]**');
  const link = segs.find((s) => s.wikilink);
  expect(link?.wikilink).toBe('a');
  expect(link?.text).toBe('bold link');
  expect(link?.bold).toBe(true);
});

test('renderMarkdown carries a wikilink target through paragraph wrapping', () => {
  const lines = renderMarkdown('A paragraph mentioning [[some-target|the thing]] inline.', 80);
  // The multi-word label wraps by word, so EACH fragment keeps the target (clicking either follows).
  const linkSegs = lines.flat().filter((s) => s.wikilink === 'some-target');
  expect(linkSegs.length).toBeGreaterThan(0);
  expect(linkSegs.map((s) => s.text).join('')).toContain('the');
  expect(linkSegs.map((s) => s.text).join('')).toContain('thing');
});
