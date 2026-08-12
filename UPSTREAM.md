# Upstream relationship

Definitive statement of how **Amore Build** relates to its upstream source.
Provenance and policy surface, not marketing.

## 1. What this is

**Amore Build** is a perpetual friendly fork of xAI's open-sourced Grok Build
harness (`xai-org/grok-build`, Apache License 2.0), by way of the sibling
fork Selene Build, and briefly named Arcus Build before ever being announced.

| | |
|---|---|
| **Product / repo** | Amore Build (`amore-build`) |
| **Primary binary** | `amore` (argv0 also tolerates `amore-build`, `grok`, `agent`) |
| **Upstream** | [xai-org/grok-build](https://github.com/xai-org/grok-build) |
| **License** | Apache-2.0; see [`LICENSE`](LICENSE) |
| **Crates** | Upstream names kept (`xai-grok-*` and related `xai-*`). Product rename is binary/docs/config-surface only, not the crate graph. |

The fork exists so cooperation-harness content, identity, and config semantics
can evolve without claiming to *be* the upstream product. Upstream remains the
source of the agent runtime, TUI, and most of `crates/`.

## 2. Provenance and non-affiliation

### License obligations

Apache-2.0 obligations for upstream work and third-party dependencies are
honored in-tree:

| Artifact | Role |
|---|---|
| [`LICENSE`](LICENSE) | Full Apache License 2.0 text; `Copyright 2023-2026 SpaceXAI` |
| [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) | Per-package dependency attributions and license notes |
| [`third_party/NOTICE`](third_party/NOTICE) | Notices for vendored projects under `third_party/` |

Distributions must preserve copyright notices, license text, and attributions
required by Apache-2.0 and by bundled third-party licenses. The root-level
[`NOTICE`](NOTICE) is part of the same obligation set.

### Non-affiliation

**Amore Build is not affiliated with, endorsed by, or supported by xAI or
X Corp.**

- Independent fork: bugs, support, and feature work for Amore Build are not
  xAI's responsibility.
- Do not open issues or PRs on `xai-org/grok-build` for Amore Build behavior,
  branding, templates, or fork-only features.
- **Trademarks** (xAI, Grok, X, and related marks) belong to their owners.
  Apache-2.0 source use does not grant trademark rights.
- Upstream names in code or docs (crate ids, historical strings, protocol
  compatibility) are provenance or technical compatibility, not endorsement.

## 3. Provenance pinning (`SOURCE_REV`)

[`SOURCE_REV`](SOURCE_REV) at the repo root names the upstream baseline this
tree is rebased on (or last synced from). **The pin stores the public
sync-bundle SHA**: the newest "Synced from monorepo" commit on
`xai-org/grok-build` that has been merged, not upstream's *internal*
monorepo SHA (the `Source-Revision:` trailer), which is not a fetchable git
object.

### How to read it

1. Open `SOURCE_REV` at the repository root.
2. Skip the `#`-prefixed header comment; the payload is the single
   non-comment line: a 40-character hexadecimal Git SHA.
3. That SHA is the upstream baseline, resolvable on `xai-org/grok-build`.
   Fork-only commits sit above the history that includes that sync; they are
   not part of the upstream tree.

Live value is always the file. Example shape only:

```text
# Amore Build: upstream baseline pin. (header comment, several lines)
ed6d543643628663873c5de28298e022ed634238
```

Each public release ships the `SOURCE_REV` its tree was rebased on.
Consumers pin **upstream baseline + fork tip** (`SOURCE_REV` + tag/commit).

## 4. Rebase and cadence policy

Settled design policy, binding for maintainers of this fork.

| Rule | Policy |
|---|---|
| **Thin-diff** | Prefer new files/local modules over drive-by edits in upstream files. Keep the fork delta small and rebasable. |
| **Rebase unit** | Periodic **upstream-sync bundles** (monorepo sync commits). Never piecemeal cherry-picks of unrelated upstream commits. |
| **Cadence** | Best-effort **within days** of an upstream sync on `xai-org/grok-build`. Intent: low lag, not same-hour mirroring. |
| **Security** | Security-relevant upstream fixes are **fast-followed** when practical. |
| **Crate names** | Do not rename `xai-grok-*` (and related) for branding. |
| **Self-update** | Auto-update that would replace the fork with upstream is **hard-off** (§5). |

Rebase rarely relative to day-to-day fork work: land the bundle, re-apply the
thin delta, re-verify fork surfaces, update `SOURCE_REV` when the pin moves.

## 5. What differs

Honest delta versus stock `xai-org/grok-build`:

**Identity and branding.** Product and binary are Amore Build / `amore`.
User-visible labels follow the fork identity. Crate package names stay
`xai-grok-*`.

**Config-dir semantics.** Project roots use **`.amore`** where upstream reads
**`.grok`**. **`.grok` is legacy fallback** so upstream-format trees keep
working. Default user home is **`~/.amore`** (compiled in); legacy
`$GROK_HOME` still works (`$AMORE_HOME` wins when both are set).

**Environment surface.** Product policy: **`AMORE_*` primaries**, **`GROK_*`**
legacy aliases on dual-mapped keys. Not every historical `GROK_*` name has a
twin; resolution follows `xai-grok-config` and related crates.

**Cooperation-harness templates.** Generic pack at `templates/house/`,
**embedded at build time** into the binary (`xai-grok-pager` embed machinery)
for offline install.

**`amore init`.** Installs the embedded harness into a target repo
(ownership/refresh policy; offline for the pack itself).

**First-run setup.** Interactive first-run / setup guidance for credentials and
companion install (wizard surface; explicit setup entry for non-interactive
use). Must not trap headless or CI paths.

**Iris.** Companion instrument in-tree at `instruments/iris/`. `amore init`
installs its release binaries into a house by default (`--no-iris` opts out;
a failed download never fails the house); `amore setup` records PATH
detection. Never required to run Amore Build; absence is quiet.

**Upstream update origins stay unreachable.** Compile-time policy in
`xai-grok-update` (`FORK_AUTO_UPDATE_HARD_OFF`) keeps the inherited upstream
installer path inert: guards and the funnel never reach xAI install
endpoints, so the fork cannot self-update back into upstream releases.
Fork updates come only from this repository's own GitHub Releases via the
pinned origin in `self_update/origin.rs` (`vincitamore/amore-build` on
`github.com`; group 11 in `scripts/sync_upstream.py --verify`). Default-on
version check at interactive startup; user-initiated apply via
`amore update` or Ctrl+U (fleet transaction with `.sha256` verification,
staging smoke, and `--rollback`). The bootstrap installer remains a valid
first-install and recovery path.

**Test-suite platform coverage (inherited).** The upstream suite is written
against unix hosts: a substantial set of tests assert unix path shapes, unix
process/env behaviour, or terminal-brand detection, and fail on Windows in
stock upstream as much as here. The fork does not "fix" those by forking test
logic: where a test is unix-only, it is `cfg`-gated to match upstream's own
gating, and nothing more. Consequence for CI: **the pager suite is gated on
Linux; Windows is gated on building the binary, smoking it (`--version`,
`doctor --json`), and the crate suites that are clean there.** Windows is a
supported build and runtime target; it is not yet a green-suite target.

Everything else is largely upstream: agent runtime, tools, TUI, ACP, workspace
logic, and the bulk of `crates/`.

## 6. How to consume upstream fixes

The mechanics below are automated by [`scripts/sync_upstream.py`](scripts/sync_upstream.py)
(stdlib Python; `py scripts/sync_upstream.py --help` on Windows, `python3`
elsewhere). Upstream publishes **sync-bundle commits**: bot-authored commits
titled "Synced from monorepo" with a `Source-Revision:` trailer naming the
internal monorepo SHA. Those bundles are the intake unit (§4); never
cherry-pick unrelated upstream commits.

### One-line intake flow

```bash
python scripts/sync_upstream.py --check      # how far behind, what's in the newest bundle
python scripts/sync_upstream.py --apply      # fetch + merge upstream/main on a sync/<sha> branch
python scripts/sync_upstream.py --verify     # run the fork-surface checklist against the tree
# resolve conflicts if any, re-apply the thin fork delta once, then:
git commit -m "sync: merge upstream <sha>"
python scripts/sync_upstream.py --update-pin # SOURCE_REV -> upstream/main
```

`--apply` refuses a dirty working tree and never commits; the merge is left
for human review. `--verify` checks the fork surfaces mechanically across
eleven check groups: `.amore`/`.grok` precedence, `~/.amore` default home,
identity/binary naming (argv0 aliases), upstream-installer hard-off
(`FORK_AUTO_UPDATE_HARD_OFF`; the fork's own `self_update` path is separate),
the embed + `init` ownership tests, the brand-boundary gate, the
`resolved_bin_name()` branding call-site pins (resume-hint / titles /
completions), the doctor-namespace migration pins, the egress pins
(telemetry mode defaults to `Disabled`; no `GROK_TELEMETRY_BUILD_*`
reporting token referenced in any workflow), companion/instrument pins,
and the self-update origin lock (group 11: origin constants; check and apply
wiring for `check_background`, `run_update`, and quit-for-update
`run_apply_result`; lacks-pins that forbid xAI endpoints in
`self_update/**`). It then builds and smokes `amore` on the host. The egress
and origin pins re-verify the shipped posture at every sync, so the public
egress statement is re-checked mechanically rather than trusted to memory.
The script is the authoritative list; keep this sentence in sync when it
grows. The Linux pager suite and full crate suite remain CI's job (see §5);
`--verify` says what it can and cannot run rather than faking a green.

### Operators / release maintainers

1. Track monorepo **sync** commits on `xai-org/grok-build` (bundle-shaped; do
   not invent a cherry-pick stream). `--check` reports the delta and the
   newest bundle's change list.
2. Rebase or merge the **entire sync bundle** (`--apply`), then re-apply/re-
   verify the thin fork delta once.
3. Refresh [`SOURCE_REV`](SOURCE_REV) when the upstream baseline moves
   (`--update-pin`). **The pin stores the public sync-bundle SHA**: the last
   one merged, not upstream's internal monorepo SHA (`Source-Revision:`),
   which is not a fetchable git object.
4. After every rebase, re-check the fork surfaces; `--verify` does
   this; keep the checklist in sync with the script when it grows.
5. Fast-follow security fixes; batch ordinary drift into the next sync rebase.

### Contributors

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution policy. Regardless of
channel:

- **Thin-diff:** smallest change that works; new files beat upstream churn.
- **Rebase-rarely:** no micro-rebase stream from upstream; intake is
  bundle-shaped (§4).
- The fork-surface grok boundary is enforced by
  [`scripts/check_grok_boundary.py`](scripts/check_grok_boundary.py):
  `--scan` to survey, `--check` to gate. It encodes which `grok` mentions are
  ours to change (fork-owned surface) versus upstream substrate (crate ids,
  paths, env, model name, provenance) that must stay untouched for merge
  economics. Add reviewed exceptions there, not by editing around the check.
- The mechanical rebase checklist **is** `sync_upstream.py --verify`; its
  check groups are the published, executable form. §4–§5 plus thin-diff /
  rebase-rarely are the binding written policy around it.

### Do not

- Re-enable auto-update toward upstream install endpoints.
- Rename workspace crates to “match” the product name.
- File Amore Build issues on the upstream GitHub repository.
- Strip or relocate `LICENSE` / `THIRD-PARTY-NOTICES` without a
  license-compliant replacement.

## Related files

| Path | Purpose |
|---|---|
| [`LICENSE`](LICENSE) | Apache-2.0 |
| [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) | Dependency attributions |
| [`SOURCE_REV`](SOURCE_REV) | Upstream sync-bundle SHA pin |
| [`SECURITY.md`](SECURITY.md) | Vulnerability reporting |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution / non-PR policy |
| [`templates/house/`](templates/house/) | Embedded cooperation-harness pack |
| [`instruments/iris/`](instruments/iris/) | Companion instrument sources |
