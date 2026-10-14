# Third-party provider OAuth (OpenAI Codex / ChatGPT Plus & Pro)

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

## Managing credentials

- **Location:** `~/.amore/oauth-credentials.json` (owner-only `0600` permissions on Unix; corrupt files are backed up with a `.corrupt.<timestamp>` suffix and the store resets cleanly).
- **Refresh:** tokens refresh automatically within 5 minutes of expiry before a request is sent. Refreshes use a compare-and-set on the stored refresh token so concurrent processes never clobber a sibling's rotated token.
- **Sign out:** remove the `"openai"` entry from `~/.amore/oauth-credentials.json` (or delete the file). `amore logout` only affects the xAI account session in `auth.json`.
