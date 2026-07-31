// Braille canvas — a 2×4-sub-pixel-per-cell monochrome rasterizer.
//
// Each terminal cell holds a Unicode braille glyph (U+2800 + an 8-bit dot mask), so one
// cell carries 2×4 = 8 addressable sub-pixels. This is the finest portable primitive for
// drawing points and thin lines (a force-directed graph) in a terminal — no sixel, no GPU.
// The cell glyphs are written into OpenTUI's OptimizedBuffer downstream; this layer is pure
// (string output) so it tests without a terminal.

// Dot → bit, indexed [subY 0..3][subX 0..1] (the standard drawille mapping).
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export class BrailleCanvas {
  /** Width/height in SUB-PIXELS (a cell is 2 wide × 4 tall). */
  readonly width: number;
  readonly height: number;
  /** Grid size in CELLS. */
  readonly cellCols: number;
  readonly cellRows: number;
  private readonly cells: Uint8Array;

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.cellCols = Math.max(1, Math.ceil(this.width / 2));
    this.cellRows = Math.max(1, Math.ceil(this.height / 4));
    this.cells = new Uint8Array(this.cellCols * this.cellRows);
  }

  /** Light a sub-pixel. Out-of-bounds is a no-op. */
  set(x: number, y: number): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const cx = (xi / 2) | 0;
    const cy = (yi / 4) | 0;
    this.cells[cy * this.cellCols + cx] |= DOT[yi % 4][xi % 2];
  }

  /** Draw a line in sub-pixel space (integer Bresenham). */
  line(x0: number, y0: number, x1: number, y1: number): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xe = Math.round(x1);
    const ye = Math.round(y1);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x, y);
      if (x === xe && y === ye) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** The braille mask for one cell (0 = empty). Used by the OpenTUI blit + tests. */
  cellAt(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.cellCols || cy >= this.cellRows) return 0;
    return this.cells[cy * this.cellCols + cx];
  }

  /** Render to one string per cell-row (empty cells are spaces). */
  toLines(): string[] {
    const lines: string[] = [];
    for (let cy = 0; cy < this.cellRows; cy++) {
      let s = '';
      for (let cx = 0; cx < this.cellCols; cx++) {
        const b = this.cells[cy * this.cellCols + cx];
        s += b === 0 ? ' ' : String.fromCodePoint(0x2800 + b);
      }
      lines.push(s);
    }
    return lines;
  }

  toString(): string {
    return this.toLines().join('\n');
  }
}
