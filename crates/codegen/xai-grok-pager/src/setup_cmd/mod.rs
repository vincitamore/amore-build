//! First-run setup wizard + `selene setup` headless/explicit entry path (0.11).
//!
//! ## Auto-guided first launch
//! On interactive TUI launch with **no** resolvable credentials, Selene shows
//! a guided setup screen once (state under `~/.selene/setup-wizard-state.json`).
//!
//! ## Hard guards (never auto-fire)
//! - Headless (`-p` / `--single` / prompt-json/file) or non-TTY / piped I/O
//! - CI environments (`CI`, `GITHUB_ACTIONS`, …)
//! - `[agent] setup_on_first_run = false` in `config.toml`
//! - Wizard state already `done` or `skipped`
//!
//! ## Explicit path
//! `selene setup` always runs the flow (interactive when TTY, else headless
//! step listing). Team managed config remains available as
//! `selene setup --managed` (and legacy `selene setup --json`).

mod credentials;
mod flow;
mod guards;
mod state;
mod writer;

pub use credentials::{
    LEGACY_XAI_API_KEY_ENV, XAI_API_KEY_ENV, credentials_resolved, read_setup_on_first_run,
};
pub use flow::{FlowContext, SetupSummary, run_flow};
pub use guards::{
    CI_ENV_MARKERS, GuardInputs, detect_ci_env, is_interactive_tty, piped_never_predicate,
    should_auto_launch_wizard,
};
pub use state::{STATE_FILE_NAME, WizardState, WizardStatus};
pub use writer::{
    DIOPTRA_POINTER_NAME, ModelEntryPlan, dioptra_asset_shape, write_dioptra_pointer,
    write_model_entry,
};

use std::io::Write;
use std::path::PathBuf;

use anyhow::Result;

/// CLI arguments for `selene setup`.
#[derive(Clone, Debug, Eq, PartialEq, clap::Args)]
pub struct SetupArgs {
    /// Team managed configuration (enterprise path; previous bare `setup` behavior).
    #[arg(long)]
    pub managed: bool,
    /// With `--managed`: print managed configuration as JSON without installing.
    /// Bare `--json` (without other wizard flags) also selects the managed path
    /// for backward compatibility with `selene setup --json`.
    #[arg(long)]
    pub json: bool,
    /// Force headless step listing (no prompts), even on a TTY.
    #[arg(long)]
    pub headless: bool,
    /// Re-run even if wizard state is already done/skipped.
    #[arg(long)]
    pub force: bool,
    /// Clear wizard state so auto first-run can fire again, then exit.
    #[arg(long)]
    pub reset: bool,
    /// Print plan / run flow without writing config or state.
    #[arg(long)]
    pub dry_run: bool,
}

impl Default for SetupArgs {
    fn default() -> Self {
        Self {
            managed: false,
            json: false,
            headless: false,
            force: false,
            reset: false,
            dry_run: false,
        }
    }
}

impl SetupArgs {
    /// True when this invocation should use the legacy managed-config path.
    #[must_use]
    pub fn is_managed_path(&self) -> bool {
        // Bare `--json` preserves pre-wizard `setup --json` managed report.
        self.managed || (self.json && !self.headless && !self.force && !self.reset && !self.dry_run)
    }
}

/// Production home for the wizard (`$SELENE_HOME` / `$GROK_HOME` / `~/.selene`).
pub fn wizard_home() -> PathBuf {
    xai_grok_config::grok_home()
}

/// CLI entry for the **wizard** path (not managed config).
pub fn run(args: &SetupArgs) -> Result<()> {
    let home = wizard_home();
    run_with_home(args, &home, &mut std::io::stdout().lock())
}

/// Injectable entry (tests + production).
pub fn run_with_home(args: &SetupArgs, home: &std::path::Path, out: &mut impl Write) -> Result<()> {
    if args.reset {
        let cleared = WizardState::clear(home)?;
        if cleared {
            writeln!(out, "Cleared wizard state ({STATE_FILE_NAME}).")?;
        } else {
            writeln!(out, "No wizard state to clear.")?;
        }
        if !args.force && !args.headless && !args.dry_run {
            // Reset-only invocation.
            return Ok(());
        }
    }

    // Without `--force`, done/skipped state blocks a second interactive/headless
    // run (help text). Dry-run still inspects. `--force` bypasses for one run.
    if !args.force {
        if let Some(state) = WizardState::load(home)? {
            if state.suppresses_auto_fire() && !args.dry_run {
                let status = match state.status {
                    WizardStatus::Done => "done",
                    WizardStatus::Skipped => "skipped",
                    WizardStatus::InProgress => "in_progress",
                };
                writeln!(
                    out,
                    "Setup already {status} (see {}). Use --force to re-run, or --reset to clear.",
                    WizardState::path_in(home).display()
                )?;
                return Ok(());
            }
        }
    }

    let ctx = FlowContext {
        home: home.to_path_buf(),
        dry_run: args.dry_run,
        headless: args.headless
            || {
                use std::io::IsTerminal;
                !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal()
            },
        stdin_is_terminal: {
            use std::io::IsTerminal;
            std::io::stdin().is_terminal()
        },
        stdout_is_terminal: {
            use std::io::IsTerminal;
            std::io::stdout().is_terminal()
        },
    };

    // When headless, ignore stdin; interactive uses stdin lock.
    if ctx.headless {
        let mut empty = std::io::Cursor::new(Vec::<u8>::new());
        let _summary = run_flow(&ctx, &mut empty, out)?;
    } else {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        let _summary = run_flow(&ctx, &mut input, out)?;
    }
    Ok(())
}

/// Build guard inputs from the live process + home. Used by auto-launch and tests.
#[must_use]
pub fn live_guard_inputs(is_headless_prompt: bool, home: &std::path::Path) -> GuardInputs {
    let config_path = home.join("config.toml");
    let wizard_status = WizardState::load(home)
        .ok()
        .flatten()
        .map(|s| s.status);
    GuardInputs {
        interactive_tty: is_interactive_tty(),
        is_headless_prompt,
        ci_env: detect_ci_env(),
        setup_on_first_run: read_setup_on_first_run(&config_path),
        wizard_status,
        credentials_resolved: credentials_resolved(home),
    }
}

/// Auto-launch on first interactive session when guards pass.
///
/// Returns `true` if the wizard ran. Errors are non-fatal for the pager (logged
/// by the caller); this function surfaces them so the binary can warn.
pub fn maybe_auto_run_first_launch(is_headless_prompt: bool) -> Result<bool> {
    let home = wizard_home();
    let inputs = live_guard_inputs(is_headless_prompt, &home);
    if !should_auto_launch_wizard(&inputs) {
        tracing::debug!(
            interactive_tty = inputs.interactive_tty,
            is_headless_prompt = inputs.is_headless_prompt,
            ci_env = inputs.ci_env,
            credentials_resolved = inputs.credentials_resolved,
            "setup wizard: auto-launch skipped"
        );
        return Ok(false);
    }

    tracing::info!("setup wizard: auto-launching first-run guided setup");
    let args = SetupArgs {
        dry_run: false,
        headless: false,
        force: false,
        ..SetupArgs::default()
    };
    run_with_home(&args, &home, &mut std::io::stdout().lock())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::tempdir;

    #[test]
    fn managed_path_detection() {
        let mut a = SetupArgs::default();
        assert!(!a.is_managed_path());
        a.managed = true;
        assert!(a.is_managed_path());
        let mut b = SetupArgs::default();
        b.json = true;
        assert!(b.is_managed_path());
        let mut c = SetupArgs::default();
        c.json = true;
        c.headless = true;
        // --json --headless is wizard-ish (not bare legacy json).
        assert!(!c.is_managed_path());
    }

    #[test]
    fn reset_clears_state() {
        let dir = tempdir().unwrap();
        WizardState::new(WizardStatus::Done)
            .save(dir.path())
            .unwrap();
        let mut out = Vec::new();
        let args = SetupArgs {
            reset: true,
            ..SetupArgs::default()
        };
        run_with_home(&args, dir.path(), &mut out).unwrap();
        assert!(WizardState::load(dir.path()).unwrap().is_none());
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Cleared"));
    }

    #[test]
    fn live_guards_respect_disable_config() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.toml"),
            "[agent]\nsetup_on_first_run = false\n",
        )
        .unwrap();
        // credentials_resolved may be true if the process has XAI_API_KEY;
        // only assert the config field is read.
        let inputs = live_guard_inputs(false, dir.path());
        assert_eq!(inputs.setup_on_first_run, Some(false));
        assert!(!should_auto_launch_wizard(&inputs));
    }

    #[test]
    fn headless_flow_via_run_with_home() {
        let dir = tempdir().unwrap();
        let mut out = Vec::new();
        let args = SetupArgs {
            headless: true,
            dry_run: true,
            ..SetupArgs::default()
        };
        run_with_home(&args, dir.path(), &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("headless") || text.contains("OpenRouter"));
        // dry_run headless still may write state only when not dry_run;
        // dry_run → no state file.
        assert!(!WizardState::path_in(dir.path()).exists());
    }

    #[test]
    fn guard_matrix_documented_cases() {
        // Integration-style: pure matrix already in guards.rs; ensure exports work.
        assert!(!piped_never_predicate(false, false));
        let mut i = GuardInputs {
            interactive_tty: true,
            is_headless_prompt: false,
            ci_env: false,
            setup_on_first_run: None,
            wizard_status: None,
            credentials_resolved: false,
        };
        assert!(should_auto_launch_wizard(&i));
        i.ci_env = true;
        assert!(!should_auto_launch_wizard(&i));
        let _ = Cursor::new(""); // keep import warm if optimized
    }

    #[test]
    fn without_force_done_state_blocks_rerun() {
        let dir = tempdir().unwrap();
        WizardState::new(WizardStatus::Done)
            .save(dir.path())
            .unwrap();
        let mut out = Vec::new();
        let args = SetupArgs {
            headless: true,
            ..SetupArgs::default()
        };
        run_with_home(&args, dir.path(), &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains("already done") || text.contains("--force"),
            "expected blocked message, got:\n{text}"
        );
        // Must not have re-written flow output as if a full run happened.
        assert!(
            !text.contains("Step 1/3"),
            "blocked re-run must not execute flow:\n{text}"
        );
    }

    #[test]
    fn force_reruns_past_done_state() {
        let dir = tempdir().unwrap();
        WizardState::new(WizardStatus::Done)
            .save(dir.path())
            .unwrap();
        let mut out = Vec::new();
        let args = SetupArgs {
            force: true,
            headless: true,
            dry_run: true,
            ..SetupArgs::default()
        };
        run_with_home(&args, dir.path(), &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains("OpenRouter") || text.contains("headless"),
            " --force must re-run flow past done state:\n{text}"
        );
    }

    #[test]
    fn dry_run_still_allowed_when_done_without_force() {
        let dir = tempdir().unwrap();
        WizardState::new(WizardStatus::Skipped)
            .save(dir.path())
            .unwrap();
        let mut out = Vec::new();
        let args = SetupArgs {
            headless: true,
            dry_run: true,
            ..SetupArgs::default()
        };
        run_with_home(&args, dir.path(), &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains("OpenRouter") || text.contains("Step"),
            "dry-run inspects even when state suppresses auto-fire:\n{text}"
        );
    }
}
