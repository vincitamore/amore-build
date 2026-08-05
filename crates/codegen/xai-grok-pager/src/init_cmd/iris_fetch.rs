//! Install the iris companion into a new house's `instruments/iris/`.
//!
//! Iris is part of the house, not an optional extra, so `init` installs it by
//! default and `--no-iris` opts out. That means `init` reaches the network,
//! and the docs say so — the alternative was keeping a "no network required"
//! sentence true by shipping a house without its instrument.
//!
//! **A failure here never fails the house.** The whole tree is already written
//! by the time this runs; a download that 404s, times out, or lands on a
//! platform with no published asset produces a clear note and one command to
//! finish later. Nothing is half-installed: the archive is verified against its
//! published checksum before anything is unpacked.
//!
//! Implementation lives in [`super::instrument_fetch`]; this module keeps the
//! iris-shaped public surface used by init and its unit tests.

use std::path::Path;

use super::instrument_fetch::{self, InstrumentSpec, IRIS};

/// Directory, relative to the house root, that the companion is installed into.
pub const IRIS_REL: &str = IRIS.install_rel;

/// Release-asset suffix for the running host, or `None` when no asset is built
/// for it. Re-export of the shared target map so iris callers stay stable.
pub use instrument_fetch::target_suffix;

/// Archive name published for `suffix`, and the multi-tool binary inside it.
#[cfg(test)]
fn asset_names(suffix: &str) -> (String, String) {
    instrument_fetch::asset_names(IRIS.name, suffix)
}

/// What happened, in terms the summary can print verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IrisOutcome {
    Installed {
        rel_path: String,
        version: String,
        /// Directory the binaries were also linked into (beside `amore`), when
        /// that succeeded — i.e. `iris` is now on PATH wherever `amore` is.
        linked: Option<String>,
    },
    OptedOut,
    /// No published asset for this host.
    UnsupportedHost { host: String },
    /// Reached for it and could not get it. Carries a human reason.
    Failed { reason: String },
}

impl IrisOutcome {
    /// One line for the init summary. `None` when there is nothing worth saying.
    pub fn summary_line(&self) -> Option<String> {
        match self {
            Self::Installed {
                rel_path,
                version,
                linked,
            } => instrument_fetch::Outcome::Installed {
                name: IRIS.name.to_string(),
                rel_path: rel_path.clone(),
                version: version.clone(),
                linked: linked.clone(),
            }
            .summary_line(),
            Self::OptedOut => None,
            Self::UnsupportedHost { host } => instrument_fetch::Outcome::UnsupportedHost {
                name: IRIS.name.to_string(),
                host: host.clone(),
            }
            .summary_line(),
            Self::Failed { reason } => instrument_fetch::Outcome::Failed {
                name: IRIS.name.to_string(),
                reason: reason.clone(),
            }
            .summary_line(),
        }
    }
}

impl From<instrument_fetch::Outcome> for IrisOutcome {
    fn from(value: instrument_fetch::Outcome) -> Self {
        match value {
            instrument_fetch::Outcome::Installed {
                rel_path,
                version,
                linked,
                ..
            } => Self::Installed {
                rel_path,
                version,
                linked,
            },
            instrument_fetch::Outcome::OptedOut => Self::OptedOut,
            instrument_fetch::Outcome::UnsupportedHost { host, .. } => {
                Self::UnsupportedHost { host }
            }
            instrument_fetch::Outcome::Failed { reason, .. } => Self::Failed { reason },
        }
    }
}

/// Install iris under `root`. Never returns `Err` — a failure to fetch is an
/// outcome to report, not an error that unwinds a successful house install.
pub fn install(root: &Path, version: &str, dry_run: bool) -> IrisOutcome {
    instrument_fetch::install(&IRIS, root, version, dry_run).into()
}

/// Spec used by the shared installer (tests and diagnostics).
pub const fn spec() -> InstrumentSpec {
    IRIS
}

#[cfg(test)]
mod tests {
    use super::*;
    use instrument_fetch::verify_sha256;

    #[test]
    fn asset_names_match_what_the_release_workflow_publishes() {
        // Windows packages `<bin>.exe` into `<bin>.exe.zip` — the doubled
        // extension is deliberate, not a typo.
        assert_eq!(
            asset_names("windows-x64"),
            ("iris-windows-x64.exe.zip".into(), "iris-windows-x64.exe".into())
        );
        assert_eq!(
            asset_names("linux-x64"),
            ("iris-linux-x64.tar.gz".into(), "iris-linux-x64".into())
        );
        assert_eq!(
            asset_names("darwin-arm64"),
            ("iris-darwin-arm64.tar.gz".into(), "iris-darwin-arm64".into())
        );
    }

    #[test]
    fn only_published_targets_resolve() {
        // Whatever host runs the tests, the mapping must agree with itself.
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => assert_eq!(target_suffix(), Some("linux-x64")),
            ("windows", "x86_64") => assert_eq!(target_suffix(), Some("windows-x64")),
            ("macos", "aarch64") => assert_eq!(target_suffix(), Some("darwin-arm64")),
            _ => assert_eq!(target_suffix(), None),
        }
    }

    #[test]
    fn checksum_is_enforced() {
        let payload = b"hello";
        let good = xai_file_utils::sha256_hex(payload);
        assert!(verify_sha256(payload, format!("{good}  x.tar.gz").as_bytes()).is_ok());
        // Uppercase hex is still a match.
        assert!(verify_sha256(payload, good.to_ascii_uppercase().as_bytes()).is_ok());
        // A wrong digest must refuse, not warn.
        let bad = "0".repeat(64);
        assert!(verify_sha256(payload, bad.as_bytes()).is_err());
        // A truncated or empty checksum file is malformed, never "close enough".
        assert!(verify_sha256(payload, b"deadbeef  x.tar.gz").is_err());
        assert!(verify_sha256(payload, b"").is_err());
    }

    #[test]
    fn a_failed_fetch_is_reported_not_fatal() {
        let out = IrisOutcome::Failed {
            reason: "HTTP 404".into(),
        };
        let line = out.summary_line().expect("failure must be reported");
        assert!(line.contains("HTTP 404"));
        assert!(line.contains("the house is complete without it"));
        // Opting out is silent — nothing failed, so nothing is said.
        assert_eq!(IrisOutcome::OptedOut.summary_line(), None);
    }

    #[test]
    fn unsupported_host_points_at_the_source_build() {
        let out = IrisOutcome::UnsupportedHost {
            host: "macos-x86_64".into(),
        };
        let line = out.summary_line().unwrap();
        assert!(line.contains("macos-x86_64"));
        assert!(line.contains("build it from source"));
    }
}
