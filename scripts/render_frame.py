#!/usr/bin/env python3
"""Render a captured terminal frame (styled JSON) to a PNG.

Draws cell by cell with PIL against real monospace fonts, with per-glyph
fallback, so coverage (braille, box drawing, dingbats) is verified rather than
left to a browser's font substitution.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

NAMED = {
    "black": "1c1f24", "red": "e05561", "green": "8cc265", "brown": "d5971a",
    "yellow": "d5971a", "blue": "4aa5f0", "magenta": "c162de", "cyan": "42b3c2",
    "white": "d7dae0", "brightblack": "6b727f", "brightred": "ff616e",
    "brightgreen": "a5e075", "brightbrown": "f0a45d", "brightyellow": "f0a45d",
    "brightblue": "4dc4ff", "brightmagenta": "de73ff", "brightcyan": "4cd1e0",
    "brightwhite": "ffffff",
}


def font_candidates():
    out = []
    cas = r"C:\Windows\Fonts\CascadiaMono.ttf"
    if os.path.exists(cas):
        out.append(("Cascadia Mono", cas, cas))
    try:
        import matplotlib
        base = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
        reg = os.path.join(base, "DejaVuSansMono.ttf")
        bold = os.path.join(base, "DejaVuSansMono-Bold.ttf")
        if os.path.exists(reg):
            out.append(("DejaVu Sans Mono", reg, bold))
    except Exception:
        pass
    for name, path in (("Consolas", r"C:\Windows\Fonts\consola.ttf"),
                       ("Segoe UI Symbol", r"C:\Windows\Fonts\seguisym.ttf")):
        if os.path.exists(path):
            out.append((name, path, path))
    return out


def to_rgb(value: str, default_hex: str) -> tuple:
    if not value or value == "default":
        value = default_hex
    value = NAMED.get(value, value)
    if len(value) == 6:
        try:
            return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return tuple(int(default_hex[i:i + 2], 16) for i in (0, 2, 4))


def _load_frame_dict(frame: str | Path | dict) -> dict[str, Any]:
    if isinstance(frame, dict):
        return frame
    path = Path(frame)
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def render_frame_to_png(
    frame: str | Path | dict,
    out: str | Path,
    *,
    font_size: int = 30,
    line_height: float = 1.24,
    pad_x: int = 40,
    pad_y: int = 34,
    radius: int = 20,
    default_fg: str = "c8c8c8",
    trim: bool = False,
    quiet: bool = False,
) -> Path:
    """Load JSON (path or already-parsed dict), paint, write PNG.

    Raises on missing fonts or unmappable glyphs. Returns the output path.
    """
    data = _load_frame_dict(frame)
    cells = [list(row) for row in data["cells"]]

    def blank_row(row):
        return all((c["c"] or " ").isspace() for c in row)

    if trim:
        while cells and blank_row(cells[-1]):
            cells.pop()
        while cells and blank_row(cells[0]):
            cells.pop(0)
        last = 0
        for row in cells:
            for x, c in enumerate(row):
                if not (c["c"] or " ").isspace():
                    last = max(last, x)
        cells = [row[: last + 1] for row in cells]

    rows, cols = len(cells), len(cells[0]) if cells else 0
    if rows == 0 or cols == 0:
        raise ValueError("frame has no cells")

    charset = {c["c"] for row in cells for c in row if not (c["c"] or " ").isspace()}

    fonts = []
    candidates = font_candidates()
    for name, reg, bold in candidates:
        fonts.append((
            name,
            ImageFont.truetype(reg, font_size),
            ImageFont.truetype(bold or reg, font_size),
        ))
    if not fonts:
        raise RuntimeError("no fonts found for frame render")

    # Coverage must come from the font's cmap, not from whether a glyph paints
    # pixels: BRAILLE PATTERN BLANK (U+2800) is a real, intentionally empty
    # glyph. A pixel test rejects it, falls through to a font without braille,
    # and draws .notdef boxes through the middle of the logo.
    from fontTools.ttLib import TTFont
    cmaps = []
    for (_name, _regular, _bold), (_n2, path, _b2) in zip(fonts, candidates):
        try:
            cmaps.append(set(TTFont(path, fontNumber=0).getBestCmap().keys()))
        except Exception:
            cmaps.append(None)

    served, missing = {}, set()
    for ch in charset:
        for idx, (_name, regular, _bold) in enumerate(fonts):
            cmap = cmaps[idx]
            covered = (ord(ch) in cmap) if cmap is not None else \
                (regular.getmask(ch, mode="L").getbbox() is not None)
            if covered:
                served[ch] = idx
                break
        else:
            missing.add(ch)
    if not quiet:
        by_font: dict[str, list[str]] = {}
        for ch, idx in served.items():
            by_font.setdefault(fonts[idx][0], []).append(ch)
        for name, chars in by_font.items():
            print(f"  {name}: {len(chars)} glyph(s)")
    if missing:
        raise RuntimeError(f"MISSING from every font: {sorted(missing)}")

    primary = fonts[0][1]
    cell_w = round(primary.getlength("M"))
    cell_h = round(font_size * line_height)
    ascent, _ = primary.getmetrics()

    counts: dict[str, int] = {}
    for row in cells:
        for c in row:
            if c["bg"] != "default":
                counts[c["bg"]] = counts.get(c["bg"], 0) + 1
    default_bg = max(counts, key=lambda k: counts[k]) if counts else "141414"
    bg_rgb = to_rgb(default_bg, "141414")

    width = cols * cell_w + 2 * pad_x
    height = rows * cell_h + 2 * pad_y
    img = Image.new("RGB", (width, height), bg_rgb)
    draw = ImageDraw.Draw(img)

    for y, row in enumerate(cells):
        top = pad_y + y * cell_h
        for x, cell in enumerate(row):
            left = pad_x + x * cell_w
            fg, bg = cell["fg"], cell["bg"]
            if cell["r"]:
                fg, bg = (bg if bg != "default" else default_bg), \
                         (fg if fg != "default" else default_fg)
            if bg != "default":
                rgb = to_rgb(bg, default_bg)
                if rgb != bg_rgb:
                    draw.rectangle(
                        [left, top, left + cell_w - 1, top + cell_h - 1], fill=rgb
                    )
            ch = cell["c"]
            if not ch or ch.isspace():
                continue
            idx = served.get(ch, 0)
            font = fonts[idx][2] if cell["b"] else fonts[idx][1]
            baseline = top + (cell_h - font_size) // 2
            draw.text((left, baseline), ch, font=font, fill=to_rgb(fg, default_fg))

    if radius > 0:
        mask = Image.new("L", (width, height), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, width - 1, height - 1], radius=radius, fill=255
        )
        card = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        card.paste(img, (0, 0), mask)
        img = card

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out_path), optimize=True)
    if not quiet:
        print(
            f"wrote {out_path}  {width}x{height}px  ({rows} rows x {cols} cols, "
            f"cell {cell_w}x{cell_h}, ascent {ascent})"
        )
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frame", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--font-size", type=int, default=30)
    ap.add_argument("--line-height", type=float, default=1.24)
    ap.add_argument("--pad-x", type=int, default=40)
    ap.add_argument("--pad-y", type=int, default=34)
    ap.add_argument("--radius", type=int, default=20)
    ap.add_argument("--default-fg", default="c8c8c8")
    ap.add_argument("--trim", action="store_true", help="drop blank rows/cols at the edges")
    args = ap.parse_args()

    try:
        render_frame_to_png(
            args.frame,
            args.out,
            font_size=args.font_size,
            line_height=args.line_height,
            pad_x=args.pad_x,
            pad_y=args.pad_y,
            radius=args.radius,
            default_fg=args.default_fg,
            trim=args.trim,
            quiet=False,
        )
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"render failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
