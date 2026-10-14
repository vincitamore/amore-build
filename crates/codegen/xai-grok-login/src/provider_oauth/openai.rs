// OpenAI Codex (ChatGPT Plus/Pro) OAuth 2.0 browser PKCE, headless device-code,
// and token refresh mechanics.
//
// Ported from `@oh-my-pi/pi-ai` (`src/registry/oauth/openai-codex.ts` and
// `rules/auth/openai-codex*.kdl`).

use std::time::Duration;

use anyhow::{Context as _, anyhow};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use serde::Deserialize;

use super::store::{self, ProviderCredentials};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
pub const CALLBACK_PORT: u16 = 1455;
pub const CALLBACK_PATH: &str = "/auth/callback";
pub const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
pub const ORIGINATOR: &str = "omp";

pub const DEVICE_USERCODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
pub const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
pub const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
pub const DEVICE_AUTH_URL: &str = "https://auth.openai.com/codex/device";
pub const DEVICE_POLL_INTERVAL_MS: u64 = 5_000;
pub const DEVICE_POLL_SAFETY_MARGIN_MS: u64 = 3_000;
pub const DEVICE_MAX_POLLS: u32 = 120;

const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM: &str = "https://api.openai.com/profile";

/// Identity slice decoded from the OpenAI Codex access/id token JWT claims.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TokenProfile {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
}

/// Decode a JWT payload without signature verification (used for extracting
/// account/workspace and email claims after HTTPS token exchange).
pub fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _sig = parts.next()?;
    if parts.next().is_some() || payload.is_empty() {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .or_else(|_| STANDARD_NO_PAD.decode(payload))
        .or_else(|_| STANDARD.decode(payload))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn non_empty_trimmed(val: Option<&serde_json::Value>) -> Option<String> {
    let s = val?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

/// Extract `account_id` (`chatgpt_account_id`), `email`, and `plan_type`
/// (`chatgpt_plan_type`) from the access token and optional `id_token`.
pub fn extract_token_profile(access_token: &str, id_token: Option<&str>) -> TokenProfile {
    let payload = decode_jwt_payload(access_token);
    let id_payload = id_token.and_then(decode_jwt_payload);

    let auth = payload.as_ref().and_then(|p| p.get(JWT_CLAIM_PATH));
    let id_auth = id_payload.as_ref().and_then(|p| p.get(JWT_CLAIM_PATH));

    let account_id = non_empty_trimmed(auth.and_then(|a| a.get("chatgpt_account_id")))
        .or_else(|| non_empty_trimmed(id_auth.and_then(|a| a.get("chatgpt_account_id"))));

    let profile = payload.as_ref().and_then(|p| p.get(JWT_PROFILE_CLAIM));
    let id_profile = id_payload.as_ref().and_then(|p| p.get(JWT_PROFILE_CLAIM));
    let email = non_empty_trimmed(profile.and_then(|p| p.get("email")))
        .or_else(|| non_empty_trimmed(id_profile.and_then(|p| p.get("email"))))
        .map(|s| s.to_ascii_lowercase());

    let plan_type = non_empty_trimmed(auth.and_then(|a| a.get("chatgpt_plan_type")))
        .or_else(|| non_empty_trimmed(id_auth.and_then(|a| a.get("chatgpt_plan_type"))))
        .map(|s| s.to_ascii_lowercase());

    TokenProfile {
        account_id,
        email,
        plan_type,
    }
}

/// Build the OpenAI Codex browser authorization URL.
pub fn authorize_url(state: &str, redirect_uri: &str, code_challenge: &str) -> String {
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("valid static AUTHORIZE_URL");
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("response_type", "code");
        pairs.append_pair("client_id", CLIENT_ID);
        pairs.append_pair("redirect_uri", redirect_uri);
        pairs.append_pair("scope", SCOPE);
        pairs.append_pair("code_challenge", code_challenge);
        pairs.append_pair("code_challenge_method", "S256");
        pairs.append_pair("state", state);
        pairs.append_pair("id_token_add_organizations", "true");
        pairs.append_pair("codex_cli_simplified_flow", "true");
        pairs.append_pair("originator", ORIGINATOR);
    }
    url.into()
}

fn describe_token_endpoint_value(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    match value {
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Object(map) => {
            let code = describe_token_endpoint_value(map.get("code").or_else(|| map.get("error")));
            let message = describe_token_endpoint_value(
                map.get("message")
                    .or_else(|| map.get("error_description"))
                    .or_else(|| map.get("description")),
            );
            match (code, message) {
                (Some(c), Some(m)) if c != m => Some(format!("{c}: {m}")),
                (Some(c), _) => Some(c),
                (None, Some(m)) => Some(m),
                (None, None) => serde_json::to_string(value).ok(),
            }
        }
        _ => None,
    }
}

/// Format OpenAI Codex OAuth token endpoint errors for login and refresh failures.
pub fn format_token_endpoint_error(status: u16, body_text: &str) -> String {
    let trimmed = body_text.trim();
    if trimmed.is_empty() {
        return status.to_string();
    }
    let Ok(body) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return format!("{status} {trimmed}");
    };
    let Some(map) = body.as_object() else {
        return format!("{status} {trimmed}");
    };
    let error = describe_token_endpoint_value(map.get("error"));
    let description = describe_token_endpoint_value(map.get("error_description"));
    if let (Some(e), Some(d)) = (&error, &description)
        && e != d
    {
        return format!("{status} {e}: {d}");
    }
    let detail = error
        .or(description)
        .or_else(|| describe_token_endpoint_value(map.get("message")))
        .unwrap_or_else(|| trimmed.to_owned());
    format!("{status} {detail}")
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

/// Exchange an authorization code for OpenAI Codex OAuth tokens.
pub(crate) async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> anyhow::Result<ProviderCredentials> {
    exchange_code_at(TOKEN_URL, code, redirect_uri, code_verifier).await
}

pub(crate) async fn exchange_code_at(
    token_url: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> anyhow::Result<ProviderCredentials> {
    let client = xai_grok_http::shared_client();
    let response = client
        .post(token_url)
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .context("requesting OpenAI OAuth token exchange")?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Token exchange failed: {}",
            format_token_endpoint_error(status.as_u16(), &body_text)
        ));
    }

    let token_data: TokenResponse = serde_json::from_str(&body_text)
        .context("parsing OpenAI OAuth token exchange response")?;
    let access = token_data
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Token response missing access_token"))?;
    let refresh = token_data
        .refresh_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Token response missing refresh_token"))?;
    let expires_in = token_data
        .expires_in
        .filter(|s| *s > 0)
        .ok_or_else(|| anyhow!("Token response missing expires_in"))?;

    let profile = extract_token_profile(&access, token_data.id_token.as_deref());
    if profile.account_id.is_none() && profile.email.is_none() {
        return Err(anyhow!(
            "Failed to extract account identity from OpenAI OAuth token"
        ));
    }

    let now = store::now_ms();
    Ok(ProviderCredentials {
        access,
        refresh,
        expires_ms: now.saturating_add(expires_in.saturating_mul(1_000)),
        authorized_at: now,
        account_id: profile.account_id.clone(),
        email: profile.email,
        org_id: profile.account_id,
        org_name: profile.plan_type,
    })
}

/// Refresh an OpenAI Codex OAuth grant.
pub(crate) async fn refresh_token(
    current: &ProviderCredentials,
) -> anyhow::Result<ProviderCredentials> {
    refresh_token_at(TOKEN_URL, current).await
}

pub(crate) async fn refresh_token_at(
    token_url: &str,
    current: &ProviderCredentials,
) -> anyhow::Result<ProviderCredentials> {
    if current.refresh.trim().is_empty() {
        return Err(anyhow!(
            "openai credentials are missing refresh token; sign in again"
        ));
    }
    let client = xai_grok_http::shared_client();
    let response = client
        .post(token_url)
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh.as_str()),
            ("client_id", CLIENT_ID),
        ])
        .send()
        .await
        .context("requesting OpenAI OAuth token refresh")?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Token refresh failed: {}",
            format_token_endpoint_error(status.as_u16(), &body_text)
        ));
    }

    let token_data: TokenResponse =
        serde_json::from_str(&body_text).context("parsing OpenAI OAuth refresh response")?;
    let access = token_data
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Refresh response missing access_token"))?;
    let refresh = token_data
        .refresh_token
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| current.refresh.clone());
    let expires_in = token_data
        .expires_in
        .filter(|s| *s > 0)
        .ok_or_else(|| anyhow!("Refresh response missing expires_in"))?;

    let profile = extract_token_profile(&access, token_data.id_token.as_deref());
    let now = store::now_ms();

    Ok(ProviderCredentials {
        access,
        refresh,
        expires_ms: now.saturating_add(expires_in.saturating_mul(1_000)),
        authorized_at: current.authorized_at,
        account_id: profile.account_id.or_else(|| current.account_id.clone()),
        email: profile.email.or_else(|| current.email.clone()),
        org_id: current.org_id.clone(),
        org_name: current.org_name.clone().or(profile.plan_type),
    })
}

/// Initiated OpenAI Codex device-code authorization session.
#[derive(Debug, Clone)]
pub(crate) struct DeviceAuthInit {
    pub device_auth_id: String,
    pub user_code: String,
    pub poll_interval_ms: u64,
}

#[derive(Debug, Deserialize)]
struct DeviceInitResponse {
    device_auth_id: Option<String>,
    user_code: Option<String>,
    #[serde(default)]
    interval: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct DevicePollResponse {
    authorization_code: Option<String>,
    code_verifier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DevicePollOutcome {
    Pending,
    Ready {
        authorization_code: String,
        code_verifier: String,
    },
}

fn parse_device_interval_secs(value: Option<&serde_json::Value>) -> u64 {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_u64().filter(|v| *v > 0).unwrap_or(5),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().ok().filter(|v| *v > 0).unwrap_or(5),
        _ => 5,
    }
}

/// Start the OpenAI Codex device-code authorization flow.
pub(crate) async fn initiate_device_auth() -> anyhow::Result<DeviceAuthInit> {
    initiate_device_auth_at(DEVICE_USERCODE_URL).await
}

pub(crate) async fn initiate_device_auth_at(url: &str) -> anyhow::Result<DeviceAuthInit> {
    let client = xai_grok_http::shared_client();
    let response = client
        .post(url)
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .json(&serde_json::json!({ "client_id": CLIENT_ID }))
        .send()
        .await
        .context("initiating OpenAI device authorization")?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!(
            "Device authorization initiation failed: {}",
            status.as_u16()
        ));
    }

    let data: DeviceInitResponse = response
        .json()
        .await
        .context("parsing OpenAI device authorization response")?;
    let device_auth_id = data
        .device_auth_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Device authorization response missing device_auth_id"))?;
    let user_code = data
        .user_code
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Device authorization response missing user_code"))?;
    let interval_secs = parse_device_interval_secs(data.interval.as_ref());
    let poll_interval_ms = interval_secs
        .saturating_mul(1_000)
        .saturating_add(DEVICE_POLL_SAFETY_MARGIN_MS);

    Ok(DeviceAuthInit {
        device_auth_id,
        user_code,
        poll_interval_ms,
    })
}

/// Poll the OpenAI Codex device-code token endpoint once.
/// HTTP 403 and 404 indicate that browser authorization is still pending.
pub(crate) async fn poll_device_token(
    device_auth_id: &str,
    user_code: &str,
) -> anyhow::Result<DevicePollOutcome> {
    poll_device_token_at(DEVICE_TOKEN_URL, device_auth_id, user_code).await
}

pub(crate) async fn poll_device_token_at(
    url: &str,
    device_auth_id: &str,
    user_code: &str,
) -> anyhow::Result<DevicePollOutcome> {
    let client = xai_grok_http::shared_client();
    let response = client
        .post(url)
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .json(&serde_json::json!({
            "device_auth_id": device_auth_id,
            "user_code": user_code,
        }))
        .send()
        .await
        .context("polling OpenAI device authorization token")?;

    let status = response.status().as_u16();
    if status == 403 || status == 404 {
        return Ok(DevicePollOutcome::Pending);
    }
    if !response.status().is_success() {
        return Err(anyhow!("Device token polling failed: {status}"));
    }

    let data: DevicePollResponse = response
        .json()
        .await
        .context("parsing OpenAI device poll response")?;
    let authorization_code = data
        .authorization_code
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Device token response missing authorization_code"))?;
    let code_verifier = data
        .code_verifier
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Device token response missing code_verifier"))?;

    Ok(DevicePollOutcome::Ready {
        authorization_code,
        code_verifier,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_jwt(claims: serde_json::Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        format!("{header}.{payload}.sig")
    }

    #[test]
    fn authorize_url_matches_omp_contract() {
        let url = authorize_url("state123", REDIRECT_URI, "challenge456");
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("auth.openai.com"));
        assert_eq!(parsed.path(), "/oauth/authorize");

        let params: std::collections::HashMap<String, String> =
            parsed.query_pairs().into_owned().collect();
        assert_eq!(params.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(params.get("client_id").map(String::as_str), Some(CLIENT_ID));
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some(REDIRECT_URI)
        );
        assert_eq!(params.get("scope").map(String::as_str), Some(SCOPE));
        assert_eq!(
            params.get("code_challenge").map(String::as_str),
            Some("challenge456")
        );
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(params.get("state").map(String::as_str), Some("state123"));
        assert_eq!(
            params.get("id_token_add_organizations").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            params.get("codex_cli_simplified_flow").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            params.get("originator").map(String::as_str),
            Some(ORIGINATOR)
        );
    }

    #[test]
    fn extracts_profile_from_access_and_id_tokens() {
        let access = make_jwt(serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_abc123"
            },
            "https://api.openai.com/profile": {
                "email": "User@Example.COM"
            }
        }));
        let id_tok = make_jwt(serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_plan_type": "Pro"
            }
        }));

        let profile = extract_token_profile(&access, Some(&id_tok));
        assert_eq!(profile.account_id.as_deref(), Some("acct_abc123"));
        assert_eq!(profile.email.as_deref(), Some("user@example.com"));
        assert_eq!(profile.plan_type.as_deref(), Some("pro"));
    }

    #[test]
    fn formats_token_endpoint_errors() {
        assert_eq!(
            format_token_endpoint_error(
                400,
                r#"{"error":"invalid_grant","error_description":"Code expired"}"#
            ),
            "400 invalid_grant: Code expired"
        );
        assert_eq!(
            format_token_endpoint_error(
                401,
                r#"{"error":{"code":"token_expired","message":"Refresh token expired"}}"#
            ),
            "401 token_expired: Refresh token expired"
        );
        assert_eq!(format_token_endpoint_error(502, ""), "502");
    }

    #[tokio::test]
    async fn exchange_and_refresh_against_mock_server() {
        let access_1 = make_jwt(serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_1",
                "chatgpt_plan_type": "plus"
            },
            "https://api.openai.com/profile": {
                "email": "alice@example.com"
            }
        }));
        let access_2 = make_jwt(serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_1"
            }
        }));

        let a1 = access_1.clone();
        let a2 = access_2.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/oauth/token",
            axum::routing::post(
                move |axum::Form(form): axum::Form<std::collections::HashMap<String, String>>| {
                    let a1 = a1.clone();
                    let a2 = a2.clone();
                    async move {
                        match form.get("grant_type").map(String::as_str) {
                            Some("authorization_code") => axum::Json(serde_json::json!({
                                "access_token": a1,
                                "refresh_token": "rt_initial",
                                "expires_in": 3600
                            })),
                            Some("refresh_token") => axum::Json(serde_json::json!({
                                "access_token": a2,
                                "refresh_token": "rt_rotated",
                                "expires_in": 7200
                            })),
                            other => panic!("unexpected grant_type: {other:?}"),
                        }
                    }
                },
            ),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let token_url = format!("http://{addr}/oauth/token");
        let creds = exchange_code_at(&token_url, "code1", REDIRECT_URI, "verifier1")
            .await
            .unwrap();
        assert_eq!(creds.access, access_1);
        assert_eq!(creds.refresh, "rt_initial");
        assert_eq!(creds.account_id.as_deref(), Some("acct_1"));
        assert_eq!(creds.email.as_deref(), Some("alice@example.com"));
        assert_eq!(creds.org_id.as_deref(), Some("acct_1"));
        assert_eq!(creds.org_name.as_deref(), Some("plus"));

        let refreshed = refresh_token_at(&token_url, &creds).await.unwrap();
        assert_eq!(refreshed.access, access_2);
        assert_eq!(refreshed.refresh, "rt_rotated");
        assert_eq!(refreshed.account_id.as_deref(), Some("acct_1"));
        assert_eq!(refreshed.email.as_deref(), Some("alice@example.com"));
        assert_eq!(refreshed.org_id.as_deref(), Some("acct_1"));
        assert_eq!(refreshed.org_name.as_deref(), Some("plus"));

        server.abort();
    }
}
