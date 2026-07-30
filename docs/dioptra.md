# Dioptra companion

**Dioptra** is a first-class companion of Selene Build: the knowledge and
organization instrument for a house tree. It is **never required** to run
Selene Build itself. Install it when you want a live file index, org CRUD
verbs, and an interactive dash over the same scaffold `selene init` plants.

Local-first: the daemon and CLI operate on directories on your machine. There
is no product telemetry surface in dioptra.

In-tree sources live at [`instruments/dioptra/`](../instruments/dioptra/).
Package-level detail: [`instruments/dioptra/README.md`](../instruments/dioptra/README.md)
and the public-port notes in
[`instruments/dioptra/PORTING.md`](../instruments/dioptra/PORTING.md).

---

## What it is

Three surfaces share one product name:

| Surface | Role |
|---------|------|
| **Daemon** | Live org index on `127.0.0.1:3852` — recursive file watch, wikilink/backlink graph, fuzzy search (`/api/search`, index mode) |
| **CLI** (`dioptra`) | Org verbs powered by `@selene/regula` (`task`, `inbox`, `reminder`, `knowledge`, plus `status`, `search`, `daemon`, …) and daemon-backed reads |
| **Dash** (TUI) | OpenTUI interactive dashboard — Dashboard / Tasks / Inbox / Reminders / Knowledge / Files / Graph / Forge |

The public package ships the **full** regula org-verb surface (no gated subset).
Semantic-search backends and other dropped lineage surfaces are not in this
tree; see `PORTING.md` if you are comparing to an older private build.

### Common commands

```sh
dioptra                     # open the dash (when available)
dioptra dash                # same
dioptra daemon [--port N]   # start the index daemon (default 3852)
dioptra status              # orientation counts (daemon-independent)
dioptra task list --json
dioptra inbox list
dioptra reminder list
dioptra knowledge create --title "…"
dioptra search "query"      # fuzzy index search via the daemon
dioptra commands            # capability manifest
```

Org root resolution: `$DIOPTRA_ORG_ROOT` if set, else walk up from the cwd for
an orientation file (`AGENTS.md` / `AGENT.md` / `CLAUDE.md`) beside a `tasks/`
directory. Callers refuse a silent cwd fallback when no root resolves.

---

## Install

**No auto-download in v1.** Selene Build does not fetch dioptra for you. Install
manually (release asset or source), put the multi-tool on your `PATH`, then
optionally re-run `selene setup` so the companion pointer records detection.

### A. Release asset (recommended)

Public v0.1.0-style assets use the shape:

```
dioptra-{os}-{arch}          # multi-tool: CLI + regula verbs + Bun daemon (~99 MB)
dioptra-dash-{os}-{arch}     # optional separate OpenTUI dash (TTY required)
```

Examples: `dioptra-windows-x64`, `dioptra-linux-x64`, `dioptra-darwin-arm64`
(Windows multi-tool may ship with a `.exe` suffix). Place the multi-tool on
`PATH` as `dioptra`. If you also take the dash artifact, keep it beside the
multi-tool (or set `DIOPTRA_DASH_BIN`) so `dioptra dash` can re-exec it.

The multi-tool **includes** the full org-verb surface (`task` / `inbox` /
`reminder` / `knowledge`). The dash binary is optional and separate so the
multi-tool stays lean.

### B. Source build

Requires **Bun 1.3.x**. From this repository:

```sh
cd instruments/dioptra
bun install
bun run scripts/build-compile.ts              # CLI + daemon → dist/dioptra-{os}-{arch}
bun run scripts/build-compile.ts --with-dash  # also dist/dioptra-dash-{os}-{arch}
```

Escape hatch without compile (always works after `bun install`):

```sh
bun packages/cli/src/dioptra.ts daemon --port 3852 <org_root>
bun packages/cli/src/dioptra.ts task list --json
bun packages/tui/src/index.tsx                 # dash
# or: bun packages/cli/src/dioptra.ts dash
```

More detail: [`instruments/dioptra/README.md`](../instruments/dioptra/README.md).

---

## The Selene Build seam

Dioptra is optional at every layer. Absence is quiet.

### First-run / `selene setup`

`selene setup` is a three-step guided flow: K3 provider → Grok rail →
**Dioptra companion (recommended, opt-out)**. The interactive path can plant
the pointer file under the selene home:

```
~/.selene/dioptra-companion.toml
```

That file is a **pointer, not an install**. It records whether `dioptra` was
detected on `PATH` (and the expected asset shape when it was not). It does not
download or place a binary. Headless `selene setup` prints the step only and
does not plant unless you re-run interactively (or write the file yourself).

Separately, `selene init --with-dioptra` can plant a repo-local note at
`.selene/dioptra-companion.note.md` (also pointer-only; default is off). That
is not a substitute for installing dioptra.

### Shortcuts bar (when the companion is present)

When dioptra is installed and detected, the Selene Build TUI can surface a
shortcuts-bar hint that launches **`dioptra dash` in a new terminal**. The
action is **Ctrl+Shift+D** (label `dash`). The in-product shortcuts cheatsheet
is the source of truth if the binding ever moves.
When dioptra is **not** installed, that hint is **hidden**.

---

## Multi-tool behavior

The compiled multi-tool embeds CLI verbs and the daemon. It does **not** embed
OpenTUI.

| Invocation | Behavior |
|------------|----------|
| `dioptra` / `dioptra dash` | Re-execs a sibling dash binary when present (`dioptra-dash-*`, `DIOPTRA_DASH_BIN`, or short `dioptra-dash` names next to the multi-tool). Sets `DIOPTRA_DAEMON_BIN` to the multi-tool if unset so the dash can auto-spawn the daemon. |
| Same, no dash sibling | Prints the source-build / compile recipe to stderr and **exits 64**. |

Daemon defaults:

| Knob | Default |
|------|---------|
| Bind / port | `127.0.0.1:3852` |
| Env prefix | `DIOPTRA_*` (e.g. `DIOPTRA_PORT`, `DIOPTRA_URL`, `DIOPTRA_ORG_ROOT`, `DIOPTRA_DAEMON_BIN`, `DIOPTRA_ALLOW_FOREIGN_ROOT`, …) |
| Home / state | `~/.dioptra` (crash logs, `allowed-roots.json`, …) |

---

## Trust model (reads vs mutations)

Tiered foreign-root trust (current product model):

| Operation | Policy |
|-----------|--------|
| **Reads** (daemon index, search, graph, dash viewing) | Unguarded on any resolved org root — no house-marker requirement |
| **Mutations** (regula CRUD / lifecycle: create, complete, archive, …) | Require a **house root** (orientation doc + `tasks/`) **or** explicit opt-in |

House markers (same walk-up idea as org-root resolution): `AGENTS.md` or
`AGENT.md` or `CLAUDE.md` **and** a `tasks/` directory.

Mutation opt-in channels (any one suffices):

1. CLI flag `--allow-foreign-root`
2. Env `DIOPTRA_ALLOW_FOREIGN_ROOT=1` (also accepts `true` / `yes`)
3. Path listed in `~/.dioptra/allowed-roots.json` (interactive TTY confirm can plant this; non-interactive must use flag or env)

Every refusal names a one-line remedy. Writes go through `@selene/regula`; the
CLI calls `ensureMutationTrust` on write verbs before mutating.

**Honest current state:** org-root resolution via `DIOPTRA_ORG_ROOT` and the
CLI mutation trust seam are live today. Do not assume a richer dash-side trust
UX or automatic wiring beyond what the CLI/daemon already enforce — further
dash trust presentation is a follow-on, not a promised v1 surface.

---

## Pointer file

Path: **`~/.selene/dioptra-companion.toml`** (under `$SELENE_HOME` / `$GROK_HOME`
when those override the default home).

| Fact | Detail |
|------|--------|
| Who writes it | `selene setup` interactive step 3 (opt-out with skip) |
| What it is | Companion **pointer** config — detection / expected asset name |
| What it is not | An installer, a download cache, or a runtime dependency of Selene Build |
| Without dioptra | Selene Build runs normally; optional UI hint stays hidden |

Example shape (fields depend on PATH detection):

```toml
# Dioptra companion pointer — written by `selene setup` / first-run wizard.
# Dioptra is optional; this file is not an install.

[dioptra]
detected = false
expected_asset = "dioptra-linux-x64"
```

---

## See also

- [onboarding.md](onboarding.md) — what `selene init` installs; optional `--with-dioptra` note
- [setup-k3.md](setup-k3.md) — headline K3 model path (setup wizard step 1)
- [authentication.md](authentication.md) — OAuth vs BYOK rails (setup wizard step 2)
- [`instruments/dioptra/README.md`](../instruments/dioptra/README.md) — layout, env list, run recipes
- [`UPSTREAM.md`](../UPSTREAM.md) — fork delta summary (dioptra called out as companion)
