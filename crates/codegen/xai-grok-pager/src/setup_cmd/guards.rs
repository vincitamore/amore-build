//! Pure predicates that decide whether the first-run wizard may auto-fire.
//!
//! Hard guards (operator-ratified, test-covered, non-negotiable):
//! - NEVER fires headless (`-p`, piped stdin/stdout, non-TTY).
//! - NEVER fires in CI (`CI`, `GITHUB_ACTIONS`, common CI markers).
//! - Respects `[agent] setup_on_first_run = false`.
//! - Respects wizard state (done/skipped) under `~/.amore`.

use super::state::WizardStatus;

/// Environment variable names that mark a CI / automation environment.
/// Presence of any of these (any value) is treated as CI.
pub const CI_ENV_MARKERS: &[&str] = &[
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "BUILDKITE",
    "CIRCLECI",
    "TRAVIS",
    "APPVEYOR",
    "TF_BUILD",
    "JENKINS_URL",
    "CONTINUOUS_INTEGRATION",
    "TEAMCITY_VERSION",
    "BITBUCKET_BUILD_NUMBER",
    "CODEBUILD_BUILD_ID",
];

/// Inputs for the auto-launch decision. All pure — no I/O inside the predicate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardInputs {
    /// Both stdin and stdout are interactive TTYs.
    pub interactive_tty: bool,
    /// Headless single-turn path (`-p` / `--single` / `--prompt-json` / `--prompt-file`).
    pub is_headless_prompt: bool,
    /// CI / automation env detected.
    pub ci_env: bool,
    /// Config escape hatch: `Some(false)` disables; `None` / `Some(true)` allow.
    pub setup_on_first_run: Option<bool>,
    /// Persisted wizard state status, if any.
    pub wizard_status: Option<WizardStatus>,
    /// True when auth.json session, `XAI_API_KEY`, or a resolvable config model key exists.
    pub credentials_resolved: bool,
}

/// True when any common CI marker is present in the process environment.
#[must_use]
pub fn detect_ci_env() -> bool {
    detect_ci_env_with(|k| std::env::var_os(k).is_some())
}

/// Injectable CI detection for tests.
#[must_use]
pub fn detect_ci_env_with(is_set: impl Fn(&str) -> bool) -> bool {
    CI_ENV_MARKERS.iter().any(|k| is_set(k))
}

/// True when both stdin and stdout are terminals (not piped / redirected).
#[must_use]
pub fn is_interactive_tty() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Pure auto-launch decision.
///
/// Returns `true` only when every hard guard passes and credentials are absent.
#[must_use]
pub fn should_auto_launch_wizard(i: &GuardInputs) -> bool {
    // Headless / non-TTY — never.
    if !i.interactive_tty {
        return false;
    }
    if i.is_headless_prompt {
        return false;
    }
    // CI — never.
    if i.ci_env {
        return false;
    }
    // Config escape hatch.
    if i.setup_on_first_run == Some(false) {
        return false;
    }
    // State file: done or skipped → no re-fire (unless reset externally).
    if matches!(
        i.wizard_status,
        Some(WizardStatus::Done) | Some(WizardStatus::Skipped)
    ) {
        return false;
    }
    // Already has usable credentials → no wizard.
    if i.credentials_resolved {
        return false;
    }
    true
}

/// "Piped-never" helper used by tests and smoke asserts: any non-TTY path
/// must refuse auto-launch regardless of other inputs.
#[must_use]
pub fn piped_never_predicate(stdin_tty: bool, stdout_tty: bool) -> bool {
    // Auto-launch is allowed only when BOTH are TTYs.
    stdin_tty && stdout_tty
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> GuardInputs {
        GuardInputs {
            interactive_tty: true,
            is_headless_prompt: false,
            ci_env: false,
            setup_on_first_run: None,
            wizard_status: None,
            credentials_resolved: false,
        }
    }

    #[test]
    fn auto_launches_when_clean_interactive_no_creds() {
        assert!(should_auto_launch_wizard(&base()));
    }

    #[test]
    fn headless_prompt_never_fires() {
        let mut i = base();
        i.is_headless_prompt = true;
        assert!(!should_auto_launch_wizard(&i));
    }

    #[test]
    fn non_tty_never_fires() {
        let mut i = base();
        i.interactive_tty = false;
        assert!(!should_auto_launch_wizard(&i));
    }

    #[test]
    fn piped_never_predicate_covers_partial_and_full_pipes() {
        assert!(!piped_never_predicate(false, true));
        assert!(!piped_never_predicate(true, false));
        assert!(!piped_never_predicate(false, false));
        assert!(piped_never_predicate(true, true));
    }

    #[test]
    fn ci_env_never_fires() {
        let mut i = base();
        i.ci_env = true;
        assert!(!should_auto_launch_wizard(&i));
    }

    #[test]
    fn detect_ci_env_with_known_markers() {
        assert!(detect_ci_env_with(|k| k == "CI"));
        assert!(detect_ci_env_with(|k| k == "GITHUB_ACTIONS"));
        assert!(detect_ci_env_with(|k| k == "GITLAB_CI"));
        assert!(!detect_ci_env_with(|_| false));
        assert!(!detect_ci_env_with(|k| k == "NOT_A_CI_VAR"));
    }

    #[test]
    fn disable_config_never_fires() {
        let mut i = base();
        i.setup_on_first_run = Some(false);
        assert!(!should_auto_launch_wizard(&i));
        i.setup_on_first_run = Some(true);
        assert!(should_auto_launch_wizard(&i));
    }

    #[test]
    fn state_done_or_skipped_never_fires() {
        let mut i = base();
        i.wizard_status = Some(WizardStatus::Done);
        assert!(!should_auto_launch_wizard(&i));
        i.wizard_status = Some(WizardStatus::Skipped);
        assert!(!should_auto_launch_wizard(&i));
        i.wizard_status = Some(WizardStatus::InProgress);
        assert!(should_auto_launch_wizard(&i));
    }

    #[test]
    fn credentials_resolved_never_fires() {
        let mut i = base();
        i.credentials_resolved = true;
        assert!(!should_auto_launch_wizard(&i));
    }
}
