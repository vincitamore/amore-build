# Model setup (BYOK quickstart)

Amore Build is **model-agnostic by design**: every model is a `[model.*]`
config entry pointed at an OpenAI-compatible endpoint, and the identity the
model is given never names a model — so entries can be added, swapped, and
compared without the harness caring which one is behind them. The wizard
ships verified recipes as a convenience, not as a binding.

| Product role | Model path |
|--------------|------------|
| **Recommended default** | DeepSeek V4 Flash via OpenRouter — the maintainer's daily driver |
| **Also verified** | GLM-5.2 (OpenRouter or Z.ai direct), DeepSeek direct |
| **Bring anything** | Any OpenAI-compatible host serving any model |
| **Native freight (second rail)** | xAI grok via `amore login` or `XAI_API_KEY` |
| **Technical fallback only** | Baked catalog `grok-4.5` — never market this as the product default |

Config lives at **`~/.amore/config.toml`** (override with `$AMORE_HOME`;
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
> The shipped default is **`"Amore Build"`** (`DEFAULT_SYSTEM_PROMPT_LABEL`,
> same file). Test any label you write against this: read it back with a
> different model sitting behind that entry, and check whether it is still
> true.

> Pricing, model IDs, provider ceilings, and host availability **rot**. Every
> such fact below is stamped **as of 2026-08-04; re-verify** against the
> linked vendor pages before you rely on them. (The previous revision of this
> page was stamped 2026-07-31; two of its numbers had already moved by
> 2026-08-04.)

---

## Reasoning models and `max_completion_tokens`

Most recipes below are reasoning models: reasoning tokens are billed and
budgeted as completion tokens, out of the same pool `max_completion_tokens`
caps. Set that field to the **provider's reported ceiling for the model** —
it is a ceiling, not a target, and raising it costs nothing on turns that do
not need the room. A cap below the ceiling truncates the reasoning pass
before the visible answer begins, and nothing in the output tells you it
happened — you get a shorter, worse answer that looks like the model's best
work. If you want to bound spend, bound it deliberately somewhere you will
see it, rather than by quietly clipping how far the model is allowed to
think.

Ceilings differ per route (the same model behind two hosts can report two
different ceilings) — take the number from the route you configure, not from
the model card.

---

## 1. DeepSeek V4 Flash via OpenRouter (recommended)

The maintainer's daily driver in this harness.

| | |
|--|--|
| Model ID on the wire | `deepseek/deepseek-v4-flash-0731` |
| Base URL | `https://openrouter.ai/api/v1` |
| Auth env | `OPENROUTER_API_KEY` |
| Context | 1,048,576 tokens |
| Provider completion ceiling (OpenRouter-reported) | 65,536 |
| List price (live-queried against `https://openrouter.ai/api/v1/models`) | $0.09 input / $0.18 output / $0.018 cached input, per 1M tokens *(as of 2026-08-04; re-verify)* |
| Keys | https://openrouter.ai/keys |
| Model card | https://openrouter.ai/deepseek/deepseek-v4-flash-0731 |

Mind the `-0731` suffix: `deepseek/deepseek-v4-flash` (no suffix) is the
older 0423 release at a different price and ceiling. Benchmarks quoted for
one do not transfer to the other.

### `~/.amore/config.toml`

```toml
[models]
default = "deepseek-openrouter"

[model.deepseek-openrouter]
model = "deepseek/deepseek-v4-flash-0731"
base_url = "https://openrouter.ai/api/v1"
name = "DeepSeek V4 Flash (OpenRouter)"
env_key = "OPENROUTER_API_KEY"
system_prompt_label = "Amore Build"
context_window = 1048576
# Reasoning tokens count against this cap. This is the OpenRouter-reported
# provider ceiling for this model (as of 2026-08-04) — a ceiling, not a
# target; a lower cap truncates the reasoning pass invisibly.
max_completion_tokens = 65536
# Optional ranking headers (OpenRouter docs):
# extra_headers = { "HTTP-Referer" = "https://example.com", "X-Title" = "Amore Build" }
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
amore -m deepseek-openrouter -p "Reply with exactly: AMORE-DS-OK"
```

Then:

```bash
amore models
```

You should see `deepseek-openrouter` listed. In the TUI,
`/model deepseek-openrouter` switches mid-session.

---

## 2. DeepSeek direct

The model's own API surface (OpenAI-compatible).

| | |
|--|--|
| Model ID | `deepseek-v4-flash` (serves DeepSeek-V4-Flash-0731) |
| Base URL | `https://api.deepseek.com` |
| Auth env | `DEEPSEEK_API_KEY` |
| Context | 1M tokens |
| Max output (vendor-reported) | 384K tokens |
| List price (vendor pricing page) | $0.14 input (cache miss) / $0.0028 input (cache hit) / $0.28 output, per 1M tokens *(as of 2026-08-04; re-verify — the vendor has announced peak/off-peak pricing)* |
| Keys | https://platform.deepseek.com/api_keys |
| Docs | https://api-docs.deepseek.com |

```toml
[models]
default = "deepseek-direct"

[model.deepseek-direct]
model = "deepseek-v4-flash"
base_url = "https://api.deepseek.com"
name = "DeepSeek V4 Flash (direct)"
env_key = "DEEPSEEK_API_KEY"
system_prompt_label = "Amore Build"
context_window = 1048576
max_completion_tokens = 393216
```

**Verify:** `export DEEPSEEK_API_KEY="..."` then
`amore -m deepseek-direct -p "Reply with exactly: AMORE-DSD-OK"`.

---

## 3. GLM-5.2 via OpenRouter

| | |
|--|--|
| Model ID on the wire | `z-ai/glm-5.2` |
| Base URL | `https://openrouter.ai/api/v1` |
| Auth env | `OPENROUTER_API_KEY` |
| Context | 1,048,576 tokens |
| Provider completion ceiling (OpenRouter-reported) | 262,144 *(moved from 128,000 since the last stamp — this number tracks OpenRouter's current top provider and drifts)* |
| List price | $0.76 input / $2.42 output / $0.14 cached input, per 1M tokens *(as of 2026-08-04; re-verify — down from $1.12/$3.52/$0.208 at the 2026-07-31 stamp)* |
| Model card | https://openrouter.ai/z-ai/glm-5.2 |

```toml
[model.glm-openrouter]
model = "z-ai/glm-5.2"
base_url = "https://openrouter.ai/api/v1"
name = "GLM-5.2 (OpenRouter)"
env_key = "OPENROUTER_API_KEY"
system_prompt_label = "Amore Build"
context_window = 1048576
max_completion_tokens = 128000
```

**Verify:** `amore -m glm-openrouter -p "Reply with exactly: AMORE-OR-OK"`.

---

## 4. GLM-5.2 via Z.ai direct

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

```toml
[model.glm-zai]
model = "glm-5.2"
base_url = "https://api.z.ai/api/paas/v4"
name = "GLM-5.2 (Z.ai)"
env_key = "ZAI_API_KEY"
system_prompt_label = "Amore Build"
context_window = 1048576
max_completion_tokens = 128000
```

**Verify:** `export ZAI_API_KEY="..."` then
`amore -m glm-zai -p "Reply with exactly: AMORE-ZAI-OK"`.

---

## 5. Any other OpenAI-compatible host

Use this tier for any host the recipes above do not cover — a hyperscaler
endpoint, a self-hosted vLLM/SGLang deployment, or a different model
entirely served over an OpenAI-compatible Chat Completions API. The config
table key is yours to pick; `openweight` below is a placeholder name, not a
reserved identifier.

Fill in the host's own wire model id, base URL, and auth env yourself. Amore
Build does not ship a preset for hosts this page has not verified, and
inventing one here would be worse than shipping none.

```toml
[model.openweight]
model = "REPLACE-WITH-THE-HOST-WIRE-MODEL-ID"
base_url = "https://YOUR-HOST/v1"          # must be OpenAI-compatible, include /v1
name = "Open host"
env_key = "YOUR_HOST_API_KEY"
system_prompt_label = "Amore Build"
context_window = 1048576
max_completion_tokens = 128000             # set to YOUR host's reported ceiling
```

`env_key` names the environment variable Amore reads for the bearer token —
rename it to match your host's own convention; the TOML value is only the
**name** of the variable, never the secret.

**Verify:** set the environment variable your `env_key` names, and your real
`base_url`, then
`amore -m openweight -p "Reply with exactly: AMORE-OW-OK"`.

### Streamed reasoning traces (route-dependent)

The field a provider streams the reasoning trace in is a property of the
**route**, not the model: OpenRouter normalizes to `reasoning`, while direct
APIs (xAI, DeepSeek, Z.ai, self-hosted vLLM/SGLang) send
`reasoning_content`. Amore Build deserializes **both** spellings
(`#[serde(alias = "reasoning")]` on `ChatChunkDelta.reasoning_content`,
`crates/codegen/xai-grok-sampling-types/src/types.rs`), so traces render on
either route. If thinking blocks are missing on some custom host, check
`[ui] show_thinking_blocks` first, then the wire field name — not the
model's reasoning effort.

---

## Shared provider blocks (optional DRY)

When several models share one host, factor connection defaults:

```toml
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
# api_backend defaults to chat_completions

[model.deepseek-openrouter]
model = "deepseek/deepseek-v4-flash-0731"
model_provider = "openrouter"
name = "DeepSeek V4 Flash (OpenRouter)"
system_prompt_label = "Amore Build"
context_window = 1048576
max_completion_tokens = 65536

[model.glm-openrouter]
model = "z-ai/glm-5.2"
model_provider = "openrouter"
name = "GLM-5.2 (OpenRouter)"
system_prompt_label = "Amore Build"
context_window = 1048576
max_completion_tokens = 128000
```

| TOML field | Maps to | Evidence |
|------------|---------|----------|
| `[model_providers.<id>]` | `ModelProviderConfig` | `crates/codegen/xai-grok-shell/src/agent/model_providers.rs` |
| `model_provider` | `ConfigModelOverride.model_provider` | `crates/codegen/xai-grok-shell/src/agent/config.rs` |
| `env_key` (on provider) | `ModelProviderConfig.env_key` | `model_providers.rs` |

Model-level fields win over provider defaults when both are set.

---

## Native grok rail (second; login-covered)

For subagent freight and first-party xAI models (including baked `grok-4.5`
as technical fallback):

| Mode | How |
|------|-----|
| Interactive | `amore login` (browser OAuth; credentials under `~/.amore/auth.json`) |
| Headless / CI | `export XAI_API_KEY="xai-..."` from https://console.x.ai |

```toml
# Optional explicit pin (usually unnecessary — baked catalog already has grok-4.5)
[model.grok-native]
model = "grok-4.5"
name = "Grok 4.5 (xAI)"
# No base_url: inherits first-party inference endpoints
# No env_key: uses session from `amore login`, else XAI_API_KEY
system_prompt_label = "Amore Build"
context_window = 500000
```

The label here is still `"Amore Build"`, not `"Grok 4.5"` — the model name
already lives in `model` and `name`. The identity rule above does not carve
out an exception for the native rail: `[model.grok-native]` is exactly as
per-model as any BYOK block, so the same rule applies.

**Verify:** after login or with `XAI_API_KEY` set:

```bash
amore -m grok-4.5 -p "Reply with exactly: GROK-OK"
```

BYOK primary + grok freight = **two meters, two credentials**. Do not force
a single global base URL for both.

---

## Credential resolution (short)

For each model, Amore resolves keys in this order
(`resolve_credentials` in the shell agent config):

1. Per-model `api_key` (literal — avoid in shared configs)
2. Per-model `env_key` (first set, non-empty env among names)
3. Named `auth_provider` helper token
4. Session token from `amore login`
5. `XAI_API_KEY` (then legacy `GROK_CODE_XAI_API_KEY`)

A model's **own** credential always wins: a third-party block that sets
`env_key` (or `api_key`) never receives the session JWT or `XAI_API_KEY`.
That is why third-party blocks **must** set one — omitting it is a
misconfiguration that falls through to credentials that were never meant for
that host (or to no Authorization header at all when nothing is set). Do not
rely on the fallthrough; set `env_key`.

---

## Appendix A — Anthropic workaround (workaround-tier)

Anthropic's **native** Messages API is **not** a drop-in OpenAI `base_url`
swap. Amore supports it via `api_backend = "messages"` plus required
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
system_prompt_label = "Amore Build"
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
`amore -m claude-workaround -p "Reply with exactly: CLAUDE-OK"`.

This path is documented for completeness. It is **not** a headline path and
is **workaround-tier** until first-class `auth_scheme` lands on the TOML
surface.

---

## Appendix B — Cost and ops tips

- **Output tokens dominate cost** on a reasoning model, because the
  reasoning pass itself draws from completion budget before the visible
  answer does. Set `max_completion_tokens` to the provider ceiling and bound
  spend somewhere you can see it.
- Keep long **stable prefixes** (AGENTS.md, project doctrine) so that any
  provider-side prompt-caching discount applies where the host offers one —
  both recommended recipes price cached input well below cache-miss input
  (see the pricing rows above).
- Leave `stream_tool_calls` unset/`false` on third-party hosts unless you
  know the endpoint accepts it.
- Do not enable xAI-only compaction headers on foreign hosts.
- Full multi-provider sample: [`examples/config.multi-provider.toml`](../examples/config.multi-provider.toml).
- Deep field reference: in-tree user guide
  `crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md`
  (upstream brand paths may still say `~/.grok` / `grok`; the fork home is
  `~/.amore` / binary `amore`).

---

## What not to do

- Do **not** expect a private preset beyond what is shown here — BYOK config
  is the product surface.
- Do **not** omit `system_prompt_label` on any custom model.
- Do **not** name the model, or its lab, inside `system_prompt_label` — name
  the harness and the role instead. Run the read-it-back test from the
  identity rule above before shipping a label.
- Do **not** put API keys in git-tracked TOML; use `env_key`.
- Do **not** market baked `grok-4.5` as the default cooperation model — it is
  technical fallback and freight only.
