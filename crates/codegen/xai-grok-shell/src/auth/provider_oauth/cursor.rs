// Cursor OAuth (login, poll, refresh).
//
// Method ported from omp (`pi-ai/src/registry/oauth/cursor.ts`): PKCE challenge
// + random uuid drive a deep-link login at cursor.com; the token pair is
// polled from api2.cursor.sh and refreshed against the exchange endpoint.
// Expiry comes from the access token's own JWT `exp` claim.

use anyhow::{anyhow, Context as _};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;

use super::store::ProviderCredentials;

const LOGIN_URL: &str = "https://cursor.com/loginDeepControl";
const POLL_URL: &str = "https://api2.cursor.sh/auth/poll";
const REFRESH_URL: &str = "https://api2.cursor.sh/auth/exchange_user_api_key";

pub(super) const POLL_MAX_ATTEMPTS: u32 = 150;
pub(super) const POLL_BASE_DELAY_MS: u64 = 1_000;
pub(super) const POLL_MAX_DELAY_MS: u64 = 10_000;
pub(super) const POLL_BACKOFF_MULTIPLIER: f64 = 1.2;
/// Consecutive transport failures (not 404s) that abort polling.
pub(super) const POLL_MAX_CONSECUTIVE_ERRORS: u32 = 3;

#[derive(Debug, Clone)]
pub(crate) struct CursorLoginStart {
    pub uuid: String,
    pub verifier: String,
    pub login_url: String,
}

/// Build the deep-link login URL for a fresh login attempt.
pub(super) fn generate_login_start() -> CursorLoginStart {
    let pkce = super::pkce::generate_pkce();
    let uuid = uuid::Uuid::new_v4().to_string();
    let query: Vec<String> = [
        ("challenge", pkce.code_challenge.as_str()),
        ("uuid", uuid.as_str()),
        ("mode", "login"),
        ("redirectTarget", "cli"),
    ]
    .into_iter()
    .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
    .collect();
    CursorLoginStart {
        uuid,
        verifier: pkce.code_verifier,
        login_url: format!("{LOGIN_URL}?{}", query.join("&")),
    }
}

#[derive(Debug)]
pub(crate) enum PollOutcome {
    /// Login not completed yet (404 from the poll endpoint).
    Pending,
    Ready { access_token: String, refresh_token: String },
}

/// One poll attempt. 404 means "keep waiting"; any other non-success status is
/// a hard failure; transport errors are reported as `Err` for the caller's
/// consecutive-error counter.
pub(super) async fn poll_once(
    uuid: &str,
    verifier: &str,
) -> anyhow::Result<PollOutcome> {
    let client = crate::http::shared_client();
    let response = client
        .get(POLL_URL)
        .query(&[("uuid", uuid), ("verifier", verifier)])
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .context("Cursor auth poll request failed")?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Ok(PollOutcome::Pending);
    }
    if !status.is_success() {
        return Err(anyhow!("Cursor auth poll failed: {status}"));
    }
    #[derive(Debug, Deserialize)]
    struct PollResponse {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "refreshToken")]
        refresh_token: String,
    }
    let data: PollResponse = response
        .json()
        .await
        .context("Cursor auth poll returned invalid JSON")?;
    Ok(PollOutcome::Ready {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
    })
}

/// Exchange a refresh token (or an API key) for a fresh token pair.
pub(super) async fn refresh_token(
    api_key_or_refresh_token: &str,
) -> anyhow::Result<ProviderCredentials> {
    let client = crate::http::shared_client();
    let response = client
        .post(REFRESH_URL)
        .header(
            "Authorization",
            format!("Bearer {api_key_or_refresh_token}"),
        )
        .header("Content-Type", "application/json")
        .body("{}")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .context("Cursor token refresh request failed")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("Cursor token refresh failed: {status}: {text}"));
    }
    #[derive(Debug, Deserialize)]
    struct RefreshResponse {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "refreshToken")]
        refresh_token: Option<String>,
    }
    let data: RefreshResponse = serde_json::from_str(&text)
        .map_err(|e| anyhow!("Cursor token refresh returned invalid JSON: {e}; body: {text}"))?;
    Ok(ProviderCredentials {
        expires_ms: jwt_expiry_ms(&data.access_token)
            .unwrap_or_else(default_expiry),
        access: data.access_token,
        // omp keeps the input token when the response omits a refresh token.
        refresh: data.refresh_token.filter(|s| !s.is_empty()).unwrap_or_else(|| api_key_or_refresh_token.to_owned()),
        // Cursor logins carry no account/org identity payload; the anchor is
        // now (the grant never hard-expires the way Anthropic's does).
        authorized_at: super::store::now_ms(),
        account_id: None,
        email: None,
        org_id: None,
        org_name: None,
    })
}

/// Expiry of a Cursor access token from its JWT `exp` claim, with the
/// 5-minute clock skew applied. `None` when the token is not a parseable JWT.
pub(crate) fn jwt_expiry_ms(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    #[derive(Deserialize)]
    struct Claims {
        exp: i64,
    }
    let claims: Claims = serde_json::from_slice(&bytes).ok()?;
    Some(claims.exp.saturating_mul(1000) - 5 * 60 * 1000)
}

fn default_expiry() -> i64 {
    super::store::now_ms() + 3_600 * 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_url_carries_pkce_and_mode() {
        let start = generate_login_start();
        assert!(start.login_url.starts_with("https://cursor.com/loginDeepControl?"));
        assert!(start.login_url.contains("mode=login"));
        assert!(start.login_url.contains("redirectTarget=cli"));
        assert!(start.login_url.contains(&format!("uuid={}", start.uuid)));
        assert!(!start.verifier.is_empty());
    }

    /// Build a JWT-shaped token with the given `exp` (unsigned; the flow only
    /// reads the claim).
    fn jwt_with_exp(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{payload}.sig")
    }

    #[test]
    fn jwt_expiry_applies_skew() {
        let exp = 1_900_000_000;
        assert_eq!(
            jwt_expiry_ms(&jwt_with_exp(exp)),
            Some(exp * 1000 - 5 * 60 * 1000)
        );
    }

    #[test]
    fn non_jwt_token_has_no_parseable_expiry() {
        assert_eq!(jwt_expiry_ms("not-a-jwt"), None);
        assert_eq!(jwt_expiry_ms("a.b.c"), None);
    }
}
