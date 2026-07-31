# Generates the Arcus rainbow braille logo assets:
#   assets/logo/logo07.txt      full tier art   (7 rows)
#   assets/logo/logo07.hue.txt  full tier hues
#   assets/logo/logo05.txt      small tier art  (5 rows)
#   assets/logo/logo05.hue.txt  small tier hues
#
# Run from the repo root:  python scripts/gen_arcus.py
#
# Braille cells pack 2x4 dots; in a typical 1:2 terminal cell the dot grid is
# ~square, so geometry drawn in dot-space renders undistorted. The logo is a
# filled circular annulus — an arch — supersampled 3x3 per dot for smooth
# edges. Outer band is red, inner is violet: a real primary rainbow.
#
# COLOR RESOLUTION IS THE DESIGN CONSTRAINT. A terminal colors whole cells,
# and a cell is 2x4 dots, so the *silhouette* resolves 4x finer vertically
# than the *hue* does. Bands are therefore sized in dots for the shape and
# sampled per cell for the color: each cell takes the band at the mean radius
# of its lit dots. At the flanks, where bands stack horizontally across 2-dot
# cells, all seven separate; over the apex, where they stack vertically across
# 4-dot cells, adjacent bands merge. That asymmetry is inherent to the medium,
# not a defect to tune away.
#
# Every line is padded to uniform width with U+2800 blank braille because the
# welcome renderer centers each line independently (ratatui Line::alignment).

import math
import sys

BITS = {  # (dx, dy) within a cell -> braille bit
    (0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
    (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80,
}

BLANK = "⠀"
N_BANDS = 7  # red orange yellow green blue indigo violet


def arc(cols, rows, cy, r_out, thickness, n_bands=N_BANDS):
    """Rasterize an arch onto a (cols*2) x (rows*4) dot grid.

    `cy` is the circle center's row in dot-space, normally at or below the
    grid's bottom edge so the arc's feet run off-frame the way a real bow
    meets the horizon. Returns (art_lines, hue_lines, grid).
    """
    W, H = cols * 2, rows * 4
    cx = W / 2.0
    r_in = r_out - thickness

    def radius(px, py):
        return math.hypot(px - cx, py - cy)

    def inside(px, py):
        return r_in <= radius(px, py) <= r_out

    def dot_on(x, y):
        hits = 0
        for sx in (-0.3, 0.0, 0.3):
            for sy in (-0.3, 0.0, 0.3):
                if inside(x + 0.5 + sx, y + 0.5 + sy):
                    hits += 1
        return hits >= 5

    grid = [[dot_on(x, y) for x in range(W)] for y in range(H)]

    art_lines, hue_lines = [], []
    for row in range(rows):
        chars, hues = [], []
        for col in range(cols):
            code = 0x2800
            radii = []
            for (dx, dy), bit in BITS.items():
                x, y = col * 2 + dx, row * 4 + dy
                if grid[y][x]:
                    code |= bit
                    radii.append(radius(x + 0.5, y + 0.5))
            chars.append(chr(code))
            if radii:
                # Band 0 is the OUTERMOST ring (red), matching a primary bow.
                mean_r = sum(radii) / len(radii)
                band = int((r_out - mean_r) / thickness * n_bands)
                hues.append(str(max(0, min(n_bands - 1, band))))
            else:
                hues.append(".")
        art_lines.append("".join(chars))
        hue_lines.append("".join(hues))

    width = max(len(l) for l in art_lines)
    art_lines = [l.ljust(width, BLANK) for l in art_lines]
    hue_lines = [l.ljust(width, ".") for l in hue_lines]
    return art_lines, hue_lines, grid


# Full tier: 21x7 cells = 42x28 dots. The center sits below the grid so the
# bow's feet leave the frame at the bottom corners rather than closing into a
# lollipop.
#
# thickness/r_out = 0.34 was chosen against the dot grid, not the glyphs. At
# 0.48 the band is so deep the legs merge and the whole form reads as a dome
# with a notch; thinning it opens the span and the arch appears. Thinner still
# and the bands stop separating, since thickness is the entire color budget.
FULL = dict(cols=21, rows=7, cy=30.0, r_out=29.0, thickness=10.0)
# Small tier: 15x5 cells = 30x20 dots — the same construction at ~0.71 scale,
# so the two tiers are one shape at two sizes rather than two drawings.
SMALL = dict(cols=15, rows=5, cy=21.4, r_out=20.7, thickness=7.1)

ASSETS = "crates/codegen/xai-grok-pager/assets/logo"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    for name, params in (("logo07", FULL), ("logo05", SMALL)):
        art, hue, grid = arc(**params)
        for suffix, lines in ((".txt", art), (".hue.txt", hue)):
            path = f"{ASSETS}/{name}{suffix}"
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(lines) + "\n")
        print(f"--- {name}: {params['cols']}x{params['rows']} cells ---")
        for a, h in zip(art, hue):
            print(f"{a}  {h}")
        for row in grid:
            print("".join("#" if c else "." for c in row))
        chars = set("".join(art))
        print("probe chars:", "OK" if {"⣷", "⣿"} <= chars else "MISSING",
              "| distinct glyphs:", len(chars))


if __name__ == "__main__":
    main()
