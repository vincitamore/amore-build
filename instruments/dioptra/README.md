# dioptra

The sight through which a selene house is seen — the knowledge/org instrument.
*dioptra* (δίοπτρα): the ancient Greek sighting/surveying instrument (Heron of
Alexandria); through-sight. A Bun/TypeScript workspace: one daemon that owns the
live org index, and clients that read it. Write authority is `@selene/regula`;
every writer goes through it.

Public home of the instrument inside the `selene-build` repo
(`instruments/dioptra/`). Packages keep the `@selene/*` product identity.

## Layout

| Package | Role |
|---------|------|
| `packages/daemon` | The dioptra daemon (`127.0.0.1:3852`) — live org index (recursive file-watcher), wikilink/backlink resolver, graph (typed-edge merge, `?shape=v2`), fuzzy search |
| `packages/regula` | The write authority — org-document schema, legal lifecycle transitions, folder placement, lint. See its README for the charter |
| `packages/cli` | Sole global bin **`dioptra`** — org verbs + sight + daemon control |
| `packages/tui` | The OpenTUI dashboard (bare `dioptra` / `dioptra dash` opens it) — Dashboard / Tasks / Inbox / Reminders / Knowledge / Files / Graph / Forge |
| `packages/parity` | Golden-master parity harness (`parity record` / `parity replay`) used to verify the Bun daemon against a historical legacy daemon; still useful for self-replay |
| `patches/` | pnpm patched dependencies (`@opentui/core` UAF mitigation) + the opentui.dll native fix |

See **PORTING.md** for what the public port dropped (lineage residual surfaces)
and known follow-on debts (OpenTUI native, foreign-root guard, install story).

## Run

- `dioptra` — opens the dash (the sight); auto-spawns the daemon on **3852** if nothing answers
- `dioptra <verb>` / `dioptra regula <verb>` — org CRUD (daemon-independent) + index reads (over the daemon)
- `dioptra daemon [--port]` — daemon standalone (default 3852)
- `bun packages/daemon/src/index.ts <org_root> --port 3852` — daemon without the CLI
- `bun install` then `bun test` at the workspace root — test sweep

Env: `DIOPTRA_PORT` / `DIOPTRA_URL` / `DIOPTRA_ORG_ROOT` / `DIOPTRA_TIMEOUT_MS` /
`DIOPTRA_DAEMON_BIN` / `DIOPTRA_WATCH_DEBOUNCE_MS` / `DIOPTRA_THEME` /
`DIOPTRA_TUI_DEBUG` / `DIOPTRA_BROWSER`. State lives under `~/.dioptra`.

## History

An earlier Tauri/Rust tier (Axum daemon + React GUI/PWA) was archived in 2026-07
at the lineage sources. This tree is the Bun daemon + OpenTUI dash + regula write
core.
