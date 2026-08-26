//! Seat coordination roster (`~/.house/coord/presence/`).
//!
//! House-neutral JSON files, one per live session, shared by every harness
//! on the seat. The session-init hook writes the same schema; this module
//! is the native emit/consume path so a clean exit removes the entry (the
//! hook pack has no SessionEnd) and the welcome splash / iris can read it.
//!
//! Liveness is a PID probe, never a TTL. Fail-soft: IO errors never block
//! session start or quit.

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub(crate) const HARNESS: &str = "amore";

/// Serializes tests that mutate `HOUSE_COORD_DIR` (process-global).
#[cfg(test)]
pub(crate) static COORD_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Presence {
    pub seat: String,
    pub harness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pname: Option<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub tree: String,
    pub started: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Loopback IPC for wake (`unix:/path` or `tcp:127.0.0.1:port`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
    /// Tailnet TLS listener (`tls:100.x.x.x:port`). Bound on the Tailscale
    /// address only — never 0.0.0.0, never LAN.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_tailnet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_token: Option<String>,
}

pub mod cmd;
pub mod log;
pub mod msg;
pub mod seat;
pub mod seats;
pub mod send;
pub mod socket;
pub mod tls;

pub use msg::{Disposition, Envelope, wrap_prompt};
pub use socket::{Inbound, spawn_listener};

/// Parent of the presence directory (`~/.house/coord`).
pub fn coord_root() -> PathBuf {
    presence_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(presence_dir)
}

/// `~/.house/coord/presence`, or `$HOUSE_COORD_DIR` when set.
pub fn presence_dir() -> PathBuf {
    if let Ok(over) = std::env::var("HOUSE_COORD_DIR") {
        let p = PathBuf::from(over);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    dirs_home().join(".house").join("coord").join("presence")
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) fn seat() -> String {
    seat::seat()
}

static THIS_SESSION_ID: OnceLock<String> = OnceLock::new();

pub(crate) fn this_session_id() -> Option<String> {
    THIS_SESSION_ID.get().cloned()
}

fn tree_of(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd.to_string())
}

fn pname_of_self() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
}

pub(crate) fn safe_ident(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

pub(crate) fn entry_path(dir: &Path, harness: &str, pid: u32) -> PathBuf {
    entry_path_on(dir, &seat(), harness, pid)
}

pub(crate) fn entry_path_on(dir: &Path, seat_name: &str, harness: &str, pid: u32) -> PathBuf {
    dir.join(format!(
        "{}-{}-{}.json",
        safe_ident(seat_name),
        safe_ident(harness),
        pid
    ))
}

fn legacy_entry_path(dir: &Path, harness: &str, pid: u32) -> PathBuf {
    dir.join(format!("{}-{}.json", safe_ident(harness), pid))
}

fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        if Path::new(&format!("/proc/{pid}")).exists() {
            return true;
        }
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(true)
    }
    #[cfg(windows)]
    {
        win_pid::is_alive(pid)
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}

#[cfg(windows)]
mod win_pid {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_ACCESS_DENIED: u32 = 5;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        fn GetExitCodeProcess(handle: *mut core::ffi::c_void, exit_code: *mut u32) -> i32;
        fn GetLastError() -> u32;
    }

    pub fn is_alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            let _ = CloseHandle(h);
            ok != 0 && code == STILL_ACTIVE
        }
    }
}

/// Write this process into the seat roster. Fail-soft.
pub fn start(session_id: Option<&str>, cwd: &str) {
    let pid = std::process::id();
    let dir = presence_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        tracing::debug!(error = %e, "coord presence: mkdir failed");
        return;
    }
    let entry = Presence {
        seat: seat(),
        harness: HARNESS.to_string(),
        model: std::env::var("HOUSE_MODEL").ok().filter(|s| !s.is_empty()),
        pid,
        pname: pname_of_self(),
        cwd: cwd.to_string(),
        tree: tree_of(cwd),
        started: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        work_unit: None,
        session_id: session_id.map(str::to_string),
        socket: socket::listen_addr(),
        socket_tailnet: socket::listen_tailnet(),
        socket_token: socket::listen_token(),
    };
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        let _ = THIS_SESSION_ID.set(sid.to_string());
    }
    seat::persist_authoritative();
    // Isolated rosters (tests, overlays) must not retarget the machine's
    // SSH-visible coord at a temp dir.
    if std::env::var_os("HOUSE_COORD_DIR").is_none() {
        seats::ensure_ssh_visible_coord();
    }
    std::thread::spawn(|| seats::converge_house_token());
    let path = entry_path(&dir, HARNESS, pid);
    let tmp = path.with_extension("tmp");
    match serde_json::to_string_pretty(&entry) {
        Ok(body) => {
            if let Err(e) = fs::write(&tmp, body) {
                tracing::debug!(error = %e, "coord presence: write failed");
                return;
            }
            if let Err(e) = fs::rename(&tmp, &path) {
                let _ = fs::remove_file(&tmp);
                tracing::debug!(error = %e, "coord presence: rename failed");
            } else {
                let _ = fs::remove_file(legacy_entry_path(&dir, HARNESS, pid));
                let _ = fs::remove_file(entry_path(&dir, "claude-code", pid));
                let publish = path.clone();
                std::thread::spawn(move || seats::publish_file(&publish));
            }
        }
        Err(e) => tracing::debug!(error = %e, "coord presence: serialize failed"),
    }
}

/// Remove this process's roster entry. Fail-soft.
pub fn stop() {
    stop_pid(std::process::id());
}

pub fn stop_pid(pid: u32) {
    let dir = presence_dir();
    let path = entry_path(&dir, HARNESS, pid);
    let legacy = legacy_entry_path(&dir, HARNESS, pid);
    if let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) {
        std::thread::spawn(move || seats::retract_file(&name));
    }
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(&legacy);
    if let Ok(rd) = fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&p)
                && let Ok(e) = serde_json::from_str::<Presence>(&text)
                && e.pid == pid
                && e.harness == HARNESS
                && e.seat.eq_ignore_ascii_case(&seat())
            {
                let _ = fs::remove_file(p);
            }
        }
    }
}

/// Live roster, oldest first. Reaps dead PID files. Unions
/// `active_sessions.json` so a session that registered there but missed a
/// presence write still appears.
pub fn roster() -> Vec<Presence> {
    let mut entries = roster_from_files();
    union_active_sessions(&mut entries);
    entries.sort_by(|a, b| a.started.cmp(&b.started));
    entries
}

fn roster_from_files() -> Vec<Presence> {
    let dir = presence_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for ent in rd.flatten() {
        let p = ent.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&p) else {
            let _ = fs::remove_file(&p);
            continue;
        };
        let Ok(e) = serde_json::from_str::<Presence>(&text) else {
            let _ = fs::remove_file(&p);
            continue;
        };
        if live_on_this_machine(&e) {
            if is_pid_alive(e.pid) {
                entries.push(e);
            } else {
                let _ = fs::remove_file(&p);
            }
        } else {
            entries.push(e);
        }
    }
    dedup_by_seat_pid(entries)
}

fn live_on_this_machine(e: &Presence) -> bool {
    !seats::is_peer_seat(&e.seat)
}

fn dedup_by_seat_pid(entries: Vec<Presence>) -> Vec<Presence> {
    let mut best: Vec<Presence> = Vec::new();
    for e in entries {
        if let Some(idx) = best
            .iter()
            .position(|b| b.pid == e.pid && b.seat.eq_ignore_ascii_case(&e.seat))
        {
            let prefer_new = e.socket.is_some() && best[idx].socket.is_none()
                || (e.harness == HARNESS && best[idx].harness != HARNESS);
            if prefer_new {
                best[idx] = e;
            }
        } else {
            best.push(e);
        }
    }
    best
}

fn union_active_sessions(entries: &mut Vec<Presence>) {
    // An explicit HOUSE_COORD_DIR is an isolated roster (tests, a seat
    // overlay). Do not mix in the install's active_sessions.json.
    if std::env::var_os("HOUSE_COORD_DIR").is_some() {
        return;
    }
    let home = xai_grok_config::grok_home();
    let Ok(sessions) = xai_grok_active_sessions::list_in(&home) else {
        return;
    };
    for s in sessions {
        if entries.iter().any(|e| e.pid == s.pid) {
            continue;
        }
        if !is_pid_alive(s.pid) {
            continue;
        }
        entries.push(Presence {
            seat: seat(),
            harness: HARNESS.to_string(),
            model: None,
            pid: s.pid,
            pname: None,
            cwd: s.cwd.clone(),
            tree: tree_of(&s.cwd),
            started: s.opened_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            work_unit: None,
            session_id: Some(s.session_id.0.to_string()),
            socket: None,
            socket_tailnet: None,
            socket_token: None,
        });
    }
}

/// Always-printed Peers line. `0 LIVE` is a finding.
/// Peer-seat copies are remote reports, not PID-probed LIVE rows.
pub fn format_roster(entries: &[Presence], self_pid: Option<u32>) -> String {
    if entries.is_empty() {
        return "Peers: 0 LIVE".to_string();
    }
    let live_n = entries
        .iter()
        .filter(|e| !seats::is_peer_seat(&e.seat))
        .count();
    let remote_n = entries.len() - live_n;
    let parts: Vec<String> = entries
        .iter()
        .map(|e| {
            let ident = format!(
                "{}@{}/{}",
                e.model.as_deref().unwrap_or(&e.harness),
                e.seat,
                e.harness
            );
            let mut bits = vec![format!("pid {}", e.pid)];
            if !e.tree.is_empty() {
                bits.push(e.tree.clone());
            }
            if let Some(u) = &e.work_unit {
                bits.push(format!("unit {u}"));
            }
            if e.started.len() >= 16 {
                bits.push(format!("since {}Z", &e.started[11..16]));
            }
            if seats::is_peer_seat(&e.seat) {
                bits.push("remote".into());
            }
            let tag = if self_pid == Some(e.pid) {
                " (this session)"
            } else {
                ""
            };
            format!("{ident} ({}){tag}", bits.join(", "))
        })
        .collect();
    let head = if remote_n == 0 {
        format!("{live_n} LIVE")
    } else {
        format!("{live_n} LIVE · {remote_n} remote-reported")
    };
    format!("Peers: {head} — {}", parts.join(" · "))
}

pub fn peers_line() -> String {
    format_roster(&roster(), Some(std::process::id()))
}

/// Stamp this process's presence file with the listen address. Fail-soft.
pub(crate) fn patch_self_socket(addr: &str, token: &str) {
    let dir = presence_dir();
    let path = entry_path(&dir, HARNESS, std::process::id());
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut e) = serde_json::from_str::<Presence>(&text) else {
        return;
    };
    e.socket = Some(addr.to_string());
    e.socket_token = Some(token.to_string());
    if let Ok(body) = serde_json::to_string_pretty(&e) {
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

/// Stamp the tailnet TLS address, then publish. Fail-soft.
/// `start()` scp's the row before the listener binds; without a republish,
/// peers keep `socket_tailnet: null`.
pub(crate) fn patch_self_tailnet(addr: &str) {
    let dir = presence_dir();
    let path = entry_path(&dir, HARNESS, std::process::id());
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut e) = serde_json::from_str::<Presence>(&text) else {
        return;
    };
    e.socket_tailnet = Some(addr.to_string());
    if let Ok(body) = serde_json::to_string_pretty(&e) {
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, body).is_ok() {
            if fs::rename(&tmp, &path).is_ok() {
                let publish = path;
                std::thread::spawn(move || seats::publish_file(&publish));
            } else {
                let _ = fs::remove_file(&tmp);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_dir<R>(f: impl FnOnce(&Path) -> R) -> R {
        let _g = super::COORD_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "amore-coord-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var_os("HOUSE_COORD_DIR");
        unsafe { std::env::set_var("HOUSE_COORD_DIR", &dir) };
        let result = f(&dir);
        match prev {
            Some(v) => unsafe { std::env::set_var("HOUSE_COORD_DIR", v) },
            None => unsafe { std::env::remove_var("HOUSE_COORD_DIR") },
        }
        let _ = fs::remove_dir_all(&dir);
        result
    }

    #[test]
    fn start_stop_round_trip() {
        with_dir(|_| {
            start(Some("sess-1"), "/tmp/house");
            let r = roster_from_files();
            assert_eq!(r.len(), 1);
            assert_eq!(r[0].harness, "amore");
            assert_eq!(r[0].pid, std::process::id());
            assert_eq!(r[0].session_id.as_deref(), Some("sess-1"));
            assert!(format_roster(&r, Some(std::process::id())).contains("this session"));
            stop();
            assert!(roster_from_files().is_empty());
        });
    }

    #[test]
    fn empty_roster_is_zero_live() {
        with_dir(|_| {
            assert_eq!(format_roster(&[], None), "Peers: 0 LIVE");
        });
    }

    #[test]
    fn reaps_dead_pid_files() {
        with_dir(|dir| {
            let ghost = Presence {
                seat: "test".into(),
                harness: "cursor".into(),
                model: None,
                pid: 0,
                pname: Some("definitely-not-alive.exe".into()),
                cwd: "/tmp".into(),
                tree: "tmp".into(),
                started: "2026-01-01T00:00:00Z".into(),
                work_unit: None,
                session_id: None,
                socket: None,
                socket_tailnet: None,
                socket_token: None,
            };
            fs::write(
                dir.join("cursor-1.json"),
                serde_json::to_string(&ghost).unwrap(),
            )
            .unwrap();
            let r = roster_from_files();
            assert!(r.iter().all(|e| e.pid != 1), "dead pid must be reaped");
            assert!(!dir.join("cursor-1.json").exists());
        });
    }

    #[test]
    fn patch_self_tailnet_stamps_before_return() {
        with_dir(|dir| {
            start(Some("sess-tailnet"), "/tmp/house");
            let path = entry_path(dir, HARNESS, std::process::id());
            patch_self_tailnet("tls:100.64.0.1:41234");
            let after: Presence =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                after.socket_tailnet.as_deref(),
                Some("tls:100.64.0.1:41234")
            );
            stop();
        });
    }
}
