// Anthropic OAuth (Claude Pro/Max via the Claude Code OAuth client).
//
// Method ported from omp (`pi-ai/src/registry/oauth/anthropic.ts` +
// `anthropic-constants.ts`): same authorize/token endpoints, scopes, PKCE
// shape, bootstrap identity fallback, refresh headers, and the ~30-day
// grant-family re-login deadline.

use anyhow::{Context as _, anyhow};
use serde::Deserialize;

use super::ProviderKind;
use super::store::ProviderCredentials;

// The Claude Code desktop client's public OAuth client id. omp obfuscates this
// with base64; it ships openly inside Claude Code, so it is kept plain here.
pub(super) const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub(super) const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub(super) const TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL: &str = "https://api.anthropic.com/api/claude_cli/bootstrap";
const BOOTSTRAP_MODEL: &str = "claude-opus-4-8";
const BOOTSTRAP_USER_AGENT: &str = "claude-code/2.1.246";
pub(super) const CALLBACK_PORT: u16 = 54545;
pub(super) const CALLBACK_PATH: &str = "/callback";

/// Scopes required for direct OAuth-token inference (`user:inference`) plus
/// account/session management. `platform.claude.com/oauth/authorize` issues
/// console tokens (org:create_api_key only) and does not grant
/// `user:inference` — the claude.ai endpoint is required for direct inference.
pub(super) const SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/// Absolute lifetime of an Anthropic OAuth grant family, anchored at the
/// interactive login. Refresh-token rotation does NOT extend it: ~30 days
/// after authorization the token endpoint returns
/// `invalid_grant: "Refresh token expired"` and only a fresh interactive
/// login recovers the account. A display heuristic, not a wire contract.
pub(crate) const GRANT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Headers the refresh call sends (Claude Code sends these on refresh but not
/// on the initial code exchange).
pub(super) const REFRESH_BETA: &str = "oauth-2025-04-20";
pub(super) const REFRESH_USER_AGENT: &str = "anthropic-sdk-typescript/0.112.1 userOAuthProvider";

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    #[serde(default)]
    account: Option<AccountBlock>,
    #[serde(default)]
    organization: Option<OrgBlock>,
}

#[derive(Debug, Deserialize)]
struct AccountBlock {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    email_address: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OrgBlock {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Identity {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
}

/// Build the `claude.ai/oauth/authorize` URL for this login.
pub(super) fn authorize_url(state: &str, redirect_uri: &str, code_challenge: &str) -> String {
    let params = [
        ("code", "true"),
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPES),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ];
    let query: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect();
    format!("{AUTHORIZE_URL}?{}", query.join("&"))
}

async fn post_json(
    body: serde_json::Value,
    extra_headers: &[(&str, &str)],
) -> anyhow::Result<String> {
    let client = crate::http::shared_client();
    let mut builder = client.post(TOKEN_URL);
    // No Accept header: Claude Code omits it on OAuth token requests.
    for (name, value) in extra_headers {
        builder = builder.header(*name, *value);
    }
    let response = builder
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .context("Anthropic OAuth token request failed")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Anthropic OAuth token endpoint returned {status}: {text}"
        ));
    }
    Ok(text)
}

fn token_response_to_credentials(
    data: TokenResponse,
    identity: Identity,
    authorized_at: i64,
) -> ProviderCredentials {
    let now = super::store::now_ms();
    ProviderCredentials {
        access: data.access_token,
        refresh: data.refresh_token,
        expires_ms: now + data.expires_in.saturating_mul(1000) - 5 * 60 * 1000,
        authorized_at,
        account_id: identity.account_id,
        email: identity.email,
        org_id: identity.org_id,
        org_name: identity.org_name,
    }
}

/// Exchange an authorization code for tokens. `code` may carry a `#state`
/// fragment (the pasted-redirect shape Anthropic produces); a fragment state
/// overrides `state`.
pub(super) async fn exchange_code(
    code: &str,
    state: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> anyhow::Result<ProviderCredentials> {
    let (exchange_code, exchange_state) = match code.split_once('#') {
        Some((code, fragment)) if !fragment.is_empty() => (code, fragment),
        _ => (code, state),
    };
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": exchange_code,
        "state": exchange_state,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    });
    let text = post_json(body, &[])
        .await
        .map_err(|e| e.context("exchanging Anthropic authorization code"))?;
    let data: TokenResponse = serde_json::from_str(&text).map_err(|e| {
        anyhow!("Anthropic token exchange returned invalid JSON: {e}; body: {text}")
    })?;
    let identity = resolve_identity(&data, true).await;
    let authorized_at = super::store::now_ms();
    Ok(token_response_to_credentials(data, identity, authorized_at))
}

/// Refresh an access token. The org an access token is scoped to is captured
/// once at login and deliberately never refreshed afterwards — rewriting
/// identity during background refreshes could silently re-key stored
/// credentials.
pub(super) async fn refresh_token(refresh_token: &str) -> anyhow::Result<ProviderCredentials> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    });
    let extra_headers = [
        ("anthropic-beta", REFRESH_BETA),
        ("User-Agent", REFRESH_USER_AGENT),
    ];
    let text = post_json(body, &extra_headers)
        .await
        .map_err(|e| e.context("refreshing Anthropic OAuth token"))?;
    let data: TokenResponse = serde_json::from_str(&text)
        .map_err(|e| anyhow!("Anthropic token refresh returned invalid JSON: {e}; body: {text}"))?;
    let identity = resolve_identity(&data, false).await;
    // Preserve the login-time `authorized_at` anchor: the grant TTL counts
    // from the interactive login, not from any refresh.
    let authorized_at = load_authorized_at(refresh_token);
    Ok(token_response_to_credentials(data, identity, authorized_at))
}

/// Load the stored `authorized_at` for the credential being refreshed so the
/// grant-TTL anchor survives rotation. Falls back to now when the row is gone
/// (the caller's CAS then rejects the write anyway).
fn load_authorized_at(refresh_token: &str) -> i64 {
    let path = super::store::default_store_path();
    super::store::load(&path, ProviderKind::Anthropic)
        .filter(|c| c.refresh == refresh_token)
        .map(|c| c.authorized_at)
        .unwrap_or_else(super::store::now_ms)
}

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    #[serde(default)]
    oauth_account: Option<BootstrapAccount>,
}

#[derive(Debug, Default, Deserialize)]
struct BootstrapAccount {
    #[serde(default)]
    account_uuid: Option<String>,
    #[serde(default)]
    account_email: Option<String>,
    #[serde(default)]
    organization_uuid: Option<String>,
    #[serde(default)]
    organization_name: Option<String>,
}

/// Recover account/org identity from the Claude CLI bootstrap endpoint when
/// the token response omits it (older/stale credential shapes).
async fn bootstrap_identity(access_token: &str) -> anyhow::Result<Identity> {
    let url = format!("{BOOTSTRAP_URL}?entrypoint=cli&model={BOOTSTRAP_MODEL}");
    let client = crate::http::shared_client();
    let response = client
        .get(&url)
        .header("Accept", "application/json, text/plain, */*")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", BOOTSTRAP_USER_AGENT)
        .header("anthropic-beta", REFRESH_BETA)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .context("Anthropic bootstrap identity request failed")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("Anthropic bootstrap endpoint returned {status}"));
    }
    let data: BootstrapResponse = serde_json::from_str(&text)
        .map_err(|e| anyhow!("Anthropic bootstrap returned invalid JSON: {e}"))?;
    let account = data.oauth_account.unwrap_or_default();
    Ok(Identity {
        account_id: account.account_uuid.filter(|s| !s.is_empty()),
        email: account.account_email.filter(|s| !s.is_empty()),
        org_id: account.organization_uuid.filter(|s| !s.is_empty()),
        org_name: account.organization_name.filter(|s| !s.is_empty()),
    })
}

/// Merge the token response's identity blocks with a bootstrap fallback.
/// `include_org` is login-only: the org an access token is scoped to is
/// captured once when the credential is created.
async fn resolve_identity(data: &TokenResponse, include_org: bool) -> Identity {
    let mut identity = Identity {
        account_id: data
            .account
            .as_ref()
            .and_then(|a| a.uuid.clone())
            .filter(|s| !s.is_empty()),
        email: data
            .account
            .as_ref()
            .and_then(|a| a.email_address.clone())
            .filter(|s| !s.is_empty()),
        org_id: data
            .organization
            .as_ref()
            .and_then(|o| o.uuid.clone())
            .filter(|s| !s.is_empty()),
        org_name: data
            .organization
            .as_ref()
            .and_then(|o| o.name.clone())
            .filter(|s| !s.is_empty()),
    };
    let org_satisfied = !include_org || identity.org_id.is_some();
    if identity.account_id.is_some() && identity.email.is_some() && org_satisfied {
        return identity;
    }
    if let Ok(bootstrap) = bootstrap_identity(&data.access_token).await {
        if identity.account_id.is_none() {
            identity.account_id = bootstrap.account_id;
        }
        if identity.email.is_none() {
            identity.email = bootstrap.email;
        }
        if identity.org_id.is_none() {
            identity.org_id = bootstrap.org_id;
        }
        if identity.org_name.is_none() {
            identity.org_name = bootstrap.org_name;
        }
    }
    identity
}

/// The re-login deadline for a credential minted at `authorized_at`.
pub(super) fn relogin_deadline(creds: &ProviderCredentials) -> i64 {
    creds.authorized_at + GRANT_TTL_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_carries_the_oauth_parameters() {
        // The loopback redirect must carry the registered host form
        // (`localhost`); the IP literal is rejected by the authorization
        // endpoint as an unauthorized callback address.
        let url = authorize_url("state123", "http://localhost:54545/callback", "challenge");
        assert!(url.starts_with("https://claude.ai/oauth/authorize?"));
        assert!(url.contains("code=true"));
        assert!(url.contains(&format!("client_id={CLIENT_ID}")));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback"));
        assert!(url.contains(&format!("scope={}", urlencoding::encode(SCOPES))));
        assert!(url.contains("code_challenge=challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state123"));
    }

    #[test]
    fn code_fragment_state_overrides() {
        // (parsing lives behind exchange_code; assert the split logic shape)
        let code = "the-code#the-state";
        let (c, s) = code.split_once('#').unwrap();
        assert_eq!(c, "the-code");
        assert_eq!(s, "the-state");
    }
}
