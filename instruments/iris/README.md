# iris

The messenger of an arcus house — the knowledge/org instrument.
*iris* (Ἶρις): in Homer the herald of the gods, who carries word between the far
and the near; her path between heaven and earth is the arc itself. The same name
belongs to the ring that admits light in every optical instrument. Both readings
name one function: fetching what is asked for, and regulating what gets through.
A Bun/TypeScript workspace: one daemon that owns the live org index, and clients
that read it. Write authority is `@arcus/regula`; every writer goes through it.

Public home of the instrument inside the `arcus-build` repo
(`instruments/iris/`). Packages keep the `@arcus/*` product identity.

## Layout

| Package | Role |
|---------|------|
| `packages/daemon` | The iris daemon (`127.0.0.1:3853`) — live org index (recursive file-watcher), wikilink/backlink resolver, graph (typed-edge merge, `?shape=v2`), fuzzy search |
| `packages/regula` | The write authority — org-document schema, legal lifecycle transitions, folder placement, lint. See its README for the charter |
| `packages/cli` | The product bin **`iris`** — org verbs + the span (bare `iris`) + daemon control |
| `packages/tui` | The OpenTUI dashboard (bare `iris` / `iris dash` opens it) — Dashboard / Tasks / Inbox / Reminders / Knowledge / Files / Forge / Graph (hotkeys `1`–`8`) |
| `packages/parity` | Golden-master parity harness (`parity record` / `parity replay`) used to verify the Bun daemon against a historical legacy daemon; still useful for self-replay |

Building from source and packaging: **[BUILD.md](BUILD.md)**. Foreign-root
trust is tiered: daemon reads work on any root; mutations need house markers or
`--allow-foreign-root` / `IRIS_ALLOW_FOREIGN_ROOT=1` / `~/.iris/allowed-roots.json`.

## Run

- `iris` — opens the dash (the span); auto-spawns the daemon on **3853** if nothing answers
- `iris <verb>` / `iris regula <verb>` — org CRUD (daemon-independent) + index reads (over the daemon)
- `iris daemon [--port]` — daemon standalone (default 3853)
- `bun packages/daemon/src/index.ts <org_root> --port 3853` — daemon without the CLI
- `bun install` then `bun test` at the workspace root — test sweep

Env: `IRIS_PORT` / `IRIS_URL` / `IRIS_ORG_ROOT` / `IRIS_TIMEOUT_MS` /
`IRIS_DAEMON_BIN` / `IRIS_WATCH_DEBOUNCE_MS` / `IRIS_THEME` /
`IRIS_TUI_DEBUG` / `IRIS_BROWSER` / `IRIS_ALLOW_FOREIGN_ROOT`.
State lives under `~/.iris` (including `allowed-roots.json` for mutation opt-in).

## History

An earlier Tauri/Rust tier (Axum daemon + React GUI/PWA) was archived in 2026-07
at the lineage sources. This tree is the Bun daemon + OpenTUI dash + regula write
core.
