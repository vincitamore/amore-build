# Selene Build — fork changelog

Selene Build is a permanent personal fork of xAI's open-source grok-build
harness (Apache-2.0). Upstream syncs land as periodic monorepo sync commits;
everything below is the fork's own delta, newest first. This document is
compiled into the binary — update it in the same change as the work it
describes.

## 2026-07-30

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
  third-party Kimi paths) is a docs/wizard concern — the house's private
  model pin is not shipped as a compiled-in default.
- Telemetry and feedback off; auto-update off — a fork must not "update"
  back to upstream.
- Windows build fixes: protoc dep-probe `/dev/stdout` routing, `LNK1318`
  PDB-limit workaround (`/DEBUG:NONE`), 8 MiB stack reserve.
