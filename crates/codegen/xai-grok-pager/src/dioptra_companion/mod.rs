//! Dioptra TUI companion seam — detect, session-cache, open `dioptra dash`
//! in a **new OS terminal** (never in-process).
//!
//! Detection order (once per process / session via [`OnceLock`]):
//! 1. `~/.selene/dioptra-companion.toml` pointer planted by `selene setup`
//!    (`[dioptra] detected = true` + `path` naming an existing file)
//! 2. `dioptra` on `PATH` ([`detect_dioptra_on_path`])

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

mod spawn;

pub use spawn::{
    SpawnPlan, build_spawn_plan, spawn_dioptra_dash, spawn_plan_for_bin,
};

/// Pointer file name under the selene home (same as setup writer).
pub const DIOPTRA_POINTER_NAME: &str = "dioptra-companion.toml";

/// Session-cached resolution of the dioptra binary (absolute path when found).
static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Detect `dioptra` on PATH (best-effort). Re-homed from `setup_cmd::writer`.
#[must_use]
pub fn detect_dioptra_on_path() -> Option<PathBuf> {
    which::which("dioptra").ok()
}

/// Whether dioptra is available this session (lazy, cached).
#[must_use]
pub fn is_available() -> bool {
    resolved_bin().is_some()
}

/// Session-cached absolute path to the dioptra binary, if any.
#[must_use]
pub fn resolved_bin() -> Option<&'static PathBuf> {
    RESOLVED
        .get_or_init(|| resolve_live())
        .as_ref()
}

/// Live resolve: pointer under selene home, else PATH. Used once by the cache.
fn resolve_live() -> Option<PathBuf> {
    let home = xai_grok_config::grok_home();
    resolve_layered(&home, detect_dioptra_on_path())
}

/// Layered detection (pure / injectable). Prefer for unit tests.
///
/// 1. If `home/dioptra-companion.toml` has `detected = true` and `path` points
///    at an existing file, use that path.
/// 2. Else use `path_hit` (typically PATH probe result).
#[must_use]
pub fn resolve_layered(home: &Path, path_hit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(from_pointer) = read_pointer_bin(home) {
        return Some(from_pointer);
    }
    // Trust `which` results even when `is_file` is flaky (PATHEXT / symlink edge).
    path_hit.filter(|p| !p.as_os_str().is_empty() && (p.is_file() || p.exists()))
}

/// Read companion pointer under `home`. Returns `Some(path)` only when
/// `detected = true` and the named path exists on disk.
#[must_use]
pub fn read_pointer_bin(home: &Path) -> Option<PathBuf> {
    let pointer = home.join(DIOPTRA_POINTER_NAME);
    let raw = std::fs::read_to_string(&pointer).ok()?;
    parse_pointer_toml(&raw).filter(|p| p.is_file())
}

/// Parse the `[dioptra]` table from pointer file body.
fn parse_pointer_toml(raw: &str) -> Option<PathBuf> {
    let value: toml::Value = toml::from_str(raw).ok()?;
    let table = value.get("dioptra")?.as_table()?;
    let detected = table.get("detected")?.as_bool()?;
    if !detected {
        return None;
    }
    let path = table.get("path")?.as_str()?;
    if path.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Launch `dioptra dash` in a new OS terminal for the session-resolved bin.
///
/// Returns `Ok(())` when a spawn was kicked off (child is detached).
/// Returns `Err(message)` suitable for a TUI toast on total failure.
/// Never panics.
pub fn open_dash() -> Result<(), String> {
    let Some(bin) = resolved_bin() else {
        return Err("dioptra not found — install the companion or re-run selene setup".into());
    };
    spawn_dioptra_dash(bin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn pointer_detected_true_with_existing_path_wins() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        let fake_bin = home.join("dioptra-bin");
        fs::write(&fake_bin, b"#!/bin/sh\n").unwrap();
        let body = format!(
            "[dioptra]\ndetected = true\npath = {}\n",
            toml_basic_string(&fake_bin.display().to_string())
        );
        fs::write(home.join(DIOPTRA_POINTER_NAME), body).unwrap();

        let path_hit = Some(PathBuf::from("/should/not/use"));
        let got = resolve_layered(home, path_hit).expect("pointer should win");
        assert_eq!(got, fake_bin);
    }

    #[test]
    fn pointer_detected_false_falls_through_to_path() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        fs::write(
            home.join(DIOPTRA_POINTER_NAME),
            "[dioptra]\ndetected = false\nexpected_asset = \"dioptra-linux-x64\"\n",
        )
        .unwrap();
        let fallback = home.join("from-path");
        fs::write(&fallback, b"x").unwrap();
        let got = resolve_layered(home, Some(fallback.clone())).expect("path fallback");
        assert_eq!(got, fallback);
    }

    #[test]
    fn pointer_missing_path_file_falls_through() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        fs::write(
            home.join(DIOPTRA_POINTER_NAME),
            "[dioptra]\ndetected = true\npath = \"/no/such/dioptra/binary\"\n",
        )
        .unwrap();
        let fallback = home.join("path-bin");
        fs::write(&fallback, b"x").unwrap();
        let got = resolve_layered(home, Some(fallback.clone())).expect("path fallback");
        assert_eq!(got, fallback);
    }

    #[test]
    fn no_pointer_no_path_is_none() {
        let dir = tempdir().unwrap();
        assert!(resolve_layered(dir.path(), None).is_none());
    }

    #[test]
    fn parse_pointer_rejects_empty_path() {
        assert!(parse_pointer_toml("[dioptra]\ndetected = true\npath = \"\"\n").is_none());
    }

    #[test]
    fn detect_dioptra_on_path_is_callable() {
        // Smoke: must not panic whether or not dioptra is installed.
        let _ = detect_dioptra_on_path();
    }

    fn toml_basic_string(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }
}
