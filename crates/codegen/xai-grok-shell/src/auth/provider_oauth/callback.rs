// Loopback OAuth callback server for the provider login flows.
//
// Mirrors the oidc login's shape (axum router + stdin paste race) with the
// provider flows' specifics: preferred port 54545 with random-port fallback,
// a 5-minute wait, and paste input accepting either a full redirect URL or a
// bare `code` (optionally `code#state`, Anthropic's fragment form).

use anyhow::{anyhow, Context as _};
use axum::extract::Query;
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;
use tokio::net::TcpListener;

use super::anthropic;

const WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The code + state that came back from the provider.
#[derive(Debug, Clone)]
pub(crate) struct CallbackCode {
    pub code: String,
    pub state: String,
}

#[derive(Debug)]
enum CallbackEvent {
    Code(CallbackCode),
    /// The provider redirected with an error and our state nonce — a genuine
    /// authorization failure (user denied consent), not a forged request.
    Denied(String),
}

/// Parse pasted input (a full redirect URL, a bare query string, or
/// `code#state`) into a code + optional state.
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
    if let Some(query) = value.strip_prefix('?') {
        let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        return callback_from_params(&params);
    }
    // Assume a raw code, possibly with a fragment state.
    match value.split_once('#') {
        Some((code, state)) => Some(CallbackCode {
            code: code.to_owned(),
            state: state.to_owned(),
        }),
        None => Some(CallbackCode {
            code: value.to_owned(),
            state: String::new(),
        }),
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

/// Bind the callback listener, preferring the provider's registered port and
/// falling back to a random one. The redirect URI is derived from the same
/// listener the callback wait consumes, so a fallback port is consistent
/// between the authorization URL and the server.
pub(crate) async fn bind_and_redirect_uri() -> anyhow::Result<(TcpListener, String)> {
    let listener = match TcpListener::bind(("127.0.0.1", anthropic::CALLBACK_PORT)).await {
        Ok(listener) => listener,
        Err(preferred_err) => {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .await
                .context("binding OAuth callback listener")?;
            eprintln!(
                "Preferred port {} unavailable ({preferred_err}), using port {}",
                anthropic::CALLBACK_PORT,
                listener.local_addr()?.port()
            );
            listener
        }
    };
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}{}", anthropic::CALLBACK_PATH);
    tracing::debug!(port, redirect_uri = %redirect_uri, "provider OAuth callback bound");
    Ok((listener, redirect_uri))
}

/// Wait for the OAuth callback: the loopback server and (when stdin is a
/// terminal) pasted input race; the first valid code with a matching state
/// wins.
pub(crate) async fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
    enable_stdin: bool,
) -> anyhow::Result<CallbackCode> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<CallbackEvent>(1);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let expected_state = expected_state.to_owned();
    let route_tx = tx.clone();
    let router = Router::new()
        .route(
            anthropic::CALLBACK_PATH,
            get(move |Query(params): Query<HashMap<String, String>>| async move {
                handle_callback(params, expected_state, route_tx.clone())
            }),
        )
        .fallback(|| async { axum::http::StatusCode::NOT_FOUND });
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    if enable_stdin {
        spawn_stdin_reader(tx.clone());
    }
    // Drop our last handle so a finished server/stdin pair closes the channel.
    drop(tx);

    let event = tokio::time::timeout(WAIT_TIMEOUT, rx.recv())
        .await
        .map_err(|_| anyhow!("timed out after 5 minutes waiting for the OAuth callback"))?
        .ok_or_else(|| anyhow!("OAuth callback channel closed without a code"))?;

    let _ = shutdown_tx.send(());
    let _ = server.await;

    match event {
        CallbackEvent::Code(code) => Ok(code),
        CallbackEvent::Denied(message) => Err(anyhow!("Authorization failed: {message}")),
    }
}

fn handle_callback(
    params: HashMap<String, String>,
    expected_state: String,
    tx: tokio::sync::mpsc::Sender<CallbackEvent>,
) -> axum::response::Html<&'static str> {
    let error = params.get("error").cloned().unwrap_or_default();
    let state = params.get("state").cloned().unwrap_or_default();
    let state_matches = state.is_empty() || state == expected_state;

    let event = if !error.is_empty() {
        if state_matches {
            let description = params
                .get("error_description")
                .cloned()
                .unwrap_or_else(|| error.clone());
            Some(CallbackEvent::Denied(description))
        } else {
            // Errors without our state nonce are forgeable by any local
            // process; ignore them and keep waiting (omp #4106).
            None
        }
    } else {
        match callback_from_params(&params) {
            Some(code) if code.state.is_empty() || code.state == expected_state => {
                Some(CallbackEvent::Code(code))
            }
            _ => None,
        }
    };

    if let Some(event) = event {
        let _ = tx.blocking_send(event);
    }
    axum::response::Html(
        "<html><body style=\"font-family: sans-serif; text-align: center; padding-top: 4em;\">\
         <h2>Login received</h2><p>You can close this window and return to the terminal.</p>\
         </body></html>",
    )
}

/// Read pasted lines from stdin until a parseable one arrives.
fn spawn_stdin_reader(tx: tokio::sync::mpsc::Sender<CallbackEvent>) {
    tokio::task::spawn_blocking(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if let Some(code) = parse_pasted_input(&line) {
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
            "http://127.0.0.1:54545/callback?code=abc123&state=st456",
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
        assert!(parse_pasted_input("http://127.0.0.1:54545/callback?state=only").is_none());
    }
}
