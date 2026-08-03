# Arcus Build — fork changelog

Arcus Build is a permanent engineered fork of xAI's open-source grok-build
harness (Apache-2.0), by way of Selene Build. Upstream syncs land as periodic
monorepo sync commits; everything below is the fork's own delta, newest first.
This document is compiled into the binary — update it in the same change as the
work it describes.

## Unreleased

- **The fork begins.** Cloned from Selene Build and re-branded end to end:
  `ARCUS_*` environment primary with the upstream `GROK_*` chain intact as
  legacy aliases, `.arcus` repo config with `.grok` as fallback, home at
  `~/.arcus`, binary `arcus`. Upstream's own `xai-grok-*` crate names are left
  alone — they name the vendor, not the product.
- **The identity is the house, not the model.** Every model entry the setup
  wizard writes carries `system_prompt_label = "Arcus Build"`. Upstream
  resolves `You are <label>` from that field, and the obvious thing to put
  there is the model name — but a label naming the model becomes false the
  moment the model is swapped, and the config it sits in is per-model already.
  Naming the harness keeps the sentence true under every resident.
- **GLM-5.2 is the headline model path**, via OpenRouter (`z-ai/glm-5.2`) or
  Z.ai direct. Any OpenAI-compatible endpoint works; the wizard's third option
  takes a base URL, env key, and wire model id for anything else.
- **A rainbow where the logo goes.** The welcome art is a filled multi-band arc
  rasterized from real geometry (`scripts/gen_arcus.py`), carrying a per-cell
  hue map so the existing shine sweep moves light *through* the colors rather
  than across a single gray. Two size tiers, still hidden outright on legacy
  Windows consoles, where the braille block has no glyphs.
- **The bundled knowledge instrument is `iris`** — daemon on `127.0.0.1:3853`,
  sole binary `iris`, offered as an opt-in step by `arcus setup` and reachable
  from the harness with `Ctrl+Shift+G`.
- Inherited from Selene Build: guided first-run setup, `arcus init` planting a
  complete agent house (AGENTS.md, context/tasks/inbox/knowledge scaffold,
  orchestration skills, hooks pack, principle lattice default-on), the native
  stop gate, and the hard-off auto-updater — a fork must not update itself back
  into upstream. Telemetry and feedback stay off by default.
