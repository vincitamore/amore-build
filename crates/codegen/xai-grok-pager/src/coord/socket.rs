//! Per-session loopback IPC. Unix domain socket on POSIX; TCP 127.0.0.1 on
//! Windows (token-gated; named-pipe clients from stdlib Python are unreliable).
//! Never bound off loopback.

use std::io::{BufRead, BufReader, Write};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::sync::{mpsc, oneshot};

use super::msg::{Disposition, Envelope};

static LISTEN_ADDR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static LISTEN_TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn addr_cell() -> &'static Mutex<Option<String>> {
    LISTEN_ADDR.get_or_init(|| Mutex::new(None))
}
fn token_cell() -> &'static Mutex<Option<String>> {
    LISTEN_TOKEN.get_or_init(|| Mutex::new(None))
}

pub fn listen_addr() -> Option<String> {
    addr_cell().lock().ok().and_then(|g| g.clone())
}
pub fn listen_token() -> Option<String> {
    token_cell().lock().ok().and_then(|g| g.clone())
}

fn set_listen(addr: String, token: String) {
    if let Ok(mut g) = addr_cell().lock() {
        *g = Some(addr.clone());
    }
    if let Ok(mut g) = token_cell().lock() {
        *g = Some(token.clone());
    }
    super::patch_self_socket(&addr, &token);
}

pub struct Inbound {
    pub envelope: Envelope,
    pub reply: oneshot::Sender<Disposition>,
}

#[derive(Debug, Deserialize)]
struct WireIn {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    envelope: Option<Envelope>,
}

#[derive(Debug, Serialize)]
struct WireOut {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    disposition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Bind and serve. Fail-soft: IO errors log and return.
pub fn spawn_listener(tx: mpsc::UnboundedSender<Inbound>) {
    tokio::spawn(async move {
        if let Err(e) = serve(tx).await {
            tracing::debug!(error = %e, "coord socket: listener stopped");
        }
    });
}

async fn serve(tx: mpsc::UnboundedSender<Inbound>) -> std::io::Result<()> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    #[cfg(unix)]
    {
        serve_unix(tx, token).await
    }
    #[cfg(windows)]
    {
        serve_tcp(tx, token).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (tx, token);
        Ok(())
    }
}

#[cfg(unix)]
async fn serve_unix(tx: mpsc::UnboundedSender<Inbound>, token: String) -> std::io::Result<()> {
    use tokio::net::UnixListener;
    let dir = super::coord_root().join("sockets");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}-{}.sock", super::HARNESS, std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let addr = format!("unix:{}", path.display());
    set_listen(addr, token.clone());
    loop {
        let (stream, _) = listener.accept().await?;
        let tx = tx.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let _ = handle_stream(stream, tx, token).await;
        });
    }
}

#[cfg(windows)]
async fn serve_tcp(tx: mpsc::UnboundedSender<Inbound>, token: String) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let addr = format!("tcp:127.0.0.1:{port}");
    set_listen(addr, token.clone());
    loop {
        let (stream, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let tx = tx.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let _ = handle_stream(stream, tx, token).await;
        });
    }
}

async fn handle_stream<S>(stream: S, tx: mpsc::UnboundedSender<Inbound>, token: String) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut reader = AsyncBufReader::new(stream);
    let mut line = String::new();
    let mut authed = false;
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let parsed: WireIn = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if parsed.kind == "auth" {
            authed = parsed.token.as_deref() == Some(token.as_str());
            continue;
        }
        if parsed.kind != "send" {
            continue;
        }
        if !authed {
            let resp = serde_json::to_string(&WireOut {
                ok: false,
                disposition: None,
                error: Some("auth required".into()),
            })
            .unwrap_or_default();
            reader.get_mut().write_all(format!("{resp}\n").as_bytes()).await?;
            break;
        }
        let Some(envelope) = parsed.envelope else {
            continue;
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        if tx.send(Inbound { envelope, reply: reply_tx }).is_err() {
            break;
        }
        let disp = reply_rx.await.unwrap_or(Disposition::Inbox);
        let resp = serde_json::to_string(&WireOut {
            ok: true,
            disposition: Some(disp.as_str().into()),
            error: None,
        })
        .unwrap_or_default();
        reader.get_mut().write_all(format!("{resp}\n").as_bytes()).await?;
        break;
    }
    Ok(())
}

/// Blocking client used by `amore coord send`.
pub fn post_local(addr: &str, token: &str, env: &Envelope) -> Result<Disposition, String> {
    let auth = serde_json::json!({"type": "auth", "token": token});
    let send = serde_json::json!({"type": "send", "envelope": env});
    let payload = format!("{auth}\n{send}\n");
    let reply = if let Some(path) = addr.strip_prefix("unix:") {
        #[cfg(unix)]
        {
            unix_post(path, &payload)?
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            return Err("unix sockets are not available on this platform".into());
        }
    } else if let Some(rest) = addr.strip_prefix("tcp:") {
        tcp_post(rest, &payload)?
    } else {
        return Err(format!("unknown socket addr: {addr}"));
    };
    parse_disposition(&reply)
}

#[cfg(unix)]
fn unix_post(path: &str, payload: &str) -> Result<String, String> {
    let mut s = std::os::unix::net::UnixStream::connect(path).map_err(|e| e.to_string())?;
    s.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    Ok(line)
}

fn tcp_post(hostport: &str, payload: &str) -> Result<String, String> {
    let mut s = std::net::TcpStream::connect(hostport).map_err(|e| e.to_string())?;
    s.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    Ok(line)
}

fn parse_disposition(line: &str) -> Result<Disposition, String> {
    #[derive(Deserialize)]
    struct Resp {
        ok: bool,
        disposition: Option<String>,
        error: Option<String>,
    }
    let r: Resp = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    if !r.ok {
        return Err(r.error.unwrap_or_else(|| "send failed".into()));
    }
    match r.disposition.as_deref() {
        Some("woken") => Ok(Disposition::Woken),
        Some("enqueued") => Ok(Disposition::Enqueued),
        Some("inbox") => Ok(Disposition::Inbox),
        Some("deferred") => Ok(Disposition::Deferred),
        other => Err(format!("unknown disposition: {other:?}")),
    }
}
