# H2 visual review artifacts (`e2e-pty-review/`)

PNG reconstructions of the compiled-binary PTY drive, for **human** visual review
of layout defects that char/substring asserts cannot see (clip, paint-over,
density, ellipsis walls).

## What lands here

| Artifact | Role |
|---|---|
| `MANIFEST.md` | Generated each run: cols/rows/profile, binary path + sha, theme, step table |
| `<step>.png` | One PNG per choreography step (boot → sessions → map → microscope → search → lens → leave) |

Char + styled-cell JSON still go to sibling `scripts/e2e-pty-frames/` (unchanged).

This directory is **gitignored** review output. Do not commit goldens unless a
later campaign opens a chrome-stable golden phase.

## How to produce

From the fork root:

```powershell
cd C:\Users\AlexMoyer\Documents\amore-build
python scripts/dash-e2e-pty.py --profile operator
python scripts/dash-e2e-pty.py --profile narrow
python scripts/dash-e2e-pty.py --profile tight
```

Useful flags:

| Flag | Default | Meaning |
|---|---|---|
| `--png` / `--no-png` | PNG on when fonts exist | Emit or skip review PNGs |
| `--review-dir DIR` | `scripts/e2e-pty-review/` | Where PNGs + MANIFEST go |
| `--profile` | `operator` | `operator` 140×48 · `narrow` 120×36 · `tight` 100×30 · `all` |
| `--cols` / `--rows` | profile | One-shot size override |
| `--font-size` | 18 | Review PNG glyph size (docs pipeline keeps 30) |
| `--skip-structural` | off | Char asserts only |

Env pins: `IRIS_E2E_COLS` / `IRIS_E2E_ROWS` override the active profile dimensions.

## How the operator reviews

1. Run H2 (exit 0 requires char + structural asserts green).
2. Open `MANIFEST.md`, then each PNG in step order.
3. **Reject** a visual change if Map legend is a noise wall, Microscope picker is
   an ellipsis wall, or any stage clips footer/chrome — even when char asserts PASS.
4. Structural JSON asserts (R5 chips+footer, R5b single-band advertising line,
   R6 path leak, R7 PNG presence) catch a subset of those defects automatically.
   Map legend/edge predicates are deferred until the map redesign lands.

## Pipeline

```
compiled iris-dash (winpty + pyte)
  → dump_frame → e2e-pty-frames/<step>.{txt,json}
  → render_frame_to_png (in-process) → e2e-pty-review/<step>.png
  → MANIFEST.md
```

Same font/cmap discipline as the docs capture path (`render_frame.py`); theme is
forced `horizon` via child env.
