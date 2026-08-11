//! CLI surface for `amore update --check` (and check-adjacent flags).
//!
//! The apply half of `amore update` lands in a later unit; this module owns
//! only the read-only check path, channel refusal, and JSON / human output.

use super::check::{CheckConfig, UpdateStatus, check_status, INSTALLER_ID};

/// Arguments for the check half of `amore update`.
#[derive(Debug, Clone)]
pub struct CheckCommand {
    pub json: bool,
    /// When true, still probe and report, but treat as a dry-run (no install).
    pub dry_run: bool,
    /// Channel switch from `--alpha` / `--stable` / `--enterprise`.
    pub channel_switch: Option<String>,
    /// CLI disable from `--no-auto-update` (rare on the update subcommand).
    pub cli_disable: bool,
}

/// Run `amore update --check` / `--dry-run` and print status.
///
/// Exit codes: 0 clean, 1 failure, 2 blocked (policy or unsupported channel).
pub fn run_check(cmd: &CheckCommand) -> i32 {
    // Unsupported channels fail loudly before any network call.
    if let Some(ref ch) = cmd.channel_switch {
        if let Some(msg) = channel_refusal_message(ch) {
            if cmd.json {
                let status = blocked_status(ch, &msg);
                print_status(&status, true);
            } else {
                eprintln!("{msg}");
            }
            return 2;
        }
    }

    let mut cfg = CheckConfig::from_disk(cmd.cli_disable, /* interactive */ false);
    if let Some(ref ch) = cmd.channel_switch {
        cfg.channel = Some(ch.clone());
    }
    let outcome = check_status(&cfg);
    print_status(outcome.status(), cmd.json);
    if cmd.dry_run && !cmd.json {
        if outcome.status().update_available {
            println!(
                "Dry-run: an update is available; run 'amore update' to install (apply path ships when ready)."
            );
        } else {
            println!("Dry-run: no install would be performed.");
        }
    }
    outcome.exit_code()
}

/// Refuse alpha / enterprise (and unknown) channels with the house messages.
pub fn channel_refusal_message(channel: &str) -> Option<String> {
    match channel {
        "stable" => None,
        "alpha" => Some(
            "No alpha channel is published for Amore Build. Only the stable channel exists."
                .to_string(),
        ),
        "enterprise" => Some(
            "No enterprise channel is published for Amore Build. Only the stable channel exists."
                .to_string(),
        ),
        other => Some(format!(
            "Unsupported release channel '{other}'. Only the stable channel exists."
        )),
    }
}

fn blocked_status(channel: &str, msg: &str) -> UpdateStatus {
    UpdateStatus {
        current_version: xai_grok_version::installed(),
        latest_version: None,
        update_available: false,
        installer: Some(INSTALLER_ID.to_string()),
        channel: channel.to_string(),
        auto_update: Some(xai_grok_config::effective_auto_update(None)),
        error: Some(msg.to_string()),
        update_check: xai_grok_config::effective_update_check(None),
        changelog_url: None,
    }
}

/// Print human or JSON status.
pub fn print_status(status: &UpdateStatus, json: bool) {
    if json {
        match serde_json::to_string(status) {
            Ok(payload) => println!("{payload}"),
            Err(e) => eprintln!("failed to serialize update status: {e}"),
        }
        return;
    }

    println!(
        "Amore Build - v{current}",
        current = status.current_version
    );
    if let Some(err) = status.error.as_deref() {
        println!("Update check: {err}");
        return;
    }
    match (status.update_available, status.latest_version.as_deref()) {
        (true, Some(latest)) => {
            println!(
                "A new version of Amore Build is available: {cur} -> {latest}. Run 'amore update' to install it.",
                cur = status.current_version,
            );
            if let Some(url) = status.changelog_url.as_deref() {
                println!("Changelog: {url}");
            }
        }
        (_, Some(latest)) => {
            println!("Up to date (latest seen: {latest}).");
        }
        _ => {
            println!("Up to date.");
        }
    }
    println!(
        "updateCheck={}  autoUpdate={}  installer={}",
        status.update_check,
        status.auto_update.unwrap_or(false),
        status.installer.as_deref().unwrap_or("none"),
    );
}
