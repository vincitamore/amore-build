# Kimi K3 quickstart (headline provider path)

Selene Build is the **Kimi-K3 cooperation harness**, with native grok subagent
freight as a second rail. This page is the public on-ramp for the marketed
default model path.

| Product role | Model path |
|--------------|------------|
| **Headline (use this)** | Kimi K3 via OpenRouter, Moonshot direct, or an open-weight host |
| **Native freight (second)** | xAI grok via `selene login` or `XAI_API_KEY` |
| **Technical fallback only** | Baked catalog `grok-4.5` — never market this as the product default |

Config lives at **`~/.selene/config.toml`** (override with `$GROK_HOME`). Prefer
**`env_key`** over a literal `api_key` so secrets stay out of the file.

> **Identity rule (mandatory):** every custom `[model.<name>]` block for K3
> **must** set `system_prompt_label`. An unlabeled model resolves to the
> product default identity and will play the wrong persona in tool loops.

> Pricing, model IDs, and host availability **rot**. Every such fact below is
> stamped **as of 2026-07-30; re-verify** against the linked vendor pages
> before you ship docs, screenshots, or onboarding copy.

---

## Preference order

1. **OpenRouter** — one key, multi-upstream routing, lowest onboarding friction  
2. **Moonshot direct** — canonical K3 API, 1M context, native features  
3. **Open-weight hosts** — Modal / Together / Fireworks when you already use them or need residency/dedicated capacity  

All three are **OpenAI-compatible** Chat Completions paths. Selene’s default
`api_backend` is `chat_completions`; you do not need to set it for these
providers.

---

## 1. OpenRouter (recommended)

| | |
|--|--|
| Model ID on the wire | `moonshotai/kimi-k3` |
| Base URL | `https://openrouter.ai/api/v1` |
| Auth env | `OPENROUTER_API_KEY` |
| Context | 1M *(as of 2026-07-30; re-verify)* |
| List price (OR page) | ~$2.90–$3.00 / $15 per 1M in/out; cached input often ~$0.30 at routed providers *(as of 2026-07-30; re-verify)* |
| Keys | https://openrouter.ai/keys |
| Model card | https://openrouter.ai/moonshotai/kimi-k3 |

### `~/.selene/config.toml`

```toml
[models]
default = "k3-openrouter"

[model.k3-openrouter]
model = "moonshotai/kimi-k3"
base_url = "https://openrouter.ai/api/v1"
name = "Kimi K3 (OpenRouter)"
env_key = "OPENROUTER_API_KEY"
system_prompt_label = "Kimi K3, a Moonshot AI model"
context_window = 1048576
max_completion_tokens = 16384
# Optional ranking headers (OpenRouter docs):
# extra_headers = { "HTTP-Referer" = "https://example.com", "X-Title" = "Selene Build" }
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `model` | `ConfigModelOverride.model` | `crates/codegen/xai-grok-shell/src/agent/config.rs:4027` |
| `base_url` | `ConfigModelOverride.base_url` | same `:4028` |
| `name` | `ConfigModelOverride.name` | same `:4029` |
| `env_key` | `ConfigModelOverride.env_key` | same `:4033` |
| `system_prompt_label` | `ConfigModelOverride.system_prompt_label` | same `:4057` |
| `context_window` | `ConfigModelOverride.context_window` | same `:4050` |
| `max_completion_tokens` | `ConfigModelOverride.max_completion_tokens` | same `:4040` |
| `extra_headers` | `ConfigModelOverride.extra_headers` | same `:4045` |
| `[models].default` | `ModelsConfig.default` | `ModelsConfig` at `:1031`, field `default` at `:1033` |

### Verify

```bash
export OPENROUTER_API_KEY="sk-or-..."   # your key
selene -m k3-openrouter -p "Reply with exactly: K3-OR-OK"
```

Expect a short completion (K3 always reasons; output tokens dominate cost). Then:

```bash
selene models
```

You should see `k3-openrouter` listed. In the TUI, `/model k3-openrouter` switches mid-session.

---

## 2. Moonshot direct (canonical K3)

| | |
|--|--|
| Model ID | `kimi-k3` |
| Base URL (international) | `https://api.moonshot.ai/v1` |
| Auth env | `MOONSHOT_API_KEY` |
| Context | **1,048,576** tokens, flat tier *(as of 2026-07-30; re-verify)* |
| Pricing | Cache hit in **$0.30** / cache miss in **$3.00** / out **$15.00** per 1M *(as of 2026-07-30; re-verify)* |
| Access | Flagship unlock after successful top-up (vendor docs: minimum **$1**) *(as of 2026-07-30; re-verify)* |
| Docs | https://platform.kimi.ai/docs/guide/kimi-k3-quickstart · pricing https://platform.kimi.ai/docs/pricing/chat-k3 |

China-region base `https://api.moonshot.cn/v1` is vendor-available but region-gated; prefer the international host unless you know you need CN.

### Vendor behavior notes

- K3 **always reasons**. Vendor `reasoning_effort` is `low` / `high` / `max` (default `max`); there is no “non-thinking” mode.
- On multi-turn / tool loops, keep the **complete** assistant message (including reasoning content). Stripping breaks context.
- Several sampling params are fixed by the vendor (`temperature=1.0`, `top_p=0.95`, …) — omit them in config rather than inventing values.
- Automatic prefix caching when prior prompt ≥ 256 tokens (cost control).

### `~/.selene/config.toml`

```toml
[models]
default = "k3-moonshot"

[model.k3-moonshot]
model = "kimi-k3"
base_url = "https://api.moonshot.ai/v1"
name = "Kimi K3 (Moonshot)"
env_key = "MOONSHOT_API_KEY"
system_prompt_label = "Kimi K3, a Moonshot AI model"
context_window = 1048576
max_completion_tokens = 16384
# Optional: lower cost vs max reasoning
# reasoning_effort = "high"
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `reasoning_effort` | `ConfigModelOverride.reasoning_effort` | `config.rs:4064` |
| (other fields) | same as OpenRouter block | `config.rs:4027–4057` |

### Verify

```bash
export MOONSHOT_API_KEY="sk-..."
selene -m k3-moonshot -p "Reply with exactly: K3-MS-OK"
```

---

## 3. Open-weight hosts (Modal / Together / Fireworks)

Use this tier when you already have an account, need US-only or dedicated
capacity, or want a non-OpenRouter primary. **Self-hosting open weights is not a
consumer path** — multi-TB / multi-enterprise-GPU class; treat hyperscaler
hosted APIs as the practical option.

### 3a. Together AI

| | |
|--|--|
| Model ID | `moonshotai/Kimi-K3` |
| Base URL | `https://api.together.xyz/v1` |
| Auth env | `TOGETHER_API_KEY` |
| Context / price | 1M; **$3.00** / **$0.30** cached / **$15.00** out per 1M *(as of 2026-07-30; re-verify)* |
| Card | https://www.together.ai/models/kimi-k3 |

```toml
[model.k3-together]
model = "moonshotai/Kimi-K3"
base_url = "https://api.together.xyz/v1"
name = "Kimi K3 (Together)"
env_key = "TOGETHER_API_KEY"
system_prompt_label = "Kimi K3, a Moonshot AI model"
context_window = 1048576
max_completion_tokens = 16384
```

**Verify:** `export TOGETHER_API_KEY=…` then  
`selene -m k3-together -p "Reply with exactly: K3-TG-OK"`.

### 3b. Fireworks AI

| | |
|--|--|
| Model path | `accounts/fireworks/models/kimi-k3` |
| Fast router (higher price) | `accounts/fireworks/routers/kimi-k3-fast` (+50% standard) |
| Base URL | `https://api.fireworks.ai/inference/v1` |
| Auth env | `FIREWORKS_API_KEY` |
| Context | ~1040k *(as of 2026-07-30; re-verify)* |
| Standard serverless | **$3.00** / **$0.30** / **$15.00** per 1M *(as of 2026-07-30; re-verify)* |
| Docs | https://fireworks.ai/models/fireworks/kimi-k3 · OpenAI compat https://docs.fireworks.ai/tools-sdks/openai-compatibility |

```toml
[model.k3-fireworks]
model = "accounts/fireworks/models/kimi-k3"
base_url = "https://api.fireworks.ai/inference/v1"
name = "Kimi K3 (Fireworks)"
env_key = "FIREWORKS_API_KEY"
system_prompt_label = "Kimi K3, a Moonshot AI model"
context_window = 1048576
max_completion_tokens = 16384
```

**Verify:** `export FIREWORKS_API_KEY=…` then  
`selene -m k3-fireworks -p "Reply with exactly: K3-FW-OK"`.

### 3c. Modal (public Shared API or your Auto Endpoint)

Public Modal offers Kimi-K3 without any third-party private deployment:

| Path | What you get | Notes |
|------|----------------|-------|
| **Shared API** | Pay-per-token OpenAI-compat for `moonshotai/Kimi-K3` | List rates match Moonshot-class **$3 / $0.30 / $15** *(as of 2026-07-30; re-verify)* — https://modal.com/library/moonshot/kimi-k3 |
| **Auto Endpoint** | Dedicated: `modal endpoint create --model moonshotai/Kimi-K3` | Bill compute $/sec; auth via workspace proxy token (`Bearer wk-….ws-…`) — https://modal.com/docs/guide/endpoints |

**Base URL caveat:** there is **no single documented global hostname** for Modal Shared API that is safe to hardcode in a preset. Auto Endpoint URLs are **per-endpoint** (dashboard / `modal endpoint list`). Paste the OpenAI-compatible base your Modal product surface issues (typically ending in `/v1`).

```toml
[model.k3-modal]
model = "moonshotai/Kimi-K3"
# Replace with YOUR Modal Shared API or Auto Endpoint base (must include /v1):
base_url = "https://YOUR-ENDPOINT.modal.direct/v1"
name = "Kimi K3 (Modal)"
env_key = "MODAL_TOKEN"
system_prompt_label = "Kimi K3, a Moonshot AI model"
context_window = 1048576
max_completion_tokens = 16384
```

`env_key = "MODAL_TOKEN"` expects a Bearer token Modal accepts for that endpoint
(Shared API product auth or Auto Endpoint proxy token). Rename the env var if
your ops convention differs — the TOML value is only the **name** of the
variable, not the secret.

**Verify:** set `MODAL_TOKEN` and your real `base_url`, then  
`selene -m k3-modal -p "Reply with exactly: K3-MD-OK"`.

> Modal is also an **OpenRouter upstream**. If you only need Modal’s fleet
> without a Modal account, Path 1 (OpenRouter) already covers that.

---

## Shared provider blocks (optional DRY)

When several models share one host, factor connection defaults:

```toml
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
# api_backend defaults to chat_completions

[model.k3-openrouter]
model = "moonshotai/kimi-k3"
model_provider = "openrouter"
name = "Kimi K3 (OpenRouter)"
system_prompt_label = "Kimi K3, a Moonshot AI model"
context_window = 1048576
max_completion_tokens = 16384
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `[model_providers.<id>]` | `ModelProviderConfig` | `crates/codegen/xai-grok-shell/src/agent/model_providers.rs:9–24` |
| `model_provider` | `ConfigModelOverride.model_provider` | `config.rs:4038` |
| `env_key` (on provider) | `ModelProviderConfig.env_key` | `model_providers.rs:12` |

Model-level fields win over provider defaults when both are set. A third-party
base **without** its own `api_key` / `env_key` / `auth_provider` is
**fail-closed** — the xAI session JWT is never sent to foreign hosts.

---

## Native grok rail (second; login-covered)

For subagent freight and first-party xAI models (including baked `grok-4.5` as
technical fallback):

| Mode | How |
|------|-----|
| Interactive | `selene login` (browser OAuth; credentials under `~/.selene/auth.json`) |
| Headless / CI | `export XAI_API_KEY="xai-..."` from https://console.x.ai |

```toml
# Optional explicit pin (usually unnecessary — baked catalog already has grok-4.5)
[model.grok-native]
model = "grok-4.5"
name = "Grok 4.5 (xAI)"
# No base_url: inherits first-party inference endpoints
# No env_key: uses session from `selene login`, else XAI_API_KEY
system_prompt_label = "Grok 4.5"
context_window = 500000
```

| | |
|--|--|
| Model | `grok-4.5` |
| Context | 500k *(as of 2026-07-30; re-verify)* |
| API pricing | Prompt &lt; 200k: **$2** in / **$0.30** cached / **$6** out; ≥200k doubles *(as of 2026-07-30; re-verify)* — https://docs.x.ai/developers/models |
| Quickstart | https://docs.x.ai/developers/quickstart |

**Verify:** after login or with `XAI_API_KEY` set:

```bash
selene -m grok-4.5 -p "Reply with exactly: GROK-OK"
```

K3 primary + grok freight = **two meters, two credentials**. Do not force a
single global base URL for both.

---

## Credential resolution (short)

For each model, Selene resolves keys in this order
(`resolve_credentials` in the shell agent config):

1. Per-model `api_key` (literal — avoid in shared configs)
2. Per-model `env_key` (first set, non-empty env among names)
3. Named `auth_provider` helper token
4. Session token from `selene login` — **only** when the model has no own
   credentials and the endpoint is first-party-safe
5. `XAI_API_KEY` (then legacy `GROK_CODE_XAI_API_KEY`)

Third-party K3 blocks **must** set `env_key` (or `api_key`) or requests fail
closed with no Authorization header.

---

## Appendix A — Anthropic workaround (workaround-tier)

Anthropic’s **native** Messages API is **not** a drop-in OpenAI `base_url` swap.
Selene supports it via `api_backend = "messages"` plus required headers.

**Gap:** `[model.*]` TOML cannot set `auth_scheme` today
(`auth_scheme` exists on runtime `ModelInfo` / `SamplerConfig` but **not** on
`ConfigModelOverride` — see Deferrals / product roadmap `auth_scheme` TOML).
Workaround: put the key in headers, not Bearer.

```toml
[model.claude-workaround]
model = "claude-sonnet-4-6"   # pick a current Anthropic id; re-verify
base_url = "https://api.anthropic.com/v1"
name = "Claude (Messages workaround)"
api_backend = "messages"
system_prompt_label = "Claude"
context_window = 200000
# Static version header + key from env (never commit the key):
extra_headers = { "anthropic-version" = "2023-06-01" }
env_http_headers = { "x-api-key" = "ANTHROPIC_API_KEY" }
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `api_backend` | `ConfigModelOverride.api_backend` (`messages` / `chat_completions` / `responses`) | `config.rs:4043` |
| `extra_headers` | `ConfigModelOverride.extra_headers` | `config.rs:4045` |
| `env_http_headers` | `ConfigModelOverride.env_http_headers` | `config.rs:4049` |
| *(gap)* `auth_scheme` | **not** on `ConfigModelOverride` — runtime `ModelInfo` only | do not invent in TOML |

**Verify:** `export ANTHROPIC_API_KEY=…` then  
`selene -m claude-workaround -p "Reply with exactly: CLAUDE-OK"`.

This path is documented for completeness. It is **not** a K3 headline path and
is **workaround-tier** until first-class `auth_scheme` lands on the TOML
surface.

Moonshot’s separate Anthropic-compatible base (`https://api.moonshot.ai/anthropic`)
is a Claude Code–style integration, not Anthropic’s own API and not required
for Selene’s OpenAI-compat K3 paths above.

---

## Appendix B — Cost and ops tips for K3

- **Output tokens dominate cost** because reasoning is always on. Prefer lower
  `reasoning_effort` when the task allows.
- Keep long **stable prefixes** (AGENTS.md, project doctrine) so provider prefix
  caches hit (`$0.30`/M class vs `$3`/M miss — *as of 2026-07-30; re-verify*).
- Leave `stream_tool_calls` unset/`false` on third-party hosts unless you know
  the endpoint accepts it.
- Do not enable xAI-only compaction headers on foreign hosts.
- Full multi-provider sample: [`examples/config.multi-provider.toml`](../examples/config.multi-provider.toml).
- Deep field reference: in-tree user guide
  `crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md`
  (upstream brand paths may still say `~/.grok` / `grok`; the fork home is
  `~/.selene` / binary `selene`).

---

## What not to do

- Do **not** expect a private house Modal slug or pre-baked K3 pin in the public
  binary — BYOK config is the product surface.
- Do **not** omit `system_prompt_label` on custom K3 models.
- Do **not** put API keys in git-tracked TOML; use `env_key`.
- Do **not** market baked `grok-4.5` as the default cooperation model — it is
  technical fallback and freight only.
