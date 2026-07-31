import { test, expect } from 'bun:test';
import {
  consumeDisplayMath,
  findInlineMath,
  latexToUnicode,
} from './math-render';
import { parseInline, renderMarkdown, type MdLine } from './md-render';

const txt = (line: MdLine) => line.map((s) => s.text).join('');

test('latexToUnicode: greek, ops, log spacing', () => {
  expect(latexToUnicode(String.raw`\theta`)).toBe('θ');
  expect(latexToUnicode(String.raw`\le`)).toBe('≤');
  expect(latexToUnicode(String.raw`\ge`)).toBe('≥');
  expect(latexToUnicode(String.raw`\approx`)).toBe('≈');
  expect(latexToUnicode(String.raw`\perp`)).toBe('⊥');
  expect(latexToUnicode(String.raw`\subset`)).toBe('⊂');
  expect(latexToUnicode(String.raw`\log 2`)).toBe('log 2');
  expect(latexToUnicode(String.raw`\in`)).toBe('∈');
});

test('latexToUnicode: subscripts and superscripts', () => {
  expect(latexToUnicode(String.raw`f_{\theta}`)).toBe('f_θ');
  expect(latexToUnicode(String.raw`x^2`)).toBe('x²');
  expect(latexToUnicode(String.raw`t^{-1}`)).toBe('t⁻¹');
  // multi-char subscript: partial Unicode (digits) + leftover ops
  expect(latexToUnicode(String.raw`V_{\le 1/2}`)).toMatch(/V.*1.*2|V.*₁.*₂/);
});

test('latexToUnicode: frac, sqrt, mathrm, overline, floor, angle', () => {
  expect(latexToUnicode(String.raw`\tfrac{1}{2}`)).toBe('½');
  expect(latexToUnicode(String.raw`\tfrac12`)).toBe('½');
  expect(latexToUnicode(String.raw`\sqrt{\tfrac{1}{2}-(\log 2)^2}`)).toBe('√(½-(log 2)²)');
  expect(latexToUnicode(String.raw`\mathrm{dist}`)).toBe('dist');
  expect(latexToUnicode(String.raw`\overline{\mathrm{span}}`)).toContain('s');
  expect(latexToUnicode(String.raw`\overline{\mathrm{span}}`)).toContain('\u0305'); // combining overline
  expect(latexToUnicode(String.raw`\lfloor\theta/t\rfloor`)).toBe('⌊θ/t⌋');
  expect(latexToUnicode(String.raw`\langle g,f_{\theta}\rangle`)).toBe('⟨g,f_θ⟩');
});
test('latexToUnicode: H1 witness formula pieces', () => {
  expect(latexToUnicode(String.raw`f_{\theta}(t)=\{\theta/t\}`)).toBe('f_θ(t)={θ/t}');
  expect(latexToUnicode(String.raw`\delta:=\sqrt{\tfrac{1}{2}-(\log 2)^2}`, { display: true })).toBe(
    'δ := √(½-(log 2)²)',
  );
  expect(latexToUnicode(String.raw`\frac{|\langle g,1\rangle|}{\|g\|}`)).toMatch(/^\(\|⟨g,1⟩\|\)\/[‖∥]g[‖∥]$/);
  const cases = latexToUnicode(
    String.raw`g(t)=\begin{cases}1-(\log 2)/t & t\in(1/2,1),\\0 & t\in(0,1/2].\end{cases}`,
    { display: true },
  );
  expect(cases).toContain('g(t) =');
  expect(cases).toContain('1-(log 2)/t');
  expect(cases).toContain('if t ∈ (1/2,1)');
  expect(cases.split('\n').length).toBeGreaterThanOrEqual(2);
  // second line indented under the opening brace
  const lines = cases.split('\n');
  expect(lines[1].trimStart().startsWith('0')).toBe(true);
  expect(lines[1].length - lines[1].trimStart().length).toBeGreaterThan(2);
});
test('findInlineMath: paren and dollar delimiters', () => {
  const p = findInlineMath(String.raw`see \(\theta\) here`);
  expect(p?.body).toBe(String.raw`\theta`);
  const d = findInlineMath(String.raw`see $\alpha$ here`);
  expect(d?.body).toBe(String.raw`\alpha`);
  // bare currency-like $not math$ without math signals is rejected
  expect(findInlineMath('cost $5$ today')).toBeNull();
});

test('consumeDisplayMath: bracket and dollar blocks', () => {
  const lines = [String.raw`\[`, String.raw`\delta = 1`, String.raw`\]`, 'after'];
  const r = consumeDisplayMath(lines, 0);
  expect(r?.body.trim()).toBe(String.raw`\delta = 1`);
  expect(r?.next).toBe(3);

  const same = consumeDisplayMath([String.raw`\[a+b\]`], 0);
  expect(same?.body).toBe('a+b');
  expect(same?.next).toBe(1);

  const dd = consumeDisplayMath(['$$', 'x=1', '$$'], 0);
  expect(dd?.body.trim()).toBe('x=1');
  expect(dd?.next).toBe(3);
});

test('parseInline: inline math becomes math-toned unicode', () => {
  const segs = parseInline(String.raw`Let \(\theta\) and $f_{\alpha}$.`);
  const math = segs.filter((s) => s.tone === 'math');
  expect(math.length).toBe(2);
  expect(math[0].text).toBe('θ');
  expect(math[1].text).toBe('f_α');
  // surrounding prose preserved
  expect(segs.map((s) => s.text).join('')).toContain('Let ');
});

test('parseInline: math wins over emphasis (* inside math)', () => {
  const segs = parseInline(String.raw`\(\theta * \phi\)`);
  expect(segs.some((s) => s.italic)).toBe(false);
  expect(segs.some((s) => s.tone === 'math')).toBe(true);
});

test('renderMarkdown: display math is its own indented block, not paragraph-joined', () => {
  const md = ['Let', String.raw`\[`, String.raw`\delta=\sqrt{\tfrac12}`, String.raw`\]`, 'Then'].join('\n');
  const out = renderMarkdown(md, 80);
  const joined = out.map(txt).join('\n');
  expect(joined).toContain('Let');
  expect(joined).toContain('δ = √½');
  expect(joined).toContain('Then');
  const mathLine = out.find((l) => l.some((s) => s.tone === 'math' && s.text.includes('δ')));
  expect(mathLine).toBeTruthy();
  expect(txt(mathLine!).startsWith('  ')).toBe(true);
  expect(joined).not.toContain(String.raw`\delta`);
  expect(joined).not.toContain(String.raw`\[`);
});
test('renderMarkdown: H1 proof sketch math fully converts (no raw TeX delimiters)', () => {
  const md = [
    String.raw`Let \(f_\theta(t)=\{\theta/t\}\) on \((0,1)\) and`,
    String.raw`\[`,
    String.raw`V_{\le 1/2}=\overline{\mathrm{span}}\{f_\theta:\theta\in(0,1/2]\}\subset L^2(0,1).`,
    String.raw`\]`,
    String.raw`Then`,
    String.raw`\[`,
    String.raw`\mathrm{dist}_{L^2(0,1)}\bigl(1,\,V_{\le 1/2}\bigr)\ge\delta:=\sqrt{\tfrac12-(\log 2)^2}.`,
    String.raw`\]`,
  ].join('\n');
  const joined = renderMarkdown(md, 100).map(txt).join('\n');
  expect(joined).toContain('f_θ(t)={θ/t}');
  expect(joined).toContain('≤');
  expect(joined).toContain('⊂');
  expect(joined).toContain('δ');
  expect(joined).toContain('√');
  expect(joined).toContain('log 2');
  expect(joined).toContain('span');
  expect(joined).not.toMatch(/s̅p̅a̅n̅/); // no per-char overline spam
  expect(joined).not.toMatch(/\\\(|\\\[|\\\]|\\theta|\\le|\\mathrm|\\sqrt|\\tfrac|\\log/);
  // soft-joined display: one readable line, not shattered across source newlines
  expect(joined).toMatch(/dist_\{L²\(0,1\)\}.*≥.*δ.*:=.*√/);
});

test('renderMarkdown: table cells convert inline math', () => {
  const md = [
    '| Claim | Status |',
    '| --- | --- |',
    String.raw`| need some \(\theta>1/2\) | **Yes** |`,
  ].join('\n');
  const joined = renderMarkdown(md, 80).map(txt).join('\n');
  expect(joined).toContain('θ>1/2');
  expect(joined).not.toContain(String.raw`\theta`);
  expect(joined).toContain('Yes');
  expect(joined).not.toContain('**Yes**');
});
