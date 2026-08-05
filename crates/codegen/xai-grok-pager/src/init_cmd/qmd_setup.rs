//! Run `iris qmd setup` after iris is installed so a fresh house has semantic
//! search ready without a second command.
//!
//! Setup is default-on whenever iris was installed in the same init run.
//! `--no-qmd` skips it; `--no-iris` implies skip (no binary to invoke). Failures
//! never fail the house: the tree is already complete, and the summary names
//! the one command that finishes later (`iris qmd setup`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::iris_fetch::IrisOutcome;

/// Relative install directory for the iris multi-tool inside a house.
const IRIS_INSTALL_REL: &str = "instruments/iris";

/// What happened when init attempted (or skipped) semantic search setup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QmdSetupOutcome {
    /// `iris qmd setup` exited zero.
    Configured,
    /// Dry-run: would have run setup after a successful iris install.
    WouldConfigure,
    /// User passed `--no-qmd`.
    OptedOut,
    /// Iris was not installed in this run (`--no-iris` or fetch failure).
    SkippedNoIris,
    /// Iris binary could not be resolved next to the install / PATH link.
    SkippedNoBinary { reason: String },
    /// Setup ran and failed (missing JS runtime, offline, nonzero exit, …).
    Failed { reason: String },
}

impl QmdSetupOutcome {
    /// One line for the init summary. Silent only when there is nothing to say.
    pub fn summary_line(&self) -> Option<String> {
        match self {
            Self::Configured => Some(
                "  qmd:          semantic search set up (runtime, house index, models)"
                    .to_owned(),
            ),
            Self::WouldConfigure => Some(
                "  qmd:          would run `iris qmd setup` after iris install".to_owned(),
            ),
            Self::OptedOut => Some(
                "  qmd:          skipped (--no-qmd); finish later with `iris qmd setup`".to_owned(),
            ),
            Self::SkippedNoIris => Some(
                "  qmd:          skipped (no iris); install iris, then run `iris qmd setup`"
                    .to_owned(),
            ),
            Self::SkippedNoBinary { reason } => Some(format!(
                "  qmd:          not set up ({reason}); the house is complete without it. \
                 Finish later with `iris qmd setup`"
            )),
            Self::Failed { reason } => Some(format!(
                "  qmd:          not set up ({reason}); the house is complete without it. \
                 Finish later with `iris qmd setup`"
            )),
        }
    }
}

/// Run house semantic search setup, or record why it was skipped.
///
/// `iris` is the outcome of the iris fetch that just ran. Progress from the
/// setup child is streamed to `writer` (and the child inherits stderr) so model
/// download sizes and hosts are visible. Never returns `Err`.
pub fn run(
    root: &Path,
    iris: &IrisOutcome,
    no_qmd: bool,
    dry_run: bool,
    writer: &mut dyn Write,
) -> QmdSetupOutcome {
    if no_qmd {
        return QmdSetupOutcome::OptedOut;
    }
    match iris {
        IrisOutcome::OptedOut => QmdSetupOutcome::SkippedNoIris,
        IrisOutcome::Failed { .. } | IrisOutcome::UnsupportedHost { .. } => {
            QmdSetupOutcome::SkippedNoIris
        }
        IrisOutcome::Installed { linked, .. } => {
            if dry_run {
                return QmdSetupOutcome::WouldConfigure;
            }
            let Some(bin) = resolve_iris_bin(root, linked.as_deref()) else {
                return QmdSetupOutcome::SkippedNoBinary {
                    reason: "iris binary not found next to the install or PATH link".to_owned(),
                };
            };
            run_setup(&bin, root, writer)
        }
    }
}

/// Prefer the directory init just linked beside `amore`, then the house install
/// tree. Never falls back to bare PATH trust in the same init run.
pub fn resolve_iris_bin(root: &Path, linked_dir: Option<&str>) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "iris.exe"
    } else {
        "iris"
    };
    if let Some(dir) = linked_dir {
        let candidate = PathBuf::from(dir).join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let house = root.join(IRIS_INSTALL_REL).join(exe_name);
    if house.is_file() {
        return Some(house);
    }
    None
}

fn run_setup(bin: &Path, root: &Path, writer: &mut dyn Write) -> QmdSetupOutcome {
    let _ = writeln!(
        writer,
        "  qmd:          running `iris qmd setup --json` (models download may take a while)…"
    );
    let _ = writer.flush();

    // Inherit stdout/stderr so package and model download progress (hosts and
    // sizes) is not swallowed. Summary writer already received the notice line.
    let status = match Command::new(bin)
        .args(["qmd", "setup", "--json"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
    {
        Ok(s) => s,
        Err(err) => {
            return QmdSetupOutcome::Failed {
                reason: format!("could not spawn iris: {err}"),
            };
        }
    };

    if status.success() {
        QmdSetupOutcome::Configured
    } else {
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_owned());
        QmdSetupOutcome::Failed {
            reason: format!(
                "iris qmd setup exited {code} (needs Node >= 22 or Bun on PATH, and network for first install)"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_qmd_is_explicit_opt_out() {
        let root = tempfile::tempdir().unwrap();
        let iris = IrisOutcome::Installed {
            rel_path: "instruments/iris/".into(),
            version: "0.0.0".into(),
            linked: None,
        };
        let mut buf = Vec::new();
        let out = run(root.path(), &iris, true, false, &mut buf);
        assert_eq!(out, QmdSetupOutcome::OptedOut);
        let line = out.summary_line().unwrap();
        assert!(line.contains("--no-qmd"));
        assert!(line.contains("iris qmd setup"));
    }

    #[test]
    fn no_iris_implies_skip() {
        let root = tempfile::tempdir().unwrap();
        let mut buf = Vec::new();
        let out = run(
            root.path(),
            &IrisOutcome::OptedOut,
            false,
            false,
            &mut buf,
        );
        assert_eq!(out, QmdSetupOutcome::SkippedNoIris);
        assert!(out.summary_line().unwrap().contains("no iris"));
    }

    #[test]
    fn failed_iris_fetch_skips_setup() {
        let root = tempfile::tempdir().unwrap();
        let mut buf = Vec::new();
        let out = run(
            root.path(),
            &IrisOutcome::Failed {
                reason: "HTTP 404".into(),
            },
            false,
            false,
            &mut buf,
        );
        assert_eq!(out, QmdSetupOutcome::SkippedNoIris);
    }

    #[test]
    fn dry_run_would_configure_when_iris_installed() {
        let root = tempfile::tempdir().unwrap();
        let iris = IrisOutcome::Installed {
            rel_path: "instruments/iris/".into(),
            version: "0.0.0".into(),
            linked: None,
        };
        let mut buf = Vec::new();
        let out = run(root.path(), &iris, false, true, &mut buf);
        assert_eq!(out, QmdSetupOutcome::WouldConfigure);
    }

    #[test]
    fn missing_binary_is_honest_not_fatal() {
        let root = tempfile::tempdir().unwrap();
        let iris = IrisOutcome::Installed {
            rel_path: "instruments/iris/".into(),
            version: "0.0.0".into(),
            linked: None,
        };
        let mut buf = Vec::new();
        let out = run(root.path(), &iris, false, false, &mut buf);
        match &out {
            QmdSetupOutcome::SkippedNoBinary { reason } => {
                assert!(reason.contains("not found"));
            }
            other => panic!("expected SkippedNoBinary, got {other:?}"),
        }
        let line = out.summary_line().unwrap();
        assert!(line.contains("iris qmd setup"));
        assert!(line.contains("complete without it"));
    }

    #[test]
    fn resolve_prefers_linked_dir_over_house() {
        let root = tempfile::tempdir().unwrap();
        let link_dir = root.path().join("bin");
        let house_dir = root.path().join(IRIS_INSTALL_REL);
        std::fs::create_dir_all(&link_dir).unwrap();
        std::fs::create_dir_all(&house_dir).unwrap();
        let exe_name = if cfg!(windows) {
            "iris.exe"
        } else {
            "iris"
        };
        // House copy exists but linked should win.
        std::fs::write(house_dir.join(exe_name), b"house").unwrap();
        std::fs::write(link_dir.join(exe_name), b"linked").unwrap();
        let resolved =
            resolve_iris_bin(root.path(), Some(link_dir.to_str().unwrap())).unwrap();
        assert_eq!(resolved, link_dir.join(exe_name));
    }

    #[test]
    fn resolve_falls_back_to_house_install() {
        let root = tempfile::tempdir().unwrap();
        let house_dir = root.path().join(IRIS_INSTALL_REL);
        std::fs::create_dir_all(&house_dir).unwrap();
        let exe_name = if cfg!(windows) {
            "iris.exe"
        } else {
            "iris"
        };
        std::fs::write(house_dir.join(exe_name), b"house").unwrap();
        let resolved = resolve_iris_bin(root.path(), None).unwrap();
        assert_eq!(resolved, house_dir.join(exe_name));
    }

    #[test]
    fn failure_summary_names_finish_command() {
        let out = QmdSetupOutcome::Failed {
            reason: "offline".into(),
        };
        let line = out.summary_line().unwrap();
        assert!(line.contains("offline"));
        assert!(line.contains("`iris qmd setup`"));
    }
}
