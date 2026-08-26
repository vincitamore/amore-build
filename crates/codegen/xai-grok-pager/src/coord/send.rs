//! Resolve a send target.
//!
//! Same-seat is a hard first path: loopback unix / 127.0.0.1 with the
//! session token. Multiple Amore sessions on this machine never leave
//! the box. Tailnet TLS is only for a *different* Tailscale node.

use super::msg::{Disposition, Envelope, Party};
use super::seats;
use super::socket;

#[derive(Debug)]
pub struct SendResult {
    pub disposition: Disposition,
    pub via: String,
    /// Set when live wake was attempted and failed before the inbox drop.
    pub degrade: Option<String>,
}

impl SendResult {
    pub fn new(disposition: Disposition, via: impl Into<String>) -> Self {
        Self {
            disposition,
            via: via.into(),
            degrade: None,
        }
    }

    fn degraded_inbox(via: impl Into<String>, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        tracing::warn!(error = %reason, "coord: live wake failed, inbox fallback");
        eprintln!("coord: degraded (inbox) after live wake: {reason}");
        Self {
            disposition: Disposition::Inbox,
            via: via.into(),
            degrade: Some(reason),
        }
    }

    /// Operator-facing line. Degraded inbox must not read as `sent (inbox)`.
    pub fn format_line(&self) -> String {
        if let Some(reason) = &self.degrade {
            format!(
                "degraded ({}) after live wake: {reason}",
                self.disposition.as_str()
            )
        } else {
            format!("sent ({}) via {}", self.disposition.as_str(), self.via)
        }
    }
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
    env.from.session_id = originator_session_id(&roster);
    if let Some(p) = hit.as_ref() {
        env.to = Some(party_of(p));
    }
    super::log::append(&env, true);
    if hit.is_none() && !same_seat_name(target) {
        let mut attempts: Vec<String> = Vec::new();
        if let Some(ip) = super::seat::tailscale_peer_ip(target) {
            if super::seat::tailscale_ip() == Some(ip) {
                // Our own CGNAT address — not a remote peer.
            } else {
                env.to = Some(Party {
                    seat: target.to_string(),
                    harness: "amore".into(),
                    model: None,
                    session_id: None,
                });
                let addr = format!("tls:{ip}:{}", super::tls::COORD_PORT);
                match super::socket::post_tailnet(&addr, target, &env) {
                    Ok(d) => return Ok(SendResult::new(d, addr)),
                    Err(e) => attempts.push(format!("{addr}: {e}")),
                }
            }
        }
        if let Some(row) = seats::lookup(target) {
            env.to = Some(Party {
                seat: row.name.clone(),
                harness: "amore".into(),
                model: None,
                session_id: None,
            });
            match seats::drop_inbox_remote(&row, &env) {
                Ok(via) => {
                    return Ok(if attempts.is_empty() {
                        SendResult::new(Disposition::Inbox, via)
                    } else {
                        SendResult::degraded_inbox(via, attempts.join("; "))
                    });
                }
                Err(e) => return Err(e),
            }
        }
        return Err(unknown_target(target));
    }
    deliver(env, hit)
}

/// Post an already-built envelope to a local socket. Does not rewrite `from`.
pub fn inject(env: Envelope) -> Result<SendResult, String> {
    super::log::append(&env, false);
    // Local delivery: inject runs on the receiving seat and must not dial
    // the network to resolve its target.
    let roster = super::local_roster();
    let hit = env
        .to
        .as_ref()
        .and_then(|t| resolve_party(&roster, t))
        .or_else(|| {
            env.to
                .as_ref()
                .and_then(|t| t.session_id.as_deref())
                .and_then(|sid| roster.iter().find(|p| p.session_id.as_deref() == Some(sid)))
        });
    deliver(env, hit)
}

fn deliver(
    env: Envelope,
    hit: Option<&super::Presence>,
) -> Result<SendResult, String> {
    if let Some(p) = hit
        && let (Some(addr), Some(token)) = (p.socket.as_deref(), p.socket_token.as_deref())
        && same_seat(p)
    {
        match socket::post_local(addr, token, &env, &p.harness) {
            Ok(d) => {
                return Ok(SendResult::new(d, format!("socket {addr}")));
            }
            Err(e) => {
                super::log::drop_inbox(&env);
                return Ok(SendResult::degraded_inbox(
                    "local inbox",
                    format!("loopback {addr}: {e}"),
                ));
            }
        }
    }

    if let Some(p) = hit
        && !same_seat(p)
    {
        return deliver_remote(p, &env);
    }

    if hit.is_none() {
        if let Some(row) = seats::lookup(target_seat_hint(&env)) {
            match seats::inject_remote(&row, &env) {
                Ok(r) => return Ok(r),
                Err(e) => tracing::debug!(error = %e, "coord inject remote failed, inbox"),
            }
            match seats::drop_inbox_remote(&row, &env) {
                Ok(via) => {
                    return Ok(SendResult::new(Disposition::Inbox, via));
                }
                Err(e) => return Err(e),
            }
        }
        if let Some(to) = env.to.as_ref() {
            if !same_seat_name(&to.seat) {
                return Err(unknown_target(&to.ident()));
            }
        }
    }

    super::log::drop_inbox(&env);
    Ok(SendResult::new(Disposition::Inbox, "local inbox"))
}

fn unknown_target(target: &str) -> String {
    format!(
        "unknown target {target}: not in the roster, not a tailnet peer, and has no row in {}",
        super::coord_root().join("seats").display()
    )
}

fn target_seat_hint(env: &Envelope) -> &str {
    env.to
        .as_ref()
        .map(|t| t.seat.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("")
}

fn originator_session_id(roster: &[super::Presence]) -> Option<String> {
    if let Some(s) = super::this_session_id() {
        return Some(s);
    }
    let me = super::seat();
    let pid = std::process::id();
    if let Some(p) = roster
        .iter()
        .find(|p| p.pid == pid && p.harness == super::HARNESS)
    {
        return p.session_id.clone();
    }
    let live: Vec<_> = roster
        .iter()
        .filter(|p| p.seat.eq_ignore_ascii_case(&me) && p.harness == super::HARNESS)
        .collect();
    if live.len() == 1 {
        live[0].session_id.clone()
    } else {
        None
    }
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
    same_seat_name(&p.seat)
}

fn same_seat_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(&super::seat())
}

fn resolve<'a>(roster: &'a [super::Presence], target: &str) -> Option<&'a super::Presence> {
    let t = target.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_lowercase();
    roster.iter().find(|p| {
        p.session_id.as_deref() == Some(t)
            || format!(
                "{}/{}/{}",
                p.seat,
                p.harness,
                p.session_id.as_deref().unwrap_or("")
            )
            .eq_ignore_ascii_case(&lower)
            || format!("{}/{}", p.seat, p.harness).eq_ignore_ascii_case(&lower)
            || p.seat.eq_ignore_ascii_case(&lower)
    })
}

fn resolve_party<'a>(roster: &'a [super::Presence], to: &Party) -> Option<&'a super::Presence> {
    if let Some(sid) = to.session_id.as_deref() {
        if let Some(p) = roster.iter().find(|p| p.session_id.as_deref() == Some(sid)) {
            return Some(p);
        }
    }
    resolve(roster, &to.ident())
}

fn deliver_remote(p: &super::Presence, env: &Envelope) -> Result<SendResult, String> {
    let mut attempts: Vec<String> = Vec::new();
    if let Some(addr) = p.socket_tailnet.as_deref() {
        match super::socket::post_tailnet(addr, &p.seat, env) {
            Ok(d) => return Ok(SendResult::new(d, addr)),
            Err(e) => attempts.push(format!("{addr}: {e}")),
        }
    }
    if let Some(ip) = super::seat::tailscale_peer_ip(&p.seat) {
        let addr = format!("tls:{ip}:{}", super::tls::COORD_PORT);
        let already = p
            .socket_tailnet
            .as_deref()
            .is_some_and(|stamped| stamped == addr);
        if !already {
            match super::socket::post_tailnet(&addr, &p.seat, env) {
                Ok(d) => return Ok(SendResult::new(d, addr)),
                Err(e) => attempts.push(format!("{addr}: {e}")),
            }
        }
    }
    let Some(row) = seats::lookup(&p.seat) else {
        if attempts.is_empty() {
            return Err(format!(
                "seat {} is not reachable on the tailnet and has no row in {} — deliver failed",
                p.seat,
                super::coord_root().join("seats").display()
            ));
        }
        return Err(format!(
            "seat {} live wake failed ({}); no row in {} for inbox fallback",
            p.seat,
            attempts.join("; "),
            super::coord_root().join("seats").display()
        ));
    };
    match seats::drop_inbox_remote(&row, env) {
        Ok(via) => Ok(if attempts.is_empty() {
            SendResult::new(Disposition::Inbox, via)
        } else {
            SendResult::degraded_inbox(via, attempts.join("; "))
        }),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coord::msg::Party;
    use std::fs;
    use std::path::{Path, PathBuf};

    struct EnvRestore {
        coord: Option<std::ffi::OsString>,
        seat: Option<std::ffi::OsString>,
        root: PathBuf,
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.coord {
                Some(v) => unsafe { std::env::set_var("HOUSE_COORD_DIR", v) },
                None => unsafe { std::env::remove_var("HOUSE_COORD_DIR") },
            }
            match &self.seat {
                Some(v) => unsafe { std::env::set_var("HOUSE_SEAT", v) },
                None => unsafe { std::env::remove_var("HOUSE_SEAT") },
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn with_isolated_coord<R>(f: impl FnOnce(&Path) -> R) -> R {
        let _g = crate::coord::COORD_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!(
            "amore-send-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let presence = root.join("presence");
        fs::create_dir_all(&presence).unwrap();
        let restore = EnvRestore {
            coord: std::env::var_os("HOUSE_COORD_DIR"),
            seat: std::env::var_os("HOUSE_SEAT"),
            root: root.clone(),
        };
        unsafe { std::env::set_var("HOUSE_COORD_DIR", &presence) };
        unsafe { std::env::set_var("HOUSE_SEAT", "node-one") };
        let result = f(&root);
        drop(restore);
        result
    }

    #[test]
    fn format_line_success_is_sent() {
        let r = SendResult::new(Disposition::Woken, "socket tcp:127.0.0.1:1");
        assert_eq!(r.format_line(), "sent (woken) via socket tcp:127.0.0.1:1");
    }

    #[test]
    fn format_line_plain_inbox_is_sent() {
        let r = SendResult::new(Disposition::Inbox, "ssh user@host");
        assert_eq!(r.format_line(), "sent (inbox) via ssh user@host");
    }

    #[test]
    fn format_line_degraded_inbox_is_not_sent() {
        let r = SendResult {
            disposition: Disposition::Inbox,
            via: "ssh user@host".into(),
            degrade: Some("tls:100.64.0.2:3856: pin mismatch".into()),
        };
        let line = r.format_line();
        assert_eq!(
            line,
            "degraded (inbox) after live wake: tls:100.64.0.2:3856: pin mismatch"
        );
        assert!(!line.starts_with("sent "), "{line}");
        assert!(line.contains("pin mismatch"), "{line}");
    }

    #[test]
    fn unknown_target_fails_loud_not_local_inbox() {
        with_isolated_coord(|root| {
            let err = send("no-such-seat", "hello").unwrap_err();
            assert!(err.contains("unknown target"), "{err}");
            assert!(err.contains("no-such-seat"), "{err}");
            let inbox = root.join("inbox");
            let n = fs::read_dir(&inbox)
                .map(|rd| rd.filter_map(|e| e.ok()).count())
                .unwrap_or(0);
            assert_eq!(n, 0, "must not drop into the sender inbox");
        });
    }

    #[test]
    fn empty_message_still_errors() {
        with_isolated_coord(|_| {
            assert_eq!(send("node-two", "  ").unwrap_err(), "message is empty");
        });
    }

    #[test]
    fn inject_unknown_remote_to_fails_loud() {
        with_isolated_coord(|root| {
            let env = Envelope::new_message(
                "hi",
                Some(Party {
                    seat: "no-such-seat".into(),
                    harness: "amore".into(),
                    model: None,
                    session_id: None,
                }),
            );
            let err = inject(env).unwrap_err();
            assert!(err.contains("unknown target"), "{err}");
            let inbox = root.join("inbox");
            let n = fs::read_dir(&inbox)
                .map(|rd| rd.filter_map(|e| e.ok()).count())
                .unwrap_or(0);
            assert_eq!(n, 0, "must not drop into the sender inbox");
        });
    }
}
