//! Per-session loopback IPC. Unix domain socket on POSIX; TCP 127.0.0.1 on
//! Windows (token-gated; named-pipe clients from stdlib Python are unreliable).
//! Never bound off loopback.

use std::io::{BufRead, BufReader, Write};
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::sync::{mpsc, oneshot};

use super::msg::{Disposition, Envelope};

static LISTEN_ADDR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static LISTEN_TAILNET: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static LISTEN_TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn addr_cell() -> &'static Mutex<Option<String>> {
    LISTEN_ADDR.get_or_init(|| Mutex::new(None))
}
fn token_cell() -> &'static Mutex<Option<String>> {
    LISTEN_TOKEN.get_or_init(|| Mutex::new(None))
}
fn tailnet_cell() -> &'static Mutex<Option<String>> {
    LISTEN_TAILNET.get_or_init(|| Mutex::new(None))
}

pub fn listen_addr() -> Option<String> {
    addr_cell().lock().ok().and_then(|g| g.clone())
}
pub fn listen_token() -> Option<String> {
    token_cell().lock().ok().and_then(|g| g.clone())
}
pub fn listen_tailnet() -> Option<String> {
    tailnet_cell().lock().ok().and_then(|g| g.clone())
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
    #[serde(skip_serializing_if = "Option::is_none")]
    roster: Option<Vec<super::Presence>>,
}

impl WireOut {
    fn error(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            disposition: None,
            error: Some(msg.into()),
            roster: None,
        }
    }
}

/// Bind and serve. Fail-soft: IO errors log and return.
pub fn spawn_listener(tx: mpsc::UnboundedSender<Inbound>) {
    let local_tx = tx.clone();
    tokio::spawn(async move {
        if let Err(e) = serve(local_tx).await {
            tracing::debug!(error = %e, "coord socket: listener stopped");
        }
    });
    tokio::spawn(async move {
        if let Err(e) = serve_tailnet(tx).await {
            tracing::debug!(error = %e, "coord tailnet listener stopped");
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

/// Seat-door keeper. Exactly one session per seat holds the tailnet TLS
/// listener on the coord port; it answers for the whole seat (routing sends
/// to local sessions over loopback, answering `roster` pulls from the local
/// presence dir). Sessions that do not hold the door keep retrying, so the
/// door survives its owner's exit within one retry interval — and a seat
/// where Tailscale comes up late still acquires it.
const DOOR_RETRY_SECS: u64 = 30;

async fn serve_tailnet(tx: mpsc::UnboundedSender<Inbound>) -> std::io::Result<()> {
    loop {
        if let Err(reason) = serve_door_once(&tx).await {
            tracing::debug!(reason = %reason, "coord door: not held");
        }
        tokio::time::sleep(std::time::Duration::from_secs(DOOR_RETRY_SECS)).await;
    }
}

async fn serve_door_once(tx: &mpsc::UnboundedSender<Inbound>) -> Result<(), String> {
    let Some(ip) = super::seat::tailscale_ip() else {
        return Err("no tailscale address".into());
    };
    if ip.is_loopback() || ip.is_unspecified() {
        return Err("tailscale address unusable".into());
    }
    let seat = super::seat();
    let tls = super::tls::server_config(ip, &seat).map_err(|e| format!("server cert: {e}"))?;
    super::tls::house_token().map_err(|e| format!("house token: {e}"))?;
    let bind = std::net::SocketAddr::new(ip, super::tls::COORD_PORT);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("door busy or unbindable ({e})"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let addr = format!("tls:{ip}:{port}");
    if let Ok(mut g) = tailnet_cell().lock() {
        *g = Some(addr.clone());
    }
    super::patch_self_tailnet(Some(&addr));
    tracing::debug!(addr = %addr, "coord door: held");
    let result = door_accept_loop(&listener, tx, ip, tls.acceptor).await;
    if let Ok(mut g) = tailnet_cell().lock() {
        *g = None;
    }
    super::patch_self_tailnet(None);
    result.map_err(|e| format!("door lost: {e}"))
}

async fn door_accept_loop(
    listener: &tokio::net::TcpListener,
    tx: &mpsc::UnboundedSender<Inbound>,
    self_ip: IpAddr,
    acceptor: tokio_rustls::TlsAcceptor,
) -> Result<(), String> {
    loop {
        let (stream, peer) = listener.accept().await.map_err(|e| e.to_string())?;
        let tx = tx.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let Ok(mut tls_stream) = acceptor.accept(stream).await else {
                return;
            };
            if !source_admitted(peer.ip(), self_ip) {
                let _ = write_wire_error(&mut tls_stream, "source not admitted").await;
                return;
            }
            let Ok(token) = super::tls::house_token() else {
                let _ = write_wire_error(&mut tls_stream, "house token unavailable").await;
                return;
            };
            let _ = handle_stream(tls_stream, tx, token).await;
        });
    }
}

fn is_tailscale_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 0x40
        }
        IpAddr::V6(_) => false,
    }
}

/// Admit this node's own tailscale IPv4, or a CGNAT source whose MagicDNS
/// name is a row in the seats file. Everyone else is refused.
fn source_admitted(peer: IpAddr, self_ip: IpAddr) -> bool {
    let seat_ips: Vec<Option<IpAddr>> = super::seats::load()
        .iter()
        .map(|row| super::seat::tailscale_peer_ip(&row.name))
        .collect();
    admitted_source(peer, self_ip, &seat_ips)
}

fn admitted_source(peer: IpAddr, self_ip: IpAddr, seat_ips: &[Option<IpAddr>]) -> bool {
    if peer == self_ip {
        return true;
    }
    if !is_tailscale_ip(peer) {
        return false;
    }
    seat_ips.iter().any(|ip| *ip == Some(peer))
}

async fn write_wire_error<S>(stream: &mut S, error: &str) -> std::io::Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    let resp = serde_json::to_string(&WireOut::error(error)).unwrap_or_default();
    stream.write_all(format!("{resp}\n").as_bytes()).await?;
    stream.flush().await
}

async fn handle_stream<S>(
    stream: S,
    tx: mpsc::UnboundedSender<Inbound>,
    token: String,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    handle_stream_inner(stream, tx, token).await
}

async fn handle_stream_inner<S>(
    stream: S,
    tx: mpsc::UnboundedSender<Inbound>,
    token: String,
) -> std::io::Result<()>
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
        if parsed.kind != "send" && parsed.kind != "roster" {
            continue;
        }
        if !authed {
            let resp = serde_json::to_string(&WireOut::error("auth required")).unwrap_or_default();
            reader
                .get_mut()
                .write_all(format!("{resp}\n").as_bytes())
                .await?;
            break;
        }
        if parsed.kind == "roster" {
            let wire = WireOut {
                ok: true,
                disposition: None,
                error: None,
                roster: Some(super::roster_answer()),
            };
            let resp = serde_json::to_string(&wire).unwrap_or_default();
            reader
                .get_mut()
                .write_all(format!("{resp}\n").as_bytes())
                .await?;
            break;
        }
        let Some(envelope) = parsed.envelope else {
            continue;
        };
        let wire = match route_other_session(&envelope) {
            RouteOutcome::Forwarded(disp) => WireOut {
                ok: true,
                disposition: Some(disp.as_str().into()),
                error: None,
                roster: None,
            },
            RouteOutcome::Failed(error) => WireOut::error(error),
            RouteOutcome::NotForPeer => {
                let (reply_tx, reply_rx) = oneshot::channel();
                if tx
                    .send(Inbound {
                        envelope,
                        reply: reply_tx,
                    })
                    .is_err()
                {
                    break;
                }
                let disp = reply_rx.await.unwrap_or(Disposition::Inbox);
                WireOut {
                    ok: true,
                    disposition: Some(disp.as_str().into()),
                    error: None,
                    roster: None,
                }
            }
        };
        let resp = serde_json::to_string(&wire).unwrap_or_default();
        reader
            .get_mut()
            .write_all(format!("{resp}\n").as_bytes())
            .await?;
        break;
    }
    Ok(())
}

fn named_pipe_path(addr: &str) -> Option<&str> {
    let a = addr.strip_prefix("uds:").unwrap_or(addr);
    if a.starts_with(r"\\.\pipe\") || a.starts_with("//./pipe/") {
        Some(a)
    } else {
        a.strip_prefix("pipe:")
    }
}

/// Blocking client used by `amore coord send`.
///
/// The frame is chosen by the TARGET HARNESS, never the transport: amore
/// sessions speak `{type:"send", envelope}` and reply with a disposition;
/// every other harness takes its own user frame (`{type:"user", message:
/// {role, content}}`) and usually writes no reply — a quiet accepted write
/// is an enqueue.
pub fn post_local(
    addr: &str,
    token: &str,
    env: &Envelope,
    peer_harness: &str,
) -> Result<Disposition, String> {
    if let Some(path) = named_pipe_path(addr) {
        #[cfg(windows)]
        {
            return pipe_post(path, token, env);
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            return Err("named pipes are not available on this platform".into());
        }
    }
    let amore = peer_harness.eq_ignore_ascii_case(super::HARNESS);
    let auth = serde_json::json!({"type": "auth", "token": token});
    let body = if amore {
        serde_json::json!({"type": "send", "envelope": env})
    } else {
        serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": super::msg::wrap_prompt(env)},
        })
    };
    let payload = format!("{auth}\n{body}\n");
    if !amore {
        return stream_post_no_reply(addr, &payload);
    }
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

/// Write a frame to a harness that usually answers with silence. The write
/// must succeed; a brief read window picks up an explicit refusal when one
/// is offered, and quiet is an enqueue.
fn stream_post_no_reply(addr: &str, payload: &str) -> Result<Disposition, String> {
    let reply = if let Some(path) = addr.strip_prefix("unix:") {
        #[cfg(unix)]
        {
            let mut s =
                std::os::unix::net::UnixStream::connect(path).map_err(|e| e.to_string())?;
            s.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut r = BufReader::new(s);
            let mut line = String::new();
            let _ = r.read_line(&mut line);
            line
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            return Err("unix sockets are not available on this platform".into());
        }
    } else if let Some(rest) = addr.strip_prefix("tcp:") {
        let mut s = std::net::TcpStream::connect(rest).map_err(|e| e.to_string())?;
        s.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
        let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        let mut r = BufReader::new(s);
        let mut line = String::new();
        let _ = r.read_line(&mut line);
        line
    } else {
        return Err(format!("unknown socket addr: {addr}"));
    };
    let line = reply.trim();
    if line.is_empty() {
        return Ok(Disposition::Enqueued);
    }
    parse_disposition(line).or(Ok(Disposition::Enqueued))
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

/// Other harnesses on Windows stamp `\\.\pipe\...`. First line is token auth;
/// the body is the harness's user frame — `{type:"user", message:{role,
/// content}}`. The listener silently drops frames of any other type, so a
/// successful pipe write with the wrong shape still looks like an enqueue.
/// Delivery into a session that bypasses permission prompts additionally
/// needs `crossSessionInbound: "accept"` in that harness's settings — a
/// classless sender's post is otherwise held and dropped.
#[cfg(windows)]
fn pipe_post(path: &str, token: &str, env: &Envelope) -> Result<Disposition, String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    let auth = serde_json::json!({"type": "auth", "token": token});
    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": super::msg::wrap_prompt(env),
        },
    });
    let payload = format!("{auth}\n{msg}\n");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .map_err(|e| format!("named pipe {path}: {e}"))?;
    let mut s = file;
    s.write_all(payload.as_bytes())
        .map_err(|e| format!("named pipe write: {e}"))?;
    let _ = s.flush();
    // Peers using first-line auth often write no reply. Do not block the CLI.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut r = BufReader::new(s);
        let mut line = String::new();
        let res = r
            .read_line(&mut line)
            .map(|_| ())
            .map_err(|e| e.to_string());
        let _ = tx.send((res, line));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok((Ok(()), line)) if line.trim().is_empty() => Ok(Disposition::Enqueued),
        Ok((Ok(()), line)) => parse_peer_reply(&line),
        Ok((Err(e), _)) => Err(format!("named pipe read: {e}")),
        Err(_) => Ok(Disposition::Enqueued),
    }
}

#[cfg(windows)]
fn parse_peer_reply(line: &str) -> Result<Disposition, String> {
    if let Ok(d) = parse_disposition(line) {
        return Ok(d);
    }
    #[derive(Deserialize)]
    struct Peer {
        #[serde(rename = "type")]
        kind: Option<String>,
        data: Option<String>,
    }
    let r: Peer = serde_json::from_str(line.trim()).map_err(|e| {
        format!("peer reply: {e}: {}", line.trim())
    })?;
    match (r.kind.as_deref(), r.data.as_deref()) {
        (Some("response"), Some("ok")) | (Some("response"), None) => {
            Ok(Disposition::Enqueued)
        }
        (Some("error"), data) => Err(data.unwrap_or("peer error").into()),
        other => Err(format!("unknown peer reply: {other:?}")),
    }
}

pub fn post_tailnet(addr: &str, peer_seat: &str, env: &Envelope) -> Result<Disposition, String> {
    let hostport = addr.strip_prefix("tls:").unwrap_or(addr);
    let token = super::tls::house_token()?;
    let auth = serde_json::json!({"type": "auth", "token": token});
    let send = serde_json::json!({"type": "send", "envelope": env});
    let payload = format!("{auth}\n{send}\n");
    let reply = super::tls::tls_post(hostport, peer_seat, &payload)?;
    parse_disposition(&reply)
}

/// Pull a peer seat's live roster from its door. Short timeouts: this runs
/// in a fan-out under a deadline and a dark seat must not stall it.
pub fn fetch_roster_tailnet(hostport: &str, peer_seat: &str) -> Result<Vec<super::Presence>, String> {
    let hostport = hostport.strip_prefix("tls:").unwrap_or(hostport);
    let token = super::tls::house_token()?;
    let auth = serde_json::json!({"type": "auth", "token": token});
    let req = serde_json::json!({"type": "roster"});
    let payload = format!("{auth}\n{req}\n");
    let reply = super::tls::tls_post_with(
        hostport,
        peer_seat,
        &payload,
        std::time::Duration::from_millis(1_200),
        std::time::Duration::from_millis(1_500),
    )?;
    parse_roster_reply(&reply)
}

fn parse_roster_reply(line: &str) -> Result<Vec<super::Presence>, String> {
    #[derive(Deserialize)]
    struct Resp {
        ok: bool,
        #[serde(default)]
        roster: Option<Vec<super::Presence>>,
        #[serde(default)]
        error: Option<String>,
    }
    let r: Resp = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    if !r.ok {
        return Err(r.error.unwrap_or_else(|| "roster refused".into()));
    }
    r.roster.ok_or_else(|| "no roster in answer".into())
}

#[derive(Debug, PartialEq, Eq)]
enum RouteOutcome {
    /// Not addressed to another local session. Caller may self-handle.
    NotForPeer,
    /// Delivered to the addressed local session (or honestly inboxed).
    Forwarded(Disposition),
    /// Addressed to another local session, but the hop failed. Never self-inject.
    Failed(String),
}

struct RoutePeer<'a> {
    session_id: Option<&'a str>,
    pid: u32,
    seat: &'a str,
    harness: &'a str,
    socket: Option<&'a str>,
    socket_token: Option<&'a str>,
}

fn route_other_session(env: &Envelope) -> RouteOutcome {
    let me = std::process::id();
    let my_seat = super::seat();
    // Local only: the door must answer from its own seat, never dial out.
    let roster = super::local_roster();
    let peers: Vec<RoutePeer<'_>> = roster
        .iter()
        .map(|p| RoutePeer {
            session_id: p.session_id.as_deref(),
            pid: p.pid,
            seat: p.seat.as_str(),
            harness: p.harness.as_str(),
            socket: p.socket.as_deref(),
            socket_token: p.socket_token.as_deref(),
        })
        .collect();
    let Some(peer) = classify_local_target(env, me, &my_seat, &peers) else {
        return RouteOutcome::NotForPeer;
    };
    route_matched_peer(env, peer, post_local)
}

fn classify_local_target<'a>(
    env: &Envelope,
    me: u32,
    my_seat: &str,
    roster: &'a [RoutePeer<'a>],
) -> Option<&'a RoutePeer<'a>> {
    let sid = env.to.as_ref().and_then(|t| t.session_id.as_deref())?;
    roster
        .iter()
        .find(|p| p.session_id == Some(sid) && p.pid != me && p.seat.eq_ignore_ascii_case(my_seat))
}

fn is_loopback_socket(addr: &str) -> bool {
    addr.starts_with("unix:") || addr.starts_with("tcp:") || named_pipe_path(addr).is_some()
}

fn route_matched_peer(
    env: &Envelope,
    peer: &RoutePeer<'_>,
    post: impl FnOnce(&str, &str, &Envelope, &str) -> Result<Disposition, String>,
) -> RouteOutcome {
    let sid = peer.session_id.unwrap_or("-");
    let (Some(addr), Some(token)) = (peer.socket, peer.socket_token) else {
        return RouteOutcome::Failed(format!("session {sid} has no loopback socket"));
    };
    match post(addr, token, env, peer.harness) {
        Ok(d) => RouteOutcome::Forwarded(d),
        Err(e) => RouteOutcome::Failed(format!("forward to {sid} failed: {e}")),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coord::msg::{Disposition, Envelope, Party};
    use std::net::{IpAddr, Ipv4Addr};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
    use tokio::sync::mpsc;

    fn env_to(sid: Option<&str>) -> Envelope {
        Envelope {
            msgid: "m1".into(),
            kind: "message".into(),
            ts: "2026-08-25T00:00:00Z".into(),
            from: Party {
                seat: "node-two".into(),
                harness: "amore".into(),
                model: None,
                session_id: Some("s-a".into()),
            },
            to: sid.map(|s| Party {
                seat: "node-one".into(),
                harness: "amore".into(),
                model: None,
                session_id: Some(s.into()),
            }),
            text: "hi".into(),
            in_reply_to: None,
        }
    }

    fn peer<'a>(
        sid: &'a str,
        pid: u32,
        socket: Option<&'a str>,
        token: Option<&'a str>,
    ) -> RoutePeer<'a> {
        RoutePeer {
            session_id: Some(sid),
            pid,
            seat: "node-one",
            harness: "amore",
            socket,
            socket_token: token,
        }
    }

    struct CoordRestore {
        coord: Option<std::ffi::OsString>,
        root: std::path::PathBuf,
    }

    impl Drop for CoordRestore {
        fn drop(&mut self) {
            match &self.coord {
                Some(v) => unsafe { std::env::set_var("HOUSE_COORD_DIR", v) },
                None => unsafe { std::env::remove_var("HOUSE_COORD_DIR") },
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn with_isolated_coord<R>(f: impl FnOnce() -> R) -> R {
        let _g = crate::coord::COORD_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!(
            "amore-socket-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let presence = root.join("presence");
        std::fs::create_dir_all(&presence).unwrap();
        let restore = CoordRestore {
            coord: std::env::var_os("HOUSE_COORD_DIR"),
            root: root.clone(),
        };
        unsafe { std::env::set_var("HOUSE_COORD_DIR", &presence) };
        let result = f();
        drop(restore);
        result
    }

    #[test]
    fn no_session_id_is_not_for_peer() {
        let env = env_to(None);
        let roster = [peer("s-b", 2, Some("tcp:127.0.0.1:1"), Some("t"))];
        assert!(classify_local_target(&env, 1, "node-one", &roster).is_none());
    }

    #[test]
    fn other_local_session_is_classified() {
        let env = env_to(Some("s-b"));
        let roster = [peer("s-b", 2, Some("tcp:127.0.0.1:1"), Some("t"))];
        let hit = classify_local_target(&env, 1, "node-one", &roster).unwrap();
        assert_eq!(hit.session_id, Some("s-b"));
    }

    #[test]
    fn self_pid_is_not_for_peer() {
        let env = env_to(Some("s-b"));
        let roster = [peer("s-b", 9, Some("tcp:127.0.0.1:1"), Some("t"))];
        assert!(classify_local_target(&env, 9, "node-one", &roster).is_none());
    }

    #[test]
    fn other_seat_is_not_local() {
        let env = env_to(Some("s-b"));
        let roster = [RoutePeer {
            session_id: Some("s-b"),
            pid: 2,
            seat: "node-two",
            harness: "amore",
            socket: Some("tcp:127.0.0.1:1"),
            socket_token: Some("t"),
        }];
        assert!(classify_local_target(&env, 1, "node-one", &roster).is_none());
    }

    #[test]
    fn missing_socket_is_failed_not_none() {
        let env = env_to(Some("s-b"));
        let p = peer("s-b", 2, None, None);
        let out = route_matched_peer(&env, &p, |_a, _t, _e, _h| Ok(Disposition::Woken));
        assert!(matches!(out, RouteOutcome::Failed(_)));
    }

    #[test]
    fn loopback_forward_error_is_failed_not_none() {
        let env = env_to(Some("s-b"));
        let p = peer("s-b", 2, Some("tcp:127.0.0.1:1"), Some("t"));
        let out = route_matched_peer(&env, &p, |_a, _t, _e, _h| Err("connection refused".into()));
        match out {
            RouteOutcome::Failed(e) => assert!(e.contains("connection refused")),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn named_pipe_forward_error_is_failed() {
        let env = env_to(Some("s-b"));
        let p = peer("s-b", 2, Some(r"\\.\pipe\harness-session"), Some("t"));
        let out = route_matched_peer(&env, &p, |addr, _, _, _| {
            Err(format!("named pipe {addr}: connection refused"))
        });
        match out {
            RouteOutcome::Failed(e) => assert!(e.contains("named pipe")),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn successful_forward_keeps_disposition() {
        let env = env_to(Some("s-b"));
        let p = peer("s-b", 2, Some("unix:/tmp/s.sock"), Some("t"));
        let out = route_matched_peer(&env, &p, |_a, _t, _e, _h| Ok(Disposition::Enqueued));
        assert_eq!(out, RouteOutcome::Forwarded(Disposition::Enqueued));
    }

    #[test]
    fn own_tailscale_ip_is_admitted() {
        let self_ip: IpAddr = Ipv4Addr::new(100, 64, 1, 1).into();
        assert!(admitted_source(self_ip, self_ip, &[]));
    }

    #[test]
    fn seats_file_ip_is_admitted() {
        let self_ip: IpAddr = Ipv4Addr::new(100, 64, 1, 1).into();
        let peer: IpAddr = Ipv4Addr::new(100, 64, 2, 2).into();
        assert!(admitted_source(peer, self_ip, &[Some(peer)]));
    }

    #[test]
    fn unknown_cgnat_ip_is_rejected() {
        let self_ip: IpAddr = Ipv4Addr::new(100, 64, 1, 1).into();
        let peer: IpAddr = Ipv4Addr::new(100, 64, 9, 9).into();
        assert!(!admitted_source(
            peer,
            self_ip,
            &[Some(Ipv4Addr::new(100, 64, 2, 2).into())]
        ));
    }

    #[test]
    fn non_tailscale_ip_is_rejected_even_if_listed() {
        let self_ip: IpAddr = Ipv4Addr::new(100, 64, 1, 1).into();
        let peer: IpAddr = Ipv4Addr::new(10, 0, 0, 8).into();
        assert!(!admitted_source(peer, self_ip, &[Some(peer)]));
    }

    #[test]
    fn parse_disposition_surfaces_auth_error() {
        let err = parse_disposition(r#"{"ok":false,"error":"auth required"}"#).unwrap_err();
        assert_eq!(err, "auth required");
    }

    #[test]
    fn parse_disposition_surfaces_source_error() {
        let err = parse_disposition(r#"{"ok":false,"error":"source not admitted"}"#).unwrap_err();
        assert_eq!(err, "source not admitted");
    }

    #[test]
    fn cgnat_range_is_tailscale_ipv4_only() {
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 64, 0, 1).into()));
        assert!(is_tailscale_ip(Ipv4Addr::new(100, 127, 255, 255).into()));
        assert!(!is_tailscale_ip(Ipv4Addr::new(100, 63, 255, 255).into()));
        assert!(!is_tailscale_ip(Ipv4Addr::new(100, 128, 0, 1).into()));
        assert!(!is_tailscale_ip(Ipv4Addr::new(127, 0, 0, 1).into()));
    }

    #[tokio::test]
    async fn tailnet_send_without_token_is_rejected() {
        let (client, server) = tokio::io::duplex(16 * 1024);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let server_task =
            tokio::spawn(
                async move { handle_stream_inner(server, tx, "house-secret".into()).await },
            );
        let send = serde_json::json!({
            "type": "send",
            "envelope": env_to(None)
        });
        let mut client = client;
        client
            .write_all(format!("{send}\n").as_bytes())
            .await
            .unwrap();
        let mut reader = AsyncBufReader::new(client);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "auth required");
        assert!(rx.try_recv().is_err(), "unauthed send must not inject");
        drop(reader);
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn tailnet_wrong_token_is_rejected() {
        let (client, server) = tokio::io::duplex(16 * 1024);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let server_task =
            tokio::spawn(
                async move { handle_stream_inner(server, tx, "house-secret".into()).await },
            );
        let auth = serde_json::json!({"type": "auth", "token": "forged"});
        let send = serde_json::json!({
            "type": "send",
            "envelope": env_to(None)
        });
        let mut client = client;
        client
            .write_all(format!("{auth}\n{send}\n").as_bytes())
            .await
            .unwrap();
        let mut reader = AsyncBufReader::new(client);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "auth required");
        assert!(rx.try_recv().is_err(), "forged token must not inject");
        drop(reader);
        let _ = server_task.await;
    }

    #[test]
    fn loopback_token_path_still_auths() {
        with_isolated_coord(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let (client, server) = tokio::io::duplex(16 * 1024);
                    let (tx, mut rx) = mpsc::unbounded_channel();
                    let server_task = tokio::spawn(async move {
                        handle_stream_inner(server, tx, "loopback-token".into()).await
                    });
                    let auth = serde_json::json!({"type": "auth", "token": "loopback-token"});
                    let send = serde_json::json!({
                        "type": "send",
                        "envelope": env_to(None)
                    });
                    let mut client = client;
                    client
                        .write_all(format!("{auth}\n{send}\n").as_bytes())
                        .await
                        .unwrap();
                    let inbound = rx.recv().await.expect("authed send injects");
                    inbound.reply.send(Disposition::Woken).ok();
                    let mut reader = AsyncBufReader::new(client);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                    assert_eq!(v["ok"], true);
                    assert_eq!(v["disposition"], "woken");
                    drop(reader);
                    let _ = server_task.await;
                });
        });
    }
}
