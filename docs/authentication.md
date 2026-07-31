# Authentication

Arcus Build has **two independent credential rails**. Pick one per model path —
they do not require each other.

| Rail | What it covers | How you enroll |
|------|----------------|----------------|
| **OAuth session** (`arcus login`) | First-party model catalog + native grok subagent freight | Interactive browser (PKCE) or device-code |
| **BYOK** (bring your own key) | Any `[model.*]` with its own key, including the headline GLM-5.2 path | Env / TOML — **never** needs OAuth |

For the headline model setup (OpenRouter / Z.ai / any OpenAI-compatible host), see
[setup-glm.md](setup-glm.md). For what `arcus init` installs into a repo, see
[onboarding.md](onboarding.md).

---

## OAuth PKCE login (`arcus login`)

Default interactive sign-in is **OAuth 2.1 / OIDC Authorization Code + PKCE**
against the xAI issuer (`https://auth.x.ai`). The CLI is a **public client**:
there is **no client secret**. The token exchange sends `grant_type`, `code`,
`redirect_uri`, `client_id`, and `code_verifier` only.

| Step | Behavior | Source |
|------|----------|--------|
| PKCE S256 | 32 random bytes → verifier; SHA-256 challenge | `crates/codegen/xai-grok-shell/src/auth/oidc/protocol.rs` (`generate_pkce`) |
| Authorize | `response_type=code`, scopes, `code_challenge_method=S256` | same file (`build_authorize_url`) |
| Loopback | Local callback on `127.0.0.1` path `/callback` | `…/auth/oidc/login.rs` |
| Token exchange | Form body **without** `client_secret` | `protocol.rs` (`exchange_code`) |
| CLI entry | `arcus login` → `run_cli_login` | `crates/codegen/xai-grok-pager-bin/src/main.rs` → `xai_grok_shell::auth::run_cli_login` |

```bash
arcus login                 # browser / loopback (default)
arcus login --oauth         # force OAuth loopback
arcus login --device-auth   # device-code (headless / remote)
arcus logout                # clear cached session
```

### Scopes (one login → catalog + subagent freight)

Default xAI OAuth2 scopes are a **frozen client contract** (unit-tested). They
include both `grok-cli:access` (API proxy / CLI traffic) and `api:access`, plus
conversation and workspace scopes:

```
openid, profile, email, offline_access,
grok-cli:access, api:access,
conversations:read, conversations:write,
workspaces:read, workspaces:write
```

| Claim | Source |
|-------|--------|
| Scope list + `grok-cli:access` purpose | `crates/codegen/xai-grok-shell/src/auth/config.rs` (`default_oauth2_scopes`, comment at top of that fn) |
| Frozen contract test | same file, `default_oauth2_scopes_are_frozen` |
| Sampling uses session when model has no own key | `crates/codegen/xai-grok-shell/src/agent/config.rs` (`resolve_credentials`) |
| Wire auth type / scheme on resolved creds | same (`ResolvedCredentials.auth_type`, `auth_scheme`) |
| Subagents inherit parent sampling credential lineage | `crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs` (`subagent_auth_type` / inherited auth) |

**Practical meaning:** one successful `arcus login` is enough for first-party
catalog models **and** native subagent freight that ride the same session.
Third-party / BYOK models never consume that session JWT (see dual-rail below).

### `~/.arcus/auth.json` (shape only — never print contents)

Home defaults to **`~/.arcus`** (override with `$ARCUS_HOME` / legacy
`$GROK_HOME`). Credentials live at `{home}/auth.json` unless
`$ARCUS_AUTH_PATH` / `$GROK_AUTH_PATH` points elsewhere.

| Fact | Source |
|------|--------|
| Default home `~/.arcus` | `crates/codegen/xai-grok-config/src/paths.rs` (`default_grok_home` / `grok_home`) |
| Path resolution (`ARCUS_AUTH` inline JSON, `ARCUS_AUTH_PATH`, else `{home}/auth.json`) | `crates/codegen/xai-grok-shell/src/auth/manager.rs` |
| Store type | `AuthStore = BTreeMap<String, GrokAuth>` in `…/auth/model.rs` |
| OAuth top-level key | `{issuer}::{client_id}` via `OAuth2ProviderConfig::base_auth_scope` in `…/auth/config.rs` (for the default public client the second segment is a UUID) |
| Plain API-key scope key | `xai::api_key` (`API_KEY_SCOPE` in `model.rs`) |
| Owner-only file perms (Unix `0600`) | `…/auth/storage.rs` (read/write paths) |

**Do not** open, paste, commit, or screenshot `auth.json` contents. Treat the
file like a password store. It is already gitignored in normal installs; never
add it to a repository.

---

## Anti-copy rule (load-bearing)

> **Never copy `auth.json` between installs or machines.**

Refresh tokens **rotate**. Two processes that **share the same file** (same
`$ARCUS_HOME`) are fine: they flock `auth.json.lock`, and the loser adopts the
winner’s rotated tokens from disk.

Two installs that each hold a **copy** of the same refresh token are not fine:

1. Install A refreshes → IdP rotates the refresh-token family; only A’s file updates.
2. Install B spends the old refresh token → IdP reuse detection can **revoke the whole family**.
3. Both installs break until each runs a fresh login.

| Mechanism | Source |
|-----------|--------|
| “Two processes must not spend the same refresh token” | `crates/codegen/xai-grok-shell/src/auth/storage.rs` (`AuthFileLock::still_live` docs) |
| Sibling rotation vs real revocation | `…/auth/refresh/mod.rs` (`tried_refresh_token` on permanent failure) |

**If auth errors appear after cloning a machine image, syncing a home folder, or
restoring a backup of `auth.json`:** delete the bad file (or `arcus logout`) and
run **`arcus login` again** on that install. Do not “fix” by recopying.

Independent `arcus login` on each machine is the supported multi-machine model
(each login mints its own grant).

---

## Env and TOML rails

### Provider-named API key (unchanged)

| Variable | Role |
|----------|------|
| `XAI_API_KEY` | Primary env API key for first-party xAI sampling when no session / BYOK wins |
| `GROK_CODE_XAI_API_KEY` | Legacy fallback for the same key |

These names are **provider-named**, not product-named: they are **not** aliased
to `ARCUS_*`.

| Source |
|--------|
| `crates/codegen/xai-grok-shell/src/agent/auth_method.rs` (`XAI_API_KEY_ENV_VAR`, `LEGACY_XAI_API_KEY_ENV_VAR`, `read_xai_api_key_env`) |
| `crates/codegen/xai-grok-env/src/identity.rs` (comment: `XAI_*` stay provider-named) |

### Per-model BYOK in `~/.arcus/config.toml`

Under `[model.<name>]`, prefer `env_key` over a literal `api_key` so secrets stay
out of the file. Full examples: [setup-glm.md](setup-glm.md).

```toml
[model.glm-openrouter]
model = "z-ai/glm-5.2"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
# The harness and the role — never the model. See setup-glm.md.
system_prompt_label = "Arcus Build"
```

| Field | Role | Source |
|-------|------|--------|
| `api_key` | Literal bearer (avoid in shared configs) | `ConfigModelOverride` in `…/agent/config.rs` |
| `env_key` | Env var name(s) to resolve | same |
| Resolution order | own `api_key`/`env_key` → auth_provider cache → **session** → `XAI_API_KEY` | `resolve_credentials` in same file |

### `ARCUS_*` primary, `GROK_*` legacy

Wave-3 env identity: for mapped suffixes, **`ARCUS_*` wins** when both are set;
legacy `GROK_*` is read silently when primary is absent. Auth-related mappings
include exact `AUTH` and the `AUTH_*` / `CLI_*` wildcards.

| Primary | Legacy | Notes |
|---------|--------|-------|
| `ARCUS_HOME` | `GROK_HOME` | Config + `auth.json` home |
| `ARCUS_AUTH` | `GROK_AUTH` | Inline JSON credential (read-only boot path) |
| `ARCUS_AUTH_PATH` | `GROK_AUTH_PATH` | Override path to auth store |
| `ARCUS_AUTH_*` | `GROK_AUTH_*` | Wildcard (provider command, TTL, early invalidation, …) |
| `ARCUS_CLI_CHAT_PROXY_BASE_URL` | `GROK_CLI_CHAT_PROXY_BASE_URL` | Proxy base override |

| Source |
|--------|
| `crates/codegen/xai-grok-env/src/identity.rs` (`EXACT_SUFFIXES`, `PREFIX_SUFFIXES`, `alias_pair`, `var`) |

Unmapped names (including `XAI_API_KEY`) resolve as plain environment variables.

---

## Subscription / plan eligibility (honest wording)

Whether a **free** xAI account is enough for OAuth catalog + cli-chat-proxy use,
or whether a **paid** plan is required, is **not encoded** in this repository in
a way that can be asserted as fact. The protocol, scopes, and public-client
shape are verified in-tree; **plan gating is a server-side policy** and was
recorded as **UNVERIFIED** in the public-release shape work (Q1 — empirical test
scheduled before GA).

Until that test lands and this page is updated:

- Require **an xAI account** that can complete `arcus login` and authorize the
  CLI scopes listed above.
- Treat **plan eligibility as verified before v0.1.0, or noted here** after the
  pre-GA check — do not assume “any free account” or “SuperGrok required.”
- For **plan-independent** use today, configure **BYOK** models (K3 path or
  `XAI_API_KEY` / per-model keys).

Do **not** invent a subscription claim in marketing copy from this doc alone.

---

## Dual-rail: BYOK never requires OAuth

| Situation | Need `arcus login`? |
|-----------|----------------------|
| Only third-party K3 (OpenRouter / Moonshot / host) via `env_key` | **No** |
| Only `XAI_API_KEY` (or per-model xAI key) for first-party models | **No** (session optional) |
| Native catalog + subagent freight on the session grant | **Yes** (or API key rail above) |
| Mix: K3 primary + grok freight | K3 key **and** (login **or** `XAI_API_KEY`) — two meters, two credentials |

Credential precedence always prefers a model’s **own** key over the session
(`resolve_credentials`). A third-party base without its own credentials is
**fail-closed** — the session JWT is not sent to foreign hosts.

---

## Quick troubleshooting

| Symptom | What to try |
|---------|-------------|
| Auth / 401 loops after copying a home dir | **Do not recopy `auth.json`.** `arcus logout` then `arcus login` on that machine |
| Headless host, no browser | `arcus login --device-auth` |
| CI / automation | `XAI_API_KEY` or per-model `env_key` — skip OAuth |
| “Model has env_key configured but none … are set” | Export the env named in TOML (see [setup-glm.md](setup-glm.md)) |
| Want a clean slate | `arcus logout` then login or set keys again |

---

## Related

- [setup-glm.md](setup-glm.md) — K3 BYOK paths and multi-provider TOML
- [onboarding.md](onboarding.md) — `arcus init` house pack (not credentials)
- Upstream user guide (vendor-shaped detail): `crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md`
