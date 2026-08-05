import { describe, expect, test } from 'bun:test';
import { formatLogCell } from './LucernaMember';

describe('formatLogCell', () => {
  test('pads short lines to width', () => {
    expect(formatLogCell('hi', 5)).toBe('hi   ');
  });

  test('truncates long lines', () => {
    expect(formatLogCell('abcdefghij', 5)).toBe('abcd.');
  });

  test('replaces multi-byte glyphs with ASCII', () => {
    const out = formatLogCell('a → b — c …', 20);
    expect(out).toContain('->');
    expect(out).not.toMatch(/[^\t\r\n\x20-\x7e]/);
  });

  test('zero width → empty', () => {
    expect(formatLogCell('x', 0)).toBe('');
  });
});
