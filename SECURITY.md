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
files; that is a local control path, not a WAN surface.

Full narrative, enablement tables, disable paths, and links to capture
scripts: [`docs/autonomy.md`](docs/autonomy.md).

### Opt-in at install

Lucerna is **not** installed by default. `amore init` installs it only with
`--with-lucerna`. Absent that flag, no Lucerna binary is fetched and no
steward process is present.

### Defaults (absent means off)

| Control | Default | Meaning |
|---------|---------|---------|
| `lucerna.enable.json` | absent | both knobs false |
| `dreamsEnabled` | `false` | no autonomous dream schedule |
| `autoCommitLive` | `false` | auto-commit stays dry-run (draft only) |

Absent or malformed enablement JSON keeps both false. Environment variables
and CLI flags may OR a knob on for one start; safe defaults never flip
themselves on.

### Default-deny governance (two lists)

Autonomous writes are allowed only when the path matches the **writable**
list and does not match the **protected** list. Paths outside the house root
are always denied.

**Never writable autonomously (shipped protected):** `AGENTS.md`,
`CLAUDE.md`, `context/`, `knowledge/`, `tasks/`, `reminders/`, `tags/`,
`graph/`, `projects/`, `archive/`, `scripts/`, `.amore/`, `.grok/`,
`.claude/`, `instruments/` (package and instrument source), with a residual
exception only for Lucerna's own runtime files under
`instruments/lucerna/` (state, health, log, enablement, notifications).

**Shipped writable:** `inbox/captures/`, `forge/`.

**User extension:** `instruments/lucerna/governance.user.toml` may add
`protected_extra = ["…"]` paths. User entries only **add** protection. They
never remove shipped protection and never widen the writable set.

### Budgets and ceilings

Shipped ceilings (overridable via `LUCERNA_*` env for operators who accept
the risk):

| Cap | Default |
|-----|---------|
| Actions per calendar day | 12 |
| Expensive (recipe / agentic) actions per ISO week | 6 |
| Cycle cooldown | 2 hours |
| Light-action cooldown | 24 hours per action key |
| Recipe / agentic cooldown | 12 hours per action key |
| Soft daily token ceiling | 200_000 tokens (from driver usage envelopes) |

A refused cycle records its reason in `state.json` and the log.

### Wall-timeout kill on model spawns

Every headless `amore` spawn from Lucerna carries a **wall-clock timeout**.
On expiry the entire process tree is killed (Windows `taskkill /T`, POSIX
process-group kill when possible). Default headless wall is 240 seconds;
light-dream planner calls use 180 seconds. Agentic maintenance spawns use
the same kill discipline (documented for integrators in the driver contract).

### Loopback-only doctrine

- **Lucerna:** no listener at all. Sentinels and enablement files under
  `<house>/instruments/lucerna/` are the control surface.
- **Iris:** binds `127.0.0.1` only (default port 3853). See `docs/ports.md`.

### Web access on maintenance dreams

Maintenance dream spawns that reach a model are expected to disable web
tools on the `amore` CLI (`--disable-web-search` and/or
`--disallowed-tools` denylisting `web_search` and `web_fetch`). Light-dream
planner calls already pass `--no-subagents` and a short wall timeout. Tools
the operator invokes in an interactive session remain out of scope for this
claim; that traffic is the workload, not the daemon.

### Model path: operator configuration only

The **only** model path is the operator's own `amore` configuration
(`~/.amore/config.toml`, auth, and provider routing). Lucerna introduces
**zero** provider endpoints of its own: no embedded SDK, no baked API keys,
no hardcoded model identifiers. Binary resolution is `LUCERNA_AMORE_BIN`,
else `amore` on `PATH`.

### Disable and kill paths

| Path | Effect |
|------|--------|
| Write sentinel `halt` (or `iris lucerna halt` / stop) | graceful stop request; iris stop may escalate to pid-verified kill |
| Set `dreamsEnabled` false (file, CLI, or env unset) | autonomous dreams stop; daemon may keep heartbeating |
| Delete or correct `lucerna.enable.json` | absent or malformed → both knobs false |
| Uninstall / remove the Lucerna binary and house runtime dir | no process remains to schedule work |
| `LUCERNA_AUTO_COMMIT=0` or `--no-auto-commit` | auto-commit drafting disabled entirely |

### Verify

- Enablement defaults and governance summary: [`docs/autonomy.md`](docs/autonomy.md)
- Syscall capture for one `amore` prompt: `scripts/egress_capture.sh`
- Syscall capture for one Lucerna dream cycle: `scripts/lucerna_egress_capture.sh`
- Component inventory: [`docs/egress.md`](docs/egress.md)

## Release integrity and residual risks

Amore Build publishes release assets on GitHub Releases for this repository.
The interactive client may check that origin for a newer version (default on;
kill with `AMORE_UPDATE_CHECK=0` or `AMORE_DISABLE_UPDATES=1`). The following
risks are accepted residual properties of the design, not temporary omissions.

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
