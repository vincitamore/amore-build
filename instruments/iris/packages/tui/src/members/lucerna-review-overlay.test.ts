import { describe, expect, test } from 'bun:test';
import {
  buildReviewOverlayLines,
  isLinkSeg,
  mdLineToText,
  mdLineTone,
  reviewOverlayFooterHint,
  type OverlayLine,
} from './LucernaReviewOverlay';
import { renderMarkdown } from '../md-render';
import {
  emptyDisplayRow,
  formatLogCell,
  formatLucernaDisplayLine,
} from './lucerna-display';

function allSegs(lines: OverlayLine[]) {
  return lines.flatMap((l) => l.segs);
}

function linkTexts(lines: OverlayLine[]): string[] {
  return allSegs(lines)
    .filter((s) => isLinkSeg(s))
    .map((s) => s.text.trim())
    .filter(Boolean);
}

describe('buildReviewOverlayLines (light markdown)', () => {
  test('headings, lists, and code are tone-tagged on spans', () => {
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
    for (const row of lines) {
      expect(row.text.length).toBe(40);
    }
    const tones = new Set(allSegs(lines).map((s) => s.tone));
    expect(tones.has('h1') || tones.has('h2')).toBe(true);
    expect(allSegs(lines).some((s) => s.tone === 'marker' || s.text.includes('bullet'))).toBe(true);
    expect(
      allSegs(lines).some((s) => s.tone === 'codeblock' || s.tone === 'code' || s.tone === 'kw'),
    ).toBe(true);
  });

  test('list bullets are hyphen not question-mark (md-render • scrub)', () => {
    const body = `- first item
- second item
* third item
`;
    const lines = buildReviewOverlayLines(body, 48);
    const joined = lines.map((l) => l.text).join('\n');
    expect(joined).not.toMatch(/\?\s+first/);
    expect(joined).not.toMatch(/\?\s+second/);
    expect(joined).toMatch(/-\s+first/);
    expect(joined).toMatch(/-\s+second/);
    expect(formatLogCell('  • first item', 20)).toContain('- first');
    expect(formatLogCell('  • first item', 20)).not.toContain('?');
  });

  test('wikilink labels render like Forge md-render (no second convention)', () => {
    const body = `See [[knowledge/alpha|Alpha note]] and [[bare-target]].`;
    const lines = buildReviewOverlayLines(body, 60);
    const joined = lines.map((l) => l.text.trimEnd()).join(' ');
    expect(joined).toContain('Alpha note');
    expect(joined).toContain('bare-target');
    expect(joined).not.toMatch(/\?Alpha/);
    // wrapSegs may split "Alpha note" across tokens; join consecutive link spans
    const linkJoined = allSegs(lines)
      .filter((s) => isLinkSeg(s))
      .map((s) => s.text)
      .join('');
    expect(linkJoined).toContain('Alpha');
    expect(linkJoined).toContain('note');
    expect(linkJoined).toContain('bare-target');
  });

  test('long→short repaint rows stay fixed width (stale-cell craft)', () => {
    const long = buildReviewOverlayLines('# ' + 'A'.repeat(80), 32);
    const short = buildReviewOverlayLines('Hi', 32);
    for (const row of long) expect(row.text.length).toBe(32);
    for (const row of short) expect(row.text.length).toBe(32);
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
    expect(allSegs(lines).some((s) => s.tone === 'h2' || s.tone === 'h3')).toBe(true);
  });
});

describe('span-scoped link styling', () => {
  /**
   * Fixture: wrapped prose with two inline path wikilinks (Forge matcher),
   * a bare short hash, and a parenthesized date. Only the path/wikilink
   * tokens may carry link tone — never the whole line, never hash/date.
   */
  const FIXTURE = [
    'House layout lives in [[context/current-state.md]] and the task index',
    '[[tasks/README.md]] — keep those paths current. Commit fb8b589 was fine',
    '(2026-08-05) and needs no follow-up.',
  ].join(' ');

  test('only path/wikilink spans are link-toned; hash and date stay prose', () => {
    // Narrow width forces wrap across multiple display lines
    const width = 36;
    const lines = buildReviewOverlayLines(FIXTURE, width);
    expect(lines.length).toBeGreaterThan(2);

    for (const row of lines) {
      expect(row.text.length).toBe(width);
    }

    // Exactly the two path tokens (possibly split by hard wrap mid-token)
    const linkSegs = allSegs(lines).filter((s) => isLinkSeg(s));
    const linkJoined = linkSegs.map((s) => s.text).join('');
    expect(linkJoined).toContain('context/current-state.md');
    expect(linkJoined).toContain('tasks/README.md');

    // No non-path text accidentally link-styled
    for (const s of linkSegs) {
      expect(s.text).not.toMatch(/^fb8b589$/);
      expect(s.text).not.toMatch(/2026-08-05/);
      expect(s.text).not.toMatch(/was fine/);
      expect(s.text).not.toMatch(/House layout/);
    }

    // Bare hash and date appear as non-link spans
    const plain = allSegs(lines)
      .filter((s) => !isLinkSeg(s))
      .map((s) => s.text)
      .join('');
    expect(plain).toContain('fb8b589');
    expect(plain).toContain('2026-08-05');

    // Every line that contains a link also has non-link prose (span-scoped, not line paint)
    const linesWithLink = lines.filter((l) => l.segs.some((s) => isLinkSeg(s)));
    expect(linesWithLink.length).toBeGreaterThan(0);
    for (const l of linesWithLink) {
      const hasProse = l.segs.some((s) => !isLinkSeg(s) && s.text.trim().length > 0);
      // A line that is ONLY a wrapped path fragment is ok; otherwise prose must remain non-link
      const onlyLink = l.segs.every((s) => isLinkSeg(s) || /^\s*$/.test(s.text));
      if (!onlyLink) expect(hasProse).toBe(true);
    }

    // Aggregate line tone must NOT be used to paint (document the old defect)
    // — if we collapsed to one tone, any line with a link would be "link"
    for (const l of linesWithLink) {
      const hasNonLink = l.segs.some((s) => s.tone !== 'link' && s.text.trim());
      if (hasNonLink) {
        // Span data proves mixed tones on the same row
        expect(new Set(l.segs.map((s) => s.tone)).size).toBeGreaterThan(1);
      }
    }
  });

  test('bare short hex and parenthesized dates are never link spans', () => {
    const body = 'Ship fb8b589 (2026-08-05) without links.';
    const lines = buildReviewOverlayLines(body, 48);
    expect(linkTexts(lines)).toEqual([]);
    const text = lines.map((l) => l.text).join('');
    expect(text).toContain('fb8b589');
    expect(text).toContain('2026-08-05');
  });

  test('wrap boundary does not turn following prose into a link span', () => {
    // Path at end of a narrow line; following prose on next line must be text
    const body =
      'Prefix words then [[context/current-state.md]] and more prose after the path token.';
    const lines = buildReviewOverlayLines(body, 28);
    let sawLink = false;
    for (const l of lines) {
      for (const s of l.segs) {
        if (isLinkSeg(s)) sawLink = true;
        else if (sawLink && /more prose|after the/.test(s.text)) {
          expect(s.tone).not.toBe('link');
        }
      }
    }
    expect(sawLink).toBe(true);
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
      expect(formatLucernaDisplayLine(h, 64)).not.toMatch(/\?\?/);
      expect(formatLucernaDisplayLine(h, 64)).toContain('up/dn');
    }
  });
});
