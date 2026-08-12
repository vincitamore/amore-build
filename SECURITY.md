# Security Policy

## Reporting a Vulnerability

Report suspected security issues through **GitHub private vulnerability
advisories** on this repository:

**[Security → Advisories → "Report a vulnerability"](https://github.com/vincitamore/amore-build/security/advisories/new)**

Please do not file public issues for security reports, and do not post details
in discussions, PRs, or any other public channel, until a fix is public.

**There is no security email alias**: private advisories are the single
reporting channel, so reports stay attached to the repository and get a
private working thread by construction.

### What to include

- Affected version / commit (`amore --version` prints the build commit).
- Reproduction steps or a proof-of-concept, and the impact you see.
- Whether the issue reproduces in **upstream** `xai-org/grok-build`: if it
  does, it is an upstream bug and should be reported there as well; this fork
  tracks upstream and will pull their fix. Issues in fork-specific surfaces
  (identity/branding layer, `.amore` config-dir handling, `amore init` /
  `amore setup`, the bundled `templates/house/` content, the iris
  companion seam, `instruments/iris/`, Lucerna, Speculum) belong here.

### Expectations

This is a personal-scale open project maintained in the open, not a staffed
security org: response is **best-effort, no SLA**. Reasonable-coordination
disclosure is appreciated; we aim to acknowledge useful reports and will
credit reporters in release notes unless you ask otherwise.

### Egress posture

The shipped binary talks to the endpoints you configure and nothing else;
the inherited telemetry subsystem ships inert (disabled by default, no
client constructed while disabled, no reporting token baked into any
release build). Receipts and the capture method: `docs/egress.md` +
`scripts/egress_capture.sh` (and `scripts/lucerna_egress_capture.sh` for
one Lucerna dream cycle). The posture is re-pinned mechanically at every
upstream sync by `scripts/sync_upstream.py --verify`. Traffic that
contradicts this is a vulnerability: report it.

Instrument network inventory (when each touchpoint fires, and how to verify):
`docs/egress.md`. Autonomy defaults and governance summary:
`docs/autonomy.md`.

### Scope guidance

- Secrets handling is documented in `docs/authentication.md`
  (`~/.amore/auth.json` must never be committed or logged; `AMORE_*` env
  vars take precedence over `GROK_*` aliases).
- `amore init` / `amore setup` write templates and config under your user
  home and project tree; report anything that writes outside those roots or
  follows input-controlled paths unsafely.
- Lucerna autonomous writes are default-deny; report any path that is
  written without matching the shipped writable set or that lands under a
  protected surface without an operator-driven tool outside Lucerna.

## Autonomy (Lucerna)

**Lucerna** is the house steward daemon. It heartbeats over a house tree,
enforces default-deny writes and action budgets, and may run opt-in
maintenance (light dreams and agentic maintenance dreams, both behind the
same operator enablement). Control is **file-based only**. Lucerna opens **no
network listener**. Iris on loopback (`127.0.0.1:3853`) can proxy the same
files; that is a local, **unauthenticated** control path, not a WAN surface.
Confirm dialogs, compare-and-swap on review flips, and the JSON
content-type check on Lucerna POSTs are operator UX and browser-reachability
guards. They are not authentication.

The files that say what the steward **may do** are not files the steward
**may write**. Charter lives under `<house>/.amore/lucerna/` (already a
protected surface). Runtime — what the steward has done — lives under
`<house>/instruments/lucerna/`. An autonomous maintenance dream cannot write
the file that enables autonomous maintenance dreams.

Full narrative, enablement tables, disable paths, and links to capture
scripts: [`docs/autonomy.md`](docs/autonomy.md).

### Opt-in at install

Lucerna is **not** installed by default. `amore init` installs it only with
`--with-lucerna`. Absent that flag, no Lucerna binary is fetched and no
steward process is present.

### Defaults (absent means off)

| Control | Default | Meaning |
|---------|---------|---------|
| `<house>/.amore/lucerna/enable.json` | absent | dreams off, auto-commit dry-run |
| `dreamsEnabled` | `false` | no autonomous dream schedule |
| `autoCommitEnabled` | `true` when the key is absent | drafting on or off; `false` is spend-off |
| `autoCommitLive` | `false` | live vs dry-run (a git word: no live commit). Ignored when disabled. |

Absent or malformed enablement JSON keeps dreams off and auto-commit
dry-run. An existing file that omits `autoCommitEnabled` keeps drafting.
Environment variables and CLI flags may OR a knob on for one start;
`--no-auto-commit` / `LUCERNA_AUTO_COMMIT=0` win over a file that is on.
Dreams-off is not spend-off: turn drafting off with
`autoCommitEnabled: false` (tab `a`, or
`iris lucerna enable auto-commit off`).

A legacy `<house>/instruments/lucerna/lucerna.enable.json` is still *read*
when the charter path is absent; it is never written.

### Default-deny governance (two lists)

Autonomous writes are allowed only when the path matches the **writable**
list and does not match the **protected** list. Paths outside the house root
are always denied. **The lists bound writes, not reads.** A dream that may
write `forge/` can summarize anything the process account can read.

**Never writable autonomously (shipped protected):** `AGENTS.md`,
`CLAUDE.md`, `context/`, `knowledge/`, `tasks/`, `reminders/`, `tags/`,
`graph/`, `projects/`, `archive/`, `scripts/`, `.amore/` (the whole tree,
including charter), `.grok/`, `.claude/`, `instruments/` (package and
instrument source).

**Residual allow-list** under `instruments/lucerna/` only (top-level
basenames): `health.json`, `state.json`, `log`, `notifications.jsonl`,
`daemon.pid`, `halt`, `wake`, `sleep`, plus write artifacts (`log.N`,
`*.tmp`, `draft-*`). Charter names (`lucerna.enable.json`,
`governance.user.toml`) are not residual-writable.

**Shipped writable:** `inbox/captures/`, `forge/`.

**User extension:** `<house>/.amore/lucerna/governance.user.toml` may add
`protected_extra = ["…"]` paths. User entries only **add** protection. They
never remove shipped protection and never widen the writable set. A user
extra outranks the residual allow-list.

### Budgets and ceilings

Shipped ceilings. Precedence is `argv > env > file > shipped`. A house-local
`<house>/.amore/lucerna/budgets.json` may set a cap **above** the shipped
default; surfaces show `aboveShipped` when that happens. Env and argv may
also raise.

| Cap | Shipped default |
|-----|-----------------|
| Actions per calendar day | 12 (`0` disables actions) |
| Expensive (recipe / agentic) actions per ISO week | 6 |
| Cycle cooldown | 2 hours (1 hour after a zero-action cycle) |
| Light-action cooldown | 24 hours per action key |
| Recipe / agentic cooldown | 12 hours per action key |
| Soft daily token ceiling | 200_000 tokens (from driver usage envelopes) |
| Dreams reserve | 80_000 tokens (auto-commit effective ceiling 120_000) |

The daily token ceiling is **soft**. A planner call is not started unless
`tokensToday +` a reservation room fits; a call already running can still
overshoot by that call's usage. The reservation is not a per-call cap and
does not make overspend impossible.

The chore roster (`chores.json`) is an operator-intent surface: it can only
narrow the shipped catalog and cannot name spawn parameters. It is not a
security boundary against a local attacker who can already write enablement.

A refused cycle records its reason in `state.json` and the log.

### Wall-timeout kill on model spawns

Every headless `amore` spawn from Lucerna carries a **wall-clock timeout**.
On expiry the entire process tree is killed (Windows `taskkill /T`, POSIX
process-group kill when possible). Default headless wall is 240 seconds;
light-dream planner calls use 180 seconds. Agentic maintenance spawns use
the same kill discipline (documented for integrators in the driver contract).

### Loopback-only doctrine

- **Lucerna:** no listener at all. Charter under
  `<house>/.amore/lucerna/`; runtime and sentinels under
  `<house>/instruments/lucerna/`.
- **Iris:** binds `127.0.0.1` only (default port 3853). See `docs/ports.md`.
  Loopback, unauthenticated. Lucerna POSTs require
  `Content-Type: application/json` so a visited page cannot submit a simple
  form to those routes; that closes browser reachability, it does not
  authenticate the caller.

### Web access and subagents on maintenance dreams

| Claim | Verify |
|-------|--------|
| Maintenance dream model spawns disable web tools | Argv includes `--disallowed-tools web_search,web_fetch` (`instruments/lucerna/src/engine/dispatch-contract.md`); one-cycle capture: `scripts/lucerna_egress_capture.sh` |
| Light-dream planner calls pass `--no-subagents` and a 180s wall | Same dispatch contract; planner argv in the lucerna package |

Tools the operator invokes in an interactive session remain out of scope for
this claim; that traffic is the workload, not the daemon.

### Model path: operator configuration only

The **only** model path is the operator's own `amore` configuration
(`~/.amore/config.toml`, auth, and provider routing). Lucerna introduces
**zero** provider endpoints of its own: no embedded SDK, no baked API keys,
no hardcoded model identifiers. Binary resolution is `LUCERNA_AMORE_BIN`,
else `amore` on `PATH`.

### Disable and kill paths

Editing or deleting a charter file stops the **next** cycle from starting.
The `halt` sentinel and process stop are the only paths that interrupt work
already running.

| Path | Effect | Scope |
|------|--------|-------|
| Write sentinel `halt` (or `iris lucerna halt`) | graceful stop request | current unit finishes; next unit does not start |
| `iris lucerna stop` / tab `k` | halt, then pid-verified kill if still alive | **immediate** after halt timeout |
| Set `dreamsEnabled` false (file, CLI, or env unset) | autonomous dreams will not start; daemon may keep heartbeating | **next cycle** (file edit does not revoke an env/argv enablement) |
| Delete or correct `enable.json` | absent or malformed → dreams off, auto-commit dry-run | **next cycle** |
| Edit or delete `budgets.json` / `chores.json` | new caps / roster take effect | **next cycle** (or next auto-commit draft attempt) |
| Uninstall / remove the Lucerna binary and house runtime dir | no process remains to schedule work | **immediate** (no process) |
| `LUCERNA_AUTO_COMMIT=0` or `--no-auto-commit` | auto-commit drafting disabled entirely | **next draft attempt** |

### Verify

- Enablement defaults and governance summary: [`docs/autonomy.md`](docs/autonomy.md)
- Syscall capture for one `amore` prompt: `scripts/egress_capture.sh`
- Syscall capture for one Lucerna dream cycle: `scripts/lucerna_egress_capture.sh`
- Component inventory: [`docs/egress.md`](docs/egress.md)

## Release integrity and residual risks

Amore Build publishes release assets on GitHub Releases for this repository.
The interactive client may check that origin for a newer version (default on;
kill with `AMORE_UPDATE_CHECK=0` or `AMORE_DISABLE_UPDATES=1`). User-initiated
apply (`amore update`, or Ctrl+U apply-then-quit) downloads archives and
sibling `.sha256` sidecars from the same pinned origin, verifies digests
before unpack, smoke-tests staged binaries, and activates the fleet under
lock so a failed pre-activation leaves nothing partially installed.
`amore update --rollback` restores each target's `.prev` binary. The version
floor in `.amore-install.json` rejects downgrades unless `--allow-downgrade`
is set. Apply is never unattended. The following risks are accepted residual
properties of the design, not temporary omissions.

1. **The trust root is GitHub.** An attacker with repository write publishes a
   build with a valid digest; signing binds identity and integrity, never
   virtue. Only an offline-key signature would close this, and it is deferred
   with named triggers (first release cut by anyone other than the operator,
   or first known third-party production use; drop rather than degrade).
2. **The bootstrap is trust-on-first-use across two operator-controlled
   origins.** The install one-liners are served from the site's storage host
   (measured redirect chain ends at storage with HTTP 200), distinct from the
   GitHub release assets that carry the binaries. The pinned-origin design
   makes every subsequent update safe against a larger attacker class than the
   first install was; it does not make the first install safer.
3. **`latest` sorts by tag-creation time, not semver.** Never cut a release
   for an older line after a newer one is tagged. The version floor catches a
   downgrade, but discovery would wrongly report no update.
4. **Companions ship three targets; amore ships five.** darwin-x64 and
   linux-arm64 users get an honest fleet-coherence warning they cannot
   resolve, reported, never silently skipped.
5. **Windows is the riskiest platform with the thinnest coverage.** The test
   matrix raises the bar; it does not erase the gap.
6. **Because the hard-off constant stays true, the old verify check stays
   green while the egress claim changed.** The new origin/wiring group
   (group 11 in `scripts/sync_upstream.py --verify`) is the replacement
   forcing function. If it is removed or misread as obsolete, a false claim
   ships under a passing gate.
7. **A transaction that fails mid-activation leaves a mixed fleet** until the
   next launch resumes it. Reverting already-good work buys complexity for no
   benefit.
8. **A compromised build-time dependency (the xz shape) is defended by no
   release mechanism.** The lockfile and crates.io immutability substantially
   narrow it; the documentation must not imply otherwise.

**Explicitly rejected mitigation: no native-roots TLS.** Bundled webpki roots
mean a corporate MITM proxy fails loudly instead of silently intercepting.
The answer for intercepting environments is `AMORE_UPDATE_CHECK=0`, not a TLS
downgrade that would re-open interception for every request the binary makes.
