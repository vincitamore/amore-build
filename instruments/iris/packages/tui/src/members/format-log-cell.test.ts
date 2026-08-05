import { describe, expect, test } from 'bun:test';
import {
  collapseHomeInText,
  emptyDisplayRow,
  formatLogCell,
  formatLucernaDisplayLine,
  formatPulseSubLine,
  pulsePanelInnerWidth,
} from './lucerna-display';

const ELLIPSIS = '\u2026';
const MIDDOT = '\u00b7';

describe('formatLogCell', () => {
  test('pads short lines to width', () => {
    expect(formatLogCell('hi', 5)).toBe('hi   ');
  });

  test('truncates long lines with ellipsis (not a bare period)', () => {
    expect(formatLogCell('abcdefghij', 5)).toBe(`abcd${ELLIPSIS}`);
    expect(formatLogCell('abcdefghij', 5).endsWith(ELLIPSIS)).toBe(true);
    expect(formatLogCell('abcdefghij', 5).endsWith('.')).toBe(false);
  });

  test('preserves middle-dot separators (Pulse sibling style)', () => {
    const out = formatLogCell(`live ${MIDDOT} beat 5s`, 20);
    expect(out).toContain(MIDDOT);
    expect(out).toMatch(new RegExp(`live ${MIDDOT} beat`));
    // Must not degrade to a bare period separator.
    expect(out).not.toMatch(/live \. beat/);
  });

  test('maps multi-byte arrows/dashes but keeps middle-dot and ellipsis', () => {
    const out = formatLogCell(`a → b — c ${MIDDOT} d`, 24);
    expect(out).toContain('->');
    expect(out).toContain(MIDDOT);
    expect(out).not.toMatch(/[^\t\r\n\x20-\x7e\u00b7\u2026]/);
  });

  test('md-render list bullet and up/down arrows map to ASCII (not ?)', () => {
    expect(formatLogCell('  • item one', 16)).toBe('  - item one    ');
    expect(formatLogCell('  • item one', 16)).not.toContain('?');
    const arrows = formatLogCell('esc · ↑↓ scroll', 20);
    expect(arrows).toContain('up');
    expect(arrows).toContain('dn');
    expect(arrows).not.toMatch(/\?/);
  });

  test('zero width → empty', () => {
    expect(formatLogCell('x', 0)).toBe('');
  });

  test('long then short: short result has no residual of long content', () => {
    const width = 40;
    const long = formatLogCell('NOTIFICATION_LONG_' + 'X'.repeat(50), width);
    const short = formatLogCell('SHORT_N', width);
    expect(long.length).toBe(width);
    expect(short.length).toBe(width);
    expect(short.startsWith('SHORT_N')).toBe(true);
    expect(short.slice('SHORT_N'.length)).toBe(' '.repeat(width - 'SHORT_N'.length));
    expect(short).not.toContain('NOTIFICATION');
    expect(short).not.toContain('XXX');
  });

  test('detail sub-line truncates mid-phrase with ellipsis at exact width', () => {
    const width = 14;
    const out = formatLogCell('Four open inbox items waiting', width);
    expect(out.length).toBe(width);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    // No bare trailing period used as the truncation marker.
    expect(out.slice(0, -1).endsWith('.')).toBe(false);
    // Full source must not remain; ellipsis marks the cut.
    expect(out).not.toContain('waiting');
  });
});

describe('collapseHomeInText (display-only tilde collapse)', () => {
  test('POSIX home prefix → tilde', () => {
    expect(collapseHomeInText('daemon start house=/home/alex/proj', '/home/alex')).toBe(
      'daemon start house=~/proj',
    );
  });

  test('Windows backslash home prefix → tilde', () => {
    const home = 'C:\\Users\\AlexMoyer';
    const line = 'daemon start house=C:\\Users\\AlexMoyer\\Documents\\house';
    expect(collapseHomeInText(line, home)).toBe('daemon start house=~\\Documents\\house');
  });

  test('Windows forward-slash form of home also collapses', () => {
    const home = 'C:\\Users\\AlexMoyer';
    const line = 'daemon start house=C:/Users/AlexMoyer/Documents/house';
    expect(collapseHomeInText(line, home)).toBe('daemon start house=~/Documents/house');
  });

  test('no home match leaves text unchanged', () => {
    expect(collapseHomeInText('beat ok', '/home/other')).toBe('beat ok');
  });

  test('formatLucernaDisplayLine applies collapse then exact width', () => {
    const out = formatLucernaDisplayLine(
      'daemon start house=/home/alex/h',
      32,
      '/home/alex',
    );
    expect(out.length).toBe(32);
    expect(out.startsWith('daemon start house=~/h')).toBe(true);
    expect(out).not.toContain('/home/alex');
  });

  test('pulse status line keeps middle-dot through display pipeline', () => {
    const out = formatLucernaDisplayLine(`live ${MIDDOT} beat 5s`, 24, '/tmp');
    expect(out.length).toBe(24);
    expect(out).toContain(`live ${MIDDOT} beat 5s`);
    expect(out).not.toMatch(/live \. beat/);
  });

  test('emptyDisplayRow is exact width spaces', () => {
    expect(emptyDisplayRow(8)).toBe('        ');
  });
});

describe('pulse sub-line width (real panel inner, not dims/3)', () => {
  test('pulsePanelInnerWidth subtracts border+pad chrome', () => {
    // Wide dash left column is agendaW capped at 48 → inner 44.
    expect(pulsePanelInnerWidth(48)).toBe(44);
    expect(pulsePanelInnerWidth(46)).toBe(42);
    expect(pulsePanelInnerWidth(10)).toBe(12); // floor
  });

  test('formatPulseSubLine at narrow panel width ends with ellipsis', () => {
    // ~46 cols is the real Pulse inner width class at 142-col terminals (agendaW 48 − chrome).
    const width = 46;
    const msg =
      'executed inbox-age-report: Four open inbox items waiting for triage this morning';
    const out = formatPulseSubLine(msg, width, '/tmp');
    expect(out.length).toBe(width);
    expect(out.startsWith('   executed')).toBe(true);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    // Full tail must not remain past the ellipsis cut.
    expect(out).not.toContain('this morning');
    // Clipped mid-phrase without ellipsis was the defect class.
    expect(out.includes('Four open inbo') && !out.includes(ELLIPSIS)).toBe(false);
  });

  test('formatPulseSubLine empty message is padded empty copy', () => {
    const out = formatPulseSubLine(null, 20, '/tmp');
    expect(out.length).toBe(20);
    expect(out.startsWith('   no notifications')).toBe(true);
    expect(out.endsWith(ELLIPSIS)).toBe(false);
  });
});
