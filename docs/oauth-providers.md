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

**Cursor backend.** The Cursor agent wire is a first-party backend: a model
entry with `api_backend = "cursor"` talks Cursor's `AgentService/Run`
endpoint (Connect protocol over HTTP/2) using the login's access token as
the bearer:

```toml
[model.cursor-composer]
model = "composer-2.5"
base_url = "https://api2.cursor.sh"
api_key = "oauth:cursor"
api_backend = "cursor"
context_window = 200000

[model.cursor-gpt]
model = "gpt-5.4-mini-high"
base_url = "https://api2.cursor.sh"
api_key = "oauth:cursor"
api_backend = "cursor"
context_window = 200000
```

Notes on the wire:

- The model id is Cursor's own id from its model list. OpenAI-family
  effort slugs (`-minimal|low|medium|high|xhigh|max`, with an optional
  `-fast` lane suffix) are split into a `reasoning` parameter
  automatically; `composer-2.5` is pinned to the Standard tier.
- The system prompt rides the request-context handshake as global rules
  (Cursor reconstructs the model prompt from those, not from the
  history blobs). Tools are advertised as none; any native tool frame
  the model still emits is rejected in band.
- Text, thinking, and usage stream through the ordinary sampling event
  path, so compaction, memory notes, and the pager all work unchanged.
- Keep `base_url` at the default endpoint; it only needs changing to
  front the wire with a local HTTP/2 bridge (the endpoint requires
  HTTP/2 with TLS-ALPN `h2`, and HTTP/1.1 is rejected with 464).

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
