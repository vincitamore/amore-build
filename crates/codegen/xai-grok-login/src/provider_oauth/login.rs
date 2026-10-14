// Login orchestration + live-token resolution for third-party OAuth providers.

use std::io::IsTerminal as _;

use anyhow::{Context as _, anyhow};
use tokio::sync::Mutex;

use super::callback::{self, CallbackCode};
use super::pkce;
use super::store::{self, ProviderCredentials};
use super::{LoginFlowKind, ProviderKind, google_antigravity, oauth_reference, openai};

/// `amore login --provider <name> [--device-auth]`: run the interactive
/// provider login and store the resulting credentials.
pub async fn run_provider_login_cli(provider: &str, force_device: bool) -> anyhow::Result<()> {
    let flow = LoginFlowKind::parse(provider, force_device).ok_or_else(|| {
        anyhow!(
            "unknown login provider '{provider}' (expected: openai, openai-codex, openai-codex-device, google-antigravity, antigravity)"
        )
    })?;
    let kind = flow.provider();
    let creds = match flow {
        LoginFlowKind::OpenAiBrowser => login_openai_browser().await?,
        LoginFlowKind::OpenAiDevice => login_openai_device().await?,
        LoginFlowKind::GoogleAntigravity => login_google_antigravity_browser().await?,
    };
    let path = store::default_store_path();
    store::store(&path, kind, &creds)
        .with_context(|| format!("storing {} OAuth credentials", kind.as_str()))?;
    eprintln!();
    eprintln!("Logged in with {}.", provider_display(kind));
    if let Some(email) = creds.email.as_deref() {
        eprintln!("Account: {email}");
    }
    if let Some(acct) = creds.account_id.as_deref() {
        match kind {
            ProviderKind::OpenAi => eprintln!("Workspace: {acct}"),
            ProviderKind::GoogleAntigravity => eprintln!("Project: {acct}"),
        }
    }
    if let Some(plan) = creds.org_name.as_deref() {
        eprintln!("Plan: {plan}");
    }
    eprintln!(
        "Use it from a model entry: api_key = \"oauth:{}\"",
        kind.as_str()
    );
    Ok(())
}

fn provider_display(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::OpenAi => "OpenAI (ChatGPT Plus/Pro via Codex OAuth)",
        ProviderKind::GoogleAntigravity => {
            "Google Antigravity (Gemini 3, Claude, GPT-OSS via Cloud Code Assist)"
        }
    }
}

async fn login_openai_browser() -> anyhow::Result<ProviderCredentials> {
    let pkce = pkce::generate_pkce();
    let state = pkce::generate_state();
    let enable_stdin = std::io::stdin().is_terminal();

    let listeners = match callback::bind_openai_callback().await {
        Ok(listeners) => Some(listeners),
        Err(err) if enable_stdin => {
            eprintln!("warning: {err:#}");
            eprintln!(
                "Continuing in manual paste mode: complete sign-in in your browser, then paste the final redirect URL here."
            );
            None
        }
        Err(err) => return Err(err),
    };

    let redirect_uri = listeners
        .as_ref()
        .map(|l| l.redirect_uri.clone())
        .unwrap_or_else(|| openai::REDIRECT_URI.to_owned());
    let auth_url = openai::authorize_url(&state, &redirect_uri, &pkce.code_challenge);

    eprintln!();
    eprintln!("Signing in with OpenAI (ChatGPT Plus/Pro Codex)...");
    eprintln!();
    if let Err(e) = webbrowser::open(&auth_url) {
        tracing::debug!(error = %e, "failed to open browser");
    }
    eprintln!("Open this URL to sign in:");
    eprintln!("  {auth_url}");
    if enable_stdin {
        eprintln!();
        eprintln!(
            "Paste the redirect URL (or authorization code) here if the browser runs on another machine:"
        );
    }

    let CallbackCode {
        code,
        state: received,
    } = callback::wait_for_callback(listeners, &state, enable_stdin).await?;
    if !received.is_empty() && received != state {
        return Err(anyhow!("OAuth state mismatch; aborting login"));
    }

    eprintln!();
    eprintln!("Exchanging authorization code for tokens...");
    openai::exchange_code(&code, &redirect_uri, &pkce.code_verifier).await
}

async fn login_openai_device() -> anyhow::Result<ProviderCredentials> {
    eprintln!();
    eprintln!("Initiating OpenAI Codex device authorization...");
    let init = openai::initiate_device_auth().await?;

    eprintln!();
    eprintln!("To sign in, open this URL in your browser:");
    eprintln!("  {}", openai::DEVICE_AUTH_URL);
    eprintln!();
    eprintln!("Enter code:");
    eprintln!("  {}", init.user_code);
    eprintln!();
    if let Err(e) = webbrowser::open(openai::DEVICE_AUTH_URL) {
        tracing::debug!(error = %e, "failed to open browser for device auth");
    }
    eprintln!("Waiting for browser authorization (code: {})...", init.user_code);

    for poll in 0..openai::DEVICE_MAX_POLLS {
        let sleep_ms = if poll == 0 {
            std::cmp::min(init.poll_interval_ms, openai::DEVICE_POLL_INTERVAL_MS)
        } else {
            init.poll_interval_ms
        };
        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;

        match openai::poll_device_token(&init.device_auth_id, &init.user_code).await? {
            openai::DevicePollOutcome::Pending => continue,
            openai::DevicePollOutcome::Ready {
                authorization_code,
                code_verifier,
            } => {
                eprintln!("Exchanging authorization code for tokens...");
                return openai::exchange_code(
                    &authorization_code,
                    openai::DEVICE_REDIRECT_URI,
                    &code_verifier,
                )
                .await;
            }
        }
    }

    Err(anyhow!(
        "Device authorization timed out — user did not complete login in time"
    ))
}

async fn login_google_antigravity_browser() -> anyhow::Result<ProviderCredentials> {
    let pkce = pkce::generate_pkce();
    let state = pkce::generate_state();
    let enable_stdin = std::io::stdin().is_terminal();

    let listeners = match callback::bind_google_antigravity_callback().await {
        Ok(listeners) => Some(listeners),
        Err(err) if enable_stdin => {
            eprintln!("warning: {err:#}");
            eprintln!(
                "Continuing in manual paste mode: complete sign-in in your browser, then paste the final redirect URL here."
            );
            None
        }
        Err(err) => return Err(err),
    };

    let redirect_uri = listeners
        .as_ref()
        .map(|l| l.redirect_uri.clone())
        .unwrap_or_else(|| google_antigravity::REDIRECT_URI.to_owned());
    let auth_url = google_antigravity::authorize_url(&state, &redirect_uri, &pkce.code_challenge);

    eprintln!();
    eprintln!("Signing in with Google Antigravity (Cloud Code Assist)...");
    eprintln!();
    if let Err(e) = webbrowser::open(&auth_url) {
        tracing::debug!(error = %e, "failed to open browser");
    }
    eprintln!("Open this URL to sign in:");
    eprintln!("  {auth_url}");
    if enable_stdin {
        eprintln!();
        eprintln!(
            "Paste the redirect URL (or authorization code) here if the browser runs on another machine:"
        );
    }

    let CallbackCode {
        code,
        state: received,
    } = callback::wait_for_callback(listeners, &state, enable_stdin).await?;
    if !received.is_empty() && received != state {
        return Err(anyhow!("OAuth state mismatch; aborting login"));
    }

    eprintln!();
    eprintln!("Exchanging authorization code for tokens...");
    google_antigravity::exchange_code(&code, &redirect_uri, &pkce.code_verifier).await
}

// ============================================================================
// Live token resolution
// ============================================================================

/// Serialize refreshes within this process. Cross-process races are settled by
/// the store's compare-and-set instead.
static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());

/// Load the provider's credentials and refresh them when stale.
pub(crate) async fn fresh_credentials(kind: ProviderKind) -> anyhow::Result<ProviderCredentials> {
    let path = store::default_store_path();
    let current = store::load(&path, kind).ok_or_else(|| missing_login_error(kind))?;

    if current.is_fresh(store::now_ms()) {
        return Ok(current);
    }

    let _guard = REFRESH_LOCK.lock().await;
    let current = match store::load(&path, kind) {
        Some(c) if c.is_fresh(store::now_ms()) => return Ok(c),
        Some(c) => c,
        None => return Err(missing_login_error(kind)),
    };

    let refreshed = match kind {
        ProviderKind::OpenAi => openai::refresh_token(&current).await,
        ProviderKind::GoogleAntigravity => google_antigravity::refresh_token(&current).await,
    };

    match refreshed {
        Ok(mut next) => {
            next.account_id = next.account_id.or(current.account_id.clone());
            next.email = next.email.or(current.email.clone());
            next.org_id = next.org_id.or(current.org_id.clone());
            next.org_name = next.org_name.or(current.org_name.clone());
            if next.authorized_at == 0 {
                next.authorized_at = current.authorized_at;
            }
            if store::store_refresh_cas(&path, kind, &current.refresh, &next) {
                tracing::info!(provider = kind.as_str(), "provider OAuth token refreshed");
            } else {
                tracing::info!(
                    provider = kind.as_str(),
                    "provider OAuth refresh lost a cross-process race; keeping the stored token"
                );
            }
            let stored = store::load(&path, kind).unwrap_or(next);
            if !stored.is_fresh(store::now_ms()) {
                return Err(anyhow!(
                    "{} OAuth token is not fresh after refresh; run `amore login --provider {}`",
                    kind.as_str(),
                    kind.as_str()
                ));
            }
            Ok(stored)
        }
        Err(e) => {
            if let Some(stored) = store::load(&path, kind)
                && stored.refresh != current.refresh
                && stored.is_fresh(store::now_ms())
            {
                tracing::info!(
                    provider = kind.as_str(),
                    "refresh failed but the stored credential was rotated by another process; using it"
                );
                return Ok(stored);
            }
            Err(anyhow!(e).context(format!(
                "{} OAuth token refresh failed; run `amore login --provider {}` to sign in again",
                kind.as_str(),
                kind.as_str()
            )))
        }
    }
}

fn missing_login_error(kind: ProviderKind) -> anyhow::Error {
    anyhow!(
        "no {} OAuth credentials stored; run `amore login --provider {}`",
        kind.as_str(),
        kind.as_str()
    )
}

/// Resolve a model `api_key` value that may be an `oauth:<provider>`
/// reference into a live access token.
///
/// Returns `Some(key)` unchanged for anything that is not a reference. A
/// reference with no stored credentials resolves to `None` (after logging an
/// actionable error) so the request fails as "no credential" rather than
/// sending the literal string as a bearer token.
pub fn resolve_api_key_reference(key: &str) -> Option<String> {
    let Some(kind) = oauth_reference(key) else {
        return Some(key.to_owned());
    };
    match blocking_fresh_credentials(kind) {
        Ok(creds) => match kind {
            ProviderKind::OpenAi => Some(creds.access),
            ProviderKind::GoogleAntigravity => {
                Some(google_antigravity::encode_structured_credential(&creds))
            }
        },
        Err(e) => {
            tracing::error!(
                provider = kind.as_str(),
                error = %e,
                "resolving oauth: model credential reference"
            );
            eprintln!("error: {e}");
            None
        }
    }
}

/// [`fresh_credentials`] for sync callers.
///
/// Runs the async refresh on a dedicated thread with its own single-threaded
/// runtime so `resolve_credentials` and `BearerResolver::current_bearer` can
/// run safely from inside a tokio worker.
pub(crate) fn blocking_fresh_credentials(
    kind: ProviderKind,
) -> anyhow::Result<ProviderCredentials> {
    let path = store::default_store_path();
    if let Some(creds) = store::load(&path, kind)
        && creds.is_fresh(store::now_ms())
    {
        return Ok(creds);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("provider-oauth-refresh".to_owned())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| anyhow!("building refresh runtime: {e}"))
                .and_then(|rt| rt.block_on(fresh_credentials(kind)));
            let _ = tx.send(result);
        })
        .map_err(|e| anyhow!("spawning provider OAuth refresh thread: {e}"))?
        .join()
        .ok();
    rx.recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| anyhow!("timed out waiting for the {} token refresh", kind.as_str()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_provider_names_are_rejected() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(run_provider_login_cli("not-a-provider", false));
        assert!(err.is_err());
    }
}
