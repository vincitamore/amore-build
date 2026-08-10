# scripts/ — headless dash E2E

## `dash-e2e.tsx`

Headless end-to-end driver of the **real** Iris dash `Shell` focused on the Sessions surface. This is the machine-verifiable acceptance gate for the sessions workstream: render the real shell, drive every Sessions stage by key, dump char frames, assert, and exit non-zero on any failure.

### Run

From `packages/tui`:

```powershell
$env:IRIS_ORG_ROOT = "C:\Users\AlexMoyer\Documents\amore"   # default if unset
bun run scripts/dash-e2e.tsx
```

Requires:

- Bun
- `@opentui/*` as already installed by the package (no extra deps)
- `speculum` on PATH for the honest installed path (otherwise the status strip reports not-installed and related asserts fail)
- Real org root + `~/.amore` index (the operator's machine)

### What it drives

1. Boot 120×40 → `S` Sessions → chips / status strip / probes board
2. Probe hits (`Enter`/`h`) → Usage (`u`)
3. Microscope (`m`) → Enter timeline
4. Map (`g`)
5. Search (`w`) → type `the` → Escape
6. Lens (`L`) → Enter dry-run of `session-postmortem --last-n 5` against the **real** index (one designed dry-run audit line)
7. Multi-size re-render at 80×24 and 100×30; chip-row + footer integrity at 80×24
8. Topology dump of `~/.amore/sessions` (one level) for the count dispute

### Outputs

| Path | Content |
|------|---------|
| `scripts/e2e-frames/<step>.txt` | Char frame per step |
| `scripts/e2e-sessions-topology.txt` | Top-level cwd dirs + counts + newest 3 session ids + grand total |

### Assertion sheet

Prints `name: bool` per assertion and ends with `ALL PASS` or `FAILURES: n`. Exit `0` only on all pass; exit `1` on assertion failures (a **finding**, not a harness bug); exit `2` on crash.

Do **not** loosen asserts to force green — failed asserts are the product signal this harness exists to surface.

### Pattern

Matches the house `/tui` §4 frame-dump walker: `createTestRenderer` + `createRoot` + `ThemeProvider` + `createMockKeys` + settle-then-assert (`setTimeout` then `renderOnce` + `captureCharFrame`). Same path as `src/shell/shell-smoke.tsx` / `src/members/sessions-smoke.tsx` at OpenTUI 0.4.5.
