#!/usr/bin/env python3
"""Assemble a captured frame series (capture_frame.py --frames N) into a GIF.

Renders every frame JSON through render_frame.py (same fonts, same geometry),
quantizes against one shared palette so the loop does not flicker, and writes
an infinitely-looping GIF at the capture's frame interval.

`--rotate K` starts the loop at frame K (use it to place the loop seam inside
the animation's quiet phase, so the wrap is invisible).
"""

from __future__ import annotations

import argparse
import glob
import os
import subprocess
import sys

from PIL import Image


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True,
                    help="frame basename (expects <frames>-NNN.json)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--font-size", type=int, default=14)
    ap.add_argument("--duration", type=int, default=83,
                    help="per-frame duration in ms")
    ap.add_argument("--rotate", type=int, default=0,
                    help="start the loop at this frame index")
    args = ap.parse_args()

    paths = sorted(glob.glob(f"{args.frames}-[0-9][0-9][0-9].json"))
    if not paths:
        print(f"no frames match {args.frames}-NNN.json", file=sys.stderr)
        return 1
    paths = paths[args.rotate:] + paths[:args.rotate]

    render = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "render_frame.py")
    pngs = []
    for p in paths:
        png = p[:-5] + ".png"
        subprocess.run([sys.executable, render, "--frame", p, "--out", png,
                        "--font-size", str(args.font_size)],
                       check=True, capture_output=True)
        pngs.append(png)

    frames = [Image.open(p).convert("RGB") for p in pngs]
    # One shared palette: per-frame adaptive palettes shimmer on their own,
    # which reads as noise layered over the real animation.
    base = frames[0].quantize(colors=256)
    quantized = [f.quantize(palette=base, dither=Image.Dither.NONE)
                 for f in frames]
    quantized[0].save(args.out, save_all=True, append_images=quantized[1:],
                      duration=args.duration, loop=0, optimize=True)
    size = os.path.getsize(args.out)
    print(f"wrote {args.out}  {len(frames)} frames @ {args.duration}ms  "
          f"{size / 1024:.0f} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
