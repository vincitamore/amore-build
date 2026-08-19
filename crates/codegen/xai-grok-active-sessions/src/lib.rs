//! Tracks open TUI sessions in `~/.grok/active_sessions.json` for crash
//! recovery. Clean exit removes the entry; crash leaves it behind. On next
//! launch, [`collect_crashed`] finds orphaned entries (dead PIDs).

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

use agent_client_protocol as acp;
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveSession {
    pub session_id: acp::SessionId,
    pub pid: u32,
    pub cwd: String,
    pub opened_at: DateTime<Utc>,
    /// Start identity of the owning process, so a recycled PID that happens
    /// to be alive is not mistaken for the same session. Captured at
    /// registration when readable; on non-Windows platforms it stays `None`
    /// (fail open). `Option` so a missing/unreadable identity is never reaped.
    pub started_at: Option<u64>,
}

const DATA_FILENAME: &str = "active_sessions.json";
const LOCK_FILENAME: &str = "active_sessions.lock";
const TMP_FILENAME: &str = "active_sessions.json.tmp";

// -- Public API (delegates to `_in` variants with default grok home) --------

/// Register a session as active (idempotent by session_id).
pub fn register(session: ActiveSession) -> io::Result<()> {
    register_in(&xai_grok_config::grok_home(), session)
}

/// Non-blocking unregister for signal handlers. Returns `Ok(false)` on
/// lock contention; the orphan is cleaned up by `collect_crashed` next launch.
pub fn try_unregister(session_id: &acp::SessionId) -> io::Result<bool> {
    try_unregister_in(&xai_grok_config::grok_home(), session_id)
}

/// Remove entries with dead PIDs and return them.
pub fn collect_crashed() -> io::Result<Vec<ActiveSession>> {
    collect_crashed_in(&xai_grok_config::grok_home())
}

// -- Injectable-root variants (`_in`) for testing ---------------------------

pub fn register_in(root: &Path, session: ActiveSession) -> io::Result<()> {
    with_locked_state(root, |sessions| {
        sessions.retain(|s| s.session_id != session.session_id);
        let mut session = session;
        if session.started_at.is_none() {
            session.started_at = process_started_at(session.pid);
        }
        sessions.push(session);
    })
}

pub fn unregister_in(root: &Path, session_id: &acp::SessionId) -> io::Result<()> {
    with_locked_state(root, |sessions| {
        sessions.retain(|s| s.session_id != *session_id);
    })
}

pub fn try_unregister_in(root: &Path, session_id: &acp::SessionId) -> io::Result<bool> {
    try_with_locked_state(root, |sessions| {
        sessions.retain(|s| s.session_id != *session_id);
    })
    .map(|opt| opt.is_some())
}

pub fn collect_crashed_in(root: &Path) -> io::Result<Vec<ActiveSession>> {
    with_locked_state(root, |sessions| {
        let (alive, dead): (Vec<_>, Vec<_>) =
            sessions.drain(..).partition(|s| is_session_alive(s));
        *sessions = alive;
        dead
    })
}

pub fn list_in(root: &Path) -> io::Result<Vec<ActiveSession>> {
    let data_path = root.join(DATA_FILENAME);
    read_data_file(&data_path)
}

// -- Internal: locked read-modify-write -------------------------------------

fn with_locked_state<F, R>(root: &Path, mutate: F) -> io::Result<R>
where
    F: FnOnce(&mut Vec<ActiveSession>) -> R,
{
    let lock_path = root.join(LOCK_FILENAME);
    let data_path = root.join(DATA_FILENAME);
    let tmp_path = root.join(TMP_FILENAME);

    fs::create_dir_all(root)?;
    let lock_file = open_lock_file(&lock_path)?;
    lock_file.lock_exclusive()?;

    let result = locked_mutate(&data_path, &tmp_path, mutate);

    let _ = lock_file.unlock();
    result
}

/// Non-blocking variant for signal handlers.
fn try_with_locked_state<F, R>(root: &Path, mutate: F) -> io::Result<Option<R>>
where
    F: FnOnce(&mut Vec<ActiveSession>) -> R,
{
    let lock_path = root.join(LOCK_FILENAME);
    let data_path = root.join(DATA_FILENAME);
    let tmp_path = root.join(TMP_FILENAME);

    fs::create_dir_all(root)?;
    let lock_file = open_lock_file(&lock_path)?;

    match lock_file.try_lock_exclusive() {
        Ok(()) => {
            let result = locked_mutate(&data_path, &tmp_path, mutate);
            let _ = lock_file.unlock();
            result.map(Some)
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
        Err(e) => Err(e),
    }
}

fn locked_mutate<F, R>(data_path: &Path, tmp_path: &Path, mutate: F) -> io::Result<R>
where
    F: FnOnce(&mut Vec<ActiveSession>) -> R,
{
    let mut sessions = read_data_file(data_path)?;
    let result = mutate(&mut sessions);
    write_data_file_atomic(tmp_path, data_path, &sessions)?;
    Ok(result)
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

fn read_data_file(path: &Path) -> io::Result<Vec<ActiveSession>> {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(Vec::new()),
        Ok(bytes) => match serde_json::from_slice::<Vec<ActiveSession>>(&bytes) {
            Ok(sessions) => Ok(sessions),
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "active_sessions.json is corrupted, starting with empty list"
                );
                Ok(Vec::new())
            }
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn write_data_file_atomic(
    tmp_path: &Path,
    data_path: &Path,
    sessions: &[ActiveSession],
) -> io::Result<()> {
    let json = serde_json::to_string_pretty(sessions)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(tmp_path, json.as_bytes())?;
    fs::rename(tmp_path, data_path).inspect_err(|_| {
        let _ = fs::remove_file(tmp_path);
    })
}

fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let pid_i = match i32::try_from(pid) {
            Ok(p) if p > 0 => p,
            _ => return false,
        };
        let ret = unsafe { libc::kill(pid_i as libc::pid_t, 0) };
        if ret == 0 {
            return true;
        }
        io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
        match handle {
            Ok(h) => {
                let _ = unsafe { CloseHandle(h) };
                true
            }
            Err(_) => false,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // Conservative: assume alive if we can't check.
        true
    }
}

/// Reads the start identity of the process `pid`. On Windows this is the
/// creation FILETIME from `GetProcessTimes` (100ns ticks since 1601); other
/// platforms have no portable equivalent, so it returns `None` (fail open).
fn process_started_at(pid: u32) -> Option<u64> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, FILETIME};
        use windows::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let result = unsafe {
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
        };
        let _ = unsafe { CloseHandle(handle) };
        result.ok()?;
        Some(
            (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// Whether the start identity read at check time (`actual`) still matches the
/// recorded identity (`expected`). Fail-open, literal: an absent or unreadable
/// identity is treated as a match (the session is kept alive) — never reap on
/// uncertainty.
fn matches_start_identity(expected: Option<u64>, actual: Option<u64>) -> bool {
    match (expected, actual) {
        (None, _) | (Some(_), None) => true,
        (Some(e), Some(a)) => e == a,
    }
}

/// A session is alive when its process exists AND its recorded start identity
/// still matches the process's current one. A *recycled* PID — a different
/// process that has since taken the same PID — is therefore not alive.
/// Missing or unreadable identity keeps the session alive (see
/// [`matches_start_identity`]).
fn is_session_alive(session: &ActiveSession) -> bool {
    is_pid_alive(session.pid)
        && matches_start_identity(session.started_at, process_started_at(session.pid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_session(id: &str, pid: u32) -> ActiveSession {
        ActiveSession {
            session_id: acp::SessionId::new(id),
            pid,
            cwd: "/tmp/test".into(),
            opened_at: Utc::now(),
            started_at: None,
        }
    }

    #[test]
    fn register_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let s = make_session("s1", std::process::id());
        register_in(dir.path(), s.clone()).unwrap();
        register_in(dir.path(), s).unwrap();
        assert_eq!(list_in(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn collect_crashed_partitions_by_pid_liveness() {
        let dir = TempDir::new().unwrap();
        register_in(dir.path(), make_session("alive", std::process::id())).unwrap();
        register_in(dir.path(), make_session("dead", 2_000_000_000)).unwrap();

        let crashed = collect_crashed_in(dir.path()).unwrap();
        assert_eq!(crashed.len(), 1);
        assert_eq!(&*crashed[0].session_id.0, "dead");
        assert_eq!(&*list_in(dir.path()).unwrap()[0].session_id.0, "alive");
    }

    #[test]
    fn matches_start_identity_is_fail_open() {
        // No recorded identity: alive whatever we can read now.
        assert!(matches_start_identity(None, None));
        assert!(matches_start_identity(None, Some(111)));
        // Recorded identity but unreadable now: fail open, keep alive.
        assert!(matches_start_identity(Some(111), None));
        // Both known and identical: same process, alive.
        assert!(matches_start_identity(Some(111), Some(111)));
        // Recycled PID: alive but with a different creation identity, so it is
        // NOT the same session (this is the regression this test guards).
        assert!(!matches_start_identity(Some(111), Some(222)));
    }

    #[test]
    fn collect_crashed_is_fail_open_on_unreadable_identity() {
        let dir = TempDir::new().unwrap();
        // Dead PID: always reaped, regardless of identity.
        register_in(dir.path(), make_session("dead", 2_000_000_000)).unwrap();
        // Live PID whose identity is unreadable (None on non-Windows): kept.
        register_in(dir.path(), make_session("alive", std::process::id())).unwrap();

        let crashed = collect_crashed_in(dir.path()).unwrap();
        assert_eq!(crashed.len(), 1);
        assert_eq!(&*crashed[0].session_id.0, "dead");
        assert_eq!(&*list_in(dir.path()).unwrap()[0].session_id.0, "alive");
    }

    #[test]
    fn concurrent_registers_no_corruption() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        std::thread::scope(|s| {
            for i in 0..10 {
                let p = path.clone();
                s.spawn(move || {
                    register_in(&p, make_session(&format!("s{i}"), std::process::id())).unwrap()
                });
            }
        });
        assert_eq!(list_in(dir.path()).unwrap().len(), 10);
    }

    #[test]
    fn try_unregister_skips_if_locked() {
        let dir = TempDir::new().unwrap();
        let s = make_session("s1", std::process::id());
        register_in(dir.path(), s.clone()).unwrap();

        let lock_file = open_lock_file(&dir.path().join(LOCK_FILENAME)).unwrap();
        lock_file.lock_exclusive().unwrap();
        assert!(!try_unregister_in(dir.path(), &s.session_id).unwrap());
        lock_file.unlock().unwrap();
        assert_eq!(list_in(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_file_recovers() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(DATA_FILENAME), "garbage{{{").unwrap();
        assert!(list_in(dir.path()).unwrap().is_empty());
        register_in(dir.path(), make_session("s1", std::process::id())).unwrap();
        assert_eq!(list_in(dir.path()).unwrap().len(), 1);
    }
}
