//! `~/.house/coord/seats` — one row per other machine.
//!
//! `<name> <user@host> [coord-root]`
//! coord-root defaults to the remote `~/.house/coord`.

use std::fs;
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
    for row in load() {
        if row.name.eq_ignore_ascii_case(&seat::seat()) {
            continue;
        }
        let remote = remote_presence_file(&row, name);
        let _ = scp(path, &row.ssh, &remote);
    }
}

/// Remove `filename` from every other seat's presence dir. Fail-soft.
pub fn retract_file(filename: &str) {
    for row in load() {
        if row.name.eq_ignore_ascii_case(&seat::seat()) {
            continue;
        }
        let remote = remote_presence_file(&row, filename);
        let cmd = format!("rm -f '{remote}'");
        let _ = ssh_run(&row.ssh, &cmd);
    }
}

pub fn inject_remote(row: &SeatRow, env: &Envelope) -> Result<SendResult, String> {
    let body = serde_json::to_string(env).map_err(|e| e.to_string())?;
    let coord = row
        .coord_root
        .clone()
        .unwrap_or_else(|| "$HOME/.house/coord".into());
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

fn remote_presence_file(row: &SeatRow, filename: &str) -> String {
    let root = row
        .coord_root
        .clone()
        .unwrap_or_else(|| "$HOME/.house/coord".into());
    format!("{root}/presence/{filename}")
}

fn scp(local: &Path, ssh: &str, remote: &str) -> Result<(), String> {
    let dest = format!("{ssh}:{remote}");
    let st = Command::new("scp")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            &local.to_string_lossy(),
            &dest,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| e.to_string())?;
    if st.success() {
        Ok(())
    } else {
        Err("scp failed".into())
    }
}

fn ssh_run(ssh: &str, cmd: &str) -> Result<(), String> {
    let st = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            ssh,
            cmd,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| e.to_string())?;
    if st.success() {
        Ok(())
    } else {
        Err("ssh failed".into())
    }
}

pub fn drop_inbox_remote(row: &SeatRow, env: &Envelope) -> Result<String, String> {
    let body = serde_json::to_string(env).map_err(|e| e.to_string())?;
    let root = row
        .coord_root
        .clone()
        .unwrap_or_else(|| "$HOME/.house/coord".into());
    let inbox = format!("{root}/inbox");
    let remote = format!("{inbox}/{}.json", env.msgid);
    let script = format!("mkdir -p '{inbox}' && cat > '{remote}'");
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
}
