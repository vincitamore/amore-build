# Amore Build — fork changelog

Amore Build is a permanent engineered fork of xAI's open-source grok-build
harness (Apache-2.0), by way of Selene Build. Upstream syncs land as periodic
monorepo sync commits; everything below is the fork's own delta, newest first.
This document is compiled into the binary — update it in the same change as the
work it describes.

## Unreleased

- **Horizon theme** — the pager gains the iris app's default palette as a
  selectable theme (`/theme horizon`): a rose brand accent with green success
  and cyan information on the dark `#1c1e26` ground.

## v1.0.1

Amore Build 1.0 — the first major release. Two headline surfaces land
together: a Sessions member that makes the working record navigable, and an
integrated update path that keeps an installation current from this fork's
own releases. Version numbering follows the upstream line, which crossed
1.0 in the same window.

- **The Sessions member, at full depth.** The iris dash now carries the
  whole session corpus: a microscope with honest full-corpus navigation
  (filters, sort, parentage jumps, in-session search) and a turn-level
  detail pane that actually magnifies; probes with scope controls, trend
  sparklines, and per-probe methodology detail; a session map that draws
  real evidence — resume lineage and shared-artifact edges — with a time
  axis and hover readouts; search filter chips, usage windows, and lens
  reports rendered readable. Sessions gain generated one-line titles from
  a cheap opt-in summarizer, so the picker reads as a record instead of a
  wall of id prefixes.
- **`amore update`, end to end.** A default-on, kill-switchable version
  check (24-hour cadence, zero-quota redirect probe) surfaces a welcome
  tip; Ctrl+U or `amore update` applies a fleet transaction that moves
  `amore` and every installed companion to the same tag together —
  sidecar-verified digests, staging smoke before activation, an exclusive
  lock, content-addressed skip so unchanged targets download nothing, and
  `--rollback` restoring the previous binaries and config beside them.
  `amore doctor` reports install state and fleet coherence. Apply is
  always user-initiated; there is no unattended install path.
- **The update origin is locked.** Updates come only from this
  repository's releases: the origin is named in exactly one module,
  verify-pinned, and the inherited upstream installer paths stay
  hard-off behind guarded, tested refusals. Companions now report their
  release tag, so staleness is visible instead of silent.
- **Supply-chain and startup hardening.** Every workflow action is
  SHA-pinned with automated update review; the release pipeline smokes
  its installers against real published assets and the released binaries
  prove their own update surface on all five targets; a remote
  deployment-config response can no longer prevent the binary from
  starting.

## v0.3.1

A reliability and hygiene patch on the v0.3.0 line, driven by a verified
defect campaign. The headline: agent turns and scheduled work no longer break
or get lost, and failures become traceable.

- **Agent turns are more reliable.** A streamed delta that carries more than
  one spelling of the reasoning trace in the same message used to terminate
  the whole turn; it no longer does. A zero-output length stop is now treated
  as input overflow and routes to compaction instead of a misleading
  "Response truncated by max_tokens." A model-backend switch strips foreign
  reasoning signatures on the switch turn, so the next turn stops hard-failing.
- **Scheduled and background work survives a disconnect.** A session that
  still holds scheduled tasks or running background work is no longer evicted
  as idle, so an agent-created obligation is not destroyed when you disconnect.
- **Leader control tolerates mixed protocol versions.** Control now enforces a
  per-command minimum protocol floor instead of exact equality, so a future
  protocol bump becomes a soft tolerance rather than a fleet-wide cutover.
- **Failures are traceable.** An unknown model's context window warns and
  surfaces once instead of silently assuming a 256k/200k default that over-runs
  small local models. The provider request-id is captured and logged on every
  failed response so a bad turn can be correlated in support.
- **Cost and config hardening.** Cache-write tokens are now counted. An
  out-of-list reasoning effort clamps to the nearest declared option. Action
  chord collisions are reported instead of silently first-winning.
- **Rendering is grapheme-aware.** Width and truncate no longer cut flags or
  emoji families mid-glyph.
- **Housekeeping.** The unenforced `allowed_tools` skill field is removed; the
  iris TUI dependencies are pinned to named floors; CI now smokes both
  canonical installers.

## v0.3.0

- **The house keeps itself.** Lucerna, the opt-in house steward, gains
  agentic maintenance dreams: governed sessions through your own model
  configuration that survey the house, refresh its graph and search
  index, and write reports and proposals for review. Web tools are
  disabled on maintenance spawns, every spawn runs under a wall-clock
  kill, budgets and token metering come from real usage envelopes, writes
  are default-deny, and nothing is enabled until the operator flips it —
  `amore init --with-lucerna` to install, dreams off by default,
  auto-commit dry-run.
- **Semantic search sets itself up.** `amore init` now runs
  `iris qmd setup` after installing iris: a pinned qmd runtime under
  `~/.amore/instruments/qmd/`, per-house collections, and full hybrid
  search (BM25 + embeddings + query expansion + rerank) as the default
  tier. The iris daemon keeps the index fresh as the tree changes, so
  nobody has to remember an update step; `--no-qmd` skips it all. Fuzzy,
  content, and semantic modes ride the dash palette, the CLI, and the
  API.
- **The review loop closes in the dash.** The Lucerna tab lists dreams
  and proposals pending-first, opens a full reading overlay with rendered
  markdown (a manifest and its linked report read as one), and flips
  review status byte-exact from the TUI or the CLI. The Dashboard pulse
  carries the pending-review count, and the Forge view groups dream
  artifacts by pipeline.
- **The typed-edge graph gains agentic tiers.** `iris edges update
  --tier 2` runs a generate-and-judge pass through a headless `amore`
  spawn with a quote-validity gate before any edge lands live. Every edge
  carries its tier and provenance; stewardship stays after the fact —
  list, show, edit, remove, with removals durable across re-derives.
- **Iris moves home.** Client state now lives at
  `~/.amore/instruments/iris/` beside the other companions. A legacy
  `~/.iris` is copied over automatically on first run — verified, marked,
  never deleted — and `IRIS_HOME` overrides everything. `iris --version`
  answers with a version now, too.
- **Doctor covers the companions.** A new instruments section reports
  iris / lucerna / speculum presence and version, honest enablement
  state, and the managed search stack (qmd runtime, models, house index,
  js runtime), taking version facts only from version-shaped output.
- **Init refuses to nest houses.** Bare `amore init` inside an existing
  house is refused rather than planting a house-inside-a-house;
  `amore init .` adopts a pre-manifest house without overwriting
  customized files, and opting out of iris keeps init quiet about the
  features that ride along with it.
- **The autonomy story is documented and receipted.** `docs/autonomy.md`
  states every default an operator can verify; `docs/egress.md`
  inventories every instrument network touchpoint; and
  `scripts/lucerna_egress_capture.sh` traces one full dream cycle under
  syscall-level capture.

## v0.2

- **Opt-in companions ride the same release tag.** `amore init --with-lucerna`
  and `amore init --with-speculum` fetch the house steward and session
  mirror from the matching GitHub Release — sha256-verified, linked beside
  `amore` the way iris already is. Both default off; iris stays default-on
  with `--no-iris` as the offline opt-out.
- **The system prompt introduces the harness by its right name.** The
  compiled-in prompt templates lagged one commit behind their plaintext
  sources, so the resident model's system prompt carried a stale product
  name and docs path. They are regenerated, the regeneration script the
  staleness test names (`scripts/encrypt_templates.py`) now actually ships
  in-tree, and the test guards the pair again.
- **Linux releases run on Ubuntu 22.04 and Debian 12 again.** The linux-x64
  and linux-arm64 release lanes now build on the oldest supported LTS
  runners, so the shipped binaries' glibc floor is 2.35 (Ubuntu 22.04+,
  Debian 12+) instead of 2.39. The installers also gained a real smoke gate:
  the installed binary must run and print its version, and a failure
  restores the previous copy from rollback instead of leaving a broken
  install behind.
- **The crowned heart.** The welcome mark is now Amore Build's own: a gold
  three-point crown resting on a rose heart, taken from the site's block art
  and rasterized in braille. Two hue zones — the crown in gold, the heart in
  the site accent's rose family — with the same shine sweep reading as light
  moving across both materials. Both tiers regenerate from
  `scripts/gen_amore.py`; it replaces the aqueduct.
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
