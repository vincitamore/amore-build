# Third-party provider OAuth (Claude / Cursor)

`amore login --provider <name>` signs in with a third-party model provider's
own OAuth flow and stores the credentials in
`~/.amore/oauth-credentials.json` — separate from the xAI account credential
in `auth.json`. A model entry references the stored credential with an
`oauth:` API key, and the token stays fresh across sessions: every request
reads the store, refreshing when the access token nears expiry.

## Claude (Claude Pro/Max via Claude Code OAuth)

```sh
amore login --provider anthropic
```

This runs the Claude Code OAuth flow (PKCE + loopback callback on port 54545,
with a paste-the-redirect-URL fallback for remote machines), stores the token
pair, and prints a **re-login deadline**: Anthropic expires the whole
refresh-token family about 30 days after the interactive login, regardless of
token rotation. Re-run the login before the deadline or inference will fail
with an expired grant.

Point a model entry at the stored credential:

```toml
[model.claude-sonnet-4-6]
model = "claude-sonnet-4-6"
base_url = "https://api.anthropic.com/v1"
name = "Claude Sonnet 4.6 (subscription)"
api_backend = "messages"
api_key = "oauth:anthropic"
context_window = 200000
```

Requests made with an Anthropic OAuth token (`sk-ant-oat…`) automatically
carry the Claude Code wire shape: `Authorization: Bearer` auth (not
`x-api-key`), the CC `anthropic-beta` set and client headers, the CC
system-instruction blocks with the billing-header attestation, CC-shaped
request metadata, and the 64k output clamp. This mirrors the method the omp
harness uses; subscription requests must look like Claude Code's own.

API keys (`sk-ant-api…`) keep the ordinary path — pass them through
`extra_headers` as shown in the custom-models guide.

## Cursor

```sh
amore login --provider cursor
```

This runs Cursor's account OAuth (deep-link login + poll, PKCE) and stores
the token pair with automatic refresh.

**Scope note:** Cursor's own agent API is a gRPC/Connect protocol this
harness's HTTP sampling backends do not speak, so there is no first-party
model provider wired to a Cursor login yet. The login, storage, and refresh
are complete, and the credential is consumable as a bearer token by any
endpoint you point a model entry at:

```toml
[model.my-cursor-compatible-endpoint]
model = "..."
base_url = "https://example.internal/v1"   # an endpoint that accepts a Cursor access token
api_key = "oauth:cursor"
```

## Managing credentials

- **Location:** `~/.amore/oauth-credentials.json` (owner-only permissions on
  unix; corrupt files are backed up with a `.corrupt.<timestamp>` suffix and
  the store restarts empty).
- **Refresh:** tokens refresh shortly before expiry, on the first request
  that needs them. Refreshes use a compare-and-set on the stored refresh
  token, so concurrently running processes cannot clobber each other's
  rotation; the loser picks up the winner's token.
- **Sign out:** delete the provider's entry from the file (or the whole
  file). `amore logout` only touches the xAI account credential.
