# Generates the Amore crowned-heart braille logo assets:
#   assets/logo/logo07.txt      full tier art   (7 rows)
#   assets/logo/logo07.hue.txt  full tier hues
#   assets/logo/logo05.txt      small tier art  (5 rows)
#   assets/logo/logo05.hue.txt  small tier hues
#
# Run from the repo root:  python scripts/gen_amore.py
#                          python scripts/gen_amore.py --dry-run   (preview only)
#
# The mark is the Amore Build crowned heart: a three-point crown resting
# directly on a two-lobe heart (heart = two circles + a wedge to the apex).
# Chosen from the round-1b candidate review on 2026-08-04 — geometry "resting
# crown", treatment "gold crown, rose heart" (two hue zones: the crown draws
# bands 0-1 in gold, the heart bands 2-6 in rose; the material line and the
# geometric seam are the same line). The review surface and its generator
# live in the house tree at forge/output/amore-splash-review/; the aqueduct
# and bow generators are in this file's git history.
#
# Braille cells pack 2x4 dots; in a typical 1:2 terminal cell the dot grid is
# ~square, so geometry drawn in dot-space renders undistorted. Shapes are filled
# and supersampled 3x3 per dot, because hand-placed braille reads as scatter and
# only mass reads as shape.
#
# THE CANVAS IS DERIVED, NOT INHERITED. The dot grid's half-width is exactly
# `cols`, so any form wider than that is silently clipped by the rasterizer.
# Width is also bounded from above by the hero box: `left_col_width = cols + 5`
# and the menu column gets `inner_width - left_col_width`, which at the
# narrowest hero-box terminal (90 cols -> inner_width 82) means cols <= 26
# keeps the menu's 51-column comfort floor intact. Hence 26. The crowned heart
# is a portrait form and uses ~14 of the 26 columns; the rest is the centered
# margin the hero box expects.
#
# ROW COUNT IS LOAD-BEARING. Assets are named logo<rows>.txt and the hero box
# takes `inner_height = logo_rows.max(right_col_height(..))`; the right column
# is as short as 7 rows when no announcement is showing, so a taller logo would
# grow the box and push narrow terminals into the stacked layout sooner. Keep 7.
#
# HORIZONTAL SEAMS SNAP TO CELL BOUNDARIES. A braille cell is 4 dots tall, so
# a band edge landing mid-cell shares its cell row with the next feature and
# the two interleave into mush at the small tier (found in the round-1
# review). The crown's bottom edge snaps to a multiple of 4 dots.

import math
import sys

BITS = {  # (dx, dy) within a cell -> braille bit
    (0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
    (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80,
}

BLANK = "⠀"
N_BANDS = 7  # 0-1 the gold crown, 2-6 the rose heart (light to deep)

# Geometry, as worked out on the review surface (build_mock.py holds the same
# constants; the shipped digits ARE the approved rendering).
MARGIN = 2.0        # blank dots kept at each side wall
CROWN_FRAC = 0.25   # crown share of H before the cell-boundary snap
BAND_TOP_FRAC = 0.55  # crown band starts at this fraction of the crown height
MERLON_W = 0.7      # merlon base half-width, in units of crown_width/6
HEART_RATIO = 3.2   # heart height = 3.2 * lobe radius; heart width = 4 * radius


def crowned_heart(cols, rows):
    """Rasterize the resting-crown heart onto a (cols*2) x (rows*4) dot grid.

    Returns (art_lines, hue_lines, grid). Symmetric about the canvas centre by
    construction — every predicate uses |px - cx| or a mirrored circle pair.
    """
    W, H = cols * 2, rows * 4
    cx = W / 2.0
    floor = float(H - 1)

    crown_h = H * CROWN_FRAC
    snapped = 4.0 * round(crown_h / 4.0)
    if abs(snapped - crown_h) <= 1.3 and snapped >= 4.0:
        crown_h = snapped

    heart_top = crown_h                  # resting: no gap, the band seats on the lobes
    hh = floor - heart_top
    R = hh / HEART_RATIO                 # lobe radius
    lobe_cy = heart_top + R
    lobe_l, lobe_r = cx - R, cx + R

    cw = 4.0 * R                         # crown width = heart width
    band_top = crown_h * BAND_TOP_FRAC
    mbh = cw / 6.0 * MERLON_W            # merlon base half-width
    peaks = (cx - cw / 3.0, cx, cx + cw / 3.0)

    def in_heart(px, py):
        if math.hypot(px - lobe_l, py - lobe_cy) <= R:
            return True
        if math.hypot(px - lobe_r, py - lobe_cy) <= R:
            return True
        if lobe_cy <= py <= floor:
            t = (py - lobe_cy) / (floor - lobe_cy)
            return abs(px - cx) <= 2.0 * R * (1.0 - t)
        return False

    def in_crown(px, py):
        if band_top <= py <= crown_h and abs(px - cx) <= cw / 2.0:
            return True
        if 0.0 <= py < band_top:
            t = py / band_top
            hw = mbh * (0.15 + 0.85 * t)   # triangle points
            return any(abs(px - mx) <= hw for mx in peaks)
        return False

    def sample(x, y):
        crown_hits = heart_hits = 0
        for sx in (-0.3, 0.0, 0.3):
            for sy in (-0.3, 0.0, 0.3):
                px, py = x + 0.5 + sx, y + 0.5 + sy
                if not (MARGIN <= px <= W - MARGIN):
                    continue
                if in_crown(px, py):
                    crown_hits += 1
                elif in_heart(px, py):
                    heart_hits += 1
        if crown_hits + heart_hits >= 5:
            return "crown" if crown_hits >= heart_hits else "heart"
        return None

    zones = [[sample(x, y) for x in range(W)] for y in range(H)]
    grid = [[z is not None for z in row] for row in zones]

    # First cell row containing heart cells — anchors the rose ramp.
    heart_rows = [r for r in range(rows)
                  if any(zones[r * 4 + dy][x] == "heart"
                         for dy in range(4) for x in range(W))]
    rh0 = heart_rows[0] if heart_rows else 0
    heart_span = max(1, rows - 1 - rh0)

    art_lines, hue_lines = [], []
    for r in range(rows):
        chars, hues = [], []
        for c in range(cols):
            code, votes = 0x2800, {"crown": 0, "heart": 0}
            for (dx, dy), bit in BITS.items():
                x, y = c * 2 + dx, r * 4 + dy
                z = zones[y][x]
                if z:
                    code |= bit
                    votes[z] += 1
            chars.append(chr(code))
            if code == 0x2800:
                hues.append(".")
            elif votes["crown"] >= votes["heart"]:
                # Gold zone: the first crown row is the bright gold, any
                # further crown rows the deeper gold. (At the small tier the
                # crown is one cell row, so band 1 does not appear there.)
                hues.append("0" if r == 0 else "1")
            else:
                # Rose zone: bands 2..6 spread over the heart's cell rows.
                band = 2 + min(4, int((r - rh0) * 4.0 / heart_span + 0.5))
                hues.append(str(band))
        art_lines.append("".join(chars))
        hue_lines.append("".join(hues))

    width = max(len(l) for l in art_lines)
    art_lines = [l.ljust(width, BLANK) for l in art_lines]
    hue_lines = [l.ljust(width, ".") for l in hue_lines]
    return art_lines, hue_lines, grid


# Full tier: 26x7 cells = 52x28 dots (the hero box always uses this one).
FULL = dict(cols=26, rows=7)
# Small tier: 18x5 cells = 36x20 dots — the stacked layout at heights 22..25.
SMALL = dict(cols=18, rows=5)

ASSETS = "crates/codegen/xai-grok-pager/assets/logo"

# Glyphs the pty probe test asserts on, to prove multi-byte UTF-8 survived the
# writer thread. Any braille glyph serves that purpose; these two are
# structural in this mark (the solid band/body mass, and a lobe shoulder).
PROBE = ("⣿", "⣼")  # U+28FF full cell, U+28FC

# Expected band coverage. The full tier must draw all seven; the small tier's
# one-row crown cannot reach the deep gold (band 1) and its four heart rows
# skip 4 — the pinned carve, asserted exactly so drift is loud.
EXPECT_BANDS = {"logo07": "0123456", "logo05": "02356"}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    dry = "--dry-run" in sys.argv
    failures = []
    for name, params in (("logo07", FULL), ("logo05", SMALL)):
        art, hue, grid = crowned_heart(**params)
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
        if bands != EXPECT_BANDS[name]:
            failures.append(f"{name}: bands present are {bands!r}, "
                            f"expected {EXPECT_BANDS[name]!r}")

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
