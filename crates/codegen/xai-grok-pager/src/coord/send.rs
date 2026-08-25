//! Resolve a send target: live local socket, then seats file + ssh/sftp inbox.

use std::fs;
use std::process::Command;

use super::msg::{Disposition, Envelope, Party};
use super::socket;

pub struct SendResult {
    pub disposition: Disposition,
    pub via: String,
}

/// Target is `seat`, `seat/harness`, `seat/harness/session`, or a session id.
pub fn send(target: &str, text: &str) -> Result<SendResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("message is empty".into());
    }
    let roster = super::roster();
    let hit = resolve(&roster, target);
    let mut env = Envelope::new_message(text, hit.as_ref().map(|p| party_of(p)));
    if let Some(sid) = hit.as_ref().and_then(|p| p.session_id.clone()) {
        env.to = Some(Party {
            seat: hit.as_ref().map(|p| p.seat.clone()).unwrap_or_default(),
            harness: hit.as_ref().map(|p| p.harness.clone()).unwrap_or_else(|| "amore".into()),
            model: hit.as_ref().and_then(|p| p.model.clone()),
            session_id: Some(sid),
        });
    }
    super::log::append(&env, true);

    if let Some(p) = hit.as_ref()
        && let (Some(addr), Some(token)) = (p.socket.as_deref(), p.socket_token.as_deref())
        && same_seat(p)
    {
        match socket::post_local(addr, token, &env) {
            Ok(d) => {
                return Ok(SendResult {
                    disposition: d,
                    via: format!("socket {addr}"),
                });
            }
            Err(e) => {
                tracing::debug!(error = %e, "coord send: local socket failed, falling through");
            }
        }
    }

    if let Some(p) = hit.as_ref()
        && !same_seat(p)
    {
        match deliver_remote(p, &env) {
            Ok(via) => {
                return Ok(SendResult {
                    disposition: Disposition::Inbox,
                    via,
                });
            }
            Err(e) => return Err(e),
        }
    }

    super::log::drop_inbox(&env);
    Ok(SendResult {
        disposition: Disposition::Inbox,
        via: "local inbox".into(),
    })
}

fn party_of(p: &super::Presence) -> Party {
    Party {
        seat: p.seat.clone(),
        harness: p.harness.clone(),
        model: p.model.clone(),
        session_id: p.session_id.clone(),
    }
}

fn same_seat(p: &super::Presence) -> bool {
    p.seat.eq_ignore_ascii_case(&super::seat())
}

fn resolve<'a>(roster: &'a [super::Presence], target: &str) -> Option<&'a super::Presence> {
    let t = target.trim();
    let lower = t.to_lowercase();
    roster.iter().find(|p| {
        p.session_id.as_deref() == Some(t)
            || format!("{}/{}/{}", p.seat, p.harness, p.session_id.as_deref().unwrap_or(""))
                .eq_ignore_ascii_case(&lower)
            || format!("{}/{}", p.seat, p.harness).eq_ignore_ascii_case(&lower)
            || p.seat.eq_ignore_ascii_case(&lower)
    })
}

/// `~/.house/coord/seats` lines: `<name> <user@host> <inbox-abs-path>`
fn deliver_remote(p: &super::Presence, env: &Envelope) -> Result<String, String> {
    let seats = super::coord_root().join("seats");
    let text = fs::read_to_string(&seats).map_err(|_| {
        format!(
            "seat {} is not this machine and {} is missing — cannot deliver",
            p.seat,
            seats.display()
        )
    })?;
    let mut dest: Option<(String, String)> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut bits = line.split_whitespace();
        let Some(name) = bits.next() else { continue };
        let Some(ssh) = bits.next() else { continue };
        let Some(inbox) = bits.next() else { continue };
        if name.eq_ignore_ascii_case(&p.seat) {
            dest = Some((ssh.to_string(), inbox.to_string()));
            break;
        }
    }
    let Some((ssh, inbox)) = dest else {
        return Err(format!(
            "seat {} has no row in {} — origin state unknown; deliver failed",
            p.seat,
            seats.display()
        ));
    };
    let body = serde_json::to_string(env).map_err(|e| e.to_string())?;
    let remote = format!("{inbox}/{}.json", env.msgid);
    ssh_write(&ssh, &inbox, &remote, &body)
}

fn ssh_write(ssh: &str, inbox: &str, remote: &str, body: &str) -> Result<String, String> {
    let mut child = Command::new("ssh");
    child.args([ssh, &format!("mkdir -p '{inbox}' && cat > '{remote}'")]);
    child.stdin(std::process::Stdio::piped());
    child.stdout(std::process::Stdio::piped());
    child.stderr(std::process::Stdio::piped());
    let mut proc = child.spawn().map_err(|e| format!("ssh spawn: {e}"))?;
    use std::io::Write;
    if let Some(mut stdin) = proc.stdin.take() {
        let _ = stdin.write_all(body.as_bytes());
    }
    let out = proc.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "FETCH FAILED delivering to {ssh}: {}",
            err.lines().last().unwrap_or("ssh failed")
        ));
    }
    Ok(format!("ssh {ssh}"))
}
