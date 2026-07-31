# Arcus Build — fork changelog

Arcus Build is a permanent engineered fork of xAI's open-source grok-build
harness (Apache-2.0). Upstream syncs land as periodic monorepo sync commits;
everything below is the fork's own delta, newest first. This document is
compiled into the binary — update it in the same change as the work it
describes.

## 2026-07-30 — v0.1.0

- **First public release.** The Kimi-K3 cooperation harness, with native grok
  subagent freight. Guided first-run setup (K3 provider paths first, grok
  native second, iris companion offered), `arcus init` planting a complete
  agent house (AGENTS.md, context/tasks/inbox/knowledge scaffold, seven
  orchestration skills, hooks pack, principle lattice default-on), `.arcus`
  config semantics with `.grok` legacy fallback, `ARCUS_*` environment
  primary, and the `Ctrl+Shift+D` iris companion seam. Auto-update is hard
  off; telemetry and feedback default off.
- **Repo-self references restored** — the compiled manual-update message now
  names the GitHub Releases URL; README links the clone URL and Releases
  page; SECURITY.md links the private-advisory form (repo-self-URL exception
  in the forbid gate: the product's own public URL is allowed).
- **Identity sweep: command spellings, paths, product-name surfaces** —
  user-visible command references in help and errors now say `arcus`
  (`arcus login` / `arcus setup` / `arcus wrap` / …), home paths point to
  `~/.arcus/`, and product-name surfaces re-voice to Arcus Build: folder
  trust warning, minimal-mode welcome title, OAuth callback page text,
  built-in agent descriptions, billing/account copy (purchase and entitlement
  wording names xAI factually), and the feedback acknowledgement.
- **Iris TUI companion seam** — when Iris is on PATH or pointed at by
  `~/.arcus/iris-companion.toml` (from `arcus setup`), the shortcuts bar
  shows a `dash` hint (Ctrl+Shift+D). The binding opens `iris dash` in a
  **new OS terminal** (Windows Terminal / `cmd start` / PowerShell; macOS
  Terminal via osascript; Linux `$TERMINAL` then common emulators) — never
  inside the TUI. When Iris is absent the hint is hidden and the key does
  nothing. Detection is session-cached (no PATH scan per keypress).
- **Doctor header re-voice** — human `arcus doctor` header reads
  `Arcus Doctor` (was `Grok Doctor`).
- **Setup wizard hardening** — atomic `config.toml` write (temp+rename);
  `--dry-run` creates no home dirs; `arcus setup --force` re-runs past
  done/skipped state; `[agent] setup_on_first_run` is a typed config field
  (no unrecognized-key warning).
- **First-run setup wizard + `arcus setup`** — auto-guided TUI on first
  interactive launch when no credentials resolve (no `auth.json` session, no
  `XAI_API_KEY`, no resolvable config `[model.*]` key). Steps: K3 provider
  (OpenRouter → Moonshot → open-weight host), Grok native rail
  (`arcus login` / `XAI_API_KEY`), Iris companion pointer (recommended,
  opt-out; release asset shape `iris-{os}-{arch}`, no auto-download in v1).
  Never fires headless (`-p`/piped), in CI, when
  `[agent] setup_on_first_run = false`, or after wizard state is done/skipped
  under `~/.arcus`. Explicit path: `arcus setup` (headless prints steps);
  `--reset` clears state; team managed config moved to `arcus setup --managed`
  (legacy `arcus setup --json` still works).
- **`ARCUS_*` env identity layer** — product env vars resolve as `ARCUS_*`
  primary with `GROK_*` as silent legacy aliases (`ARCUS_HOME`,
  `ARCUS_DEFAULT_MODEL`, `ARCUS_SYSTEM_PROMPT_LABEL`, `ARCUS_AUTH_*`,
  `ARCUS_SHELL`, `ARCUS_CAMPAIGNS`, `ARCUS_CLI_*`, managed-config TTL /
  fail-closed, etc.). Provider keys (`XAI_API_KEY`, `XAI_*`) stay unaliased.
  Default home remains `~/.arcus` when unset.
- **SessionStart hook `additionalContext`** — Observe-mode SessionStart hooks
  that emit `hookSpecificOutput.additionalContext` now inject that text into
  the session conversation (system-reminder), so house session-init hooks can
  surface due reminders / orientation. `.arcus/hooks` discovery parity with
  `.grok/hooks` verified.
- **Binary rename to `arcus`** — public CLI artifact is `arcus` (repo
  remains `arcus-build`). argv0 multi-call tolerates `arcus`,
  `arcus-build`, `grok`, and `agent`. Version output names `arcus` (commit
  stamp preserved).
- **PATH-collision doctor check** — `arcus doctor --json` always includes a
  `pathCollision` probe; warns when another `arcus` on PATH (e.g. the
  crates.io Lua linter) would shadow Arcus Build.
- **Default system-prompt label** is now `Arcus Build` (still overridable
  per-model via `system_prompt_label` / env).
- **Auto-update hard-off** — this fork never self-updates back to upstream.
  Config key `cli.auto_update` is still parsed for file compat but always
  reads as false; the `update` surface points operators at the arcus-build
  GitHub Releases page (no xAI reinstall hints).
- **Dual-rail auth verified** — BYOK (`XAI_API_KEY` or config `api_key` /
  provider `base_url`) works with no OAuth grant / auth file; not hard-walled
  behind interactive login.
- **`arcus init`** — offline install of the embedded cooperation harness
  (`templates/house/`) into any git repo. Ownership-aware: never silently
  overwrites; `--refresh` only rewrites files still matching the install
  manifest (`.arcus/house-install.json`); `--force` overwrites with confirm
  (or `--yes`). Lattice is default-on (`--no-lattice` opt-out); skills
  default-on (`--no-skills`); iris pointer note opt-in (`--with-iris`).
  Registers project `.arcus/hooks` in the global `hooks-paths` registry.
  Flags: `--dry-run`, `--yes`, `--skills`/`--no-skills`, `--hooks`/`--no-hooks`,
  `--no-lattice`, `--with-iris`/`--no-iris`.
- **`.arcus` config-dir semantics** — the fork's native repo config dir is
  `.arcus` at every surface upstream reads `.grok`: `skills/` + `commands/`,
  `rules/`, `hooks/`, `workflows/`, `agents/`, `plugins/` (project tier,
  folder-trust gated as before), plus user-tier `~/.grok/skills` scanned as a
  legacy fallback. Precedence: `.arcus` outranks `.grok` everywhere; `.grok`
  stays working for upstream-format repos and the upstream-grok freight lane.
- **Honest identity**: the system-prompt template no longer hardcodes
  "released by xAI" — identity comes wholly from `system_prompt_label`
  (per-model in `config.toml`; env `GROK_SYSTEM_PROMPT_LABEL` overrides).
  Per-model labels can introduce third-party model identities without
  role-playing the default.
- **Arcus crescent** welcome logo — geometric braille moon and sparkle
  rasterized from real geometry (`scripts/gen_crescent.py`), both size tiers.
- Fork-local changelog: the welcome screen and `/release-notes` now read this
  compiled-in document instead of fetching xAI's CDN feed.
- **Native Windows**: pty-harness test-support import gated `cfg(unix)` so
  the full test closure compiles on Windows; `parse_login_env_capture` tests
  gated to match their `cfg(unix)` helper (same upstream Windows-blindness
  class).

## 2026-07-29

- Forked from `xai-org/grok-build`. Identity pass: Arcus Build branding,
  `arcus` theme (truecolor), compiled-in home `~/.arcus`.
- Multi-provider BYOK substrate retained; first-run model setup (including
  third-party Kimi paths) is a docs/wizard concern — private model pins are
  not shipped as compiled-in defaults.
- Telemetry and feedback off; auto-update off — a fork must not "update"
  back to upstream.
- Windows build fixes: protoc dep-probe `/dev/stdout` routing, `LNK1318`
  PDB-limit workaround (`/DEBUG:NONE`), 8 MiB stack reserve.
