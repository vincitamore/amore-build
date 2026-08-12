# Egress: what talks to the network, and how to prove it

The claim: **on the wire, the shipped harness talks to the endpoints you
configure and nothing else** (plus deliberate, documented fetches such as
companion install). This document is the receipt behind that sentence, the
method to re-check it, and an inventory of every instrument touchpoint.

**Related pages:** [autonomy defaults](autonomy.md) ·
[SECURITY.md](../SECURITY.md) · [loopback ports](ports.md) ·
[iris Lucerna surface](iris-lucerna.md)

---

## Method

Syscall tracing is per-process ground truth: a binary cannot opt out of the
tracer the way it could ignore an HTTPS proxy.

### One-shot `amore` prompt

[`scripts/egress_capture.sh`](../scripts/egress_capture.sh) runs a released
binary in a scratch `AMORE_HOME` containing only the model entry under test,
executes one headless prompt under `strace -f -e trace=network`, and
attributes every remote endpoint the process tree asked the kernel for:
the configured host, DNS, local plumbing, or UNKNOWN (non-zero exit).

```bash
scripts/egress_capture.sh ~/.local/bin/amore ~/.amore/config.toml <model-entry>
```

### One Lucerna dream cycle

[`scripts/lucerna_egress_capture.sh`](../scripts/lucerna_egress_capture.sh)
uses the same attribution helpers. It builds a scratch home and a scratch
house with `dreamsEnabled: true` and `autoCommitLive: false`, then runs
`lucerna dream-cycle --force --dreams-enabled` under the same strace harness
so the lucerna + amore process tree is fully attributed. Exit is non-zero on
any UNKNOWN endpoint, or if the log shows no network touch at all (a silent
refuse is not treated as a PASS for the model-endpoint claim).

```bash
scripts/lucerna_egress_capture.sh \
  ~/.local/bin/lucerna ~/.local/bin/amore \
  ~/.amore/config.toml <model-entry>
```

Shared helpers live in [`scripts/egress_lib.sh`](../scripts/egress_lib.sh)
(sourced by both scripts; not meant to be run alone).

**Platform:** Linux + strace. Non-Linux hosts exit 2 with an honest degrade
message rather than a fake pass.

---

## Receipts: v0.2.121 (`amore 0.2.121 (bfeb3fe)`, linux-x64, 2026-08-05)

**Rail 1: BYOK (DeepSeek V4 Flash over OpenRouter), one completed prompt:**

| Endpoint | Attribution |
|---|---|
| local resolver `:53` | DNS |
| `104.18.2.115`, `104.18.3.115` `:443` | openrouter.ai (configured `base_url`) |

Nothing else. `PASS: every touched endpoint is the configured host, DNS, or
local plumbing.`

**Rail 2: native Grok (OAuth device-auth, fresh scratch login), one
completed prompt:**

| Endpoint | Attribution |
|---|---|
| local resolver `:53` | DNS |
| `104.18.28.234`, `104.18.29.234` `:443` | `cli-chat-proxy.grok.com` (the native chat proxy) |

The device-auth login flow itself (captured separately, same method) touched
`api.x.ai` and `accounts.x.ai` only. Nothing else on either capture.

Re-run the scripts against your own binaries and config to refresh receipts
for a later release.

---

## Instrument egress inventory

| Component | Touchpoint | When it fires | How to verify |
|-----------|------------|---------------|---------------|
| **amore** | Model endpoint (`base_url` per config entry, or native chat proxy after `amore login`) | Explicit prompt / headless session / tool-using turn | `scripts/egress_capture.sh` |
| **amore** | OAuth / device-auth hosts (`api.x.ai`, `accounts.x.ai`) | Explicit `amore login` on the native rail | Same method on the login process; see Rail 2 notes above |
| **amore** | Version check (default on) | At interactive startup, at most once per 24 hours: a `HEAD` to `github.com/vincitamore/amore-build/releases/latest` (redirect probe, zero REST quota). User-initiated `amore update --check` may also `GET` `api.github.com` for release metadata (60/hr unauthenticated). Kill switches: `AMORE_UPDATE_CHECK=0` (checks off) and `AMORE_DISABLE_UPDATES=1` / `GROK_DISABLE_AUTOUPDATER` (all update paths). Auto-apply stays off (compiled default `cli.auto_update = false`); the upstream installer origin remains compile-time hard-off (`FORK_AUTO_UPDATE_HARD_OFF`) | `scripts/egress_capture.sh` attributes `github.com` as `release origin` when checks are enabled; a checks-off capture must not see it. Group 11 in `scripts/sync_upstream.py --verify` pins the origin wiring |
| **amore** | Update apply (user-initiated) | Explicit `amore update` (or Ctrl+U apply-then-quit). May fetch release metadata, then archives and sibling `.sha256` sidecars from the single-sourced, gate-pinned origin `https://github.com/vincitamore/amore-build/releases/download` (constants in `self_update/origin.rs`). Fleet transaction moves `amore` and every installed companion together: digest verify, staging smoke, activate under lock; `--rollback` restores `.prev` binaries; `--dry-run` plans without download. Never background, never unattended | Group 11 pins origin single-sourcing and forbids xAI hosts in `self_update/**`; install state and fleet coherence surface in `amore doctor` |
| **amore** | Remote settings / announcements / deployment-config fetch (native proxy path) | Historically a startup-gating input: a live deployment-config response could write `requirements.toml` with `required_*` version keys that blocked launch. In this fork the fetch is off by default (`features.managed_config = false`), and even when re-enabled, remotely-synced `required_*` keys cannot prevent startup. Interactive paths may still prefetch announcements when the fetch is enabled and auth is present | Not part of the BYOK one-shot receipt (Rail 1 showed only the configured host). Treat as native-rail traffic when you use that rail |
| **amore** | Telemetry | **Inert by default**: mode Disabled, no client while disabled, no reporting token in release builds | `scripts/sync_upstream.py --verify` re-pins |
| **amore init** | GitHub Releases fetch for companions | Install / `--refresh` when iris (default on) or `--with-lucerna` / `--with-speculum` is requested | Documented URL base `https://github.com/vincitamore/amore-build/releases/download`; sha256-verified. Offline when iris is opted out **and** optional companions are not requested |
| **iris** | Loopback HTTP `127.0.0.1:3853` | When the iris daemon is running | Local only; [ports.md](ports.md). Not WAN egress |
| **iris** | Release fetch | Same as `amore init` companion install (iris asset) | Install-time only |
| **iris qmd** | npm registry (`registry.npmjs.org`) install of pinned `@tobilu/qmd` | Explicit `iris qmd setup` (or init-driven setup) into `~/.amore/instruments/qmd/runtime/` | Deliberate one-shot package install; no global npm; no PATH edits |
| **iris qmd** | Hugging Face GGUF model pulls (`huggingface.co`) for embedding, rerank, and query-expansion models | Explicit setup without `--no-models` (first hybrid enablement) | Hosts resolve as `https://huggingface.co/<repo>/resolve/main/<file>` for the three default GGUF files (~2.1 GB total). Nothing at query time once models are cached; automatic index refresh is local-only |
| **iris qmd** | Search / update / embed after setup | Query and daemon refresh | Local subprocess only; no network when models and package are present |
| **lucerna** | Model via `amore` spawn only | When dreams (or auto-commit draft) are enabled and a cycle runs | `scripts/lucerna_egress_capture.sh`; defaults off ([autonomy.md](autonomy.md)) |
| **lucerna** | Network listener | **None** | File-based control only |
| **speculum** | Probes / ingest / usage | Explicit CLI; **no network** | Local sqlite + session tree only |
| **speculum** | Lenses | Explicit `speculum lens <name>` (not dry-run); model via `amore` spawn | Operator-initiated; dry-run never spawns |
| **vinculum** | Tier 0 structural | `iris edges derive` / structural refresh; **no model** | Local house walk + `graph/edges.jsonl` |
| **vinculum** | Higher structural tiers without a model | Non-model refresh paths when present; **no model** | Same local store; no network |
| **vinculum** | Model-judged edges (tier 2) | Explicit `iris edges update` including tier 2 when a working `amore` is available | Model via `amore` spawn only; same operator config |

**Tools do what you invoke:** `web_search` / `web_fetch` and shell commands
inside an interactive or unrestricted headless session reach whatever they
are asked to reach. The harness claim covers harness-owned traffic, not
arbitrary tool workload. Maintenance dreams are expected to disable web
tools; see [autonomy.md](autonomy.md).

---

## Scope, stated plainly

- **The native rail's endpoints** (`api.x.ai`, `accounts.x.ai`,
  `cli-chat-proxy.grok.com`) are what you opt into by running `amore login`;
  the BYOK rail talks only to the `base_url` in your config entry.
- **`amore init`** fetches companion binaries from this repository's GitHub
  Releases (sha256-verified) for iris (default) and for Lucerna / Speculum
  when opted in. That is a deliberate, documented fetch, not background
  traffic. Fully offline init: `--no-iris` and do not pass
  `--with-lucerna` / `--with-speculum`.
- **Telemetry:** the subsystem inherited from upstream ships inert: mode
  defaults to `Disabled`, no client is constructed while disabled, and no
  release workflow bakes in a reporting token. `scripts/sync_upstream.py
  --verify` re-pins both facts at every upstream sync.
- **Version check and apply:** the default-on check is kill-switchable and
  disclosed here. It reaches only this repository's release origin on GitHub
  (and the REST API host for user-initiated checks). Apply is always
  user-initiated (`amore update` or Ctrl+U) and may download release
  metadata, archives, and `.sha256` sidecars from that same pinned origin.
  Neither path reaches an upstream vendor installer. Disable checks with
  `AMORE_UPDATE_CHECK=0`; disable every update path with
  `AMORE_DISABLE_UPDATES=1`.
- **Lucerna** introduces no provider endpoints. See [autonomy.md](autonomy.md)
  for enablement, governance, budgets, and kill paths.

---

## Reproduce it

```bash
# Rail 1: any BYOK entry from your own config
scripts/egress_capture.sh ~/.local/bin/amore ~/.amore/config.toml <model-entry>

# Rail 2: log into a scratch home, then trace one prompt
AMORE_HOME=/tmp/scratch ~/.local/bin/amore login --device-auth
AMORE_HOME=/tmp/scratch strace -f -e trace=network -o rail2.strace \
  ~/.local/bin/amore -p 'Reply with exactly: EGRESS-OK'

# Lucerna dream cycle (requires lucerna + amore binaries)
scripts/lucerna_egress_capture.sh \
  ~/.local/bin/lucerna ~/.local/bin/amore \
  ~/.amore/config.toml <model-entry>
```

Attribution of the strace output is the last stage of the capture scripts;
run them against your own log, or read the addresses yourself; that is the
point of the method.
