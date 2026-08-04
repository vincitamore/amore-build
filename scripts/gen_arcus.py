# Generates the Arcus aqueduct braille logo assets:
#   assets/logo/logo07.txt      full tier art   (7 rows)
#   assets/logo/logo07.hue.txt  full tier hues
#   assets/logo/logo05.txt      small tier art  (5 rows)
#   assets/logo/logo05.hue.txt  small tier hues
#
# Run from the repo root:  python scripts/gen_arcus.py
#                          python scripts/gen_arcus.py --dry-run   (preview only)
#
# The mark is an aqueduct: a deck carried on an arcade of three arches. `arcus`
# is Latin for arch, and the arcade reads as engineering and infrastructure --
# chosen over the earlier rainbow bow, which a seven-band arc unavoidably
# resembles. The bow generator is in this file's git history if it is ever wanted
# back.
#
# Braille cells pack 2x4 dots; in a typical 1:2 terminal cell the dot grid is
# ~square, so geometry drawn in dot-space renders undistorted. Shapes are filled
# and supersampled 3x3 per dot, because hand-placed braille reads as scatter and
# only mass reads as shape.
#
# THE CANVAS IS DERIVED, NOT INHERITED. The dot grid's half-width is exactly
# `cols`, so any form wider than that is silently clipped by the rasterizer --
# which is how the previous mark shipped cropped for weeks. Width is also
# bounded from above by the hero box: `left_col_width = cols + 5` and the menu
# column gets `inner_width - left_col_width`, which at the narrowest hero-box
# terminal (90 cols -> inner_width 82) means cols <= 26 keeps the menu's
# 51-column comfort floor intact. Hence 26.
#
# ROW COUNT IS LOAD-BEARING. Assets are named logo<rows>.txt and the hero box
# takes `inner_height = logo_rows.max(right_col_height(..))`; the right column
# is as short as 7 rows when no announcement is showing, so a taller logo would
# grow the box and push narrow terminals into the stacked layout sooner. Keep 7.
#
# Bands are MASONRY: quiet-stone courses (band = cell row, row-proportional at
# the small tier) with a deterministic per-cell jitter of at most one shade --
# the "ashlar, tight jitter" treatment chosen on the review artifact
# 2026-08-04. Every braille cell is one 8-dot stone. The jitter hash must stay
# bit-identical to the review page's generator (cell_hash in the house's
# forge/output/welcome-splash-review/build_mock.py): the approved look IS
# these exact digits.

import math
import sys

BITS = {  # (dx, dy) within a cell -> braille bit
    (0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
    (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80,
}

BLANK = "⠀"
N_BANDS = 7  # quiet-stone ramp: 0 the light deck course .. 6 the dark footing


def cell_hash(x, y):
    """Deterministic 32-bit mix of a cell coordinate. Bit-identical to the
    review page's build_mock.py -- the approved rendering depends on it."""
    h = (x * 374761393 + y * 668265263) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return h ^ (h >> 16)


def course_band(row, rows):
    """Course index for a cell row: identity at the 7-row full tier,
    row-proportional at the 5-row small tier."""
    return row if rows == 7 else int(row * (N_BANDS - 1) / (rows - 1) + 0.5)


def tight_band(col, row, rows):
    """Ashlar, tight jitter: the row's course drifted at most one shade per
    cell (uniform -1/0/+1), clamped to the palette."""
    jitter = cell_hash(col, row) % 3 - 1
    return max(0, min(N_BANDS - 1, course_band(row, rows) + jitter))

# Geometry as fractions of the dot grid, so the two tiers are one drawing at two
# sizes rather than two drawings.
MARGIN = 2.0        # blank dots kept at each side wall
DECK_TOP = 0.107    # deck (the roadway) as a fraction of H
DECK_BOT = 0.232
ARCADE_TOP = 0.286  # where the arcade below the deck begins
SPRING = 0.643      # springing line of the arch openings
# The three openings, the two piers between them and the two end abutments are
# solved from the usable span rather than pinned to fractions of W, so masonry
# stays proportional at every canvas size. Fixed fractions left the small tier's
# abutments barely a dot wide, which reads as a line rather than a pier.
#   usable = 2*abutment + 2*pier + 3*(2*radius),  abutment = pier = 0.9*radius
#         => usable = 9.6*radius
SOLID_TO_RADIUS = 0.9


def aqueduct(cols, rows):
    """Rasterize the aqueduct onto a (cols*2) x (rows*4) dot grid.

    Returns (art_lines, hue_lines, grid).
    """
    W, H = cols * 2, rows * 4
    cx = W / 2.0
    floor = float(H - 1)
    deck_t, deck_b = H * DECK_TOP, H * DECK_BOT
    arcade_t = H * ARCADE_TOP
    # The shadow line between deck and arcade is proportional, so at the small
    # tier it works out thinner than one dot -- and a gap under a dot cannot
    # render, it only smears the deck into the arcade. Close it below ~1.2 dots
    # instead: the small tier then reads as a solid deck over the arches, which
    # is the same silhouette minus a detail it has no resolution for.
    if arcade_t - deck_b < 1.2:
        arcade_t = deck_b
    spring = H * SPRING
    usable = W - 2.0 * MARGIN
    rad = usable / (4.0 * SOLID_TO_RADIUS + 6.0)
    spacing = 2.0 * rad + SOLID_TO_RADIUS * rad
    bays = (cx - spacing, cx, cx + spacing)

    def solid(px, py):
        # Side walls: the bounds must SUM TO W or the mark is not mirror
        # symmetric -- an off-by-one here shaves one end abutment.
        if not (MARGIN <= px <= W - MARGIN):
            return False
        on_deck = deck_t <= py <= deck_b
        in_arcade = arcade_t <= py <= floor
        if not (on_deck or in_arcade):
            return False
        if py <= deck_b + 0.5:
            return True
        # subtract the arched openings: a rectangle below the springing line
        # capped by a semicircle above it
        for ox in bays:
            if abs(px - ox) <= rad and py >= spring:
                return False
            if math.hypot(px - ox, py - spring) <= rad and py < spring:
                return False
        return True

    def dot_on(x, y):
        hits = 0
        for sx in (-0.3, 0.0, 0.3):
            for sy in (-0.3, 0.0, 0.3):
                if solid(x + 0.5 + sx, y + 0.5 + sy):
                    hits += 1
        return hits >= 5

    grid = [[dot_on(x, y) for x in range(W)] for y in range(H)]

    art_lines, hue_lines = [], []
    for row in range(rows):
        chars, hues = [], []
        for col in range(cols):
            code = 0x2800
            for (dx, dy), bit in BITS.items():
                x, y = col * 2 + dx, row * 4 + dy
                if grid[y][x]:
                    code |= bit
            chars.append(chr(code))
            if code != 0x2800:
                # Masonry: the row's course jittered at most one shade per
                # cell -- every 8-dot block its own stone.
                hues.append(str(tight_band(col, row, rows)))
            else:
                hues.append(".")
        art_lines.append("".join(chars))
        hue_lines.append("".join(hues))

    # Every line is padded to uniform width with U+2800 blank braille because the
    # welcome renderer centers each line independently (ratatui Line::alignment).
    width = max(len(l) for l in art_lines)
    art_lines = [l.ljust(width, BLANK) for l in art_lines]
    hue_lines = [l.ljust(width, ".") for l in hue_lines]
    return art_lines, hue_lines, grid


# Full tier: 26x7 cells = 52x28 dots. 26 is the widest the hero box tolerates
# before the menu column drops under its comfort floor (see header).
FULL = dict(cols=26, rows=7)
# Small tier: 18x5 cells = 36x20 dots -- the same construction at ~0.71 scale,
# used by the stacked layout at terminal heights 22..25.
SMALL = dict(cols=18, rows=5)

ASSETS = "crates/codegen/xai-grok-pager/assets/logo"

# Glyphs the pty probe test asserts on, to prove multi-byte UTF-8 survived the
# writer thread. Any braille glyph serves that purpose; these two are structural
# in this mark (the solid mass, and the deck's top edge).
PROBE = ("⣿", "⣀")  # U+28FF full cell, U+28C0 bottom-row pair


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    dry = "--dry-run" in sys.argv
    failures = []
    for name, params in (("logo07", FULL), ("logo05", SMALL)):
        art, hue, grid = aqueduct(**params)
        W = params["cols"] * 2
        H = params["rows"] * 4

        print(f"--- {name}: {params['cols']}x{params['rows']} cells ---")
        for a, h in zip(art, hue):
            print(f"{a}  {h}")

        # Invariants, checked every run rather than trusted.
        cellwise = all((a != BLANK) == (h != ".")
                       for al, hl in zip(art, hue) for a, h in zip(al, hl))
        asym = sum(1 for y in range(H) for x in range(W)
                   if grid[y][x] != grid[y][W - 1 - x])
        walls = sum(1 for y in range(H) if grid[y][0] or grid[y][W - 1])
        chars = set("".join(art))
        probe_ok = set(PROBE) <= chars
        bands = "".join(sorted(set("".join(hue)) - {"."}))
        print(f"cellwise art<->hue: {'OK' if cellwise else 'MISMATCH'} | "
              f"mirror-asymmetric dots: {asym} | side-wall dots: {walls} | "
              f"probe {'OK' if probe_ok else 'MISSING'} | bands {bands} | "
              f"distinct glyphs {len(chars)}")
        if not cellwise:
            failures.append(f"{name}: hue map does not match art cell for cell")
        if asym:
            failures.append(f"{name}: {asym} mirror-asymmetric dots")
        if walls:
            failures.append(f"{name}: {walls} dots touch a side wall (clipped)")
        if name == "logo07" and not probe_ok:
            failures.append(f"{name}: missing a pty probe glyph {PROBE}")
        if bands != "0123456":
            failures.append(f"{name}: bands present are {bands!r}, expected all 7")

        if not dry:
            for suffix, lines in ((".txt", art), (".hue.txt", hue)):
                path = f"{ASSETS}/{name}{suffix}"
                with open(path, "w", encoding="utf-8", newline="\n") as f:
                    f.write("\n".join(lines) + "\n")
        print()

    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    print("dry run - no files written" if dry else f"wrote 4 files under {ASSETS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
