//! Single source of truth for the grok home directory: `$AMORE_HOME` (primary),
//! `$GROK_HOME` (legacy alias), or `<home>/.amore`. Shared by `xai-grok-config`
//! and `xai-fast-worktree`.
//!
//! Which function to call:
//! - [`grok_home`]: the usual choice, a cached, created path to build on.
//! - [`user_grok_home`]: `None` instead of a cwd fallback when no home resolves.
//! - [`default_grok_home`]: the `<home>/.amore` default, ignoring `$AMORE_HOME` /
//!   `$GROK_HOME`, so callers can detect an override.
//! - [`resolve_grok_home`]: a fresh, uncached resolve. Env override is read
//!   through `xai_grok_env::var_os("GROK_HOME")` so `$AMORE_HOME` wins.
//!
//! TODO: collapse these getters by threading the path through config as an
//! explicit value.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// `<home>/.amore`, canonicalized via `dunce` (not `std::fs::canonicalize`,
/// which yields Windows `\\?\` verbatim paths).
fn grok_home_in(home: &Path) -> PathBuf {
    dunce::canonicalize(home)
        .unwrap_or_else(|_| home.to_path_buf())
        .join(".amore")
}

/// Home-override env value verbatim when non-empty, else `<home>/.amore`. The
/// env value is used as-is (not canonicalized) so it stays stable and
/// comparable: callers do literal prefix checks against it, and downstream
/// symlink guards must still see its original components.
fn resolve_grok_home_from(
    grok_home_env: Option<&OsStr>,
    os_home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(env) = grok_home_env.filter(|env| !env.is_empty()) {
        return Some(PathBuf::from(env));
    }
    os_home.map(grok_home_in)
}

/// Resolve the grok home from the environment (fresh, no cache); `None` if neither resolves.
///
/// Override is `xai_grok_env::var_os("GROK_HOME")`: `$AMORE_HOME` primary,
/// `$GROK_HOME` legacy. Empty override falls through to `<home>/.amore`.
pub fn resolve_grok_home() -> Option<PathBuf> {
    resolve_grok_home_from(
        xai_grok_env::var_os("GROK_HOME").as_deref(),
        dirs::home_dir().as_deref(),
    )
}

/// The default `<home>/.amore`, used when `$AMORE_HOME` / `$GROK_HOME` is unset.
pub fn default_grok_home() -> PathBuf {
    grok_home_in(&dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

/// The grok home, created if missing and cached for the process; falls back to
/// [`default_grok_home`] when neither `$AMORE_HOME` / `$GROK_HOME` nor a home
/// resolves.
pub fn grok_home() -> PathBuf {
    static GROK_HOME: OnceLock<PathBuf> = OnceLock::new();
    GROK_HOME
        .get_or_init(|| {
            let home = resolve_grok_home().unwrap_or_else(default_grok_home);
            if let Err(err) = std::fs::create_dir_all(&home) {
                tracing::warn!(path = %home.display(), %err, "failed to create grok home");
            }
            home
        })
        .clone()
}

/// Like [`grok_home`], but `None` when no home resolves (no cwd fallback).
pub fn user_grok_home() -> Option<PathBuf> {
    resolve_grok_home().is_some().then(grok_home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::ffi::OsString;
    use std::sync::Mutex;

    static HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Snapshot/restore `$AMORE_HOME` and `$GROK_HOME` for live `resolve_grok_home` tests.
    /// Nested `xai_grok_env::EnvVarGuard` would deadlock on that crate's env lock.
    struct HomeEnvGuard {
        prev_amore: Option<OsString>,
        prev_grok: Option<OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl HomeEnvGuard {
        fn set(amore: Option<&OsStr>, grok: Option<&OsStr>) -> Self {
            let lock = HOME_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let prev_amore = std::env::var_os("AMORE_HOME");
            let prev_grok = std::env::var_os("GROK_HOME");
            unsafe {
                match amore {
                    Some(v) => std::env::set_var("AMORE_HOME", v),
                    None => std::env::remove_var("AMORE_HOME"),
                }
                match grok {
                    Some(v) => std::env::set_var("GROK_HOME", v),
                    None => std::env::remove_var("GROK_HOME"),
                }
            }
            Self {
                prev_amore,
                prev_grok,
                _lock: lock,
            }
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            unsafe {
                match self.prev_amore.take() {
                    Some(v) => std::env::set_var("AMORE_HOME", v),
                    None => std::env::remove_var("AMORE_HOME"),
                }
                match self.prev_grok.take() {
                    Some(v) => std::env::set_var("GROK_HOME", v),
                    None => std::env::remove_var("GROK_HOME"),
                }
            }
        }
    }

    #[test]
    fn env_wins_over_os_home() {
        let resolved =
            resolve_grok_home_from(Some(OsStr::new("/custom/home")), Some(Path::new("/home/u")));
        assert_eq!(resolved, Some(PathBuf::from("/custom/home")));
    }

    #[test]
    fn env_used_verbatim_even_when_it_exists() {
        // A real, existing dir whose canonical form differs (macOS symlinks
        // `/var` -> `/private/var`): the env value must come back unchanged.
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_grok_home_from(Some(tmp.path().as_os_str()), None);
        assert_eq!(resolved, Some(tmp.path().to_path_buf()));
    }

    #[test]
    fn empty_env_falls_through_to_os_home() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_grok_home_from(Some(&OsString::new()), Some(tmp.path()));
        assert_eq!(
            resolved,
            Some(dunce::canonicalize(tmp.path()).unwrap().join(".amore"))
        );
    }

    #[test]
    fn default_grok_home_has_no_verbatim_prefix() {
        // The reason we canonicalize via dunce: std::fs::canonicalize yields
        // `\\?\` verbatim paths on Windows that break git and byte-exact
        // comparisons. No-op assertion on Unix.
        let home = default_grok_home();
        assert!(!home.to_string_lossy().starts_with(r"\\?\"));
        assert!(home.ends_with(".amore"));
    }

    #[test]
    fn none_when_nothing_resolves() {
        assert_eq!(
            resolve_grok_home_from(/* grok_home_env */ None, /* os_home */ None),
            None
        );
    }

    #[test]
    fn resolve_grok_home_amore_home_wins_over_grok_home() {
        let amore = tempfile::tempdir().unwrap();
        let grok = tempfile::tempdir().unwrap();
        let _guard = HomeEnvGuard::set(
            Some(amore.path().as_os_str()),
            Some(grok.path().as_os_str()),
        );
        assert_eq!(resolve_grok_home(), Some(amore.path().to_path_buf()));
    }

    #[test]
    fn resolve_grok_home_legacy_when_primary_absent() {
        let grok = tempfile::tempdir().unwrap();
        let _guard = HomeEnvGuard::set(None, Some(grok.path().as_os_str()));
        assert_eq!(resolve_grok_home(), Some(grok.path().to_path_buf()));
    }
}
