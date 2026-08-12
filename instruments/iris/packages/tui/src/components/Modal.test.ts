import { describe, expect, test } from 'bun:test';
import { confirmModalWidth } from './Modal';

describe('confirmModalWidth', () => {
  test('clamps to dims.width − 4', () => {
    const wide = 'x'.repeat(80);
    expect(confirmModalWidth(wide, undefined, 40)).toBe(36);
    expect(confirmModalWidth(wide, undefined, 40)).toBeLessThanOrEqual(40 - 4);
  });

  test('uses the longest line including detail', () => {
    expect(confirmModalWidth('short', ['a longer detail line here'], 80)).toBe(
      Math.max(28, 'a longer detail line here'.length + 6),
    );
  });

  test('floor is 28 when the terminal allows it', () => {
    expect(confirmModalWidth('ok', undefined, 80)).toBe(28);
  });
});
