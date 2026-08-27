// Login orchestration + live-token resolution for the provider OAuth flows.

use anyhow::{anyhow, Context as _};
use std::io::IsTerminal as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use super::anthropic;
use super::callback::{self, CallbackCode};
use super::cursor;
use super::pkce;
use super::store::{self, ProviderCredentials};
use super::{oauth_reference, ProviderKind};

// ============================================================================
// Login
// ============================================================================

/// `amore login --provider <name>`: run the interactive provider login and
/// store the resulting credentials.
pub async fn run_provider_login_cli(provider: &str) -> anyhow::Result<()> {
    let kind = ProviderKind::parse(provider)
        .ok_or_else(|| anyhow!("unknown login provider '{provider}' (expected: anthropic, cursor)"))?;
    let creds = match kind {
        ProviderKind::Anthropic => login_anthropic().await?,
        ProviderKind::Cursor => login_cursor().await?,
    };
    let path = store::default_store_path();
    store::store(&path, kind, &creds)
        .with_context(|| format!("storing {} OAuth credentials", kind.as_str()))?;
    eprintln!();
    eprintln!("Logged in with {}.", provider_display(kind));
    if let Some(email) = creds.email.as_deref() {
        eprintln!("Account: {email}");
    }
    if let Some(org) = creds.org_name.as_deref().or(creds.org_id.as_deref()) {
        eprintln!("Organization: {org}");
    }
    if let ProviderKind::Anthropic = kind {
        let deadline = anthropic::relogin_deadline(&creds);
        eprintln!(
            "Claude subscriptions require a fresh login about 30 days after this one.\
             \nRe-login by {} or inference will fail with an expired grant.",
            format_epoch_ms(deadline)
        );
    }
    eprintln!(
        "Use it from a model entry: api_key = \"oauth:{}\"",
        kind.as_str()
    );
    Ok(())
}

fn provider_display(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::Anthropic => "Claude (Claude Pro/Max via Claude Code OAuth)",
        ProviderKind::Cursor => "Cursor",
    }
}

fn format_epoch_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M %Z").to_string())
        .unwrap_or_else(|| format!("{ms} ms epoch"))
}

async fn login_anthropic() -> anyhow::Result<ProviderCredentials> {
    let pkce = pkce::generate_pkce();
    let state = pkce::generate_state();

    // Bind the callback server first so the actual redirect URI (the
    // registered port, or the fallback port) is known before the
    // authorization URL is built.
    let enable_stdin = std::io::stdin().is_terminal();
    let (listener, redirect_uri) = callback::bind_and_redirect_uri()
        .await
        .context("binding Anthropic OAuth callback listener")?;
    let auth_url = anthropic::authorize_url(&state, &redirect_uri, &pkce.code_challenge);

    eprintln!();
    eprintln!("Signing in with Claude (Claude Pro/Max)...");
    eprintln!();
    if let Err(e) = webbrowser::open(&auth_url) {
        tracing::debug!(error = %e, "failed to open browser");
    }
    eprintln!("Open this URL to sign in:");
    eprintln!("  {auth_url}");
    if enable_stdin {
        eprintln!();
        eprintln!("Paste the redirect URL (or code) here if the browser cannot reach this machine:");
    }

    let CallbackCode { code, state: received } =
        callback::wait_for_callback(listener, &state, enable_stdin).await?;
    if !received.is_empty() && received != state {
        return Err(anyhow!("OAuth state mismatch — possible CSRF; aborting login"));
    }

    eprintln!();
    eprintln!("Exchanging authorization code for tokens...");
    anthropic::exchange_code(&code, &state, &redirect_uri, &pkce.code_verifier).await
}

async fn login_cursor() -> anyhow::Result<ProviderCredentials> {
    let start = cursor::generate_login_start();
    eprintln!();
    eprintln!("Signing in with Cursor...");
    eprintln!();
    if let Err(e) = webbrowser::open(&start.login_url) {
        tracing::debug!(error = %e, "failed to open browser");
    }
    eprintln!("Complete the login in your browser:");
    eprintln!("  {}", start.login_url);

    let mut delay_ms = cursor::POLL_BASE_DELAY_MS;
    let mut consecutive_errors: u32 = 0;
    eprintln!("Waiting for authorization...");
    for attempt in 0..cursor::POLL_MAX_ATTEMPTS {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        match cursor::poll_once(&start.uuid, &start.verifier).await {
            Ok(cursor::PollOutcome::Ready { access_token, refresh_token }) => {
                return Ok(ProviderCredentials {
                    expires_ms: cursor::jwt_expiry_ms(&access_token)
                        .unwrap_or_else(|| store::now_ms() + 3_600 * 1000),
                    access: access_token,
                    refresh: refresh_token,
                    authorized_at: store::now_ms(),
                    account_id: None,
                    email: None,
                    org_id: None,
                    org_name: None,
                });
            }
            Ok(cursor::PollOutcome::Pending) => {
                consecutive_errors = 0;
                delay_ms = std::cmp::min(
                    (delay_ms as f64 * cursor::POLL_BACKOFF_MULTIPLIER) as u64,
                    cursor::POLL_MAX_DELAY_MS,
                );
                if attempt % 10 == 9 {
                    eprintln!("Still waiting for authorization... ({}s)", (attempt + 1));
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= cursor::POLL_MAX_CONSECUTIVE_ERRORS {
                    return Err(e).context("Cursor auth polling");
                }
            }
        }
    }
    Err(anyhow!("Cursor authentication polling timed out"))
}

// ============================================================================
// Live token resolution
// ============================================================================

/// Serialize refreshes within this process. Cross-process races are settled by
/// the store's compare-and-set instead.
static REFRESH_LOCK: Mutex<()> = Mutex::new(());

/// Was the "grant expired, re-login required" message already printed this
/// process? Emit it once, not per request.
static GRANT_EXPIRY_WARNED: AtomicBool = AtomicBool::new(false);

/// Load the provider's credentials and refresh them when stale.
pub(crate) async fn fresh_credentials(kind: ProviderKind) -> anyhow::Result<ProviderCredentials> {
    let path = store::default_store_path();
    let current = store::load(&path, kind)
        .ok_or_else(|| missing_login_error(kind))?;

    if current.is_fresh(store::now_ms()) {
        return Ok(current);
    }

    let _guard = REFRESH_LOCK.lock().map_err(|_| anyhow!("OAuth refresh lock poisoned"))?;
    // Re-load after taking the lock: a sibling task may have refreshed while
    // we waited.
    let current = match store::load(&path, kind) {
        Some(c) if c.is_fresh(store::now_ms()) => return Ok(c),
        Some(c) => c,
        None => return Err(missing_login_error(kind)),
    };

    warn_if_grant_expired(kind, &current);

    let refreshed = match kind {
        ProviderKind::Anthropic => anthropic::refresh_token(&current.refresh).await,
        ProviderKind::Cursor => cursor::refresh_token(&current.refresh).await,
    };

    match refreshed {
        Ok(mut next) => {
            // The refresh response does not carry identity; keep the row's
            // identity fields (omp preserves them across refreshes too).
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
                // Another process rotated the token while we refreshed; the
                // stored row is newer than our result — keep it (omp's CAS
                // discipline: never tear down a row that already holds a
                // valid token because our refresh attempt lost the race).
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
            // A definitive refresh failure may mean another process already
            // rotated: reload and use a fresh stored token when one exists.
            if let Some(stored) = store::load(&path, kind) {
                if stored.refresh != current.refresh && stored.is_fresh(store::now_ms()) {
                    tracing::info!(
                        provider = kind.as_str(),
                        "refresh failed but the stored credential was rotated by another process; using it"
                    );
                    return Ok(stored);
                }
            }
            Err(anyhow!(e).context(format!(
                "{} OAuth token refresh failed; run `amore login --provider {}` to sign in again",
                kind.as_str(),
                kind.as_str()
            )))
        }
    }
}

fn warn_if_grant_expired(kind: ProviderKind, creds: &ProviderCredentials) {
    if let ProviderKind::Anthropic = kind {
        if store::now_ms() >= anthropic::relogin_deadline(creds) {
            if !GRANT_EXPIRY_WARNED.swap(true, Ordering::Relaxed) {
                eprintln!(
                    "warning: this Claude OAuth grant passed its ~30-day re-login deadline \
                     (login anchored {}). Refreshes will fail until you run \
                     `amore login --provider anthropic`.",
                    format_epoch_ms(creds.authorized_at)
                );
            }
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
/// reference with no stored credentials resolves to `None` (after an
/// actionable error log) so the request fails as "no credential" rather than
/// sending the literal string as a bearer token.
pub fn resolve_api_key_reference(key: &str) -> Option<String> {
    let Some(kind) = oauth_reference(key) else {
        return Some(key.to_owned());
    };
    match blocking_fresh_credentials(kind) {
        Ok(creds) => Some(creds.access),
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
/// runtime: `resolve_credentials` can run on a tokio worker, where a nested
/// `block_on` would panic. The thread join blocks the caller only for the
/// rare refresh (~once an hour per provider); the fresh path is a file read.
pub(crate) fn blocking_fresh_credentials(
    kind: ProviderKind,
) -> anyhow::Result<ProviderCredentials> {
    let path = store::default_store_path();
    if let Some(creds) = store::load(&path, kind) {
        if creds.is_fresh(store::now_ms()) {
            return Ok(creds);
        }
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
    rx.recv_timeout(std::time::Duration::from_secs(60))
        .map_err(|_| anyhow!("timed out waiting for the {} token refresh", kind.as_str()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_provider_names_are_rejected() {
        let err = futures_now(run_provider_login_cli("not-a-provider"));
        assert!(err.is_err());
    }

    /// Run a future to completion on the current thread (tests only).
    fn futures_now<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }
}
