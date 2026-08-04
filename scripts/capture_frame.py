#!/usr/bin/env python3
"""Capture rendered TUI frames from a real pty as styled-cell JSON.

Drives a binary through a ConPTY (Windows; `pywinpty`), feeds its output to a
VT emulator (`pyte`), and dumps the screen as a grid of styled cells that
`render_frame.py` turns into a PNG. This is how the repository's docs images
are made: a capture of the real binary painting a real frame — never a mock.

Two capture modes:

  * single frame (default): wait for `--sentinel`, let the screen settle,
    dump `<out>.txt` + `<out>.json`.
  * frame series (`--frames N --interval MS`): after sentinel + settle, dump
    N numbered snapshots (`<out>-000.json`, ...) at a fixed wall-clock
    interval — the input for an animation (see `make_gif.py`).

`--send` writes bytes to the child after the sentinel appears (repeatable,
with `--send-delay` between writes) — enough to drive a tabbed TUI to the
view you want before the shot.

A TUI will not paint until its terminal capability queries (device
attributes, cursor position) are answered; the responding screen below wires
those replies back into the pty. See pyte's `write_process_input`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import pyte
from winpty import PtyProcess


def dump_frame(screen: pyte.Screen, rows: int, cols: int, path: str) -> None:
    cells = []
    for y in range(rows):
        line = screen.buffer[y]
        cells.append([{
            "c": line[x].data or " ",
            "fg": line[x].fg,
            "bg": line[x].bg,
            "b": bool(line[x].bold),
            "i": bool(line[x].italics),
            "u": bool(line[x].underscore),
            "r": bool(line[x].reverse),
        } for x in range(cols)])
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"rows": rows, "cols": cols, "cells": cells}, fh)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True, help="program to spawn in the pty")
    ap.add_argument("--args", nargs=argparse.REMAINDER, default=[],
                    help="arguments passed to the program (everything after --args)")
    ap.add_argument("--out", required=True, help="output basename (writes .txt/.json)")
    ap.add_argument("--rows", type=int, default=34)
    ap.add_argument("--cols", type=int, default=108)
    ap.add_argument("--sentinel", default="Quit",
                    help="string that must appear on screen before capture")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--settle", type=float, default=3.0,
                    help="seconds after sentinel (and sends) before the shot")
    ap.add_argument("--home", default=os.path.join("target", "cap-home"),
                    help="throwaway HOME for the child (keeps real config out of frames)")
    ap.add_argument("--env", action="append", default=[], metavar="K=V")
    ap.add_argument("--cwd", default=None, help="working directory for the child")
    ap.add_argument("--send", action="append", default=[], metavar="BYTES",
                    help="write these bytes to the child after the sentinel "
                         "(repeatable; python escapes, e.g. '\\x1b[B' or '2')")
    ap.add_argument("--send-delay", type=float, default=0.4,
                    help="seconds between --send writes")
    ap.add_argument("--resize-jiggle", action="store_true",
                    help="resize the pty down one column and back before the "
                         "shot — forces a full relayout/repaint, clearing any "
                         "stale cells a render diff left behind")
    ap.add_argument("--frames", type=int, default=1,
                    help=">1 captures a numbered series after settle")
    ap.add_argument("--interval", type=float, default=83.0,
                    help="series inter-frame interval in milliseconds")
    args = ap.parse_args()

    # Absolutize: these become the CHILD's env (USERPROFILE / AMORE_HOME), and
    # a relative path there resolves against the child's cwd, not ours —
    # silently pointing the app at an empty home.
    args.home = os.path.abspath(args.home)
    if args.cwd:
        args.cwd = os.path.abspath(args.cwd)
    os.makedirs(args.home, exist_ok=True)

    keep = ["SystemRoot", "windir", "SystemDrive", "PATHEXT", "COMSPEC",
            "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "TEMP", "TMP",
            "APPDATA", "LOCALAPPDATA", "PATH"]
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update({
        "USERPROFILE": args.home,
        "HOME": args.home,
        "AMORE_HOME": os.path.join(args.home, ".amore"),
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        # Modern-terminal glyph path: the frame should show what a real
        # terminal shows, not the legacy-console fallbacks.
        "WT_SESSION": "00000000-0000-0000-0000-000000000000",
    })
    for pair in args.env:
        key, _, value = pair.partition("=")
        env[key] = value

    class RespondingScreen(pyte.Screen):
        proc: "PtyProcess | None" = None

        def write_process_input(self, data):
            if self.proc is not None:
                try:
                    self.proc.write(data)
                except Exception:
                    pass

    screen = RespondingScreen(args.cols, args.rows)
    stream = pyte.ByteStream(screen)

    # The child resolves a relative binary path against ITS cwd, not ours —
    # and a failed spawn leaves the pty open with a blocking read. Absolutize.
    binary = os.path.abspath(args.binary)
    cmdline = binary
    prog_args = [a for a in args.args if a != "--"]
    if prog_args:
        cmdline = " ".join([binary] + prog_args)
    proc = PtyProcess.spawn(cmdline, dimensions=(args.rows, args.cols), env=env,
                            cwd=args.cwd)
    screen.proc = proc

    # `PtyProcess.read` blocks, and a TUI that painted a static screen goes
    # quiet — a blocking read then starves every timeout below. Read on a
    # thread; the main loop consumes a queue with real deadlines.
    import queue
    import threading

    q: "queue.Queue[bytes | None]" = queue.Queue()

    def reader() -> None:
        try:
            while True:
                chunk = proc.read(65536)
                if not chunk:
                    time.sleep(0.02)
                    continue
                q.put(chunk.encode("utf-8", "replace")
                      if isinstance(chunk, str) else chunk)
        except (EOFError, OSError):
            q.put(None)

    threading.Thread(target=reader, daemon=True).start()

    def pump(duration: float) -> None:
        """Feed pty output into the emulator for `duration` seconds."""
        end = time.time() + duration
        while True:
            remaining = end - time.time()
            if remaining <= 0:
                return
            try:
                chunk = q.get(timeout=remaining)
            except queue.Empty:
                return
            if chunk is None:
                return
            stream.feed(chunk)

    deadline = time.time() + args.timeout
    seen = False
    text = ""
    try:
        while time.time() < deadline and not seen:
            pump(0.1)
            seen = any(args.sentinel in line for line in screen.display)
        if seen:
            for payload in args.send:
                data = payload.encode("utf-8").decode("unicode_escape")
                proc.write(data)
                pump(args.send_delay)
            if args.resize_jiggle:
                proc.setwinsize(args.rows, args.cols - 1)
                screen.resize(args.rows, args.cols - 1)
                pump(0.6)
                proc.setwinsize(args.rows, args.cols)
                screen.resize(args.rows, args.cols)
                pump(0.6)
            pump(args.settle)
            if args.frames > 1:
                for i in range(args.frames):
                    t0 = time.time()
                    dump_frame(screen, args.rows, args.cols,
                               f"{args.out}-{i:03d}.json")
                    remaining = args.interval / 1000.0 - (time.time() - t0)
                    pump(max(remaining, 0.001))
            else:
                dump_frame(screen, args.rows, args.cols, args.out + ".json")
    finally:
        text = "\n".join(screen.display)
        with open(args.out + ".txt", "w", encoding="utf-8") as fh:
            fh.write(text)
        try:
            proc.terminate(force=True)
        except Exception:
            pass

    if not seen:
        sys.stderr.write(f"sentinel {args.sentinel!r} never appeared\n"
                         f"--- screen ---\n{text}\n")
        return 1
    n = args.frames if args.frames > 1 else 1
    print(f"captured {n} frame(s) {args.rows}x{args.cols} -> {args.out}*")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
