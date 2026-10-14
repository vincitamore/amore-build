// Loopback OAuth callback server for the OpenAI Codex browser flow.
//
// Binds the provider-registered port 1455 on 127.0.0.1 (and ::1 when available)
// with port fallback disabled — OpenAI only allowlists
// `http://localhost:1455/auth/callback` — and races the HTTP callback against
// manual stdin paste so remote/SSH sessions can still complete the flow by
// pasting the redirect URL or authorization code.

use std::collections::HashMap;

use anyhow::{Context as _, anyhow};
use axum::Router;
use axum::extract::Query;
use axum::routing::get;
use tokio::net::TcpListener;

use super::{google_antigravity, openai};

const WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The code + state that came back from the provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallbackCode {
    pub code: String,
    pub state: String,
}

#[derive(Debug)]
enum CallbackEvent {
    Code(CallbackCode),
    /// The provider redirected with an error and our state nonce — a genuine
    /// authorization failure (e.g. user denied consent).
    Denied(String),
}

/// Parse pasted input (a full redirect URL, a query string, or `code#state`)
/// into a code + optional state.
pub(crate) fn parse_pasted_input(input: &str) -> Option<CallbackCode> {
    let value = input.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(url) = url::Url::parse(value) {
        let params: HashMap<String, String> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        return callback_from_params(&params);
    }
    if value.contains("code=") {
        let query = value.trim_start_matches(['?', '#']);
        let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        return callback_from_params(&params);
    }
    match value.split_once('#') {
        Some((code, state)) if !code.is_empty() => Some(CallbackCode {
            code: code.to_owned(),
            state: state.to_owned(),
        }),
        None => Some(CallbackCode {
            code: value.to_owned(),
            state: String::new(),
        }),
        _ => None,
    }
}

fn callback_from_params(params: &HashMap<String, String>) -> Option<CallbackCode> {
    let code = params.get("code")?;
    if code.is_empty() {
        return None;
    }
    Some(CallbackCode {
        code: code.clone(),
        state: params.get("state").cloned().unwrap_or_default(),
    })
}

/// The loopback listeners the OAuth callback wait serves, plus the redirect URI
/// the authorization request carries.
pub(crate) struct CallbackListeners {
    pub(crate) primary: TcpListener,
    /// Companion listener on `::1` so browsers resolving `localhost` to IPv6
    /// first reach our callback server.
    pub(crate) ipv6: Option<TcpListener>,
    pub(crate) redirect_uri: String,
    pub(crate) callback_path: &'static str,
}

/// Bind the OpenAI Codex callback listener on port 1455 (`port_fallback = false`).
///
/// OpenAI's OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`) only allowlists
/// `http://localhost:1455/auth/callback`; advertising a random port would fail
/// on the consent redirect. If port 1455 is busy and `enable_stdin` is false,
/// this returns an actionable error suggesting `--device-auth`.
pub(crate) async fn bind_openai_callback() -> anyhow::Result<CallbackListeners> {
    let primary = TcpListener::bind(("127.0.0.1", openai::CALLBACK_PORT))
        .await
        .with_context(|| {
            format!(
                "OAuth callback port {} is in use. OpenAI Codex OAuth requires exact redirect URI {}. \
                 Free port {} and retry, or run `amore login --provider openai --device-auth` for headless device login",
                openai::CALLBACK_PORT,
                openai::REDIRECT_URI,
                openai::CALLBACK_PORT,
            )
        })?;
    let ipv6 = match TcpListener::bind(("::1", openai::CALLBACK_PORT)).await {
        Ok(listener) => Some(listener),
        Err(err) => {
            tracing::debug!(
                port = openai::CALLBACK_PORT,
                error = %err,
                "IPv6 OAuth callback listener unavailable; serving IPv4 only"
            );
            None
        }
    };
    Ok(CallbackListeners {
        primary,
        ipv6,
        redirect_uri: openai::REDIRECT_URI.to_owned(),
        callback_path: openai::CALLBACK_PATH,
    })
}

/// Bind the Google Antigravity callback listener on `127.0.0.1:51121` with
/// automatic fallback to a random ephemeral port (`port_fallback = true`).
///
/// Desktop Google OAuth clients accept any loopback port on `127.0.0.1`.
pub(crate) async fn bind_google_antigravity_callback() -> anyhow::Result<CallbackListeners> {
    let primary = match TcpListener::bind(("127.0.0.1", google_antigravity::CALLBACK_PORT)).await {
        Ok(listener) => listener,
        Err(preferred_err) => {
            tracing::debug!(
                preferred_port = google_antigravity::CALLBACK_PORT,
                error = %preferred_err,
                "preferred Antigravity callback port unavailable; falling back to an ephemeral port"
            );
            let fallback = TcpListener::bind(("127.0.0.1", 0u16))
                .await
                .context("binding loopback OAuth callback listener for Google Antigravity")?;
            if let Ok(addr) = fallback.local_addr() {
                eprintln!(
                    "Preferred port {} unavailable, using port {}",
                    google_antigravity::CALLBACK_PORT,
                    addr.port()
                );
            }
            fallback
        }
    };
    let actual_port = primary
        .local_addr()
        .context("reading local address of Google Antigravity callback listener")?
        .port();
    let redirect_uri = format!(
        "http://{}:{}{}",
        google_antigravity::CALLBACK_HOSTNAME,
        actual_port,
        google_antigravity::CALLBACK_PATH
    );
    Ok(CallbackListeners {
        primary,
        ipv6: None,
        redirect_uri,
        callback_path: google_antigravity::CALLBACK_PATH,
    })
}

/// Wait for the OAuth callback: the loopback server (when bound) and stdin
/// paste race; the first valid code with a matching state wins.
pub(crate) async fn wait_for_callback(
    listeners: Option<CallbackListeners>,
    expected_state: &str,
    enable_stdin: bool,
) -> anyhow::Result<CallbackCode> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<CallbackEvent>(1);

    let callback_path = listeners
        .as_ref()
        .map(|l| l.callback_path)
        .unwrap_or(openai::CALLBACK_PATH);
    let expected_state_owned = expected_state.to_owned();
    let build_router = |tx: tokio::sync::mpsc::Sender<CallbackEvent>| {
        let expected = expected_state_owned.clone();
        Router::new()
            .route(
                callback_path,
                get(
                    move |Query(params): Query<HashMap<String, String>>| async move {
                        handle_callback(params, expected.clone(), tx.clone())
                    },
                ),
            )
            .fallback(|| async { axum::http::StatusCode::NOT_FOUND })
    };

    let mut shutdown_senders: Vec<tokio::sync::oneshot::Sender<()>> = Vec::new();
    let mut servers = Vec::new();
    if let Some(listeners) = listeners {
        for listener in [Some(listeners.primary), listeners.ipv6]
            .into_iter()
            .flatten()
        {
            let router = build_router(tx.clone());
            let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
            shutdown_senders.push(shutdown_tx);
            servers.push(tokio::spawn(async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = shutdown_rx.await;
                    })
                    .await;
            }));
        }
    }

    if enable_stdin {
        spawn_stdin_reader(tx.clone(), expected_state.to_owned());
    }
    drop(tx);

    let event = tokio::time::timeout(WAIT_TIMEOUT, rx.recv())
        .await
        .map_err(|_| anyhow!("timed out after 5 minutes waiting for the OAuth callback"))?
        .ok_or_else(|| anyhow!("OAuth callback channel closed without an authorization code"))?;

    for sender in shutdown_senders {
        let _ = sender.send(());
    }
    for server in servers {
        let _ = server.await;
    }

    match event {
        CallbackEvent::Code(code) => Ok(code),
        CallbackEvent::Denied(message) => Err(anyhow!("Authorization failed: {message}")),
    }
}

fn handle_callback(
    params: HashMap<String, String>,
    expected_state: String,
    tx: tokio::sync::mpsc::Sender<CallbackEvent>,
) -> (axum::http::StatusCode, axum::response::Html<&'static str>) {
    let error = params.get("error").cloned().unwrap_or_default();
    let state = params.get("state").cloned().unwrap_or_default();
    let state_matches = expected_state.is_empty() || state == expected_state;

    let (status, html, event) = if !error.is_empty() {
        if state_matches {
            let description = params
                .get("error_description")
                .cloned()
                .unwrap_or_else(|| error.clone());
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "<html><body style=\"font-family: sans-serif; text-align: center; padding-top: 4em;\">\
                 <h2>Authorization failed</h2><p>You can close this window and return to the terminal.</p>\
                 </body></html>",
                Some(CallbackEvent::Denied(description)),
            )
        } else {
            (
                axum::http::StatusCode::BAD_REQUEST,
                "<html><body style=\"font-family: sans-serif; text-align: center; padding-top: 4em;\">\
                 <h2>Invalid callback state</h2><p>State mismatch.</p>\
                 </body></html>",
                None,
            )
        }
    } else {
        match callback_from_params(&params) {
            Some(code) if expected_state.is_empty() || code.state == expected_state => (
                axum::http::StatusCode::OK,
                "<html><body style=\"font-family: sans-serif; text-align: center; padding-top: 4em;\">\
                 <h2>Login received</h2><p>You can close this window and return to Amore Build.</p>\
                 </body></html>",
                Some(CallbackEvent::Code(code)),
            ),
            _ => (
                axum::http::StatusCode::BAD_REQUEST,
                "<html><body style=\"font-family: sans-serif; text-align: center; padding-top: 4em;\">\
                 <h2>Invalid callback</h2><p>Missing authorization code or state mismatch.</p>\
                 </body></html>",
                None,
            ),
        }
    };

    if let Some(event) = event {
        let _ = tx.try_send(event);
    }
    (status, axum::response::Html(html))
}

fn spawn_stdin_reader(tx: tokio::sync::mpsc::Sender<CallbackEvent>, expected_state: String) {
    tokio::task::spawn_blocking(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            if tx.is_closed() {
                break;
            }
            let Ok(line) = line else { break };
            if let Some(code) = parse_pasted_input(&line) {
                if !expected_state.is_empty()
                    && !code.state.is_empty()
                    && code.state != expected_state
                {
                    eprintln!("  State mismatch in pasted URL; paste the current login redirect URL:");
                    continue;
                }
                let _ = tx.blocking_send(CallbackEvent::Code(code));
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_redirect_url() {
        let parsed = parse_pasted_input(
            "http://localhost:1455/auth/callback?code=abc123&state=st456",
        )
        .unwrap();
        assert_eq!(parsed.code, "abc123");
        assert_eq!(parsed.state, "st456");
    }

    #[test]
    fn parses_bare_code_with_fragment_state() {
        let parsed = parse_pasted_input("abc123#st456").unwrap();
        assert_eq!(parsed.code, "abc123");
        assert_eq!(parsed.state, "st456");
    }

    #[test]
    fn parses_query_string_form() {
        let parsed = parse_pasted_input("?code=abc&state=xyz").unwrap();
        assert_eq!(parsed.code, "abc");
        assert_eq!(parsed.state, "xyz");
    }

    #[test]
    fn rejects_empty_and_codeless_input() {
        assert!(parse_pasted_input("").is_none());
        assert!(parse_pasted_input("   ").is_none());
        assert!(parse_pasted_input("http://localhost:1455/auth/callback?state=only").is_none());
    }
}
