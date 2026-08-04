# Amore Build — fork changelog

Amore Build is a permanent engineered fork of xAI's open-source grok-build
harness (Apache-2.0), by way of Selene Build. Upstream syncs land as periodic
monorepo sync commits; everything below is the fork's own delta, newest first.
This document is compiled into the binary — update it in the same change as the
work it describes.

## Unreleased

- **Iris lands on PATH with the house.** `amore init` now links the freshly
  installed companion binaries beside the running `amore` executable — if
  `amore` resolves on PATH, `iris` (and `iris dash`) now do too, with no
  shell-config or registry surgery on any platform. The planted `AGENTS.md`
  also teaches the resident agent the iris org verbs and the
  `iris regula lint` leave-step, so agent, CLI, and dash all write through
  the same regula authority.
- **Dash panels keep their titles under pressure.** Panel headers are pinned
  chrome now: a vertically squashed panel clips its body instead of painting
  the body over its own title (the interleaved-text artifact on the
  Dashboard's Recent Commits pane).
- **DeepSeek V4 Flash is the recommended model path.** The setup wizard's
  first slot writes `deepseek/deepseek-v4-flash-0731` over OpenRouter at the
  provider's reported completion ceiling; the GLM-5.2 recipes remain, and the
  docs are model-agnostic — every path is the same `[model.*]` primitive
  pointed at a different host (`docs/setup-models.md`).
- **Install one-liners.** `scripts/install.sh` and `scripts/install.ps1`
  fetch the newest release asset for the host, verify its published sha256,
  and install the binary with a rollback of any previous copy.
- **Iris installs with the house, and its daemon binds loopback only.**
  `amore init` downloads the companion into `instruments/iris/` by default
  (`--no-iris` opts out and makes init fully offline; a failed download never
  fails the house), and the index daemon now pins `127.0.0.1` — a local-first
  instrument should not listen on the LAN.
- **The aqueduct in quiet stone.** The welcome mark is a deck on an arcade of
  three arches, hue-banded as masonry with per-cell jitter, replacing the
  spectral bow. Both tiers regenerate from `scripts/gen_amore.py`; the shine
  sweep is unchanged and reads as a glint moving across stone.
- **The fork begins.** Cloned from Selene Build and re-branded end to end:
  `AMORE_*` environment primary with the upstream `GROK_*` chain intact as
  legacy aliases, `.amore` repo config with `.grok` as fallback, home at
  `~/.amore`, binary `amore`. Upstream's own `xai-grok-*` crate names are left
  alone — they name the vendor, not the product.
- **The identity is the house, not the model.** Every model entry the setup
  wizard writes carries `system_prompt_label = "Amore Build"`. Upstream
  resolves `You are <label>` from that field, and the obvious thing to put
  there is the model name — but a label naming the model becomes false the
  moment the model is swapped, and the config it sits in is per-model already.
  Naming the harness keeps the sentence true under every resident.
- **GLM-5.2 is the headline model path**, via OpenRouter (`z-ai/glm-5.2`) or
  Z.ai direct. Any OpenAI-compatible endpoint works; the wizard's third option
  takes a base URL, env key, and wire model id for anything else.
- **A rainbow where the logo goes.** The welcome art is a filled multi-band arc
  rasterized from real geometry (`scripts/gen_amore.py`), carrying a per-cell
  hue map so the existing shine sweep moves light *through* the colors rather
  than across a single gray. Two size tiers, still hidden outright on legacy
  Windows consoles, where the braille block has no glyphs.
- **The bundled knowledge instrument is `iris`** — daemon on `127.0.0.1:3853`,
  sole binary `iris`, offered as an opt-in step by `amore setup` and reachable
  from the harness with `Ctrl+Shift+G`.
- Inherited from Selene Build: guided first-run setup, `amore init` planting a
  complete agent house (AGENTS.md, context/tasks/inbox/knowledge scaffold,
  orchestration skills, hooks pack, principle lattice default-on), the native
  stop gate, and the hard-off auto-updater — a fork must not update itself back
  into upstream. Telemetry and feedback stay off by default.
