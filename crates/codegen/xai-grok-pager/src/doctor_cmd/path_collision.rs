//! PATH-collision detection for the public `amore` binary name.
//!
//! crates.io already publishes a Lua linter named `amore`. When that binary
//! (or any other non-ours `amore`) sits earlier on PATH than Amore Build,
//! users get the wrong tool. Doctor surfaces a recommendation with a PATH
//! remedy — never a hard failure.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Stable doctor finding id: `path.amore-collision`.
pub const PATH_COLLISION_ID: crate::diagnostics::DiagnosticId =
    crate::diagnostics::DiagnosticId::new("path", "amore-collision");

/// Result of resolving `amore` on PATH against this process's executable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PathCollisionResult {
    /// `amore` not found on PATH.
    NotOnPath,
    /// First PATH hit is this binary (or same file).
    Ours { path: PathBuf },
    /// First PATH hit is a different binary that would shadow us.
    Shadowed { path: PathBuf },
    /// Resolution failed (spawn/parse).
    CheckFailed { error: String },
}

impl PathCollisionResult {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::NotOnPath => "not_on_path",
            Self::Ours { .. } => "ours",
            Self::Shadowed { .. } => "shadowed",
            Self::CheckFailed { .. } => "check_failed",
        }
    }

    pub fn is_shadowed(&self) -> bool {
        matches!(self, Self::Shadowed { .. })
    }

    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Ours { path } | Self::Shadowed { path } => Some(path.as_path()),
            Self::NotOnPath | Self::CheckFailed { .. } => None,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::NotOnPath => {
                "amore is not on PATH (install or add the binary directory to PATH).".to_owned()
            }
            Self::Ours { path } => {
                format!("amore on PATH resolves to this binary ({})", path.display())
            }
            Self::Shadowed { path } => format!(
                "Another `amore` on PATH shadows Amore Build: {}. \
                 (crates.io also publishes a Lua linter named amore.)",
                path.display()
            ),
            Self::CheckFailed { error } => {
                format!("Could not resolve amore on PATH: {error}")
            }
        }
    }
}

/// Resolve the first `amore` on PATH and compare with `current_exe`.
pub fn check_amore_path_collision() -> PathCollisionResult {
    let current = match std::env::current_exe() {
        Ok(p) => canonicalize_soft(&p),
        Err(e) => {
            return PathCollisionResult::CheckFailed {
                error: format!("current_exe: {e}"),
            };
        }
    };
    let candidates = match resolve_amore_on_path() {
        Ok(v) => v,
        Err(e) => {
            return PathCollisionResult::CheckFailed {
                error: e.to_string(),
            };
        }
    };
    let Some(first) = candidates.into_iter().next() else {
        return PathCollisionResult::NotOnPath;
    };
    let first_canon = canonicalize_soft(&first);
    if paths_same_file(&current, &first_canon) {
        PathCollisionResult::Ours { path: first }
    } else {
        PathCollisionResult::Shadowed { path: first }
    }
}

/// Apply the PATH-collision check to a doctor report.
///
/// Always records a structured result on the report's findings when shadowed;
/// callers that emit JSON also serialize the always-present check result.
pub fn apply_path_collision_probe(report: &mut crate::diagnostics::DiagnosticReport) {
    let result = check_amore_path_collision();
    if let PathCollisionResult::Shadowed { ref path } = result {
        report.findings.push(crate::diagnostics::DiagnosticFinding {
            id: PATH_COLLISION_ID,
            disposition: crate::diagnostics::FindingDisposition::Recommendation,
            message: result.message(),
            remediation: Some(crate::diagnostics::ManualRemediation {
                fix: format!(
                    "Ensure the Amore Build install directory appears before \
                     \"{}\" on PATH (or rename/remove the other `amore`). \
                     On Windows: `where.exe amore`. Elsewhere: `which -a amore`.",
                    path.display()
                ),
                config_path: None,
            }),
            automatic_remediation: None,
            note: Some(
                "The crates.io Lua-linter package is also named amore; PATH order picks the winner."
                    .to_owned(),
            ),
        });
    }
}

fn resolve_amore_on_path() -> anyhow::Result<Vec<PathBuf>> {
    if cfg!(windows) {
        resolve_via_where()
    } else {
        resolve_via_which()
    }
}

fn resolve_via_where() -> anyhow::Result<Vec<PathBuf>> {
    // where.exe lists every match, one path per line. Exit 1 = not found.
    let output = Command::new("where.exe").arg("amore").output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.stdout.is_empty() {
            return Ok(Vec::new());
        }
        // Some where.exe builds still print paths with non-zero status; fall through.
        if stderr.to_ascii_lowercase().contains("could not find") {
            return Ok(Vec::new());
        }
    }
    Ok(parse_path_lines(&output.stdout))
}

fn resolve_via_which() -> anyhow::Result<Vec<PathBuf>> {
    // `which -a amore` lists every match; exit 1 = not found.
    let output = Command::new("which").args(["-a", "amore"]).output()?;
    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    Ok(parse_path_lines(&output.stdout))
}

fn parse_path_lines(stdout: &[u8]) -> Vec<PathBuf> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn canonicalize_soft(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn paths_same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    // Case-insensitive compare on Windows paths.
    if cfg!(windows) {
        let a_s = a.to_string_lossy().to_ascii_lowercase();
        let b_s = b.to_string_lossy().to_ascii_lowercase();
        if a_s == b_s {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_labels_are_stable() {
        assert_eq!(PathCollisionResult::NotOnPath.status_label(), "not_on_path");
        assert_eq!(
            PathCollisionResult::Ours {
                path: PathBuf::from("/x/amore")
            }
            .status_label(),
            "ours"
        );
        assert_eq!(
            PathCollisionResult::Shadowed {
                path: PathBuf::from("/other/amore")
            }
            .status_label(),
            "shadowed"
        );
        assert!(
            PathCollisionResult::Shadowed {
                path: PathBuf::from("/other/amore")
            }
            .is_shadowed()
        );
        assert!(!PathCollisionResult::NotOnPath.is_shadowed());
    }

    #[test]
    fn collision_id_is_path_amore_collision() {
        assert_eq!(PATH_COLLISION_ID.to_string(), "path.amore-collision");
    }

    #[test]
    fn check_runs_without_panic() {
        // Environment-dependent; just ensure the probe is callable.
        let _ = check_amore_path_collision();
    }

    #[test]
    fn parse_path_lines_trims_and_skips_blank() {
        // The probe reads `where amore` on Windows and `which -a amore` on
        // Unix, so both the line shape and what counts as a trailing component
        // are platform-specific. `Path::ends_with` compares whole components,
        // not string suffixes — a Windows path on Unix is a single component,
        // so a Windows fixture cannot assert a leaf there.
        #[cfg(windows)]
        let (stdout, leaf): (&[u8], &str) =
            (b"C:\\a\\amore.exe\r\n\r\nC:\\b\\amore.exe\n", "amore.exe");
        #[cfg(not(windows))]
        let (stdout, leaf): (&[u8], &str) =
            (b"/usr/local/bin/amore\n\n/usr/bin/amore\n", "amore");

        let paths = parse_path_lines(stdout);
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with(leaf));
    }
}
