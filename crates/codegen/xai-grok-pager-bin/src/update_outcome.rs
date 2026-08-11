//! Classify quit-for-update results into honest user-facing outcomes.
//!
//! Exit code 0 alone is never treated as a successful install: the caller must
//! supply what actually happened (direct `run_update` result, or child exit
//! plus a post-child disk version).

/// What the quit-for-update path concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOutcome {
    /// A new version is present on disk after the attempt.
    Installed { version: String },
    /// No install occurred (hard-off, already current, or no evidence of change).
    AlreadyLatest,
    /// The attempt failed; `reason` is shown to the user.
    Failed { reason: String },
}

impl UpdateOutcome {
    /// User-facing line for the three outcomes. `bin` is the resolved invocation name.
    pub fn user_message(&self, bin: &str) -> String {
        match self {
            Self::Installed { version } => {
                format!("Amore Build v{version} installed. Run '{bin}' to start.")
            }
            Self::AlreadyLatest => {
                format!("Already on the latest version. Run '{bin}' to start.")
            }
            Self::Failed { reason } => {
                format!("Update did not complete: {reason}. Run '{bin} update' to retry.")
            }
        }
    }
}

/// Classify a direct `run_update` result (`Result<Option<String>>`).
///
/// - `Ok(Some(v))` — target version present (install or already on disk)
/// - `Ok(None)` — real no-op (including fork hard-off)
/// - `Err(reason)` — failure
pub fn classify_run_update(result: Result<Option<String>, String>) -> UpdateOutcome {
    match result {
        Ok(Some(version)) => UpdateOutcome::Installed { version },
        Ok(None) => UpdateOutcome::AlreadyLatest,
        Err(reason) => UpdateOutcome::Failed { reason },
    }
}

/// Classify an adopted background-update child after it exits.
///
/// Installation is never inferred from exit status alone. A post-child disk
/// version that differs from the still-running process version is required.
///
/// - exit failure → [`UpdateOutcome::Failed`]
/// - exit success + disk version differs from running → [`UpdateOutcome::Installed`]
/// - exit success + unchanged / unknown disk version → [`UpdateOutcome::AlreadyLatest`]
pub fn classify_child(
    exit_success: bool,
    running_version: &str,
    disk_version_after: Option<&str>,
) -> UpdateOutcome {
    if !exit_success {
        return UpdateOutcome::Failed {
            reason: "background update exited unsuccessfully".to_string(),
        };
    }
    match disk_version_after {
        Some(disk) if disk != running_version => UpdateOutcome::Installed {
            version: disk.to_string(),
        },
        _ => UpdateOutcome::AlreadyLatest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "amore";

    #[test]
    fn run_update_ok_none_is_noop_never_installed() {
        let outcome = classify_run_update(Ok(None));
        assert_eq!(outcome, UpdateOutcome::AlreadyLatest);
        let msg = outcome.user_message(BIN);
        assert!(
            msg.contains("Already on the latest version"),
            "expected no-op copy, got: {msg}"
        );
        assert!(
            !msg.contains("installed"),
            "Ok(None) must never claim install, got: {msg}"
        );
    }

    #[test]
    fn run_update_ok_some_is_installed_copy() {
        let outcome = classify_run_update(Ok(Some("1.2.3".into())));
        assert_eq!(
            outcome,
            UpdateOutcome::Installed {
                version: "1.2.3".into()
            }
        );
        let msg = outcome.user_message(BIN);
        assert_eq!(msg, "Amore Build v1.2.3 installed. Run 'amore' to start.");
    }

    #[test]
    fn run_update_err_is_failure_copy_with_reason() {
        let outcome = classify_run_update(Err("network down".into()));
        assert_eq!(
            outcome,
            UpdateOutcome::Failed {
                reason: "network down".into()
            }
        );
        let msg = outcome.user_message(BIN);
        assert_eq!(
            msg,
            "Update did not complete: network down. Run 'amore update' to retry."
        );
    }

    #[test]
    fn child_exit_0_unchanged_disk_version_is_noop() {
        let outcome = classify_child(true, "1.0.0", Some("1.0.0"));
        assert_eq!(outcome, UpdateOutcome::AlreadyLatest);
        let msg = outcome.user_message(BIN);
        assert!(
            msg.contains("Already on the latest version"),
            "exit 0 + same disk must be no-op, got: {msg}"
        );
        assert!(!msg.contains("installed"), "must not claim install: {msg}");
    }

    #[test]
    fn child_exit_0_unknown_disk_version_is_noop() {
        // Windows / unmanaged installs: disk probe returns None. Exit 0 alone
        // must not claim a successful install.
        let outcome = classify_child(true, "1.0.0", None);
        assert_eq!(outcome, UpdateOutcome::AlreadyLatest);
        assert!(!outcome.user_message(BIN).contains("installed"));
    }

    #[test]
    fn child_exit_0_newer_disk_version_is_installed() {
        let outcome = classify_child(true, "1.0.0", Some("2.0.0"));
        assert_eq!(
            outcome,
            UpdateOutcome::Installed {
                version: "2.0.0".into()
            }
        );
        assert_eq!(
            outcome.user_message(BIN),
            "Amore Build v2.0.0 installed. Run 'amore' to start."
        );
    }

    #[test]
    fn child_exit_failure_is_failed() {
        let outcome = classify_child(false, "1.0.0", Some("2.0.0"));
        assert!(matches!(outcome, UpdateOutcome::Failed { .. }));
        let msg = outcome.user_message(BIN);
        assert!(msg.contains("Update did not complete:"), "{msg}");
        assert!(msg.contains("amore update"), "{msg}");
    }
}
