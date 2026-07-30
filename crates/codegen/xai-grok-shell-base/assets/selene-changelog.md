# Selene Build — fork changelog

Selene Build is a permanent engineered fork of xAI's open-source grok-build
harness (Apache-2.0). Upstream syncs land as periodic monorepo sync commits;
everything below is the fork's own delta, newest first. This document is
compiled into the binary — update it in the same change as the work it
describes.

## 2026-07-30

- **Dioptra TUI companion seam** — when Dioptra is on PATH or pointed at by
  `~/.selene/dioptra-companion.toml` (from `selene setup`), the shortcuts bar
  shows a `dash` hint (Ctrl+Shift+D). The binding opens `dioptra dash` in a
  **new OS terminal** (Windows Terminal / `cmd start` / PowerShell; macOS
  Terminal via osascript; Linux `$TERMINAL` then common emulators) — never
  inside the TUI. When Dioptra is absent the hint is hidden and the key does
  nothing. Detection is session-cached (no PATH scan per keypress).
- **Doctor header re-voice** — human `selene doctor` header reads
  `Selene Doctor` (was `Grok Doctor`).
- **Setup wizard hardening** — atomic `config.toml` write (temp+rename);
  `--dry-run` creates no home dirs; `selene setup --force` re-runs past
  done/skipped state; `[agent] setup_on_first_run` is a typed config field
  (no unrecognized-key warning).
- **First-run setup wizard + `selene setup`** — auto-guided TUI on first
  interactive launch when no credentials resolve (no `auth.json` session, no
  `XAI_API_KEY`, no resolvable config `[model.*]` key). Steps: K3 provider
  (OpenRouter → Moonshot → open-weight host), Grok native rail
  (`selene login` / `XAI_API_KEY`), Dioptra companion pointer (recommended,
  opt-out; release asset shape `dioptra-{os}-{arch}`, no auto-download in v1).
  Never fires headless (`-p`/piped), in CI, when
  `[agent] setup_on_first_run = false`, or after wizard state is done/skipped
  under `~/.selene`. Explicit path: `selene setup` (headless prints steps);
  `--reset` clears state; team managed config moved to `selene setup --managed`
  (legacy `selene setup --json` still works).
- **`SELENE_*` env identity layer** — product env vars resolve as `SELENE_*`
  primary with `GROK_*` as silent legacy aliases (`SELENE_HOME`,
  `SELENE_DEFAULT_MODEL`, `SELENE_SYSTEM_PROMPT_LABEL`, `SELENE_AUTH_*`,
  `SELENE_SHELL`, `SELENE_CAMPAIGNS`, `SELENE_CLI_*`, managed-config TTL /
  fail-closed, etc.). Provider keys (`XAI_API_KEY`, `XAI_*`) stay unaliased.
  Default home remains `~/.selene` when unset.
- **SessionStart hook `additionalContext`** — Observe-mode SessionStart hooks
  that emit `hookSpecificOutput.additionalContext` now inject that text into
  the session conversation (system-reminder), so house session-init hooks can
  surface due reminders / orientation. `.selene/hooks` discovery parity with
  `.grok/hooks` verified.
- **Binary rename to `selene`** — public CLI artifact is `selene` (repo
  remains `selene-build`). argv0 multi-call tolerates `selene`,
  `selene-build`, `grok`, and `agent`. Version output names `selene` (commit
  stamp preserved).
- **PATH-collision doctor check** — `selene doctor --json` always includes a
  `pathCollision` probe; warns when another `selene` on PATH (e.g. the
  crates.io Lua linter) would shadow Selene Build.
- **Default system-prompt label** is now `Selene Build` (still overridable
  per-model via `system_prompt_label` / env).
- **Auto-update hard-off** — this fork never self-updates back to upstream.
  Config key `cli.auto_update` is still parsed for file compat but always
  reads as false; the `update` surface points operators at the selene-build
  GitHub Releases page (no xAI reinstall hints).
- **Dual-rail auth verified** — BYOK (`XAI_API_KEY` or config `api_key` /
  provider `base_url`) works with no OAuth grant / auth file; not hard-walled
  behind interactive login.
- **`selene init`** — offline install of the embedded cooperation harness
  (`templates/house/`) into any git repo. Ownership-aware: never silently
  overwrites; `--refresh` only rewrites files still matching the install
  manifest (`.selene/house-install.json`); `--force` overwrites with confirm
  (or `--yes`). Lattice is default-on (`--no-lattice` opt-out); skills
  default-on (`--no-skills`); dioptra pointer note opt-in (`--with-dioptra`).
  Registers project `.selene/hooks` in the global `hooks-paths` registry.
  Flags: `--dry-run`, `--yes`, `--skills`/`--no-skills`, `--hooks`/`--no-hooks`,
  `--no-lattice`, `--with-dioptra`/`--no-dioptra`.
- **`.selene` config-dir semantics** — the fork's native repo config dir is
  `.selene` at every surface upstream reads `.grok`: `skills/` + `commands/`,
  `rules/`, `hooks/`, `workflows/`, `agents/`, `plugins/` (project tier,
  folder-trust gated as before), plus user-tier `~/.grok/skills` scanned as a
  legacy fallback. Precedence: `.selene` outranks `.grok` everywhere; `.grok`
  stays working for upstream-format repos and the upstream-grok freight lane.
- **Honest identity**: the system-prompt template no longer hardcodes
  "released by xAI" — identity comes wholly from `system_prompt_label`
  (per-model in `config.toml`; env `GROK_SYSTEM_PROMPT_LABEL` overrides).
  Per-model labels can introduce third-party model identities without
  role-playing the default.
- **Selene crescent** welcome logo — geometric braille moon and sparkle
  rasterized from real geometry (`scripts/gen_crescent.py`), both size tiers.
- Fork-local changelog: the welcome screen and `/release-notes` now read this
  compiled-in document instead of fetching xAI's CDN feed.
- **Native Windows**: pty-harness test-support import gated `cfg(unix)` so
  the full test closure compiles on Windows; `parse_login_env_capture` tests
  gated to match their `cfg(unix)` helper (same upstream Windows-blindness
  class).

## 2026-07-29

- Forked from `xai-org/grok-build`. Identity pass: Selene Build branding,
  `selene` theme (truecolor), compiled-in home `~/.selene`.
- Multi-provider BYOK substrate retained; first-run model setup (including
  third-party Kimi paths) is a docs/wizard concern — private model pins are
  not shipped as compiled-in defaults.
- Telemetry and feedback off; auto-update off — a fork must not "update"
  back to upstream.
- Windows build fixes: protoc dep-probe `/dev/stdout` routing, `LNK1318`
  PDB-limit workaround (`/DEBUG:NONE`), 8 MiB stack reserve.
