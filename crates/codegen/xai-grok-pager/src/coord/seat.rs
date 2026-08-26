//! Seat identity: `HOUSE_SEAT`, then the seat file, then Tailscale MagicDNS
//! first label, then the kernel hostname first label.
//!
//! `HOUSE_SEAT` wins (tests, an overlay). The seat file is persisted only
//! from a `HOUSE_SEAT` or Tailscale resolution — never from the hostname
//! fallback, so a degraded process cannot poison the file.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

struct Resolved {
    value: String,
    persist: bool,
}

pub fn seat() -> String {
    resolve().value
}

/// Write `coord_root()/seat` only when the winning source is `HOUSE_SEAT` or
/// Tailscale. Hostname fallback must not land on disk.
pub(crate) fn persist_authoritative() {
    let resolved = resolve();
    if !resolved.persist {
        return;
    }
    let root = super::coord_root();
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join("seat"), format!("{}\n", resolved.value));
}

fn resolve() -> Resolved {
    if let Some(value) = std::env::var("HOUSE_SEAT").ok().and_then(|s| normalize(&s)) {
        return Resolved {
            value,
            persist: true,
        };
    }
    if let Some(value) = read_seat_file() {
        return Resolved {
            value,
            persist: false,
        };
    }
    if let Some(value) = tailscale_label() {
        return Resolved {
            value,
            persist: true,
        };
    }
    if let Some(value) = hostname_label() {
        return Resolved {
            value,
            persist: false,
        };
    }
    Resolved {
        value: "unknown".into(),
        persist: false,
    }
}

fn normalize(s: &str) -> Option<String> {
    let t = s.trim().trim_end_matches('.').trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_lowercase())
    }
}

fn first_label(s: &str) -> Option<String> {
    let label = s.trim().trim_end_matches('.').split('.').next()?.trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_lowercase())
    }
}

fn read_seat_file() -> Option<String> {
    let text = std::fs::read_to_string(super::coord_root().join("seat")).ok()?;
    normalize(&text)
}

pub fn tailscale_ip() -> Option<std::net::IpAddr> {
    let v = tailscale_status()?;
    v.pointer("/Self/TailscaleIPs")
        .and_then(|ips| ips.as_array())
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str())
        .filter_map(|s| s.parse().ok())
        .find(|ip: &std::net::IpAddr| ip.is_ipv4())
}

pub fn tailscale_peer_ip(name: &str) -> Option<std::net::IpAddr> {
    let want = name.trim().trim_end_matches('.').to_lowercase();
    let v = tailscale_status()?;
    let peers = v.get("Peer")?.as_object()?;
    for peer in peers.values() {
        let dns = peer.get("DNSName").and_then(|x| x.as_str()).unwrap_or("");
        let host = peer.get("HostName").and_then(|x| x.as_str()).unwrap_or("");
        let label = dns
            .trim_end_matches('.')
            .split('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
        if label == want || host.eq_ignore_ascii_case(&want) {
            return peer
                .get("TailscaleIPs")
                .and_then(|ips| ips.as_array())
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str())
                .filter_map(|s| s.parse().ok())
                .find(|ip: &std::net::IpAddr| ip.is_ipv4());
        }
    }
    None
}

fn tailscale_bins() -> Vec<PathBuf> {
    let mut bins = vec![PathBuf::from("tailscale")];
    #[cfg(windows)]
    {
        bins.push(PathBuf::from("tailscale.exe"));
        if let Ok(pf) = std::env::var("ProgramFiles") {
            bins.push(PathBuf::from(pf).join("Tailscale").join("tailscale.exe"));
        }
        bins.push(PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe"));
    }
    bins
}

fn tailscale_output() -> Option<std::process::Output> {
    for bin in tailscale_bins() {
        let mut cmd = Command::new(&bin);
        cmd.args(["status", "--json"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Ok(out) = cmd.output()
            && out.status.success()
            && !out.stdout.is_empty()
        {
            return Some(out);
        }
    }
    None
}

fn tailscale_status() -> Option<serde_json::Value> {
    // Cache successes only. A failed probe must be retryable — a OnceLock of
    // `Option` would pin a miss for the process lifetime.
    static CACHED: OnceLock<serde_json::Value> = OnceLock::new();
    if let Some(v) = CACHED.get() {
        return Some(v.clone());
    }
    let out = tailscale_output()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    match CACHED.set(v.clone()) {
        Ok(()) => Some(v),
        Err(_) => CACHED.get().cloned(),
    }
}

fn tailscale_label() -> Option<String> {
    let v = tailscale_status()?;
    let dns = v.pointer("/Self/DNSName")?.as_str()?;
    first_label(dns)
}

fn hostname_label() -> Option<String> {
    kernel_hostname()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .and_then(|s| first_label(&s))
}

fn kernel_hostname() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if rc != 0 {
            return None;
        }
        let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let s = std::str::from_utf8(&buf[..len]).ok()?.trim();
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty())
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            "amore-seat-test-{}-{}",
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
        // HOUSE_COORD_DIR is the presence dir; coord_root() is its parent.
        unsafe { std::env::set_var("HOUSE_COORD_DIR", &presence) };
        unsafe { std::env::remove_var("HOUSE_SEAT") };
        let result = f(&root);
        drop(restore);
        result
    }

    fn seat_path(root: &Path) -> PathBuf {
        root.join("seat")
    }

    #[test]
    fn house_seat_zzz_test_wins() {
        with_isolated_coord(|root| {
            fs::write(seat_path(root), "from-file\n").unwrap();
            unsafe { std::env::set_var("HOUSE_SEAT", "zzz-test") };
            assert_eq!(seat(), "zzz-test");
        });
    }

    #[test]
    fn seat_file_read_when_house_seat_unset() {
        with_isolated_coord(|root| {
            fs::write(seat_path(root), "from-file-zzz\n").unwrap();
            assert!(std::env::var_os("HOUSE_SEAT").is_none());
            assert_eq!(seat(), "from-file-zzz");
        });
    }

    #[test]
    fn persist_authoritative_from_house_seat() {
        with_isolated_coord(|root| {
            unsafe { std::env::set_var("HOUSE_SEAT", "zzz-test") };
            persist_authoritative();
            let got = fs::read_to_string(seat_path(root)).unwrap();
            assert_eq!(got.trim(), "zzz-test");
        });
    }

    #[test]
    fn persist_authoritative_skips_file_and_hostname() {
        with_isolated_coord(|root| {
            fs::write(seat_path(root), "from-file-zzz\n").unwrap();
            persist_authoritative();
            let got = fs::read_to_string(seat_path(root)).unwrap();
            assert_eq!(got.trim(), "from-file-zzz");
        });
    }

    #[test]
    fn persist_authoritative_never_writes_hostname_fallback() {
        with_isolated_coord(|root| {
            persist_authoritative();
            match tailscale_label() {
                Some(label) => {
                    let got = fs::read_to_string(seat_path(root)).unwrap();
                    assert_eq!(got.trim(), label);
                }
                None => {
                    assert!(
                        !seat_path(root).exists(),
                        "hostname fallback must not persist the seat file"
                    );
                }
            }
        });
    }

    #[test]
    fn tailscale_dnsname_first_label() {
        let v: serde_json::Value = serde_json::json!({
            "Self": { "DNSName": "node-one.example.ts.net." }
        });
        let dns = v.pointer("/Self/DNSName").unwrap().as_str().unwrap();
        assert_eq!(first_label(dns).as_deref(), Some("node-one"));
    }

    #[test]
    fn tailscale_bins_include_bare_name() {
        let bins = tailscale_bins();
        assert!(
            bins.iter()
                .any(|p| p.ends_with("tailscale") || p.ends_with("tailscale.exe")),
            "{bins:?}"
        );
    }

    #[test]
    fn hostname_first_label_strips_domain() {
        assert_eq!(
            first_label("node-one.example.local.").as_deref(),
            Some("node-one")
        );
    }
}
