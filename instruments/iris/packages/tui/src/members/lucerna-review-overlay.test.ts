import { describe, expect, test } from 'bun:test';
import {
  buildReviewOverlayLines,
  mdLineToText,
  mdLineTone,
  reviewOverlayFooterHint,
} from './LucernaReviewOverlay';
import { renderMarkdown } from '../md-render';
import {
  emptyDisplayRow,
  formatLogCell,
  formatLucernaDisplayLine,
} from './lucerna-display';

describe('buildReviewOverlayLines (light markdown)', () => {
  test('headings, lists, and code are tone-tagged', () => {
    const body = `# Title

Intro paragraph.

- bullet one
- bullet two

\`\`\`
const x = 1
\`\`\`

Done with \`inline\`.
`;
    const lines = buildReviewOverlayLines(body, 40);
    expect(lines.length).toBeGreaterThan(4);
    // Every row is exact width (opaque clear contract)
    for (const row of lines) {
      expect(row.text.length).toBe(40);
    }
    const tones = new Set(lines.map((l) => l.tone));
    expect(tones.has('h1') || tones.has('h2')).toBe(true);
    // list markers or body present
    expect(lines.some((l) => l.tone === 'marker' || l.text.includes('bullet'))).toBe(true);
    // code fence content is code-ish
    expect(lines.some((l) => l.tone === 'codeblock' || l.tone === 'code' || l.tone === 'kw')).toBe(
      true,
    );
  });

  test('list bullets are hyphen not question-mark (md-render • scrub)', () => {
    const body = `- first item
- second item
* third item
`;
    const lines = buildReviewOverlayLines(body, 48);
    const joined = lines.map((l) => l.text).join('\n');
    // Must not show the defect: "?" standing in for bullet glyphs
    expect(joined).not.toMatch(/\?\s+first/);
    expect(joined).not.toMatch(/\?\s+second/);
    expect(joined).toMatch(/-\s+first/);
    expect(joined).toMatch(/-\s+second/);
    // formatLogCell alone maps U+2022 to hyphen
    expect(formatLogCell('  • first item', 20)).toContain('- first');
    expect(formatLogCell('  • first item', 20)).not.toContain('?');
  });

  test('wikilink labels render like Forge md-render (no second convention)', () => {
    // Forge MarkdownView uses parseInline: [[target|label]] → visible "label"
    const body = `See [[knowledge/alpha|Alpha note]] and [[bare-target]].`;
    const lines = buildReviewOverlayLines(body, 60);
    const joined = lines.map((l) => l.text.trimEnd()).join(' ');
    expect(joined).toContain('Alpha note');
    expect(joined).toContain('bare-target');
    // No "?"-prefix decoration for links
    expect(joined).not.toMatch(/\?Alpha/);
  });

  test('long→short repaint rows stay fixed width (stale-cell craft)', () => {
    const long = buildReviewOverlayLines('# ' + 'A'.repeat(80), 32);
    const short = buildReviewOverlayLines('Hi', 32);
    for (const row of long) expect(row.text.length).toBe(32);
    for (const row of short) expect(row.text.length).toBe(32);
    // empty slot helper still exact
    expect(emptyDisplayRow(32).length).toBe(32);
    expect(formatLucernaDisplayLine('x', 32).length).toBe(32);
  });

  test('linked report section renders as markdown heading', () => {
    const body = `What ran.

## Linked report

_forge/dreams/x.md_

### Findings

- one
- two
`;
    const lines = buildReviewOverlayLines(body, 48);
    const joined = lines.map((l) => l.text.trimEnd()).join('\n');
    expect(joined).toContain('Linked report');
    expect(joined).toContain('Findings');
    expect(lines.some((l) => l.tone === 'h2' || l.tone === 'h3')).toBe(true);
  });
});

describe('mdLine helpers', () => {
  test('mdLineToText joins segments; tone prefers heading', () => {
    const lines = renderMarkdown('## Hello **world**', 40);
    expect(lines.length).toBeGreaterThan(0);
    const text = mdLineToText(lines[0]!);
    expect(text.toLowerCase()).toContain('hello');
    expect(mdLineTone(lines[0]!)).toBe('h2');
  });
});

describe('reviewOverlayFooterHint (ASCII-safe)', () => {
  test('uses up/dn not arrow glyphs', () => {
    const dream = reviewOverlayFooterHint({ kind: 'dream', pending: true });
    const idle = reviewOverlayFooterHint({ kind: 'dream', pending: false });
    const prop = reviewOverlayFooterHint({ kind: 'proposal', pending: true });
    for (const h of [dream, idle, prop]) {
      expect(h).toContain('up/dn');
      expect(h).not.toMatch(/[↑↓]/);
      // After Lucerna scrub, still no question-mark residue from arrows
      expect(formatLucernaDisplayLine(h, 64)).not.toMatch(/\?\?/);
      expect(formatLucernaDisplayLine(h, 64)).toContain('up/dn');
    }
  });
});
