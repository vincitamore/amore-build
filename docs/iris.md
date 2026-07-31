# Iris companion

**Iris** is a first-class companion of Arcus Build: the knowledge and
organization instrument for a house tree. It is **never required** to run
Arcus Build itself. Install it when you want a live file index, org CRUD
verbs, and an interactive dash over the same scaffold `arcus init` plants.

Local-first: the daemon and CLI operate on directories on your machine. There
is no product telemetry surface in iris.

In-tree sources live at [`instruments/iris/`](../instruments/iris/).
Package-level detail: [`instruments/iris/README.md`](../instruments/iris/README.md);
building from source: [`instruments/iris/BUILD.md`](../instruments/iris/BUILD.md).

---

## What it is

Three surfaces share one product name:

| Surface | Role |
|---------|------|
| **Daemon** | Live org index on `127.0.0.1:3853` — recursive file watch, wikilink/backlink graph, fuzzy search (`/api/search`, index mode) |
| **CLI** (`iris`) | Org verbs powered by `@arcus/regula` (`task`, `inbox`, `reminder`, `knowledge`, plus `status`, `search`, `daemon`, …) and daemon-backed reads |
| **Dash** (TUI) | OpenTUI interactive dashboard — Dashboard / Tasks / Inbox / Reminders / Knowledge / Files / Graph / Forge |

Iris ships the **full** regula org-verb surface — there is no gated subset.

### Common commands

```sh
iris                     # open the dash (when available)
iris dash                # same
iris daemon [--port N]   # start the index daemon (default 3853)
iris status              # orientation counts (daemon-independent)
iris task list --json
iris inbox list
iris reminder list
iris knowledge create --title "…"
iris search "query"      # fuzzy index search via the daemon
iris commands            # capability manifest
```

Org root resolution: `$IRIS_ORG_ROOT` if set, else walk up from the cwd for
an orientation file (`AGENTS.md` / `AGENT.md` / `CLAUDE.md`) beside a `tasks/`
directory. Callers refuse a silent cwd fallback when no root resolves.

---

## Install

**No auto-download in v1.** Arcus Build does not fetch iris for you. Install
manually (release asset or source), put the multi-tool on your `PATH`, then
optionally re-run `arcus setup` so the companion pointer records detection.

### A. Release asset (recommended)

Public v0.1.0-style assets use the shape:

```
iris-{os}-{arch}          # multi-tool: CLI + regula verbs + Bun daemon (~99 MB)
iris-dash-{os}-{arch}     # optional separate OpenTUI dash (TTY required)
```

Examples: `iris-windows-x64`, `iris-linux-x64`, `iris-darwin-arm64`
(Windows multi-tool may ship with a `.exe` suffix). Place the multi-tool on
`PATH` as `iris`. If you also take the dash artifact, keep it beside the
multi-tool (or set `IRIS_DASH_BIN`) so `iris dash` can re-exec it.

The multi-tool **includes** the full org-verb surface (`task` / `inbox` /
`reminder` / `knowledge`). The dash binary is optional and separate so the
multi-tool stays lean.

### B. Source build

Requires **Bun 1.3.x**. From this repository:

```sh
cd instruments/iris
bun install
bun run scripts/build-compile.ts              # CLI + daemon → dist/iris-{os}-{arch}
bun run scripts/build-compile.ts --with-dash  # also dist/iris-dash-{os}-{arch}
```

Escape hatch without compile (always works after `bun install`):

```sh
bun packages/cli/src/iris.ts daemon --port 3853 <org_root>
bun packages/cli/src/iris.ts task list --json
bun packages/tui/src/index.tsx                 # dash
# or: bun packages/cli/src/iris.ts dash
```

More detail: [`instruments/iris/README.md`](../instruments/iris/README.md).

---

## The Arcus Build seam

Iris is optional at every layer. Absence is quiet.

### First-run / `arcus setup`

`arcus setup` is a three-step guided flow: K3 provider → Grok rail →
**Iris companion (recommended, opt-out)**. The interactive path can plant
the pointer file under the arcus home:

```
~/.arcus/iris-companion.toml
```

That file is a **pointer, not an install**. It records whether `iris` was
detected on `PATH` (and the expected asset shape when it was not). It does not
download or place a binary. Headless `arcus setup` prints the step only and
does not plant unless you re-run interactively (or write the file yourself).

Separately, `arcus init --with-iris` can plant a repo-local note at
`.arcus/iris-companion.note.md` (also pointer-only; default is off). That
is not a substitute for installing iris.

### Shortcuts bar (when the companion is present)

When iris is installed and detected, the Arcus Build TUI can surface a
shortcuts-bar hint that launches **`iris dash` in a new terminal**. The
action is **Ctrl+Shift+D** (label `dash`). The in-product shortcuts cheatsheet
is the source of truth if the binding ever moves.
When iris is **not** installed, that hint is **hidden**.

---

## Multi-tool behavior

The compiled multi-tool embeds CLI verbs and the daemon. It does **not** embed
OpenTUI.

| Invocation | Behavior |
|------------|----------|
| `iris` / `iris dash` | Re-execs a sibling dash binary when present (`iris-dash-*`, `IRIS_DASH_BIN`, or short `iris-dash` names next to the multi-tool). Sets `IRIS_DAEMON_BIN` to the multi-tool if unset so the dash can auto-spawn the daemon. |
| Same, no dash sibling | Prints the source-build / compile recipe to stderr and **exits 64**. |

Daemon defaults:

| Knob | Default |
|------|---------|
| Bind / port | `127.0.0.1:3853` |
| Env prefix | `IRIS_*` (e.g. `IRIS_PORT`, `IRIS_URL`, `IRIS_ORG_ROOT`, `IRIS_DAEMON_BIN`, `IRIS_ALLOW_FOREIGN_ROOT`, …) |
| Home / state | `~/.iris` (crash logs, `allowed-roots.json`, …) |

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
2. Env `IRIS_ALLOW_FOREIGN_ROOT=1` (also accepts `true` / `yes`)
3. Path listed in `~/.iris/allowed-roots.json` (interactive TTY confirm can plant this; non-interactive must use flag or env)

Every refusal names a one-line remedy. Writes go through `@arcus/regula`; the
CLI calls `ensureMutationTrust` on write verbs before mutating.

**Honest current state:** org-root resolution via `IRIS_ORG_ROOT` and the
CLI mutation trust seam are live today. Do not assume a richer dash-side trust
UX or automatic wiring beyond what the CLI/daemon already enforce — further
dash trust presentation is a follow-on, not a promised v1 surface.

---

## Pointer file

Path: **`~/.arcus/iris-companion.toml`** (under `$ARCUS_HOME` / `$GROK_HOME`
when those override the default home).

| Fact | Detail |
|------|--------|
| Who writes it | `arcus setup` interactive step 3 (opt-out with skip) |
| What it is | Companion **pointer** config — detection / expected asset name |
| What it is not | An installer, a download cache, or a runtime dependency of Arcus Build |
| Without iris | Arcus Build runs normally; optional UI hint stays hidden |

Example shape (fields depend on PATH detection):

```toml
# Iris companion pointer — written by `arcus setup` / first-run wizard.
# Iris is optional; this file is not an install.

[iris]
detected = false
expected_asset = "iris-linux-x64"
```

---

## See also

- [onboarding.md](onboarding.md) — what `arcus init` installs; optional `--with-iris` note
- [setup-glm.md](setup-glm.md) — headline model path (setup wizard step 1)
- [authentication.md](authentication.md) — OAuth vs BYOK rails (setup wizard step 2)
- [`instruments/iris/README.md`](../instruments/iris/README.md) — layout, env list, run recipes
- [`UPSTREAM.md`](../UPSTREAM.md) — fork delta summary (iris called out as companion)
