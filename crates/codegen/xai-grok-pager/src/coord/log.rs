//! Per-peer append-only NDJSON logs. One file per peer identity; never a
//! shared append file. Dedup by msgid on ingest.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use super::msg::Envelope;

pub fn log_dir() -> PathBuf {
    super::coord_root().join("log")
}

fn peer_file(peer: &str) -> PathBuf {
    let safe: String = peer
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    log_dir().join(format!("{safe}.ndjson"))
}

/// True if this msgid is already in the peer log.
pub fn seen(peer: &str, msgid: &str) -> bool {
    let path = peer_file(peer);
    let Ok(f) = fs::File::open(path) else {
        return false;
    };
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if line.contains(msgid)
            && let Ok(e) = serde_json::from_str::<Envelope>(&line)
            && e.msgid == msgid
        {
            return true;
        }
    }
    false
}

/// Persist inbound/outbound. Returns false if duplicate (not written).
pub fn append(env: &Envelope, outbound: bool) -> bool {
    let peer = if outbound {
        env.to.as_ref().map(|p| p.ident()).unwrap_or_else(|| env.from.ident())
    } else {
        env.from.ident()
    };
    if seen(&peer, &env.msgid) {
        return false;
    }
    let dir = log_dir();
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let path = peer_file(&peer);
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) else {
        return false;
    };
    let Ok(line) = serde_json::to_string(env) else {
        return false;
    };
    let _ = writeln!(f, "{line}");
    true
}

/// Recent envelopes across all peer logs, oldest first.
pub fn recent(limit: usize) -> Vec<Envelope> {
    let dir = log_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut all = Vec::new();
    for ent in rd.flatten() {
        let p = ent.path();
        if p.extension().and_then(|e| e.to_str()) != Some("ndjson") {
            continue;
        }
        let Ok(f) = fs::File::open(&p) else {
            continue;
        };
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            if let Ok(e) = serde_json::from_str::<Envelope>(&line) {
                all.push(e);
            }
        }
    }
    all.sort_by(|a, b| a.ts.cmp(&b.ts));
    if all.len() > limit {
        all.drain(0..all.len() - limit);
    }
    all
}

pub fn drop_inbox(env: &Envelope) {
    let dir = super::coord_root().join("inbox");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", env.msgid));
    if let Ok(body) = serde_json::to_string_pretty(env) {
        let _ = fs::write(path, body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coord::msg::{Envelope, Party};

    fn env(msgid: &str) -> Envelope {
        Envelope {
            msgid: msgid.into(),
            kind: "message".into(),
            ts: "2026-08-25T00:00:00Z".into(),
            from: Party {
                seat: "a".into(),
                harness: "amore".into(),
                model: None,
                session_id: Some("s".into()),
            },
            to: None,
            text: "hi".into(),
            in_reply_to: None,
        }
    }

    #[test]
    fn append_dedups_msgid() {
        let _g = crate::coord::COORD_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "amore-coord-log-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("presence")).unwrap();
        let prev = std::env::var_os("HOUSE_COORD_DIR");
        unsafe { std::env::set_var("HOUSE_COORD_DIR", dir.join("presence")) };
        let e = env("msg-1");
        assert!(append(&e, false));
        assert!(!append(&e, false));
        assert_eq!(recent(10).len(), 1);
        match prev {
            Some(v) => unsafe { std::env::set_var("HOUSE_COORD_DIR", v) },
            None => unsafe { std::env::remove_var("HOUSE_COORD_DIR") },
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
