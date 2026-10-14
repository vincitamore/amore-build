# Amore Build — fork changelog

Amore Build is a permanent engineered fork of xAI's open-source grok-build
harness (Apache-2.0). Upstream syncs land as periodic
monorepo sync commits; everything below is the fork's own delta, newest first.
This document is compiled into the binary — update it in the same change as the
work it describes.

## Unreleased

- **Project rules loader deduplicates `.grok/rules` against `.amore/rules`** — when both `.amore/rules/<name>.md` and legacy `.grok/rules/<name>.md` exist in a project root, the loader skips the `.grok/rules` duplicate so orientation rules are injected once. `iris` adds `forge list|pipeline|dream-acted|review|proposal-resolve` CLI verbs, and Lucerna light chores count by frontmatter `status:`, age inbox items from `created:`, and use a 600s `iris` subprocess timeout.
- **Google Antigravity OAuth login (`amore login --provider google-antigravity`)** — signs in with Google Antigravity (Cloud Code Assist: Gemini 3, Claude, GPT-OSS) via Google OAuth 2.0 PKCE browser login on `http://127.0.0.1:51121/oauth-callback` (with ephemeral port fallback and manual paste fallback), provisions or discovers the account's `cloudaicompanionProject` via `v1internal:loadCodeAssist` / `v1internal:onboardUser`, and stores credentials in `~/.amore/oauth-credentials.json` with compare-and-set token refresh. Model entries reference `api_key = "oauth:google-antigravity"` (or `"oauth:antigravity"`) and route through `/v1internal:streamGenerateContent?alt=sse` on `https://daily-cloudcode-pa.googleapis.com` with Antigravity headers, effort-tier wire model routing, and Cloud Code Assist stream translation.
- **Responses SSE keepalive control frames** — the Responses stream reader consumes explicit `keepalive` heartbeats after raw SSE logging and error/doom-loop checks, yielding between control frames so cancellation and progress timeouts remain responsive without counting heartbeats as model output or first-content timing.
- **Tool-call identity collision recovery** — repeated provider tool-call IDs are re-minted when assistant output is committed, and execution uses the committed IDs so parallel results stay correctly paired. Session load, history replacement, snapshot restore, and explicit repair recover existing collisions before duplicate-result cleanup. Unique provider IDs remain unchanged. OpenRouter HTTP 400 errors show the upstream provider name and error detail in the client and unified log.

## v1.0.45

- **OpenAI Codex OAuth login (`amore login --provider openai`)** — signs in with
  ChatGPT Plus/Pro via OpenAI's Codex OAuth 2.0 PKCE browser flow (loopback
  callback on `http://localhost:1455/auth/callback` plus manual paste fallback)
  or headless device-code flow (`--device-auth` / `--provider
  openai-codex-device`) and stores credentials in
  `~/.amore/oauth-credentials.json` with compare-and-set token refresh. Model
  entries reference `api_key = "oauth:openai"` and automatically route through
  the ChatGPT Codex Responses endpoint (`/codex/responses`) with account/residency
  headers and Codex body shaping. See `docs/oauth-providers.md`.
- **OpenRouter prompt-cache sticky routing and pruning stability** —
  `ChatStateActor` latches request-copy tool-result pruning once a session
  crosses 50% of its context window (resetting only on compaction, rewind, or
  conversation replacement) so pruned requests no longer oscillate between
  pruned and unpruned prefixes on every subsequent turn. Every sampling request
  now forwards `x-session-id`, and OpenRouter `/chat/completions` requests
  include top-level `session_id` (plus `cache_control: { "type": "ephemeral" }`
  on user/system-tail turns) so multi-turn agent loops pin sticky routing from
  turn 1 without stalling tool-result continuations.
- **Upstream intake: four monorepo bundles (1.0.38 to 1.0.45)** — Claude
  settings import, typed `requirements.toml` sections, context-window
  selection in the model picker, per-folder sandbox and network egress hold
  in the workspace daemon, minimal-mode history reprint on resize, clip-route
  voice dictation state machine, MCP SDK 3.4.0, tree-sitter 0.26.13, bounded
  file locks, and dozens of upstream fixes. Every fork surface (`.amore`
  roots ahead of `.grok`, `AMORE_*` env ahead of `GROK_*`, the SessionStart
  house context, the seat-roster and wake plane, the baked changelog, the
  hard-off updater, and the crowned-heart splash) is re-seated on the new
  tree.

## v1.0.24

- **Upstream intake: seven monorepo bundles (1.0.8 to 1.0.24)** — memory v2
  observation capture and the safe memory-file workflow, the `terminal`
  theme (your terminal's own colors, no background of its own), hook
  `systemMessage` output and PostToolUse output replacement, a request
  `LengthPolicy` so a length-truncated turn whose tool calls are complete
  runs them instead of failing, startup spans, the agent-host daemon lane,
  and dozens of upstream fixes. Every fork surface was re-seated on the new
  tree: `.amore` roots ahead of `.grok`, `AMORE_*` env ahead of `GROK_*`,
  the SessionStart house context, the baked changelog, the hard-off updater,
  and the crowned-heart splash inside upstream's tiered welcome layout.
- **`sync_upstream.py --check` no longer crashes** on a bundle message that
  carries non-ASCII text.

## v1.0.8-hotfix.1

- **Seat identity is the Tailscale node** — MagicDNS first label, not the
  OS hostname or NetBIOS name, and not `unknown` when `HOSTNAME` is
  unset. `HOUSE_SEAT` wins; the hostname fallback is never written into
  the shared seat file.
- **Splash Peers is live at first paint** — presence is registered before
  the welcome announcement is built, so this session is not `0 LIVE`.
- **House token converges** — seats share one `tls/token` on start (pull,
  pick a winner, push). No hand copy between machines.
- **Wake transport** — same-seat sessions stay on loopback (unix domain
  on POSIX, token-gated TCP 127.0.0.1 on Windows). Cross-seat live wake
  is TLS to the peer's Tailscale IPv4 only (house-issued cert, TOFU pin,
  bind that address, never 0.0.0.0, never LAN). A busy session enqueues;
  it does not interrupt the running turn. ssh inbox is the offline
  fallback; a failed live wake prints `degraded (inbox) after live wake:`
  instead of a success-shaped `sent (inbox)`.
- **Hop from v1.0.8 on Unix** — that cut's updater unpacks `iris-dash-*`
  as a 644 docs member and stage-smokes it, then aborts (`failed to spawn
  smoke command`). Hide the dash sibling in the install directory (rename
  it away from `iris-dash-*` / `iris-dash`) so the 1.0.8 updater does not
  adopt it, run `amore update`, then un-hide the sibling: a hidden dash
  is never re-adopted, and `iris dash` re-execs only a sibling it can
  see. Later hops use this cut's updater, which marks the dash executable
  before smoke.
- **Pulse** — Peers shows a count plus a sub-line of `seat/harness`
  identities, refreshed with the Dashboard poll. Duplicate harness rows
  for the same pid are collapsed.
- **Presence is pulled live, never pushed** — every session runs a seat-door
  keeper: it tries to hold the tailnet TLS listener on the coord port and
  retries every 30s, so the door survives its owner's exit and a late
  Tailscale bring-up. The door answers an authed `roster` request from its
  own PID-probed presence dir (loopback tokens stripped), and consumers dial
  every registered seat in parallel under a deadline — a seat that does not
  answer renders **dark** with its last successful answer. If a session
  shows up at all, it is running right now — so every surface counts it
  **LIVE**, wherever it lives; rows name the seat, and a dark seat's
  sessions are never counted. The iris daemon holds the door whenever no
  amore session does (same persisted certificate, so peers' pins hold) —
  a seat answers as long as anything on it is alive, TUI open or not, and
  a seat that answers with nothing running shows as `up, no sessions`
  rather than disappearing. Presence files
  are local-only: the scp presence copy, its retract-at-exit race, and
  remote ghost files are gone (pushed-era foreign-seat files are reaped on
  read), and per-session ephemeral tailnet listeners no longer exist — one
  tailnet listener per seat, loopback everywhere else. ssh remains only for
  offline mail drops and house-token convergence. Sessions from other
  harnesses on a seat are visible cross-seat through that seat's door
  without publishing anything. Each seat still links every local SSH-login
  home's `.house/coord` to the house coord so offline mail drops land in
  one directory.
- **Peers member in iris** — the first-class mesh surface (`P` in the member
  bar, `--member Peers`): the per-seat session roster (harness, model, pid,
  tree, start time, door marker; dark seats with their last answer) beside
  the full coord message log with an unread divider and a persisted read
  cursor. Pulse's Peers and Mail vitals click through to it; Mail shows the
  unread count and the last message's age. The iris daemon serves the
  native pull (`amore coord roster --json`, cached) with the local file
  roster as its degrade path.
- **Messages actually reach other harnesses now** — sends to a non-amore
  session speak that harness's real inject contract (auth line, then
  `{"type":"user","message":{"role":"user","content":…}}`), chosen by the
  target's harness on every transport (Windows named pipe and the POSIX
  unix socket alike). The earlier text frame was accepted at the transport
  and silently dropped at parse, so v1.0.8's cross-harness hop never
  delivered despite reporting `enqueued`. Exhibited: a message sent from
  one machine rendered inside a Claude conversation on another, with no
  amore session open anywhere. Receiving Claude sessions that bypass
  permission prompts also need `"crossSessionInbound": "accept"` in their
  Claude settings — without it the harness holds an external post for
  ~5 minutes and drops it. A failed hop prints
  `degraded (inbox) after live wake:`, never a success-shaped
  `sent (inbox)`.
- **Leader comparator** — `1.0.8 < 1.0.8-hotfix.1 < 1.0.9`. Already-running
  v1.0.8 sessions still use raw semver until they exit and can force-kill
  the new leader. Restart live sessions after the hop, or expect a bounded
  thrash window.
- **`amore update` on Unix (this cut onward)** — the iris dash sibling in
  the archive is marked executable before smoke, so a 644 docs member no
  longer fails the fleet transaction.

## v1.0.8

- **Coordination plane** — live sessions on a seat can name each other
  and be woken by an addressed message. This cut ships the roster, the
  send-that-wakes path, and the operator surfaces together.
- **Seat roster** — Amore sessions register in a house-neutral presence
  directory (`~/.house/coord/presence/`) at start and drop the entry on
  exit. `amore coord roster` lists who is live (`--json` for scripts).
  New houses stamped by `amore init` emit Peers and Origin at session
  start (the model sees them as a system-reminder). The welcome splash
  and the iris Dashboard Pulse show the same live roster, so two
  sessions on one seat can name each other.
- **Addressed send that wakes** — `amore coord send <seat|session> <text>`
  delivers to a live session over a loopback socket (unix domain on POSIX,
  token-gated TCP 127.0.0.1 on Windows). An idle session starts a turn
  with the message as a `<cross-session-message>` block; a busy session
  enqueues and drains at the next turn. Other seats go through
  `~/.house/coord/seats` (`name user@host inbox-path`) then ssh; the
  socket never leaves the machine. Unreachable seats drop to the inbox.
  iris Pulse shows Mail next to Peers.
- **Also** — in-process `/minimal` and `/fullscreen`, plugin marketplace
  CTAs, feedback image attachments, MCP elicitation, workflow remote-bundle
  load plus `agent_budget`, Ctrl+S prompt stash, and a concurrent
  subagent sampling gate. `xai-grok-version` tracks upstream 1.0.8.

## v1.0.6

- **No more console windows flashing on Windows** — the iris daemon spawned
  its qmd runtime probes without a hidden window, so every status check,
  search and index refresh flashed a `node.exe` console on the desktop. The
  probes are hidden now, and the fleet updater relaunches daemons with a
  hidden console of their own instead of none.
- **Hotfix tags** — release tags track the upstream pin (`v1.0.6` is upstream
  1.0.6 plus the fork's delta); a fix cut between two pins is
  `v1.0.6-hotfix.1`, which `amore update` orders after `v1.0.6` and before
  `v1.0.7`. Fleets on this release or later are offered hotfixes.
- **Startup-failure advice names your binary** — the "try a larger startup
  budget" and "stop the shared leader" commands on the startup-failure screen
  say `amore`, not `grok`.
- **Status line** — a configurable status line under the prompt: model, cost,
  context use, session name, and custom command segments that re-run on a
  timer (`refresh_interval`). See `docs/user-guide/25-status-line.md`.
- **Permissions** — tool approvals are remembered by default, and "Never
  allow" is persistent for MCP tools and web-fetch domains.
- **Also** — compact on a model-family switch, identical tool-call loops are
  interrupted earlier (two tiers), paused workflows stay visible, e-mail
  addresses render as `mailto:` links, and `GROK_CONNECT_UI_TIMEOUT_SECS`
  raises the startup connect budget.

## v1.0.5

- **House compact packet** — after compact, the successor sees the house
  orientation packet (re-read current-state and the active task; the
  summary is forensics). The summarizer receives the PreCompact snapshot
  through `/compact keep`, alongside any keep-line you already passed.
- **Selection** — drag-copy in scrollback is more reliable, `/session-info`
  rows copy on drag, and Text selection can be set to `word_select` for
  double-click word / triple-click paragraph.
- **Worktree GC** — idle copies under the house worktrees dir are
  reclaimed when safe, and never when they hold the last copy of the work.
  `amore worktree gc --max-age 7d` is the manual pass (`--dry-run` first).
- **Arabic and Persian** — optional RTL reordering in scrollback. Turn on
  in `/settings`, or `[scrollback.display] rtl_bidi = true`. Off by default.
- **Hooks can rewrite a tool call** — a `PreToolUse` hook may return
  `updatedInput` to replace the model's arguments before the tool runs.

## v1.0.3

- **House compact hook** — `amore init` plants a `PreCompact` / `PostCompact`
  hook that emits a disk-orientation packet (re-read current-state and the
  active task; the summary is forensics). The harness does not yet inject
  that packet into the successor conversation.
- **Dream proposals no longer double-write** — Lucerna materializes
  `### Proposal:` blocks after the agent finishes. The agent is told not
  to write `forge/proposals/` itself, and a second file with the same
  title (even under a shorter slug) is skipped.
- **The Lucerna tab shows the charter cap you just wrote** — iris overlays
  `.amore/lucerna/budgets.json` onto a stale `state.json` snapshot, so
  raising the token ceiling is visible immediately. A running Lucerna
  adopts the file on the next idle poll (not mid-dream). Million-scale
  caps render as `2M`, not `2000K`.

## v1.0.2

- **Auto-commit can be turned off** — `a` on the Lucerna tab cycles
  off / dry-run / live. Dry-run still drafts (and spends tokens); off
  does not. `iris lucerna enable auto-commit off|dry-run|live` writes
  `autoCommitEnabled` on `enable.json`. `auto-commit-live on|off` still
  means live vs dry-run and keeps drafting on.
- **Lucerna's Budgets panel tells the truth it already promised** — the
  Running tab now shows live caps, capability (`ready` / `cooling` /
  `refusing`), and provenance (`source`, `aboveShipped`). This honours a
  published claim; it is not a new spend surface.
- **Enablement and other charter edits apply at the next cycle** — deleting
  or flipping `enable.json`, `budgets.json`, or `chores.json` stops the
  *next* cycle from starting. The `halt` sentinel and process stop are the
  only paths that interrupt work already running.
- **Charter files are no longer daemon-writable** — an autonomous
  maintenance dream could write the file that enables autonomous
  maintenance dreams; it now cannot. No exploitation is known — the
  boundary was simply drawn in the wrong place. Charter lives under
  `<house>/.amore/lucerna/`; runtime stays under `instruments/lucerna/`.
- **Operator knobs: `budgets.json` / `chores.json`** — six spend scalars
  and a narrowing chore roster, house-local, `b` / `c` on the Lucerna tab,
  `iris lucerna budgets` / `chores` on the CLI. The file may raise a cap
  above shipped (`aboveShipped` is visible). The roster cannot invent a key
  or name a spawn flag. Confirm dialogs and the JSON content-type check are
  not authentication; iris stays loopback-unauthenticated. A planner
  reservation refuses *starting* a call when remaining room is too small —
  it does not make overspend impossible. Dreams-off is not spend-off:
  drafting still spends until auto-commit itself is off.
- **Lucerna status tells the truth** — the iris dashboard no longer reports a
  healthy daemon as Hung between adaptive heartbeats. Iris now honors the
  daemon's own `intervalMs` for staleness (bound `max(120s, 2.5×interval)`,
  the same formula the lucerna CLI uses), checks process liveness so a dead
  daemon reads Stopped instead of running-until-stale — and start/stop no
  longer double-spawn or refuse a restart on a wrong staleness guess — and
  the Activity card shows **Running** with the live phase when the daemon is
  well. Activity, last actions, and phase now render from the fields the
  daemon actually writes.
- **Lucerna stays visibly alive during long work** — auto-commit compose and
  dream cycles advertise a bounded work-in-progress window on health and
  refresh the heartbeat every 30 seconds while they run, so long work no
  longer reads as a dead daemon; a graceful stop leaves an honest `stopped`
  tombstone instead of an eternally-healthy health file.
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
