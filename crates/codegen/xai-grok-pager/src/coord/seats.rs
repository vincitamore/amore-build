//! `~/.house/coord/seats` — one row per other machine.
//!
//! `<name> <user@host> [coord-root]`
//! coord-root is an optional override. The default is discovered: ssh
//! `echo $HOME` (bash and pwsh both have `$HOME`), then
//! `{home}/.house/coord`. scp uses that absolute path (Windows OpenSSH
//! does not expand `~` on dest). Local `start` links every SSH-login
//! home's `.house/coord` to this process's coord so the SSH user and
//! the house user share one directory.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use super::msg::Envelope;
use super::send::SendResult;
use super::seat;

#[derive(Debug, Clone)]
pub struct SeatRow {
    pub name: String,
    pub ssh: String,
    pub coord_root: Option<String>,
}

pub fn load() -> Vec<SeatRow> {
    let path = super::coord_root().join("seats");
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse(&text)
}

pub fn parse(text: &str) -> Vec<SeatRow> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut bits = line.split_whitespace();
        let Some(name) = bits.next() else { continue };
        let Some(ssh) = bits.next() else { continue };
        let coord_root = bits.next().map(str::to_string);
        out.push(SeatRow {
            name: name.to_string(),
            ssh: ssh.to_string(),
            coord_root,
        });
    }
    out
}

pub fn lookup(name: &str) -> Option<SeatRow> {
    load()
        .into_iter()
        .find(|r| r.name.eq_ignore_ascii_case(name))
}

pub fn is_peer_seat(name: &str) -> bool {
    let me = seat::seat();
    if name.eq_ignore_ascii_case(&me) {
        return false;
    }
    load().iter().any(|r| r.name.eq_ignore_ascii_case(name))
}

/// Copy `path` into every other seat's presence dir. Fail-soft.
pub fn publish_file(path: &Path) {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    if !is_safe_filename(name) {
        return;
    }
    for row in load() {
        if row.name.eq_ignore_ascii_case(&seat::seat()) {
            continue;
        }
        let root = discovered_coord_root(&row);
        ensure_remote_dir(&row.ssh, &format!("{root}/presence"));
        let remote = format!("{root}/presence/{name}");
        if let Err(e) = scp(path, &row.ssh, &remote) {
            tracing::debug!(seat = %row.name, error = %e, "coord: presence publish failed");
        }
    }
}

/// Remove `filename` from every other seat's presence dir. Fail-soft.
pub fn retract_file(filename: &str) {
    if !is_safe_filename(filename) {
        return;
    }
    for row in load() {
        if row.name.eq_ignore_ascii_case(&seat::seat()) {
            continue;
        }
        let root = discovered_coord_root(&row);
        remove_remote_file(&row.ssh, &format!("{root}/presence/{filename}"));
    }
}

pub fn inject_remote(row: &SeatRow, env: &Envelope) -> Result<SendResult, String> {
    let body = serde_json::to_string(env).map_err(|e| e.to_string())?;
    let coord = discovered_coord_root(row);
    let remote = format!(
        "export PATH=\"$HOME/.local/bin:$HOME/amore/bin:$PATH\"; \
         export HOUSE_COORD_DIR=\"{coord}/presence\"; \
         amore coord inject"
    );
    let mut child = Command::new("ssh");
    child.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        &row.ssh,
        &remote,
    ]);
    child.stdin(Stdio::piped());
    child.stdout(Stdio::piped());
    child.stderr(Stdio::piped());
    hide_window(&mut child);
    let mut proc = child.spawn().map_err(|e| format!("ssh spawn: {e}"))?;
    use std::io::Write;
    if let Some(mut stdin) = proc.stdin.take() {
        let _ = stdin.write_all(body.as_bytes());
    }
    let out = proc.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "FETCH FAILED injecting on {}: {}",
            row.ssh,
            err.lines().last().unwrap_or("ssh failed")
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(parse_inject_stdout(&stdout, &row.ssh))
}

fn parse_inject_stdout(stdout: &str, ssh: &str) -> SendResult {
    let line = stdout.lines().find(|l| l.starts_with("sent (")).unwrap_or("");
    let disp = if line.contains("(woken)") {
        super::msg::Disposition::Woken
    } else if line.contains("(enqueued)") {
        super::msg::Disposition::Enqueued
    } else if line.contains("(deferred)") {
        super::msg::Disposition::Deferred
    } else {
        super::msg::Disposition::Inbox
    };
    let via = line
        .split(" via ")
        .nth(1)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| format!("ssh {ssh}"));
    SendResult::new(disp, via)
}

/// Ask the remote who it is, then write to *that* home's `.house/coord`.
///
/// scp dest is not a remote shell: OpenSSH does not expand `$HOME` there,
/// and Windows OpenSSH turns `~` into a relative `.house/...` off the
/// sshd cwd. So we expand `$HOME` over ssh (a variable in both bash and
/// pwsh), then scp to the absolute path.
///
/// The SSH login user may not be the house user. `ensure_ssh_visible_coord`
/// junctions/symlinks every local `authorized_keys` home's `.house/coord`
/// to this process's coord, so `$HOME/.house/coord` on the SSH account
/// *is* the house coord. No machine or account names in code. The seats
/// third column remains an explicit override, not a required pin.
fn discovered_coord_root(row: &SeatRow) -> String {
    if let Some(explicit) = &row.coord_root {
        return scp_slash(explicit);
    }
    match probe_remote_home(&row.ssh) {
        Some(home) => format!("{home}/.house/coord"),
        None => "~/.house/coord".into(),
    }
}

fn probe_remote_home(ssh: &str) -> Option<String> {
    let text = ssh_stdout(ssh, "echo $HOME").ok()?;
    let home = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && *l != "None")?;
    let home = scp_slash(home);
    if home.is_empty() || home.contains('\0') {
        None
    } else {
        Some(home)
    }
}

fn scp_slash(path: &str) -> String {
    path.trim().replace('\\', "/").trim_end_matches('/').to_string()
}

fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Quote an already-absolute remote path for a POSIX *or* pwsh remote.
fn shell_expandable(path: &str) -> String {
    if path.starts_with("$HOME") {
        format!("\"{path}\"")
    } else if path.starts_with('~') {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

fn ensure_remote_dir(ssh: &str, dir: &str) {
    let q = shell_expandable(dir);
    if ssh_run(ssh, &format!("mkdir -p {q}")).is_ok() {
        return;
    }
    // pwsh: `mkdir -p` is New-Item -Path and errors if the dir exists.
    // New-Item -Force is the idempotent form.
    let win = dir.replace('/', "\\");
    let quoted = win.replace('\'', "''");
    if let Err(e) = ssh_run(
        ssh,
        &format!("New-Item -ItemType Directory -Force -Path '{quoted}'"),
    ) {
        tracing::debug!(error = %e, "coord: presence mkdir failed");
    }
}

fn remove_remote_file(ssh: &str, path: &str) {
    let q = shell_expandable(path);
    if ssh_run(ssh, &format!("rm -f {q}")).is_ok() {
        return;
    }
    let win = path.replace('/', "\\");
    let quoted = win.replace('\'', "''");
    if let Err(e) = ssh_run(
        ssh,
        &format!("Remove-Item -Force -ErrorAction SilentlyContinue -Path '{quoted}'"),
    ) {
        tracing::debug!(error = %e, "coord: presence retract failed");
    }
}

/// Point every local SSH-login home at this process's coord directory.
pub fn ensure_ssh_visible_coord() {
    let real = super::coord_root();
    let Ok(real_abs) = fs::canonicalize(&real) else {
        return;
    };
    for home in local_login_homes() {
        let keys = home.join(".ssh").join("authorized_keys");
        if !keys.is_file() {
            continue;
        }
        let visible = home.join(".house").join("coord");
        if let Ok(v) = fs::canonicalize(&visible)
            && v == real_abs
        {
            continue;
        }
        if let Some(parent) = visible.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if visible.exists() || visible.symlink_metadata().is_ok() {
            let bak = unique_bak(&visible);
            if fs::rename(&visible, &bak).is_err() {
                tracing::debug!(path = %visible.display(), "coord: could not move aside ssh-home coord");
                continue;
            }
        }
        if let Err(e) = link_dir(&real_abs, &visible) {
            tracing::debug!(error = %e, "coord: ssh-visible coord link failed");
        }
    }
}

fn local_login_homes() -> Vec<std::path::PathBuf> {
    let mut homes = Vec::new();
    let seed = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    let Some(mine) = seed else {
        return homes;
    };
    let Some(parent) = mine.parent() else {
        return homes;
    };
    if let Ok(rd) = fs::read_dir(parent) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                homes.push(e.path());
            }
        }
    }
    homes
}

fn unique_bak(path: &Path) -> std::path::PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    path.with_file_name(format!(
        "{}.bak-ssh-visible-{ts}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("coord")
    ))
}

fn link_dir(src: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut child = Command::new("cmd");
        child.args([
            "/C",
            "mklink",
            "/J",
            &dest.to_string_lossy(),
            &src.to_string_lossy(),
        ]);
        hide_window(&mut child);
        let out = child.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dest).map_err(|e| e.to_string())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (src, dest);
        Err("coord link unsupported on this os".into())
    }
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn scp(local: &Path, ssh: &str, remote: &str) -> Result<(), String> {
    let dest = format!("{ssh}:{remote}");
    let mut child = Command::new("scp");
    child.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        &local.to_string_lossy(),
        &dest,
    ]);
    child.stdout(Stdio::null());
    child.stderr(Stdio::piped());
    hide_window(&mut child);
    let out = child.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err
            .lines()
            .last()
            .unwrap_or("scp failed")
            .trim()
            .to_string())
    }
}

fn ssh_run(ssh: &str, cmd: &str) -> Result<(), String> {
    let mut child = Command::new("ssh");
    child.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        ssh,
        cmd,
    ]);
    child.stdout(Stdio::null());
    child.stderr(Stdio::piped());
    hide_window(&mut child);
    let out = child.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err
            .lines()
            .last()
            .unwrap_or("ssh failed")
            .trim()
            .to_string())
    }
}

/// One house token across seats. Pull any peer token, pick a deterministic
/// winner, write it locally, and push it to peers that still differ.
/// Fail-soft: unreachable peers are skipped.
pub fn converge_house_token() {
    let Ok(local) = super::tls::house_token() else {
        return;
    };
    let rows = load();
    if rows.is_empty() {
        return;
    }
    let mut tokens = vec![local.clone()];
    for row in &rows {
        if let Some(t) = fetch_token(row) {
            tokens.push(t);
        }
    }
    tokens.sort();
    tokens.dedup();
    let Some(winner) = tokens.into_iter().next() else {
        return;
    };
    if winner != local {
        tracing::warn!("coord: house token diverged across seats; converging");
        if super::tls::install_house_token(&winner).is_err() {
            return;
        }
    }
    for row in &rows {
        if fetch_token(row).as_deref() != Some(winner.as_str()) {
            let _ = push_token(row, &winner);
        }
    }
}

fn remote_tls_token(row: &SeatRow) -> String {
    format!("{}/tls/token", discovered_coord_root(row))
}

fn fetch_token(row: &SeatRow) -> Option<String> {
    let path = remote_tls_token(row);
    let q = shell_expandable(&path);
    let text = ssh_stdout(&row.ssh, &format!("cat {q} 2>/dev/null"))
        .or_else(|_| {
            let win = path.replace('/', "\\").replace('\'', "''");
            ssh_stdout(
                &row.ssh,
                &format!("Get-Content -Raw -ErrorAction SilentlyContinue -Path '{win}'"),
            )
        })
        .ok()?;
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn push_token(row: &SeatRow, token: &str) -> Result<(), String> {
    let path = remote_tls_token(row);
    ensure_remote_dir(&row.ssh, &path.rsplit_once('/').map(|(d, _)| d).unwrap_or(&path).to_string());
    let q = shell_expandable(&path);
    let script = format!("cat > {q}");
    let mut child = Command::new("ssh");
    child.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        &row.ssh,
        &script,
    ]);
    child.stdin(Stdio::piped());
    child.stdout(Stdio::null());
    child.stderr(Stdio::piped());
    hide_window(&mut child);
    let mut proc = child.spawn().map_err(|e| format!("ssh spawn: {e}"))?;
    if let Some(mut stdin) = proc.stdin.take() {
        let _ = stdin.write_all(format!("{token}\n").as_bytes());
    }
    let out = proc.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err("ssh token push failed".into())
    }
}

fn ssh_stdout(ssh: &str, cmd: &str) -> Result<String, String> {
    let mut child = Command::new("ssh");
    child.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        ssh,
        cmd,
    ]);
    child.stdout(Stdio::piped());
    child.stderr(Stdio::piped());
    hide_window(&mut child);
    let out = child.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("ssh failed".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn drop_inbox_remote(row: &SeatRow, env: &Envelope) -> Result<String, String> {
    let body = serde_json::to_string(env).map_err(|e| e.to_string())?;
    let inbox = format!("{}/inbox", discovered_coord_root(row));
    let remote = format!("{inbox}/{}.json", env.msgid);
    let script = format!(
        "mkdir -p {} && cat > {}",
        shell_expandable(&inbox),
        shell_expandable(&remote)
    );
    let mut child = Command::new("ssh");
    child.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        &row.ssh,
        &script,
    ]);
    child.stdin(Stdio::piped());
    child.stdout(Stdio::piped());
    child.stderr(Stdio::piped());
    hide_window(&mut child);
    let mut proc = child.spawn().map_err(|e| format!("ssh spawn: {e}"))?;
    use std::io::Write;
    if let Some(mut stdin) = proc.stdin.take() {
        let _ = stdin.write_all(body.as_bytes());
    }
    let out = proc.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "FETCH FAILED delivering to {}: {}",
            row.ssh,
            err.lines().last().unwrap_or("ssh failed")
        ));
    }
    Ok(format!("ssh {}", row.ssh))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_name_ssh_and_optional_root() {
        let rows = parse(
            "# comment\n\
             peer-one user@peer-one\n\
             peer-two user@peer-two /home/user/.house/coord\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "peer-one");
        assert_eq!(rows[0].ssh, "user@peer-one");
        assert!(rows[0].coord_root.is_none());
        assert_eq!(rows[1].coord_root.as_deref(), Some("/home/user/.house/coord"));
    }

    #[test]
    fn parse_inject_stdout_woken() {
        let r = parse_inject_stdout(
            "sent (woken) via socket unix:/tmp/s.sock\n",
            "host",
        );
        assert_eq!(r.disposition.as_str(), "woken");
        assert!(r.via.contains("unix:"));
    }

    fn peer() -> SeatRow {
        SeatRow {
            name: "peer-one".into(),
            ssh: "user@peer-one".into(),
            coord_root: None,
        }
    }

    #[test]
    fn scp_slash_normalizes_windows_home() {
        assert_eq!(scp_slash(r"C:\Users\sshuser\"), "C:/Users/sshuser");
        assert_eq!(scp_slash("/home/me/"), "/home/me");
    }

    #[test]
    fn explicit_root_wins_without_a_probe() {
        let row = SeatRow {
            name: "peer-two".into(),
            ssh: "user@peer-two".into(),
            coord_root: Some(r"C:\Users\me\.house\coord".into()),
        };
        assert_eq!(discovered_coord_root(&row), "C:/Users/me/.house/coord");
    }

    #[test]
    fn probe_miss_falls_back_to_tilde() {
        // user@peer-one is not a live ssh target in unit tests.
        assert_eq!(discovered_coord_root(&peer()), "~/.house/coord");
    }

    #[test]
    fn unsafe_filename_is_rejected() {
        assert!(!is_safe_filename("../x.json"));
        assert!(!is_safe_filename("a;rm -rf /.json"));
        assert!(is_safe_filename("seat-amore-12.json"));
    }
}
