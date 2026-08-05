//! Companion instrument presence for `amore doctor`.
//!
//! Probes iris (default-on), lucerna (opt-in), and speculum (opt-in) without
//! starting daemons or editing enablement. Binary resolution prefers the
//! directory beside the running `amore` executable (init's PATH-link layout),
//! then PATH. Version probes use a short wall timeout and never hang doctor.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{
    CompanionInstall, DiagnosticFinding, DiagnosticId, DiagnosticReport, FindingDisposition,
    InstrumentsFacts, IrisDaemonHome, LucernaEnablementFact, ManualRemediation,
};

/// Finding when the default-on iris companion is not installed.
pub const IRIS_MISSING_ID: DiagnosticId = DiagnosticId::new("instruments", "iris-missing");

/// Wall timeout for companion `--version` probes.
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

/// Probe companions on the live host and attach facts (+ optional findings).
///
/// Never starts processes beyond a short `--version` read. Never writes
/// enablement. Opt-in companions that are absent add facts only — no issues.
pub fn apply_instruments_probe(report: &mut DiagnosticReport) {
    let facts = probe_instruments();
    if matches!(facts.iris, CompanionInstall::NotInstalled) {
        report.findings.push(iris_missing_finding());
    }
    report.facts.instruments = facts;
}

fn iris_missing_finding() -> DiagnosticFinding {
    let bin = super::fix::invoked_bin();
    DiagnosticFinding {
        id: IRIS_MISSING_ID,
        disposition: FindingDisposition::Recommendation,
        message: "iris companion is not installed beside this binary or on PATH".to_owned(),
        remediation: Some(ManualRemediation {
            fix: format!(
                "{bin} init installs iris by default into a new house and links it beside {bin}"
            ),
            config_path: None,
        }),
        automatic_remediation: None,
        note: Some(
            "Iris is the default house companion. Absence is quiet at runtime; install via \
             init or place `iris` on PATH. Doctor never starts the iris daemon."
                .to_owned(),
        ),
    }
}

/// Live probe of all three companions.
pub fn probe_instruments() -> InstrumentsFacts {
    let iris = probe_companion("iris");
    let lucerna = probe_companion("lucerna");
    let speculum = probe_companion("speculum");
    let iris_daemon_home = probe_iris_daemon_home();
    let lucerna_enablement = if lucerna.is_installed() {
        probe_lucerna_enablement(std::env::current_dir().ok().as_deref())
    } else {
        LucernaEnablementFact::NotObserved
    };
    InstrumentsFacts {
        iris,
        iris_daemon_home,
        lucerna,
        lucerna_enablement,
        speculum,
    }
}

/// Resolve `name` beside the running binary, then on PATH; run `--version`.
pub fn probe_companion(name: &str) -> CompanionInstall {
    let Some(path) = resolve_companion_bin(name) else {
        return CompanionInstall::NotInstalled;
    };
    match run_version(&path) {
        Ok(version) => CompanionInstall::Installed {
            path,
            version: Some(version),
        },
        Err(error) => CompanionInstall::ProbeFailed { path, error },
    }
}

/// Prefer the directory of `current_exe` (init links companions there), else PATH.
pub fn resolve_companion_bin(name: &str) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    if let Ok(current) = std::env::current_exe()
        && let Some(dir) = current.parent()
    {
        let beside = dir.join(&exe_name);
        if beside.is_file() || beside.exists() {
            return Some(beside);
        }
    }
    which::which(name).ok().filter(|p| !p.as_os_str().is_empty())
}

fn probe_iris_daemon_home() -> IrisDaemonHome {
    #[allow(deprecated)]
    let Some(home) = std::env::home_dir() else {
        return IrisDaemonHome::HomeUnavailable;
    };
    let path = home.join(".iris");
    if path.is_dir() {
        IrisDaemonHome::Present { path }
    } else {
        IrisDaemonHome::Absent { path }
    }
}

/// Walk from `start` upward for `instruments/lucerna/lucerna.enable.json`.
pub fn probe_lucerna_enablement(start: Option<&Path>) -> LucernaEnablementFact {
    let Some(start) = start else {
        return LucernaEnablementFact::NotObserved;
    };
    let Some(path) = find_enablement_file(start) else {
        return LucernaEnablementFact::NotObserved;
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => match parse_enablement_json(&raw) {
            Ok((dreams_enabled, auto_commit_live)) => LucernaEnablementFact::Observed {
                path,
                dreams_enabled,
                auto_commit_live,
                error: None,
            },
            Err(error) => LucernaEnablementFact::Observed {
                path,
                dreams_enabled: false,
                auto_commit_live: false,
                error: Some(error),
            },
        },
        Err(err) => LucernaEnablementFact::Observed {
            path,
            dreams_enabled: false,
            auto_commit_live: false,
            error: Some(format!("read failed: {err}")),
        },
    }
}

fn find_enablement_file(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        let candidate = dir
            .join("instruments")
            .join("lucerna")
            .join("lucerna.enable.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Parse lucerna enablement JSON. Invalid JSON → error; missing keys → false.
pub fn parse_enablement_json(raw: &str) -> Result<(bool, bool), String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("malformed enablement JSON: {e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "malformed enablement JSON: expected object".to_owned())?;
    let dreams_enabled = obj.get("dreamsEnabled").and_then(|v| v.as_bool()) == Some(true);
    let auto_commit_live = obj.get("autoCommitLive").and_then(|v| v.as_bool()) == Some(true);
    Ok((dreams_enabled, auto_commit_live))
}

fn run_version(bin: &Path) -> Result<String, String> {
    use std::io::Read as _;

    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;

    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "timed out after {}s",
                        VERSION_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("wait: {e}")),
        }
    }

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut stdout_buf);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_end(&mut stderr_buf);
    }
    let stdout = String::from_utf8_lossy(&stdout_buf);
    let stderr = String::from_utf8_lossy(&stderr_buf);
    let text = if !stdout.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_owned();
    if line.is_empty() {
        return Err("empty --version output".to_owned());
    }
    Ok(truncate_version(&line))
}

fn truncate_version(line: &str) -> String {
    const MAX: usize = 120;
    if line.chars().count() <= MAX {
        return line.to_owned();
    }
    let mut out: String = line.chars().take(MAX).collect();
    out.push('…');
    out
}

/// Human-readable one-line install status for doctor rows.
pub fn format_install_line(install: &CompanionInstall) -> String {
    match install {
        CompanionInstall::Installed { path, version } => match version {
            Some(v) => format!("installed {v} ({})", path.display()),
            None => format!("installed ({})", path.display()),
        },
        CompanionInstall::NotInstalled => "not installed".to_owned(),
        CompanionInstall::ProbeFailed { path, error } => {
            format!(
                "present, version check failed ({error}) ({})",
                path.display()
            )
        }
    }
}

/// Human-readable lucerna enablement lines (dreams / auto-commit).
pub fn format_lucerna_enablement(fact: &LucernaEnablementFact) -> (String, String) {
    match fact {
        LucernaEnablementFact::NotObserved => (
            "not observed (no house enablement file from cwd)".to_owned(),
            "not observed".to_owned(),
        ),
        LucernaEnablementFact::Observed {
            dreams_enabled: _,
            auto_commit_live: _,
            error: Some(err),
            path,
        } => (
            format!("off (defaults; {err}) ({})", path.display()),
            format!("dry-run (defaults; {err})"),
        ),
        LucernaEnablementFact::Observed {
            dreams_enabled,
            auto_commit_live,
            path,
            error: None,
        } => {
            let dreams = if *dreams_enabled { "on" } else { "off" };
            let commit = if *auto_commit_live {
                "live"
            } else {
                "dry-run"
            };
            (
                format!("{dreams} ({})", path.display()),
                commit.to_owned(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn enablement_parse_defaults_missing_keys_to_false() {
        assert_eq!(parse_enablement_json("{}").unwrap(), (false, false));
        assert_eq!(
            parse_enablement_json(r#"{"dreamsEnabled":true}"#).unwrap(),
            (true, false)
        );
        assert_eq!(
            parse_enablement_json(r#"{"dreamsEnabled":true,"autoCommitLive":true}"#).unwrap(),
            (true, true)
        );
        // Non-boolean truthy values are not true (same as lucerna's strict check).
        assert_eq!(
            parse_enablement_json(r#"{"dreamsEnabled":"yes","autoCommitLive":1}"#).unwrap(),
            (false, false)
        );
        assert!(parse_enablement_json("not-json").is_err());
    }

    #[test]
    fn enablement_walk_finds_house_file() {
        let root = tempfile::tempdir().unwrap();
        let house = root.path().join("house");
        let nested = house.join("projects").join("x");
        std::fs::create_dir_all(&nested).unwrap();
        let runtime = house.join("instruments").join("lucerna");
        std::fs::create_dir_all(&runtime).unwrap();
        let enable = runtime.join("lucerna.enable.json");
        std::fs::write(
            &enable,
            r#"{"dreamsEnabled":true,"autoCommitLive":false}"#,
        )
        .unwrap();

        match probe_lucerna_enablement(Some(&nested)) {
            LucernaEnablementFact::Observed {
                dreams_enabled,
                auto_commit_live,
                error: None,
                path,
            } => {
                assert!(dreams_enabled);
                assert!(!auto_commit_live);
                assert_eq!(path, enable);
            }
            other => panic!("expected observed enablement, got {other:?}"),
        }
    }

    #[test]
    fn enablement_absent_is_not_observed() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            probe_lucerna_enablement(Some(root.path())),
            LucernaEnablementFact::NotObserved
        );
    }

    #[test]
    fn companion_not_installed_status_stable() {
        assert_eq!(
            CompanionInstall::NotInstalled.status_label(),
            "not_installed"
        );
        assert!(!CompanionInstall::NotInstalled.is_installed());
    }

    #[test]
    fn iris_missing_finding_is_recommendation_not_issue() {
        let finding = iris_missing_finding();
        assert_eq!(finding.id, IRIS_MISSING_ID);
        assert_eq!(finding.disposition, FindingDisposition::Recommendation);
        assert!(finding.automatic_remediation.is_none());
        assert!(finding.remediation.is_some());
        assert!(!finding.message.to_ascii_lowercase().contains("enable dream"));
    }

    #[test]
    fn apply_probe_never_issues_for_missing_opt_ins() {
        let mut report = DiagnosticReport {
            facts: super::super::DiagnosticFacts {
                terminal: crate::terminal::TerminalName::Unknown,
                xtversion: super::super::RuntimeFact::Unavailable,
                multiplexer: crate::terminal::MultiplexerKind::Undetected,
                byobu: None,
                ssh: false,
                tmux: super::super::TmuxFacts {
                    extended_keys: super::super::TmuxOptionFact::Unavailable,
                    set_clipboard: super::super::TmuxOptionFact::Unavailable,
                    allow_passthrough_support: super::super::TmuxSupportFact::Unavailable,
                    allow_passthrough: super::super::TmuxOptionFact::Unavailable,
                    color_passthrough: super::super::TmuxColorPassthrough::Unknown,
                },
                color: super::super::ColorFacts {
                    level: super::super::RuntimeFact::Unavailable,
                    available_themes: Vec::new(),
                    total_themes: 0,
                },
                keyboard: None,
                newline: None,
                clipboard: super::super::ClipboardFacts {
                    native_route: false,
                    native_tool: "none".into(),
                    native_preflight: crate::clipboard::NativeClipboardPreflight::Unavailable,
                    tmux_route: false,
                    osc52_route: false,
                    osc52_capability: crate::clipboard::Osc52Capability::Unknown,
                    wrap_sink: false,
                    display_server: crate::host::DisplayServer::Unknown,
                    container_no_display: false,
                    data_control: super::super::DataControlFact::NotApplicable,
                    delivery: crate::clipboard::ClipboardDelivery::Failed,
                    fix: None,
                },
                voice: None,
                instruments: InstrumentsFacts::default(),
            },
            findings: Vec::new(),
            probe_notes: Vec::new(),
        };
        apply_instruments_probe(&mut report);
        let opt_in_issues = report.findings.iter().filter(|f| {
            f.disposition == FindingDisposition::Issue
                && (f.id.item.contains("lucerna") || f.id.item.contains("speculum"))
        });
        assert_eq!(opt_in_issues.count(), 0);
    }

    #[test]
    fn version_timeout_constant_is_short() {
        assert!(VERSION_TIMEOUT <= Duration::from_secs(3));
    }

    #[test]
    fn format_install_not_installed() {
        assert_eq!(
            format_install_line(&CompanionInstall::NotInstalled),
            "not installed"
        );
    }

    #[test]
    fn write_temp_enablement_malformed_defaults_off() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("instruments").join("lucerna");
        std::fs::create_dir_all(&runtime).unwrap();
        let mut f = std::fs::File::create(runtime.join("lucerna.enable.json")).unwrap();
        write!(f, "{{not json").unwrap();
        match probe_lucerna_enablement(Some(dir.path())) {
            LucernaEnablementFact::Observed {
                dreams_enabled: false,
                auto_commit_live: false,
                error: Some(_),
                ..
            } => {}
            other => panic!("expected malformed observed defaults, got {other:?}"),
        }
    }
}
