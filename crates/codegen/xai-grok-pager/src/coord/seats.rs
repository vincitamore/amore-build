//! `~/.house/coord/seats` — one row per other machine.
//!
//! `<name> <user@host> [coord-root]`
//! coord-root defaults to the remote `~/.house/coord`.

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
        let dir = format!("{}/presence", coord_root_shell(&row));
        if let Err(e) = ssh_run(&row.ssh, &format!("mkdir -p {}", shell_expandable(&dir))) {
            tracing::debug!(seat = %row.name, error = %e, "coord: presence mkdir failed");
            continue;
        }
        let remote = remote_presence_scp(&row, name);
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
        let remote = remote_presence_shell(&row, filename);
        let cmd = format!("rm -f {remote}");
        if let Err(e) = ssh_run(&row.ssh, &cmd) {
            tracing::debug!(seat = %row.name, error = %e, "coord: presence retract failed");
        }
    }
}

pub fn inject_remote(row: &SeatRow, env: &Envelope) -> Result<SendResult, String> {
    let body = serde_json::to_string(env).map_err(|e| e.to_string())?;
    let coord = coord_root_shell(row);
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

/// scp dest: OpenSSH expands a leading `~` on the remote side and does
/// **not** expand `$HOME`. Default must be tilde, never `$HOME`.
const DEFAULT_COORD_ROOT_SCP: &str = "~/.house/coord";
/// Remote-shell path: `$HOME` expands inside double quotes; a quoted `~`
/// does not. Default must be `$HOME`, never a single-quoted string.
const DEFAULT_COORD_ROOT_SHELL: &str = "$HOME/.house/coord";

fn coord_root_scp(row: &SeatRow) -> String {
    row.coord_root
        .clone()
        .unwrap_or_else(|| DEFAULT_COORD_ROOT_SCP.into())
}

fn coord_root_shell(row: &SeatRow) -> String {
    row.coord_root
        .clone()
        .unwrap_or_else(|| DEFAULT_COORD_ROOT_SHELL.into())
}

fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Quote a remote path so a POSIX login shell can still expand `~` / `$HOME`.
fn shell_expandable(path: &str) -> String {
    if path.starts_with("$HOME") {
        format!("\"{path}\"")
    } else if path.starts_with('~') {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

fn remote_presence_scp(row: &SeatRow, filename: &str) -> String {
    format!("{}/presence/{filename}", coord_root_scp(row))
}

fn remote_presence_shell(row: &SeatRow, filename: &str) -> String {
    shell_expandable(&format!("{}/presence/{filename}", coord_root_shell(row)))
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
    shell_expandable(&format!("{}/tls/token", coord_root_shell(row)))
}

fn fetch_token(row: &SeatRow) -> Option<String> {
    let path = remote_tls_token(row);
    let cmd = format!("cat {path} 2>/dev/null");
    let text = ssh_stdout(&row.ssh, &cmd).ok()?;
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn push_token(row: &SeatRow, token: &str) -> Result<(), String> {
    let path = remote_tls_token(row);
    let script = format!("mkdir -p \"$(dirname {path})\" && cat > {path} && chmod 600 {path}");
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
    let inbox = format!("{}/inbox", coord_root_shell(row));
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
    fn default_scp_dest_uses_tilde_not_home() {
        let dest = remote_presence_scp(&peer(), "seat-amore-1.json");
        assert_eq!(dest, "~/.house/coord/presence/seat-amore-1.json");
        assert!(
            !dest.contains("$HOME"),
            "OpenSSH scp does not expand $HOME on dest"
        );
    }

    #[test]
    fn default_shell_path_double_quotes_home() {
        let path = remote_presence_shell(&peer(), "seat-amore-1.json");
        assert_eq!(path, "\"$HOME/.house/coord/presence/seat-amore-1.json\"");
        assert!(
            !path.contains('\''),
            "single quotes prevent $HOME expansion on the remote"
        );
    }

    #[test]
    fn explicit_root_is_used_as_is() {
        let row = SeatRow {
            name: "peer-two".into(),
            ssh: "user@peer-two".into(),
            coord_root: Some("/home/user/.house/coord".into()),
        };
        assert_eq!(
            remote_presence_scp(&row, "f.json"),
            "/home/user/.house/coord/presence/f.json"
        );
        assert_eq!(
            remote_presence_shell(&row, "f.json"),
            "'/home/user/.house/coord/presence/f.json'"
        );
    }

    #[test]
    fn unsafe_filename_is_rejected() {
        assert!(!is_safe_filename("../x.json"));
        assert!(!is_safe_filename("a;rm -rf /.json"));
        assert!(is_safe_filename("seat-amore-12.json"));
    }
}
