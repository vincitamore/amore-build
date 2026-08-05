import { describe, expect, test } from 'bun:test';
import { reviewOverlayFooterHint } from './LucernaReviewOverlay';
import { formatLucernaDisplayLine } from './lucerna-display';
// Shared path: overlay body is MarkdownView → renderMarkdown (same as Forge DocView .md).
import { parseInline, renderMarkdown, type MdLine } from '../md-render';

const txt = (line: MdLine) => line.map((s) => s.text).join('');

describe('reviewOverlayFooterHint (chrome only)', () => {
  test('uses up/dn not arrow glyphs; mentions review verbs when pending', () => {
    const dream = reviewOverlayFooterHint({ kind: 'dream', pending: true });
    const idle = reviewOverlayFooterHint({ kind: 'dream', pending: false });
    const prop = reviewOverlayFooterHint({ kind: 'proposal', pending: true });
    expect(dream).toContain('up/dn');
    expect(dream).toContain('v mark reviewed');
    expect(prop).toContain('x close');
    expect(idle).toContain('esc close');
    for (const h of [dream, idle, prop]) {
      expect(h).not.toMatch(/[↑↓]/);
      expect(formatLucernaDisplayLine(h, 72)).toContain('up/dn');
      expect(formatLucernaDisplayLine(h, 72)).not.toMatch(/\?\?/);
    }
  });
});

describe('overlay body rides shared renderMarkdown (MarkdownView path)', () => {
  // Pins that the SHARED pipeline (not a lucerna-display fork) still delivers
  // the shapes the overlay depends on. Detailed md-render fixtures live in md-render.test.ts.

  test('hard-wrapped bullet continuation joins without multi-space', () => {
    const body = [
      '- prior agentic spawn **failed** with',
      '  `agentic spawn failed: ENOENT`',
    ].join('\n');
    const out = renderMarkdown(body, 48);
    const flat = out.map(txt).join(' ');
    expect(flat).toContain('failed with');
    expect(flat).toContain('agentic spawn failed');
    expect(flat).not.toMatch(/with\s{2,}`/);
  });

  test('nested list keeps deeper indent', () => {
    const out = renderMarkdown('- parent\n  - child\n    - grand', 80);
    expect(txt(out[0])).toContain('parent');
    expect(txt(out[1]).indexOf('•')).toBeGreaterThan(txt(out[0]).indexOf('•'));
    expect(txt(out[2]).indexOf('•')).toBeGreaterThan(txt(out[1]).indexOf('•'));
  });

  test('inline code, link, and italic come from parseInline/renderMarkdown', () => {
    const body =
      'See [[context/current-state.md]] and `tasks/README.md`. The *coherent* house.';
    const out = renderMarkdown(body, 80);
    const segs = out.flat();
    expect(segs.some((s) => s.tone === 'link')).toBe(true);
    expect(segs.some((s) => s.tone === 'code')).toBe(true);
    expect(segs.some((s) => s.italic && s.text.includes('coherent'))).toBe(true);
    // code and link remain distinct tones (MarkdownView maps them to different palette keys)
    expect(segs.find((s) => s.tone === 'code')!.tone).not.toBe('link');
  });

  test('wikilink labels only — no line-wide link collapse at the data layer', () => {
    const segs = parseInline('prose [[path/a.md]] more prose');
    expect(segs.filter((s) => s.tone === 'link').map((s) => s.text).join('')).toContain('path/a.md');
    expect(segs.some((s) => s.tone === 'text' && s.text.includes('prose'))).toBe(true);
  });
});
