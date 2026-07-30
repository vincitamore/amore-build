# Selene Build — fork changelog

Selene Build is a permanent personal fork of xAI's open-source grok-build
harness (Apache-2.0). Upstream syncs land as periodic monorepo sync commits;
everything below is the fork's own delta, newest first. This document is
compiled into the binary — update it in the same change as the work it
describes.

## 2026-07-30

- **`selene init`** — offline install of the embedded cooperation harness
  (`templates/house/`) into any git repo. Ownership-aware: never silently
  overwrites; `--refresh` only rewrites files still matching the install
  manifest (`.selene/house-install.json`); `--force` overwrites with confirm
  (or `--yes`). Lattice is default-on (`--no-lattice` opt-out); skills
  default-on (`--no-skills`); dioptra pointer note opt-in (`--with-dioptra`).
  Registers project `.selene/hooks` in the global `hooks-paths` registry.
  Flags: `--dry-run`, `--yes`, `--skills`/`--no-skills`, `--no-lattice`,
  `--with-dioptra`/`--no-dioptra`.
- **`.selene` config-dir semantics** — the fork's native repo config dir is
  `.selene` at every surface upstream reads `.grok`: `skills/` + `commands/`,
  `rules/`, `hooks/`, `workflows/`, `agents/`, `plugins/` (project tier,
  folder-trust gated as before), plus user-tier `~/.grok/skills` scanned as a
  legacy fallback. Precedence: `.selene` outranks `.grok` everywhere; `.grok`
  stays working for upstream-format repos and the upstream-grok freight lane.
- **Honest identity**: the system-prompt template no longer hardcodes
  "released by xAI" — identity comes wholly from `system_prompt_label`
  (per-model in `config.toml`; env `GROK_SYSTEM_PROMPT_LABEL` overrides).
  `selene-k3` now introduces itself as Kimi K3 instead of role-playing Grok.
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
- **Kimi K3 (Modal)** wired as the compiled-in default model (`selene-k3`,
  1M context window).
- Telemetry and feedback off; auto-update off — a fork must not "update"
  back to upstream.
- Windows build fixes: protoc dep-probe `/dev/stdout` routing, `LNK1318`
  PDB-limit workaround (`/DEBUG:NONE`), 8 MiB stack reserve.
