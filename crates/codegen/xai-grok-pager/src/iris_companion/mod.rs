//! Iris TUI companion seam — detect, session-cache, open `iris dash`
//! in a **new OS terminal** (never in-process).
//!
//! Detection order (once per process / session via [`OnceLock`]):
//! 1. `~/.amore/iris-companion.toml` pointer planted by `amore setup`
//!    (`[iris] detected = true` + `path` naming an existing file)
//! 2. `iris` on `PATH` ([`detect_iris_on_path`])

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

mod spawn;

pub use spawn::{
    SpawnPlan, build_spawn_plan, spawn_iris_dash, spawn_plan_for_bin,
};

/// Pointer file name under the amore home (same as setup writer).
pub const IRIS_POINTER_NAME: &str = "iris-companion.toml";

/// Session-cached resolution of the iris binary (absolute path when found).
static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Detect `iris` on PATH (best-effort). Re-homed from `setup_cmd::writer`.
#[must_use]
pub fn detect_iris_on_path() -> Option<PathBuf> {
    which::which("iris").ok()
}

/// Whether iris is available this session (lazy, cached).
#[must_use]
pub fn is_available() -> bool {
    resolved_bin().is_some()
}

/// Session-cached absolute path to the iris binary, if any.
#[must_use]
pub fn resolved_bin() -> Option<&'static PathBuf> {
    RESOLVED
        .get_or_init(|| resolve_live())
        .as_ref()
}

/// Live resolve: pointer under amore home, else PATH. Used once by the cache.
fn resolve_live() -> Option<PathBuf> {
    let home = xai_grok_config::grok_home();
    resolve_layered(&home, detect_iris_on_path())
}

/// Layered detection (pure / injectable). Prefer for unit tests.
///
/// 1. If `home/iris-companion.toml` has `detected = true` and `path` points
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
    let pointer = home.join(IRIS_POINTER_NAME);
    let raw = std::fs::read_to_string(&pointer).ok()?;
    parse_pointer_toml(&raw).filter(|p| p.is_file())
}

/// Parse the `[iris]` table from pointer file body.
fn parse_pointer_toml(raw: &str) -> Option<PathBuf> {
    let value: toml::Value = toml::from_str(raw).ok()?;
    let table = value.get("iris")?.as_table()?;
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

/// Launch `iris dash` in a new OS terminal for the session-resolved bin.
///
/// The org root (the house the harness is working in) is resolved and pinned
/// into the spawn so the new terminal opens in the house and iris finds it —
/// the new tab would otherwise inherit an unrelated cwd and refuse with
/// "Org root not found" (a tab that flashes and closes = "dash didn't launch").
///
/// Returns `Ok(())` when a spawn was kicked off (child is detached).
/// Returns `Err(message)` suitable for a TUI toast on total failure.
/// Never panics.
pub fn open_dash() -> Result<(), String> {
    let Some(bin) = resolved_bin() else {
        return Err("iris not found — install the companion or re-run amore setup".into());
    };
    spawn_iris_dash(bin, resolve_org_root().as_deref())
}

/// Resolve the org root the harness is operating in — the same walk iris uses:
/// `$IRIS_ORG_ROOT` if set, else up from the cwd for an orientation file
/// (`AGENTS.md` / `AGENT.md` / `CLAUDE.md`) beside a `tasks/` directory.
/// `None` when no house is found (the spawn then pins nothing and iris resolves
/// from the new tab's own cwd, failing with its standard refusal if absent).
#[must_use]
pub fn resolve_org_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("IRIS_ORG_ROOT") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    org_root_walk_from(std::env::current_dir().ok()?)
}

/// Pure house-root walk (injectable for tests): the nearest ancestor of `start`
/// — `start` itself included — that carries an orientation file beside `tasks/`.
fn org_root_walk_from(start: PathBuf) -> Option<PathBuf> {
    let mut dir = start;
    loop {
        let orient = ["AGENTS.md", "AGENT.md", "CLAUDE.md"]
            .iter()
            .any(|m| dir.join(m).is_file());
        if orient && dir.join("tasks").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
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
        let fake_bin = home.join("iris-bin");
        fs::write(&fake_bin, b"#!/bin/sh\n").unwrap();
        let body = format!(
            "[iris]\ndetected = true\npath = {}\n",
            toml_basic_string(&fake_bin.display().to_string())
        );
        fs::write(home.join(IRIS_POINTER_NAME), body).unwrap();

        let path_hit = Some(PathBuf::from("/should/not/use"));
        let got = resolve_layered(home, path_hit).expect("pointer should win");
        assert_eq!(got, fake_bin);
    }

    #[test]
    fn pointer_detected_false_falls_through_to_path() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        fs::write(
            home.join(IRIS_POINTER_NAME),
            "[iris]\ndetected = false\nexpected_asset = \"iris-linux-x64\"\n",
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
            home.join(IRIS_POINTER_NAME),
            "[iris]\ndetected = true\npath = \"/no/such/iris/binary\"\n",
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
        assert!(parse_pointer_toml("[iris]\ndetected = true\npath = \"\"\n").is_none());
    }

    #[test]
    fn detect_iris_on_path_is_callable() {
        // Smoke: must not panic whether or not iris is installed.
        let _ = detect_iris_on_path();
    }

    #[test]
    fn org_root_walk_finds_the_house_from_deep_inside() {
        let dir = tempdir().unwrap();
        let house = dir.path().join("house");
        fs::create_dir_all(house.join("tasks")).unwrap();
        fs::write(house.join("AGENTS.md"), "# house\n").unwrap();
        let deep = house.join("a/b/c");
        fs::create_dir_all(&deep).unwrap();

        assert_eq!(org_root_walk_from(deep), Some(house.clone()));
        assert_eq!(org_root_walk_from(house.clone()), Some(house));
    }

    #[test]
    fn org_root_walk_needs_both_orientation_and_tasks() {
        let dir = tempdir().unwrap();
        let only_orient = dir.path().join("only-orient");
        fs::create_dir_all(&only_orient).unwrap();
        fs::write(only_orient.join("AGENTS.md"), "# not a house\n").unwrap();
        assert_eq!(org_root_walk_from(only_orient), None);

        let only_tasks = dir.path().join("only-tasks");
        fs::create_dir_all(only_tasks.join("tasks")).unwrap();
        assert_eq!(org_root_walk_from(only_tasks), None);
    }

    #[test]
    fn org_root_walk_returns_none_in_a_bare_tree() {
        let dir = tempdir().unwrap();
        let deep = dir.path().join("x/y/z");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(org_root_walk_from(deep), None);
    }

    #[test]
    fn resolve_org_root_env_wins_and_blank_is_absent() {
        // IRIS_ORG_ROOT is honored first; a blank value falls through to the walk.
        // set_var/remove_var are unsafe in the 2024 edition (env is process-global).
        unsafe {
            std::env::set_var("IRIS_ORG_ROOT", "C:\\some\\house");
        }
        assert_eq!(resolve_org_root(), Some(std::path::PathBuf::from("C:\\some\\house")));
        unsafe {
            std::env::remove_var("IRIS_ORG_ROOT");
        }

        unsafe {
            std::env::set_var("IRIS_ORG_ROOT", "   ");
        }
        assert_ne!(resolve_org_root(), Some(std::path::PathBuf::from("   ")));
        unsafe {
            std::env::remove_var("IRIS_ORG_ROOT");
        }
    }

    fn toml_basic_string(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }
}
