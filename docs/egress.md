# Egress: what the shipped binary talks to

The claim: **on the wire, the shipped binary talks to the endpoints you
configure and nothing else.** This document is the receipt behind that
sentence, and the method to re-check it yourself.

## Method

[`scripts/egress_capture.sh`](../scripts/egress_capture.sh) runs a released
binary in a scratch `AMORE_HOME` containing only the model entry under test,
executes one headless prompt under `strace -f -e trace=network`, and
attributes every remote endpoint the process tree asked the kernel for:
the configured host, DNS, local plumbing, or UNKNOWN (non-zero exit).
Syscall tracing is per-process ground truth: a binary cannot opt out of the
tracer the way it could ignore an HTTPS proxy.

## Receipts — v0.2.121 (`amore 0.2.121 (bfeb3fe)`, linux-x64, 2026-08-05)

**Rail 1 — BYOK (DeepSeek V4 Flash over OpenRouter), one completed prompt:**

| Endpoint | Attribution |
|---|---|
| local resolver `:53` | DNS |
| `104.18.2.115`, `104.18.3.115` `:443` | openrouter.ai (configured `base_url`) |

Nothing else. `PASS: every touched endpoint is the configured host, DNS, or
local plumbing.`

**Rail 2 — native Grok (OAuth device-auth, fresh scratch login), one
completed prompt:**

| Endpoint | Attribution |
|---|---|
| local resolver `:53` | DNS |
| `104.18.28.234`, `104.18.29.234` `:443` | `cli-chat-proxy.grok.com` (the native chat proxy) |

The device-auth login flow itself (captured separately, same method) touched
`api.x.ai` and `accounts.x.ai` only. Nothing else on either capture.

## Scope, stated plainly

- **The native rail's endpoints** (`api.x.ai`, `accounts.x.ai`,
  `cli-chat-proxy.grok.com`) are what you opt into by running `amore login`;
  the BYOK rail talks only to the `base_url` in your config entry.
- **`amore init`** fetches the iris companion binaries from this
  repository's GitHub Releases (sha256-verified) unless you pass
  `--no-iris`. That is a deliberate, documented fetch, not background
  traffic.
- **Tools do what you invoke**: `web_search` / `web_fetch` and the shell
  commands a session runs reach whatever they are asked to reach. The claim
  covers the harness's own traffic, not your workload's.
- **Telemetry**: the subsystem inherited from upstream ships inert — mode
  defaults to `Disabled`, no client is constructed while disabled, and no
  release workflow bakes in a reporting token. `scripts/sync_upstream.py
  --verify` re-pins both facts at every upstream sync, so this posture is
  re-checked mechanically rather than remembered.

## Reproduce it

```bash
# Rail 1: any BYOK entry from your own config
scripts/egress_capture.sh ~/.local/bin/amore ~/.amore/config.toml <model-entry>

# Rail 2: log into a scratch home, then trace one prompt
AMORE_HOME=/tmp/scratch ~/.local/bin/amore login --device-auth
AMORE_HOME=/tmp/scratch strace -f -e trace=network -o rail2.strace \
  ~/.local/bin/amore -p 'Reply with exactly: EGRESS-OK'
```

Attribution of the strace output is the last stage of the capture script;
run it against your own log, or read the addresses yourself — that is the
point of the method.
