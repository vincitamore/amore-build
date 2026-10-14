// Google Antigravity (Cloud Code Assist) OAuth 2.0 browser PKCE login,
// project discovery/onboarding, and token refresh mechanics.
//
// Ported from `@oh-my-pi/pi-ai` (`src/registry/oauth/google-antigravity.ts`,
// `rules/auth/google-antigravity.kdl`) and `@oh-my-pi/pi-catalog`
// (`src/wire/gemini-headers.ts`).

use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;

use super::openai::format_token_endpoint_error;
use super::store::{self, ProviderCredentials};

/// Base64 chunks of the Google OAuth desktop client ID for the Antigravity application.
const CLIENT_ID_B64_PARTS: &[&str] = &[
    "MTA3MTAwNjA2MDU5MS10bWhz",
    "c2luMmgyMWxjcmUyMzV2dG9s",
    "b2poNGc0MDNlcC5hcHBzLmdv",
    "b2dsZXVzZXJjb250ZW50LmNvbQ==",
];
/// Base64 chunks of the Google OAuth desktop client secret for the Antigravity application.
const CLIENT_SECRET_B64_PARTS: &[&str] = &[
    "R09DU1BYLUs1OEZX",
    "UjQ4NkxkTEoxbUxC",
    "OHNYQzR6NnFEQWY=",
];

pub const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

pub const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];

pub const CALLBACK_PORT: u16 = 51121;
pub const CALLBACK_PATH: &str = "/oauth-callback";
pub const CALLBACK_HOSTNAME: &str = "127.0.0.1";
pub const REDIRECT_URI: &str = "http://127.0.0.1:51121/oauth-callback";

pub const CLOUD_CODE_ASSIST_ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";
pub const SANDBOX_ENDPOINT: &str = "https://daily-cloudcode-pa.sandbox.googleapis.com";
pub const FREE_TIER_ID: &str = "free-tier";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const ONBOARD_TIMEOUT: Duration = Duration::from_secs(30);
const ONBOARD_POLL_INTERVAL: Duration = Duration::from_secs(1);

pub fn client_id() -> String {
    let b64: String = CLIENT_ID_B64_PARTS.iter().copied().collect();
    let bytes = STANDARD
        .decode(b64)
        .expect("static base64 Antigravity client_id");
    String::from_utf8(bytes).expect("valid UTF-8 Antigravity client_id")
}

pub fn client_secret() -> String {
    let b64: String = CLIENT_SECRET_B64_PARTS.iter().copied().collect();
    let bytes = STANDARD
        .decode(b64)
        .expect("static base64 Antigravity client_secret");
    String::from_utf8(bytes).expect("valid UTF-8 Antigravity client_secret")
}

pub fn scope_string() -> String {
    SCOPES.join(" ")
}

/// Build the Antigravity `User-Agent` header value.
pub fn antigravity_user_agent() -> String {
    xai_grok_sampler::google_antigravity_oauth::antigravity_user_agent()
}

/// Build the Google OAuth 2.0 browser authorization URL for Antigravity.
pub fn authorize_url(state: &str, redirect_uri: &str, code_challenge: &str) -> String {
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("valid static AUTHORIZE_URL");
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("client_id", &client_id());
        pairs.append_pair("response_type", "code");
        pairs.append_pair("redirect_uri", redirect_uri);
        pairs.append_pair("scope", &scope_string());
        pairs.append_pair("code_challenge", code_challenge);
        pairs.append_pair("code_challenge_method", "S256");
        pairs.append_pair("state", state);
        pairs.append_pair("access_type", "offline");
        pairs.append_pair("prompt", "consent");
    }
    url.into()
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct UserinfoResponse {
    email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct UserTier {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IneligibleTier {
    #[serde(default)]
    tier_id: Option<String>,
    #[serde(default)]
    reason_message: Option<String>,
    #[serde(default)]
    validation_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadCodeAssistResponse {
    #[serde(default)]
    current_tier: Option<UserTier>,
    #[serde(default)]
    paid_tier: Option<UserTier>,
    #[serde(default)]
    allowed_tiers: Option<Vec<UserTier>>,
    #[serde(default)]
    ineligible_tiers: Option<Vec<IneligibleTier>>,
    #[serde(default)]
    cloudaicompanion_project: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct OperationError {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardUserResponse {
    #[serde(rename = "@type", default)]
    _type: Option<String>,
    #[serde(default)]
    cloudaicompanion_project: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct OnboardOperation {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    done: Option<bool>,
    #[serde(default)]
    error: Option<OperationError>,
    #[serde(default)]
    response: Option<OnboardUserResponse>,
}

/// Extract a Google account verification URL from an error body containing
/// a `VALIDATION_REQUIRED` detail.
pub fn extract_google_validation_url(error_body: &str) -> Option<String> {
    if !error_body.contains("VALIDATION_REQUIRED") {
        return None;
    }
    let start = error_body.find('{')?;
    let json_tail = error_body.get(start..)?;
    let parsed: serde_json::Value = serde_json::from_str(json_tail).ok()?;
    let details = parsed.get("error")?.get("details")?.as_array()?;
    for detail in details {
        if detail.get("reason").and_then(|r| r.as_str()) == Some("VALIDATION_REQUIRED")
            && let Some(url) = detail
                .get("metadata")
                .and_then(|m| m.get("validation_url"))
                .and_then(|u| u.as_str())
                .map(str::trim)
            && !url.is_empty()
        {
            return Some(url.to_owned());
        }
    }
    None
}

pub fn format_google_validation_required_message(
    validation_url: &str,
    next_action: &str,
    email: Option<&str>,
) -> String {
    let account = email
        .filter(|e| !e.trim().is_empty())
        .map(|e| format!(" for {e}"))
        .unwrap_or_default();
    format!(
        "Account verification required{account}. Visit {validation_url} to continue, then {next_action}."
    )
}

fn extract_project_id(payload: &LoadCodeAssistResponse) -> Option<String> {
    payload
        .cloudaicompanion_project
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn is_free_tier_allowed(payload: &LoadCodeAssistResponse) -> bool {
    payload
        .allowed_tiers
        .as_ref()
        .is_some_and(|tiers| tiers.iter().any(|t| t.id.as_deref() == Some(FREE_TIER_ID)))
}

fn assert_free_tier_eligible(payload: &LoadCodeAssistResponse) -> anyhow::Result<()> {
    if is_free_tier_allowed(payload) {
        return Ok(());
    }
    if let Some(ineligible) = payload
        .ineligible_tiers
        .as_ref()
        .and_then(|tiers| tiers.iter().find(|t| t.tier_id.as_deref() == Some(FREE_TIER_ID)))
        && let Some(reason) = ineligible
            .reason_message
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        if let Some(url) = ineligible
            .validation_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Err(anyhow!("{reason}\n{url}"));
        }
        return Err(anyhow!("{reason}"));
    }
    Ok(())
}

async fn post_load_code_assist(
    base_endpoint: &str,
    access_token: &str,
    user_agent: &str,
    body: &serde_json::Value,
) -> anyhow::Result<LoadCodeAssistResponse> {
    let url = format!("{}/v1internal:loadCodeAssist", base_endpoint.trim_end_matches('/'));
    let client = xai_grok_http::shared_client();
    let response = client
        .post(&url)
        .timeout(REQUEST_TIMEOUT)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", user_agent)
        .json(body)
        .send()
        .await
        .context("requesting Cloud Code Assist loadCodeAssist")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status != reqwest::StatusCode::OK {
        return Err(anyhow!(
            "loadCodeAssist failed: {} {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            text
        ));
    }
    serde_json::from_str(&text).context("failed to unmarshal LoadCodeAssistResponse")
}

async fn load_code_assist(
    base_endpoint: &str,
    access_token: &str,
    user_agent: &str,
) -> anyhow::Result<LoadCodeAssistResponse> {
    let metadata = serde_json::json!({ "ideType": "ANTIGRAVITY" });
    let mut payload = post_load_code_assist(
        base_endpoint,
        access_token,
        user_agent,
        &serde_json::json!({ "metadata": metadata }),
    )
    .await?;

    if payload.paid_tier.is_none()
        && let Some(project_id) = extract_project_id(&payload)
    {
        payload = post_load_code_assist(
            base_endpoint,
            access_token,
            user_agent,
            &serde_json::json!({
                "cloudaicompanionProject": project_id,
                "metadata": { "ideType": "ANTIGRAVITY" },
            }),
        )
        .await?;
    }
    Ok(payload)
}

fn describe_operation_error(error: &OperationError) -> String {
    if let Some(msg) = error.message.as_deref().filter(|s| !s.is_empty()) {
        if let Some(code) = error.code {
            return format!("{code}: {msg}");
        }
        return msg.to_owned();
    }
    format!("{error:?}")
}

async fn onboard_user(
    base_endpoint: &str,
    access_token: &str,
    user_agent: &str,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + ONBOARD_TIMEOUT;
    let base = base_endpoint.trim_end_matches('/');
    let onboard_url = format!("{base}/v1internal:onboardUser");
    let client = xai_grok_http::shared_client();

    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| anyhow!("onboardUser timed out"))?;
    let response = client
        .post(&onboard_url)
        .timeout(remaining)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", user_agent)
        .json(&serde_json::json!({
            "tierId": FREE_TIER_ID,
            "metadata": { "ideType": "ANTIGRAVITY" },
        }))
        .send()
        .await
        .context("requesting Cloud Code Assist onboardUser")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status != reqwest::StatusCode::OK {
        return Err(anyhow!(
            "onboardUser failed: {} {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            text
        ));
    }
    let mut operation: OnboardOperation =
        serde_json::from_str(&text).context("failed to unmarshal OnboardUser operation")?;

    loop {
        if operation.done == Some(true) {
            if let Some(err) = operation.error.as_ref() {
                return Err(anyhow!(
                    "OnboardUser operation failed: {}",
                    describe_operation_error(err)
                ));
            }
            if operation.response.is_none() {
                return Err(anyhow!("failed to unmarshal OnboardUserResponse"));
            }
            return Ok(());
        }

        let remaining = deadline.checked_duration_since(Instant::now()).ok_or_else(|| {
            anyhow!(
                "onboardUser timed out after {}ms",
                ONBOARD_TIMEOUT.as_millis()
            )
        })?;
        tokio::time::sleep(std::cmp::min(ONBOARD_POLL_INTERVAL, remaining)).await;

        let op_name = operation
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("onboardUser returned an operation without a name"))?;
        let op_url = format!("{base}/v1internal/{}", op_name.trim_start_matches('/'));
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or_else(|| {
            anyhow!(
                "onboardUser timed out after {}ms",
                ONBOARD_TIMEOUT.as_millis()
            )
        })?;
        let poll_resp = client
            .get(&op_url)
            .timeout(remaining)
            .header("Authorization", format!("Bearer {access_token}"))
            .header("Content-Type", "application/json")
            .header("User-Agent", user_agent)
            .send()
            .await
            .context("polling Cloud Code Assist onboardUser operation")?;

        let poll_status = poll_resp.status();
        let poll_text = poll_resp.text().await.unwrap_or_default();
        if poll_status != reqwest::StatusCode::OK {
            return Err(anyhow!(
                "onboardUser operation failed: {} {}: {}",
                poll_status.as_u16(),
                poll_status.canonical_reason().unwrap_or(""),
                poll_text
            ));
        }
        operation = serde_json::from_str(&poll_text)
            .context("failed to unmarshal OnboardUser operation")?;
    }
}

/// Discover (and if needed, provision) the user's Cloud Code Assist project ID.
pub async fn discover_project(access_token: &str, email: Option<&str>) -> anyhow::Result<String> {
    discover_project_at(CLOUD_CODE_ASSIST_ENDPOINT, access_token, email).await
}

pub async fn discover_project_at(
    base_endpoint: &str,
    access_token: &str,
    email: Option<&str>,
) -> anyhow::Result<String> {
    let user_agent = antigravity_user_agent();
    let result: anyhow::Result<String> = async {
        eprintln!("Checking Cloud Code Assist account status...");
        let initial = load_code_assist(base_endpoint, access_token, &user_agent).await?;
        assert_free_tier_eligible(&initial)?;
        if initial.current_tier.is_none() {
            eprintln!("Provisioning the Antigravity free tier...");
            onboard_user(base_endpoint, access_token, &user_agent).await?;
        }
        eprintln!("Refreshing Cloud Code Assist project...");
        let refreshed = load_code_assist(base_endpoint, access_token, &user_agent).await?;
        extract_project_id(&refreshed)
            .ok_or_else(|| anyhow!("loadCodeAssist did not return a cloudaicompanionProject"))
    }
    .await;

    match result {
        Ok(project_id) => Ok(project_id),
        Err(err) => {
            let msg = format!("{err:#}");
            if let Some(validation_url) = extract_google_validation_url(&msg) {
                return Err(anyhow!(format_google_validation_required_message(
                    &validation_url,
                    "sign in again",
                    email,
                )));
            }
            Err(err)
        }
    }
}

async fn fetch_userinfo_email(userinfo_url: &str, access_token: &str) -> Option<String> {
    let client = xai_grok_http::shared_client();
    let response = client
        .get(userinfo_url)
        .timeout(REQUEST_TIMEOUT)
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let info: UserinfoResponse = response.json().await.ok()?;
    info.email
        .map(|e| e.trim().to_owned())
        .filter(|e| !e.is_empty())
}

/// Exchange an authorization code for Google Antigravity OAuth tokens and
/// discover the Cloud Code Assist project ID.
pub(crate) async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> anyhow::Result<ProviderCredentials> {
    exchange_code_at(
        TOKEN_URL,
        USERINFO_URL,
        CLOUD_CODE_ASSIST_ENDPOINT,
        code,
        redirect_uri,
        code_verifier,
    )
    .await
}

pub(crate) async fn exchange_code_at(
    token_url: &str,
    userinfo_url: &str,
    cca_endpoint: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> anyhow::Result<ProviderCredentials> {
    let client = xai_grok_http::shared_client();
    let cid = client_id();
    let csecret = client_secret();
    let response = client
        .post(token_url)
        .timeout(REQUEST_TIMEOUT)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", cid.as_str()),
            ("client_secret", csecret.as_str()),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .context("requesting Google Antigravity OAuth token exchange")?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Token exchange failed: {}",
            format_token_endpoint_error(status.as_u16(), &body_text)
        ));
    }

    let token_data: TokenResponse = serde_json::from_str(&body_text)
        .context("parsing Google Antigravity OAuth token exchange response")?;
    let access = token_data
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Token response missing access_token"))?;
    let refresh = token_data
        .refresh_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("No refresh token received. Please try again."))?;
    let expires_in = token_data
        .expires_in
        .filter(|s| *s > 0)
        .ok_or_else(|| anyhow!("Token response missing expires_in"))?;

    let email = fetch_userinfo_email(userinfo_url, &access).await;
    let project_id = discover_project_at(cca_endpoint, &access, email.as_deref()).await?;

    let now = store::now_ms();
    Ok(ProviderCredentials {
        access,
        refresh,
        expires_ms: now.saturating_add(expires_in.saturating_mul(1_000)),
        authorized_at: now,
        account_id: Some(project_id.clone()),
        email,
        org_id: Some(project_id),
        org_name: None,
    })
}

/// Refresh a Google Antigravity OAuth grant, preserving the stored
/// `cloudaicompanionProject` ID (`account_id` / `org_id`).
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
            "google-antigravity credentials are missing refresh token; sign in again"
        ));
    }
    let project_id = current
        .account_id
        .as_deref()
        .or(current.org_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "google-antigravity credentials are missing projectId; run `amore login --provider google-antigravity`"
            )
        })?
        .to_owned();

    let client = xai_grok_http::shared_client();
    let cid = client_id();
    let csecret = client_secret();
    let response = client
        .post(token_url)
        .timeout(REQUEST_TIMEOUT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh.as_str()),
            ("client_id", cid.as_str()),
            ("client_secret", csecret.as_str()),
        ])
        .send()
        .await
        .context("requesting Google Antigravity OAuth token refresh")?;

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "Token refresh failed: {}",
            format_token_endpoint_error(status.as_u16(), &body_text)
        ));
    }

    let token_data: TokenResponse = serde_json::from_str(&body_text)
        .context("parsing Google Antigravity OAuth refresh response")?;
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

    let now = store::now_ms();
    Ok(ProviderCredentials {
        access,
        refresh,
        expires_ms: now.saturating_add(expires_in.saturating_mul(1_000)),
        authorized_at: current.authorized_at,
        account_id: Some(project_id.clone()),
        email: current.email.clone(),
        org_id: Some(project_id),
        org_name: current.org_name.clone(),
    })
}

/// Format stored credentials as the structured JSON string expected by the
/// Cloud Code Assist sampler (`{"token":"...","projectId":"...","email":"..."}`),
/// or fall back to the bare access token if no project ID is present.
pub(crate) fn encode_structured_credential(creds: &ProviderCredentials) -> String {
    let project_id = creds
        .account_id
        .as_deref()
        .or(creds.org_id.as_deref())
        .unwrap_or_default();
    serde_json::json!({
        "token": creds.access,
        "projectId": project_id,
        "refreshToken": creds.refresh,
        "expiresAt": creds.expires_ms,
        "email": creds.email,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_matches_omp_contract() {
        let url = authorize_url("st_abc", REDIRECT_URI, "chal_xyz");
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("accounts.google.com"));
        assert_eq!(parsed.path(), "/o/oauth2/v2/auth");

        let params: std::collections::HashMap<String, String> =
            parsed.query_pairs().into_owned().collect();
        assert_eq!(params.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(
            params.get("client_id").map(String::as_str),
            Some(client_id().as_str())
        );
        assert!(client_id().ends_with(".apps.googleusercontent.com"));
        assert!(client_secret().starts_with("GOCSPX-"));
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some(REDIRECT_URI)
        );
        assert_eq!(
            params.get("scope").map(String::as_str),
            Some(scope_string().as_str())
        );
        assert_eq!(
            params.get("code_challenge").map(String::as_str),
            Some("chal_xyz")
        );
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(params.get("state").map(String::as_str), Some("st_abc"));
        assert_eq!(
            params.get("access_type").map(String::as_str),
            Some("offline")
        );
        assert_eq!(params.get("prompt").map(String::as_str), Some("consent"));
    }

    #[test]
    fn extracts_validation_url_from_google_error_body() {
        let body = r#"403 Forbidden: {"error":{"code":403,"message":"Validation required","details":[{"reason":"VALIDATION_REQUIRED","metadata":{"validation_url":"https://accounts.google.com/verify/123"}}]}}"#;
        assert_eq!(
            extract_google_validation_url(body).as_deref(),
            Some("https://accounts.google.com/verify/123")
        );
        assert_eq!(
            format_google_validation_required_message(
                "https://accounts.google.com/verify/123",
                "sign in again",
                Some("dev@example.com")
            ),
            "Account verification required for dev@example.com. Visit https://accounts.google.com/verify/123 to continue, then sign in again."
        );
    }

    #[tokio::test]
    async fn exchange_onboard_and_refresh_against_mock_server() {
        let load_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let load_calls_route = load_calls.clone();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let app = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(
                    move |axum::Form(form): axum::Form<std::collections::HashMap<String, String>>| async move {
                        match form.get("grant_type").map(String::as_str) {
                            Some("authorization_code") => axum::Json(serde_json::json!({
                                "access_token": "ya29.initial_token",
                                "refresh_token": "1//refresh_initial",
                                "expires_in": 3600
                            })),
                            Some("refresh_token") => axum::Json(serde_json::json!({
                                "access_token": "ya29.refreshed_token",
                                "expires_in": 3600
                            })),
                            other => panic!("unexpected grant_type: {other:?}"),
                        }
                    },
                ),
            )
            .route(
                "/userinfo",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "email": "antigravity@example.com"
                    }))
                }),
            )
            .route(
                "/v1internal:loadCodeAssist",
                axum::routing::post(move || {
                    let count = load_calls_route.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async move {
                        if count == 0 {
                            axum::Json(serde_json::json!({
                                "allowedTiers": [{ "id": "free-tier" }]
                            }))
                        } else {
                            axum::Json(serde_json::json!({
                                "currentTier": { "id": "free-tier" },
                                "paidTier": { "id": "free-tier" },
                                "allowedTiers": [{ "id": "free-tier" }],
                                "cloudaicompanionProject": "cca-proj-42"
                            }))
                        }
                    }
                }),
            )
            .route(
                "/v1internal:onboardUser",
                axum::routing::post(|| async {
                    axum::Json(serde_json::json!({
                        "name": "operations/op-123",
                        "done": false
                    }))
                }),
            )
            .route(
                "/v1internal/operations/op-123",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "name": "operations/op-123",
                        "done": true,
                        "response": {
                            "@type": "type.googleapis.com/OnboardUserResponse",
                            "cloudaicompanionProject": "cca-proj-42"
                        }
                    }))
                }),
            );

        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let base = format!("http://{addr}");
        let creds = exchange_code_at(
            &format!("{base}/token"),
            &format!("{base}/userinfo"),
            &base,
            "auth_code_1",
            REDIRECT_URI,
            "verifier_1",
        )
        .await
        .unwrap();

        assert_eq!(creds.access, "ya29.initial_token");
        assert_eq!(creds.refresh, "1//refresh_initial");
        assert_eq!(creds.account_id.as_deref(), Some("cca-proj-42"));
        assert_eq!(creds.org_id.as_deref(), Some("cca-proj-42"));
        assert_eq!(creds.email.as_deref(), Some("antigravity@example.com"));

        let refreshed = refresh_token_at(&format!("{base}/token"), &creds)
            .await
            .unwrap();
        assert_eq!(refreshed.access, "ya29.refreshed_token");
        assert_eq!(refreshed.refresh, "1//refresh_initial");
        assert_eq!(refreshed.account_id.as_deref(), Some("cca-proj-42"));
        assert_eq!(refreshed.email.as_deref(), Some("antigravity@example.com"));

        let structured = encode_structured_credential(&refreshed);
        let parsed: serde_json::Value = serde_json::from_str(&structured).unwrap();
        assert_eq!(
            parsed.get("token").and_then(|v| v.as_str()),
            Some("ya29.refreshed_token")
        );
        assert_eq!(
            parsed.get("projectId").and_then(|v| v.as_str()),
            Some("cca-proj-42")
        );

        server.abort();
    }
}
