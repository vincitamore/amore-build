# Third-party provider OAuth (OpenAI Codex, Google Antigravity)

`amore login --provider <name>` signs in with a third-party model provider's
OAuth flow and stores credentials in `~/.amore/oauth-credentials.json`,
separate from the xAI account credential in `auth.json`. A model entry
references the stored credential with `api_key = "oauth:<provider>"`, and
every request reads the store and refreshes the token automatically when it
nears expiry.

## OpenAI (ChatGPT Plus/Pro via Codex OAuth)

### Browser PKCE login

```sh
amore login --provider openai
```

This runs the OpenAI Codex OAuth 2.0 PKCE flow (`https://auth.openai.com/oauth/authorize`,
client `app_EMoamEEZ73f0CkXaXp7hrann`) with a loopback callback listener on
`http://localhost:1455/auth/callback` (both IPv4 `127.0.0.1:1455` and IPv6
`[::1]:1455`), plus a stdin manual-paste fallback for remote or SSH sessions.
`amore login --provider openai-codex` is accepted as an alias.

### Headless device-code login

When port `1455` is unavailable or you are signing in on a headless machine:

```sh
amore login --provider openai --device-auth
# or:
amore login --provider openai-codex-device
```

This requests a user code from `https://auth.openai.com/api/accounts/deviceauth/usercode`,
prints the verification URL (`https://auth.openai.com/codex/device`) and
one-time code, polls `https://auth.openai.com/api/accounts/deviceauth/token`
until approved, exchanges the resulting authorization code for OAuth tokens,
and stores them under the same `openai` provider slot.

### Model configuration (`~/.amore/config.toml`)

Point any OpenAI Codex model entry at `api_key = "oauth:openai"` (or
`"oauth:openai-codex"`):

```toml
[model.gpt-5-4-codex]
model = "gpt-5.4"
name = "GPT-5.4 (ChatGPT Codex OAuth)"
api_key = "oauth:openai"
base_url = "https://chatgpt.com/backend-api"
api_backend = "responses"
system_prompt_label = "Amore Build"
context_window = 272000
```

When `api_key = "oauth:openai"` is set on a model entry, `base_url` defaults
to `https://chatgpt.com/backend-api`, `api_backend` defaults to `"responses"`,
and `supports_reasoning_effort` defaults to `true`.

Requests made with an OpenAI Codex OAuth JWT automatically target
`/codex/responses` and carry the Codex wire contract:
- `Authorization: Bearer <access_token>` (with `x-grok-*` and `x-api-key` stripped)
- `chatgpt-account-id` and `x-openai-internal-codex-residency` extracted from the token's `https://api.openai.com/auth` claims
- `OpenAI-Beta: responses=experimental`, `originator: omp`, `version: 0.159.0`, and `x-codex-routing-hint: model=<model>`
- `session_id`, `conversation_id`, `session-id`, and `x-client-request-id`
- System prompts lifted to top-level `instructions` (first system message) and `developer` role input messages (subsequent system messages), `store: false`, `stream: true`, `include: ["reasoning.encrypted_content"]`, and unsupported sampling parameters (`max_output_tokens`, `max_completion_tokens`, `temperature`, `top_p`) omitted.

## Google Antigravity (Gemini 3, Claude, GPT-OSS via Cloud Code Assist)

### Browser PKCE login

```sh
amore login --provider google-antigravity
# or:
amore login --provider antigravity
```

This runs the Google Antigravity OAuth 2.0 PKCE flow (`https://accounts.google.com/o/oauth2/v2/auth`)
with a loopback callback listener on `http://127.0.0.1:51121/oauth-callback`
(automatically falling back to an ephemeral loopback port if `51121` is in
use, plus a stdin manual-paste fallback for remote or SSH sessions), fetches
the account email from `https://www.googleapis.com/oauth2/v1/userinfo?alt=json`,
calls `v1internal:loadCodeAssist` on `https://daily-cloudcode-pa.googleapis.com`
(provisioning the `free-tier` via `v1internal:onboardUser` when the account
has no active tier yet), and stores the token pair alongside the discovered
`cloudaicompanionProject` ID under the `google-antigravity` provider slot.

### Model configuration (`~/.amore/config.toml`)

Point any Google Antigravity model entry at `api_key = "oauth:google-antigravity"`
(or `"oauth:antigravity"`):

```toml
[model.antigravity-gemini-3-1-pro]
model = "gemini-3.1-pro"
name = "Gemini 3.1 Pro Preview (Antigravity OAuth)"
api_key = "oauth:google-antigravity"
base_url = "https://daily-cloudcode-pa.googleapis.com"
api_backend = "messages"
system_prompt_label = "Amore"
context_window = 1048576
max_completion_tokens = 65535

[model.antigravity-claude-opus-4-6]
model = "claude-opus-4-6"
name = "Claude Opus 4.6 (Antigravity OAuth)"
api_key = "oauth:google-antigravity"
base_url = "https://daily-cloudcode-pa.googleapis.com"
api_backend = "messages"
system_prompt_label = "Amore"
context_window = 250000
max_completion_tokens = 64000
```

| Model ID (`model`) | Display Name | `context_window` | `max_completion_tokens` | Wire Routing / Thinking |
|---|---|---:|---:|---|
| `gemini-4-argon` | Gemini 4 Argon | `1048576` | `65536` | `gemini-4-argon-{low,medium,high}` (`thinkingLevel`) |
| `gemini-3.8-flash` | Gemini 3.8 Flash | `1048576` | `65536` | `gemini-3.8-flash-{low,medium,high}` (`thinkingLevel`) |
| `gemini-3.7-flash` | Gemini 3.7 Flash | `1048576` | `65536` | `gemini-3.7-flash-{low,medium,high}` (`thinkingLevel`) |
| `gemini-3.6-flash` | Gemini 3.6 Flash | `1048576` | `65536` | `gemini-3.6-flash-{low,medium,high}` (`thinkingLevel`) |
| `gemini-3.5-flash` | Gemini 3.5 Flash | `1048576` | `65536` | `gemini-3.5-flash-extra-low` (1000) / `gemini-3.5-flash-low` (4000) / `gemini-3-flash-agent` (10000) |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | `1048576` | `65535` | `thinkingLevel` (`MINIMAL`..`HIGH`) |
| `gemini-3.1-pro` | Gemini 3.1 Pro Preview | `1048576` | `65535` | `gemini-3.1-pro-low` (1001) / `gemini-pro-agent` (10001) |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | `1048576` | `65535` | `thinkingLevel` (`MINIMAL`..`HIGH`) |
| `gemini-3-pro` | Gemini 3 Pro | `1048576` | `65535` | `gemini-3-pro-{low,high}` (`thinkingLevel`) |
| `gemini-3-flash` | Gemini 3 Flash | `1048576` | `65536` | `gemini-3.5-flash-extra-low` (1000) / `gemini-3.5-flash-low` (4000) / `gemini-3-flash-agent` (10000) |
| `gemini-2.5-pro` | Gemini 2.5 Pro | `1048576` | `65536` | `thinkingBudget` |
| `gemini-2.5-flash` | Gemini 2.5 Flash | `1048576` | `65535` | `gemini-2.5-flash` / `gemini-2.5-flash-thinking` (`thinkingBudget`) |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash-Lite | `1048576` | `65535` | `thinkingBudget` |
| `claude-opus-5-5` | Claude Opus 5.5 | `1000000` | `128000` | `claude-opus-5-5-{low,medium,high}` (`thinkingBudget`) |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | `1000000` | `128000` | `claude-sonnet-5-5-{low,medium,high}` (`thinkingBudget`) |
| `claude-opus-4-6` | Claude Opus 4.6 | `250000` | `64000` | `claude-opus-4-6-thinking` (`thinkingBudget`) |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | `250000` | `64000` | `claude-sonnet-4-6` (`thinkingBudget`) |
| `claude-opus-4-5` | Claude Opus 4.5 | `200000` | `64000` | `claude-opus-4-5` / `claude-opus-4-5-thinking` (`thinkingBudget`) |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | `1000000` | `64000` | `claude-sonnet-4-5` / `claude-sonnet-4-5-thinking` (`thinkingBudget`) |
| `gpt-oss-120b` | GPT OSS 120B | `131072` | `32768` | `gpt-oss-120b-medium` (`thinkingBudget`) |

When `api_key = "oauth:google-antigravity"` is set on a model entry,
`base_url` defaults to `https://daily-cloudcode-pa.googleapis.com`,
`api_backend` defaults to `"messages"`, and `supports_reasoning_effort`
defaults to `true`.

Requests made against the Cloud Code Assist endpoint automatically target
`/v1internal:streamGenerateContent?alt=sse` and carry the Antigravity wire
contract:
- `Authorization: Bearer <access_token>` and `User-Agent: antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64; cl=963137146)` (overridable via `AMORE_ANTIGRAVITY_VERSION`, `_CL`, `_OS`, `_ARCH`)
- `anthropic-beta: interleaved-thinking-2025-05-14` on Claude thinking turns
- Effort-tier wire model routing (`gemini-3.1-pro` -> `gemini-pro-agent` / `gemini-3.1-pro-low`, `gemini-3.5-flash` -> `gemini-3.5-flash-extra-low` / `gemini-3.5-flash-low` / `gemini-3-flash-agent`, `gemini-3.7-flash` -> `gemini-3.7-flash-{low,medium,high}`, `claude-opus-4-6` -> `claude-opus-4-6-thinking`, `claude-sonnet-4-6` -> `claude-sonnet-4-6`, etc.) with per-model `maxOutputTokens` and `labels.model_enum`
- Automatic translation of streamed Cloud Code Assist `candidates` (thoughts, text, `thoughtSignature`, `functionCall`, and `usageMetadata`) into the harness's streaming event pipeline.

## Managing credentials

- **Location:** `~/.amore/oauth-credentials.json` (owner-only `0600` permissions on Unix; corrupt files are backed up with a `.corrupt.<timestamp>` suffix and the store resets cleanly).
- **Refresh:** tokens refresh automatically within 5 minutes of expiry before a request is sent. Refreshes use a compare-and-set on the stored refresh token so concurrent processes never clobber a sibling's rotated token.
- **Sign out:** remove the `"openai"` or `"google-antigravity"` entry from `~/.amore/oauth-credentials.json` (or delete the file). `amore logout` only affects the xAI account session in `auth.json`.
