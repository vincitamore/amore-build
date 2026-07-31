# Generates the Arcus crescent-moon braille logo assets:
#   assets/logo/logo07.txt  (full tier, 7 rows x 13 cols)
#   assets/logo/logo05.txt  (small tier, 5 rows x 9 cols)
#
# Run from the repo root:  python scripts/gen_crescent.py
#
# Braille cells pack 2x4 dots; in a typical 1:2 terminal cell the dot grid is
# ~square, so geometry drawn in dot-space renders undistorted. The crescent is
# a filled disc minus an offset "bite" disc, supersampled 3x3 per dot for
# smooth edges. The sparkle in the hollow is placed dot-by-dot (a geometric
# star this small supersamples into a blob). Every line is padded to uniform
# width with U+2800 blank braille because the welcome renderer centers each
# line independently.

import sys

BITS = {  # (dx, dy) within a cell -> braille bit
    (0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
    (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80,
}


def crescent(cols, rows, R, bite_dx, bite_dy, bite_r, star=None):
    """Rasterize onto a (cols*2) x (rows*4) dot grid. Returns (lines, grid)."""
    W, H = cols * 2, rows * 4
    cx, cy = W / 2.0, H / 2.0

    def inside(px, py):
        if (px - cx) ** 2 + (py - cy) ** 2 > R * R:
            return False
        bx, by = cx + bite_dx, cy + bite_dy
        return (px - bx) ** 2 + (py - by) ** 2 >= bite_r * bite_r

    def dot_on(x, y):
        hits = 0
        for sx in (-0.3, 0.0, 0.3):
            for sy in (-0.3, 0.0, 0.3):
                if inside(x + 0.5 + sx, y + 0.5 + sy):
                    hits += 1
        return hits >= 5

    grid = [[dot_on(x, y) for x in range(W)] for y in range(H)]

    if star is not None:
        # 4-pointed sparkle, dot-exact: vertical + horizontal arms of `arm`
        # dots each side, optionally the four inner diagonals for body.
        sx, sy, arm, diag = star
        pts = [(sx, sy)]
        for d in range(1, arm + 1):
            pts += [(sx + d, sy), (sx - d, sy), (sx, sy + d), (sx, sy - d)]
        if diag:
            pts += [(sx - 1, sy - 1), (sx + 1, sy - 1),
                    (sx - 1, sy + 1), (sx + 1, sy + 1)]
        for px, py in pts:
            if 0 <= px < W and 0 <= py < H:
                grid[py][px] = True

    lines = []
    for row in range(rows):
        chars = []
        for col in range(cols):
            code = 0x2800
            for (dx, dy), bit in BITS.items():
                if grid[row * 4 + dy][col * 2 + dx]:
                    code |= bit
            chars.append(chr(code))
        lines.append("".join(chars))
    return lines, grid


FULL = dict(cols=13, rows=7, R=13.2, bite_dx=9.0, bite_dy=-6.2, bite_r=12.4,
            star=(20, 6, 3, True))
SMALL = dict(cols=9, rows=5, R=9.4, bite_dx=6.4, bite_dy=-4.4, bite_r=8.8,
             star=(13, 4, 2, False))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    for name, params in (("logo07", FULL), ("logo05", SMALL)):
        lines, grid = crescent(**params)
        path = f"crates/codegen/xai-grok-pager/assets/logo/{name}.txt"
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        print(f"--- {name} -> {path} ---")
        for ln in lines:
            print(ln)
        for row in grid:
            print("".join("#" if c else "." for c in row))


if __name__ == "__main__":
    main()
