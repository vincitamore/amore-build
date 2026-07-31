# GLM-5.2 quickstart (headline model path)

Arcus Build ships with **GLM-5.2** configured as the default model, reached
over OpenRouter. That default is a config entry, not an architecture: the
harness is not a wrapper around GLM-5.2 or around any other model, and every
path below is the same `[model.*]` primitive pointed at a different host.
Native xAI grok subagent freight rides a second rail alongside it. This page
is the public on-ramp for the shipped default and the paths around it.

| Product role | Model path |
|--------------|------------|
| **Headline (shipped default)** | GLM-5.2 via OpenRouter, Z.ai direct, or any OpenAI-compatible host |
| **Native freight (second rail)** | xAI grok via `arcus login` or `XAI_API_KEY` |
| **Technical fallback only** | Baked catalog `grok-4.5` — never market this as the product default |

Config lives at **`~/.arcus/config.toml`** (override with `$ARCUS_HOME`;
legacy `$GROK_HOME` still works). Prefer **`env_key`** over a literal
`api_key` so secrets stay out of the file.

> **Identity rule (mandatory):** every custom `[model.<name>]` block **must**
> set `system_prompt_label`. An unlabeled model falls through the resolver
> chain to a default and will confidently answer to the wrong name
> (`resolve_system_prompt_label`,
> `crates/codegen/xai-grok-shell/src/util/config/resolve/system_prompt.rs`).
>
> The label must name **the harness and the role — never the model or its
> lab.** Upstream renders it literally as `You are <label>…`
> (`crates/codegen/xai-grok-agent/src/prompt/context.rs`, doc comment on
> `PromptContext.system_prompt_label`). A label naming the model is false the
> moment that entry is pointed at a different model, and the block it sits in
> is already per-model — the model name is never the thing missing from a
> `[model.<name>]` table, so a label that repeats it adds nothing and rots
> the first time the entry is repointed.
>
> The shipped default is **`"Arcus Build"`** (`DEFAULT_SYSTEM_PROMPT_LABEL`,
> same file). Test any label you write against this: read it back with a
> different model sitting behind that entry, and check whether it is still
> true.

> Pricing, model IDs, and host availability **rot**. Every such fact below is
> stamped **as of 2026-07-31; re-verify** against the linked vendor pages
> before you ship docs, screenshots, or onboarding copy.

---

## Preference order

1. **OpenRouter** — one key, multi-upstream routing, lowest onboarding friction
2. **Z.ai direct** — the model's own API surface
3. **Any other OpenAI-compatible host** — when you already have an account
   with a host that serves GLM-5.2, or you are pointing this same config
   shape at a different model entirely

All three are **OpenAI-compatible** Chat Completions paths. Arcus Build's
default `api_backend` is `chat_completions`; you do not need to set it for
these providers.

---

## 1. OpenRouter (recommended)

| | |
|--|--|
| Model ID on the wire | `z-ai/glm-5.2` |
| Base URL | `https://openrouter.ai/api/v1` |
| Auth env | `OPENROUTER_API_KEY` |
| Context | 1,048,576 tokens |
| Provider `max_completion_tokens` (OpenRouter-reported) | 128000 |
| List price (OpenRouter, live-queried against `https://openrouter.ai/api/v1/models`) | $1.12 input / $3.52 output / $0.208 cached input, per 1M tokens *(as of 2026-07-31; re-verify)* |
| Keys | https://openrouter.ai/keys |
| Model card | https://openrouter.ai/z-ai/glm-5.2 |

GLM-5.2 is a reasoning model: reasoning tokens are billed and budgeted as
completion tokens, out of the same pool `max_completion_tokens` caps.
OpenRouter reports a provider ceiling of **128000** for this model. Set it
there. A cap below the model's capability truncates the reasoning pass
before the visible answer begins, and nothing in the output tells you it
happened — you get a shorter, worse answer that looks like the model's best
work. This field is a ceiling, not a target: raising it costs nothing on
turns that do not need the room. If you want to bound spend, bound it
deliberately somewhere you will see it, rather than by quietly clipping how
far the model is allowed to think.

### `~/.arcus/config.toml`

```toml
[models]
default = "glm-openrouter"

[model.glm-openrouter]
model = "z-ai/glm-5.2"
base_url = "https://openrouter.ai/api/v1"
name = "GLM-5.2 (OpenRouter)"
env_key = "OPENROUTER_API_KEY"
system_prompt_label = "Arcus Build"
context_window = 1048576
# Reasoning tokens count against this. Too tight truncates mid-thought.
max_completion_tokens = 128000
# Optional ranking headers (OpenRouter docs):
# extra_headers = { "HTTP-Referer" = "https://example.com", "X-Title" = "Arcus Build" }
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `model` | `ConfigModelOverride.model` | `crates/codegen/xai-grok-shell/src/agent/config.rs` |
| `base_url` | `ConfigModelOverride.base_url` | same |
| `name` | `ConfigModelOverride.name` | same |
| `env_key` | `ConfigModelOverride.env_key` | same |
| `system_prompt_label` | `ConfigModelOverride.system_prompt_label` | same |
| `context_window` | `ConfigModelOverride.context_window` | same |
| `max_completion_tokens` | `ConfigModelOverride.max_completion_tokens` | same |
| `extra_headers` | `ConfigModelOverride.extra_headers` | same |
| `[models].default` | `ModelsConfig.default` | same file (`ModelsConfig`) |

### Verify

```bash
export OPENROUTER_API_KEY="sk-or-..."   # your key
arcus -m glm-openrouter -p "Reply with exactly: ARCUS-OR-OK"
```

Expect a short completion (GLM-5.2 reasons before it answers; output tokens
dominate cost). Then:

```bash
arcus models
```

You should see `glm-openrouter` listed. In the TUI, `/model glm-openrouter`
switches mid-session.

---

## 2. Z.ai direct

GLM-5.2 is made by Z.ai (智谱 / Zhipu; English company name Knowledge Atlas
Technology).

| | |
|--|--|
| Model ID | `glm-5.2` |
| Base URL | `https://api.z.ai/api/paas/v4` |
| Auth env | `ZAI_API_KEY` |
| Context | 1,048,576 tokens |
| Keys | https://z.ai/manage-apikey/apikey-list |
| Docs | https://docs.z.ai/guides/llm/glm-5.2 · API reference https://docs.z.ai/api-reference/introduction |

### `~/.arcus/config.toml`

```toml
[models]
default = "glm-zai"

[model.glm-zai]
model = "glm-5.2"
base_url = "https://api.z.ai/api/paas/v4"
name = "GLM-5.2 (Z.ai)"
env_key = "ZAI_API_KEY"
system_prompt_label = "Arcus Build"
context_window = 1048576
max_completion_tokens = 128000
```

### Verify

```bash
export ZAI_API_KEY="..."
arcus -m glm-zai -p "Reply with exactly: ARCUS-ZAI-OK"
```

---

## 3. Any other OpenAI-compatible host

Use this tier for a host that is neither OpenRouter nor Z.ai — a hyperscaler
endpoint, a dedicated deployment, or a different model entirely served over
an OpenAI-compatible Chat Completions API. The config table key is yours to
pick; `openweight` below is a placeholder name, not a reserved identifier.

Fill in the host's own wire model id, base URL, and auth env yourself. Arcus
Build does not ship a preset for hosts this page has not verified, and
inventing one here would be worse than shipping none.

```toml
[model.openweight]
model = "REPLACE-WITH-THE-HOST-WIRE-MODEL-ID"
base_url = "https://YOUR-HOST/v1"          # must be OpenAI-compatible, include /v1
name = "Open host"
env_key = "YOUR_HOST_API_KEY"
system_prompt_label = "Arcus Build"
context_window = 1048576
max_completion_tokens = 128000
```

`env_key` names the environment variable Arcus reads for the bearer token —
rename it to match your host's own convention; the TOML value is only the
**name** of the variable, never the secret.

**Verify:** set the environment variable your `env_key` names, and your real
`base_url`, then
`arcus -m openweight -p "Reply with exactly: ARCUS-OW-OK"`.

---

## Shared provider blocks (optional DRY)

When several models share one host, factor connection defaults:

```toml
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
# api_backend defaults to chat_completions

[model.glm-openrouter]
model = "z-ai/glm-5.2"
model_provider = "openrouter"
name = "GLM-5.2 (OpenRouter)"
system_prompt_label = "Arcus Build"
context_window = 1048576
max_completion_tokens = 128000
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `[model_providers.<id>]` | `ModelProviderConfig` | `crates/codegen/xai-grok-shell/src/agent/model_providers.rs` |
| `model_provider` | `ConfigModelOverride.model_provider` | `crates/codegen/xai-grok-shell/src/agent/config.rs` |
| `env_key` (on provider) | `ModelProviderConfig.env_key` | `model_providers.rs` |

Model-level fields win over provider defaults when both are set. A
third-party base **without** its own `api_key` / `env_key` / `auth_provider`
is **fail-closed** — the xAI session JWT is never sent to foreign hosts.

---

## Native grok rail (second; login-covered)

For subagent freight and first-party xAI models (including baked `grok-4.5`
as technical fallback):

| Mode | How |
|------|-----|
| Interactive | `arcus login` (browser OAuth; credentials under `~/.arcus/auth.json`) |
| Headless / CI | `export XAI_API_KEY="xai-..."` from https://console.x.ai |

```toml
# Optional explicit pin (usually unnecessary — baked catalog already has grok-4.5)
[model.grok-native]
model = "grok-4.5"
name = "Grok 4.5 (xAI)"
# No base_url: inherits first-party inference endpoints
# No env_key: uses session from `arcus login`, else XAI_API_KEY
system_prompt_label = "Arcus Build"
context_window = 500000
```

The label here is still `"Arcus Build"`, not `"Grok 4.5"` — the model name
already lives in `model` and `name`. The identity rule above does not carve
out an exception for the native rail: `[model.grok-native]` is exactly as
per-model as `[model.glm-openrouter]`, so the same rule applies.

| | |
|--|--|
| Model | `grok-4.5` |
| Quickstart | https://docs.x.ai/developers/quickstart |

**Verify:** after login or with `XAI_API_KEY` set:

```bash
arcus -m grok-4.5 -p "Reply with exactly: GROK-OK"
```

GLM-5.2 primary + grok freight = **two meters, two credentials**. Do not
force a single global base URL for both.

---

## Credential resolution (short)

For each model, Arcus resolves keys in this order
(`resolve_credentials` in the shell agent config):

1. Per-model `api_key` (literal — avoid in shared configs)
2. Per-model `env_key` (first set, non-empty env among names)
3. Named `auth_provider` helper token
4. Session token from `arcus login` — **only** when the model has no own
   credentials and the endpoint is first-party-safe
5. `XAI_API_KEY` (then legacy `GROK_CODE_XAI_API_KEY`)

Third-party GLM-5.2 blocks **must** set `env_key` (or `api_key`) or requests
fail closed with no Authorization header.

---

## Appendix A — Anthropic workaround (workaround-tier)

Anthropic's **native** Messages API is **not** a drop-in OpenAI `base_url`
swap. Arcus supports it via `api_backend = "messages"` plus required
headers.

**Gap:** `[model.*]` TOML cannot set `auth_scheme` today
(`auth_scheme` exists on runtime `ModelInfo` / `SamplerConfig` but **not** on
`ConfigModelOverride`). Workaround: put the key in headers, not Bearer.

```toml
[model.claude-workaround]
model = "claude-sonnet-4-6"   # pick a current Anthropic id; re-verify
base_url = "https://api.anthropic.com/v1"
name = "Claude (Messages workaround)"
api_backend = "messages"
system_prompt_label = "Arcus Build"
context_window = 200000
# Static version header + key from env (never commit the key):
extra_headers = { "anthropic-version" = "2023-06-01" }
env_http_headers = { "x-api-key" = "ANTHROPIC_API_KEY" }
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `api_backend` | `ConfigModelOverride.api_backend` (`messages` / `chat_completions` / `responses`) | `crates/codegen/xai-grok-shell/src/agent/config.rs` |
| `extra_headers` | `ConfigModelOverride.extra_headers` | same |
| `env_http_headers` | `ConfigModelOverride.env_http_headers` | same |
| *(gap)* `auth_scheme` | **not** on `ConfigModelOverride` — runtime `ModelInfo` only | do not invent in TOML |

**Verify:** `export ANTHROPIC_API_KEY=…` then
`arcus -m claude-workaround -p "Reply with exactly: CLAUDE-OK"`.

This path is documented for completeness. It is **not** the headline path
and is **workaround-tier** until first-class `auth_scheme` lands on the
TOML surface.

---

## Appendix B — Cost and ops tips

- **Output tokens dominate cost** on a reasoning model, because the
  reasoning pass itself draws from completion budget before the visible
  answer does. A `max_completion_tokens` cap below the model's
  ceiling truncates the reasoning pass invisibly — set it to the provider
  ceiling and bound spend somewhere you can see it.
- Keep long **stable prefixes** (AGENTS.md, project doctrine) so that any
  provider-side prompt-caching discount applies where the host offers one —
  GLM-5.2 on OpenRouter prices cached input well below cache-miss input (see
  the pricing row above).
- Leave `stream_tool_calls` unset/`false` on third-party hosts unless you
  know the endpoint accepts it.
- Do not enable xAI-only compaction headers on foreign hosts.
- Full multi-provider sample: [`examples/config.multi-provider.toml`](../examples/config.multi-provider.toml).
- Deep field reference: in-tree user guide
  `crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md`
  (upstream brand paths may still say `~/.grok` / `grok`; the fork home is
  `~/.arcus` / binary `arcus`).

---

## What not to do

- Do **not** expect a private preset or a pre-baked GLM-5.2 pin beyond what
  is shown here — BYOK config is the product surface.
- Do **not** omit `system_prompt_label` on any custom model.
- Do **not** name the model, or its lab, inside `system_prompt_label` — name
  the harness and the role instead. Run the read-it-back test from the
  identity rule above before shipping a label.
- Do **not** put API keys in git-tracked TOML; use `env_key`.
- Do **not** market baked `grok-4.5` as the default cooperation model — it is
  technical fallback and freight only.
