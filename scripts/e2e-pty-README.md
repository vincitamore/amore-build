# H2 — Compiled-binary PTY drive (`dash-e2e-pty.py`)

Assert-driven end-to-end drive of the **real compiled** `iris-dash` binary over a Windows ConPTY (winpty + pyte). Companion to the H1 headless Shell walker (`instruments/iris/packages/tui/scripts/dash-e2e.tsx`).

| | H1 (primary gate) | H2 (this script) |
|---|---|---|
| Surface | React Shell via `createTestRenderer` | Native compiled `iris-dash-*.exe` in a real PTY |
| Speed / stability | Fast, deterministic enough for CI-ish gates | **Flaky-by-nature** (ConPTY races, winpty title-replay) |
| Role | Feature regression gate | Shipped-artifact confirmation |

## Requirements

- Python 3 with the same deps as `scripts/capture_frame.py`: **pyte**, **winpty** (`pywinpty`)
- Compiled dash binary, preferred order:
  1. `instruments/iris/dist/iris-dash-windows-x64.exe`
  2. `~/amore/bin/iris-dash-windows-x64.exe` (fallback; script prints which it drove)

No new Python packages beyond the capture pipeline.

## Run

From the repo root:

```powershell
cd C:\Users\AlexMoyer\Documents\amore-build
python scripts/dash-e2e-pty.py
```

Compile check:

```powershell
python -m py_compile scripts/dash-e2e-pty.py
```

Exit **0** only when every assertion PASSes. Any miss → exit **1** and a printed FAIL sheet. A finding is a finding — do not force green.

### Belt-and-suspenders re-run

Native PTY races and the winpty title-replay hazard can flake a single step. **Re-run once** on an isolated miss before treating it as a product bug. Two consecutive fails on the same assert = real.

## What it does

1. **Scratch env under `C:\Temp\iris-e2e-pty-*`** (path deliberately avoids the operator username so frames do not leak `C:\Users\<name>\…`):
   - Fake org: `AGENTS.md` + `tasks/` + `context/current-state.md` (dated section for Dashboard)
   - Synthetic **speculum v4** index (`PRAGMA user_version = 4`, schema aligned with `instruments/speculum/src/store/schema.sql`) with a handful of sessions/events + FTS rows
   - Child env: `IRIS_ORG_ROOT`, `SPECULUM_DB`, `SPECULUM_HOME`, `IRIS_THEME=horizon`, throwaway `USERPROFILE`/`HOME`/`AMORE_HOME`
2. **Launch** the compiled dash at **120×36** inside ConPTY.
3. **Choreograph + assert** (keys chosen to avoid the winpty title-replay shell/picker letters `t q v j k` where possible):
   - Boot → Dashboard/Sessions chrome
   - `S` → Sessions: status strip + five stage chips
   - `g` → Map: braille glyphs or map chrome
   - `w` then type `hello` (safe FTS token, no `t/q/v/j/k`) → hit row or honest empty
   - `L` → Lens picker selection row
   - Escape / `q` leave
4. **Frames** land in `scripts/e2e-pty-frames/<step>.txt` (+ `.json` cell dumps via `capture_frame.dump_frame`).
5. **Cleanup**: deletes the scratch tree on full PASS; **keeps it and prints the path** on any FAIL.

## Path leak rule

Shipped / committed frames must not contain absolute operator home paths (`C:\Users\<name>\…`). This harness seeds under `C:\Temp\…` so even raw dumps are clean. If you re-point `scratch` at a user-named temp, scrub frames before attaching them to docs.

## Reuse of `capture_frame.py`

- **Imports** `dump_frame` (the only top-level library primitive).
- **Does not modify** `capture_frame.py`.
- Reimplements the PTY loop (RespondingScreen, threaded read, pump, env keep-list, home-then-env order, unicode_escape sends, resize-jiggle) **in-process** so one continuous session can walk S→g→w→L. Subprocess-per-step would lose state between stages.

## Flakiness notes

| Hazard | Defense |
|--------|---------|
| Winpty replays console title as keystrokes (`t` opens theme picker invisibly) | Typed query uses only safe letters (`hello`); stage keys prefer `S p u m g w` |
| First key after mount swallowed | Double-send `S` |
| Static screen starves blocking `read` | Threaded reader + queue (same as capture_frame) |
| Sentinel never on screen at small cols | Fixed 120×36 so member bar shows names |
| Status/scan spawn latency | Per-step poll up to ~10s (boot ~45s) |
| Residual ConPTY layout dirt | Optional resize-jiggle after boot |

H1 remains the **primary** acceptance gate. If a step is genuinely un-stabilizable on this machine, report the exact failure rather than papering it over.
