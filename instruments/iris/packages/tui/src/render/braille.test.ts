import { test, expect } from 'bun:test';
import { BrailleCanvas } from './braille';

test('a single set pixel = one braille glyph (top-left dot ⠁)', () => {
  const c = new BrailleCanvas(2, 4);
  c.set(0, 0);
  expect(c.toString()).toBe(String.fromCodePoint(0x2801)); // ⠁
});

test('all 8 dots in one cell = the full block ⣿', () => {
  const c = new BrailleCanvas(2, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) c.set(x, y);
  expect(c.toString()).toBe(String.fromCodePoint(0x28ff)); // ⣿
});

test('out-of-bounds set is a no-op (cell stays empty → space)', () => {
  const c = new BrailleCanvas(2, 4);
  c.set(-1, 0);
  c.set(0, 99);
  c.set(5, 5);
  expect(c.toString()).toBe(' ');
});

test('a horizontal top-row line sets the top dots of every cell (⠉ × N)', () => {
  const c = new BrailleCanvas(8, 4); // 4 cells wide
  c.line(0, 0, 7, 0);
  expect(c.toLines()[0]).toBe(String.fromCodePoint(0x2809).repeat(4)); // ⠉⠉⠉⠉
});

test('dimensions: 80×40 sub-pixels → 40 cols × 10 rows', () => {
  const c = new BrailleCanvas(80, 40);
  expect(c.cellCols).toBe(40);
  expect(c.cellRows).toBe(10);
  expect(c.toLines().length).toBe(10);
});

test('a diagonal line lights both ends', () => {
  const c = new BrailleCanvas(8, 8);
  c.line(0, 0, 7, 7);
  expect(c.cellAt(0, 0) & 0x01).toBeGreaterThan(0); // start dot
  expect(c.cellAt(3, 1) & 0x80).toBeGreaterThan(0); // end dot (sub 7,7 → cell 3,1 dot8)
});
