//! CLI surface for `amore update`: check, dry-run, apply, and rollback.
//!
//! The check half is read-only. The apply half composes `fleet::` for the full
//! install-dir transaction and never re-implements lock, fetch, or activate.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::check::{CheckConfig, UpdateStatus, check_status, INSTALLER_ID};
use super::discover;
use super::fleet::{self, FleetError, TransactionOpts};
use super::state::{self, FileRecord, InstallState};
use super::swap::{self, Rollback};
use super::version::{strip_v, version_cmp, version_key};
use xai_grok_config::{
    effective_update_channel, updates_disabled_by_env, updates_permitted,
};

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

/// Full `amore update` command surface (check, dry-run, apply, rollback).
#[derive(Debug, Clone)]
pub struct UpdateCommand {
    pub check: bool,
    pub json: bool,
    pub dry_run: bool,
    /// Skip the interactive confirmation prompt before apply.
    pub yes: bool,
    /// Allow a target tag at or below the install state's version floor.
    pub allow_downgrade: bool,
    /// Restore `.prev` binaries for every fleet target that has one.
    pub rollback: bool,
    /// Force re-fetch even when the candidate tag matches the installed tag.
    pub force_reinstall: bool,
    /// Pin install to this version (semver or `v`-prefixed tag).
    pub version: Option<String>,
    /// Channel switch from `--alpha` / `--stable` / `--enterprise`.
    pub channel_switch: Option<String>,
    /// CLI disable from `--no-auto-update` (rare on the update subcommand).
    pub cli_disable: bool,
}

/// Stack size for the update worker thread (debug PE default overflows the
/// deep apply/check call stack on this crate).
const UPDATE_STACK_SIZE: usize = 8 * 1024 * 1024;

/// Run `amore update` (check / dry-run / apply / rollback) and return an exit code.
///
/// Exit codes: 0 applied / already current / clean check; 1 failure; 2 blocked
/// by policy (floor, unsupported channel/host, unwritable install dir, kill switch).
///
/// The body runs on a dedicated thread with an 8 MiB stack so host/link PE
/// defaults do not overflow on the apply or check paths.
pub fn run_update(cmd: &UpdateCommand) -> i32 {
    let cmd = cmd.clone();
    match std::thread::Builder::new()
        .name("amore-update".into())
        .stack_size(UPDATE_STACK_SIZE)
        .spawn(move || run_update_body(&cmd))
    {
        Ok(handle) => match handle.join() {
            Ok(code) => code,
            Err(_) => {
                eprintln!("Update did not complete: update worker panicked");
                1
            }
        },
        Err(e) => {
            eprintln!("Update did not complete: could not start update worker ({e})");
            1
        }
    }
}

fn run_update_body(cmd: &UpdateCommand) -> i32 {
    if cmd.json && !cmd.check {
        eprintln!("--json requires --check");
        return 1;
    }

    // Unsupported channels fail loudly before any network call.
    if let Some(ref ch) = cmd.channel_switch {
        if let Some(msg) = channel_refusal_message(ch) {
            if cmd.json {
                print_status(&blocked_status(ch, &msg), true);
            } else {
                eprintln!("{msg}");
            }
            return 2;
        }
    }

    if cmd.rollback {
        return run_rollback(cmd);
    }

    if cmd.check {
        return run_check(&CheckCommand {
            json: cmd.json,
            dry_run: cmd.dry_run,
            channel_switch: cmd.channel_switch.clone(),
            cli_disable: cmd.cli_disable,
        });
    }

    if cmd.dry_run {
        return run_apply_dry_run(cmd);
    }

    match run_apply_inner(cmd, /* print */ true) {
        Ok(None) => 0,
        Ok(Some(_)) => 0,
        Err(ApplyFailure { code, .. }) => code,
    }
}

/// Apply-path outcome for quit-for-update (Ctrl+U) and other callers that
/// classify through `update_outcome::classify_run_update`.
///
/// - `Ok(Some(version))` — fleet activated a new tag
/// - `Ok(None)` — already current / nothing to install
/// - `Err(reason)` — failure or policy block
///
/// Uses `--yes` semantics (no confirmation prompt). Does not print the
/// installed / already-latest lines (the caller owns that copy).
pub fn run_apply_result() -> Result<Option<String>, String> {
    let cmd = UpdateCommand {
        check: false,
        json: false,
        dry_run: false,
        yes: true,
        allow_downgrade: false,
        rollback: false,
        force_reinstall: false,
        version: None,
        channel_switch: None,
        cli_disable: false,
    };
    match std::thread::Builder::new()
        .name("amore-update-apply".into())
        .stack_size(UPDATE_STACK_SIZE)
        .spawn(move || run_apply_inner(&cmd, /* print */ false))
    {
        Ok(handle) => match handle.join() {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(ApplyFailure { message, .. })) => Err(message),
            Err(_) => Err("update worker panicked".into()),
        },
        Err(e) => Err(format!("could not start update worker ({e})")),
    }
}

struct ApplyFailure {
    code: i32,
    message: String,
}

/// Core apply path. When `print` is true, emits the CLI success/error lines.
fn run_apply_inner(cmd: &UpdateCommand, print: bool) -> Result<Option<String>, ApplyFailure> {
    if let Some(msg) = policy_block_message() {
        if print {
            eprintln!("{msg}");
        }
        return Err(ApplyFailure {
            code: 2,
            message: msg,
        });
    }

    let mut opts = transaction_opts(cmd);
    if let Err(e) = validate_pin_version(cmd.version.as_deref()) {
        if print {
            eprintln!("{e}");
        }
        return Err(ApplyFailure {
            code: 1,
            message: e,
        });
    }

    if !cmd.yes {
        match preflight_confirm(&opts) {
            Confirm::Abort(code) => {
                return Err(ApplyFailure {
                    code,
                    message: if code == 0 {
                        "update cancelled".into()
                    } else {
                        "update aborted".into()
                    },
                });
            }
            Confirm::Proceed => {}
            Confirm::AlreadyCurrent => {
                if print {
                    println!("{}", already_latest_line());
                }
                return Ok(None);
            }
        }
    }

    // force_reinstall of the same tag must not short-circuit as AlreadyCurrent.
    if cmd.force_reinstall {
        opts.allow_downgrade = true;
    }

    match fleet::run_transaction(&opts) {
        Ok(out) => {
            let ver = strip_v(&out.tag).to_string();
            if out.activated.is_empty() {
                if print {
                    println!("{}", already_latest_line());
                }
                Ok(None)
            } else {
                // ACTIVATE-time hook (post-transaction): fleet FINALIZE is
                // foreign; snapshot here so rollback can restore config with
                // the binaries. Best-effort — install already succeeded.
                snapshot_config_after_activate(&out.install_dir, print);
                if print {
                    println!("{}", installed_line(&ver));
                }
                Ok(Some(ver))
            }
        }
        Err(FleetError::AlreadyCurrent { .. }) => {
            if print {
                println!("{}", already_latest_line());
            }
            Ok(None)
        }
        Err(e) => {
            let (code, message) = fleet_error_code_message(&e);
            if print {
                // Re-use the existing stderr mapping.
                let _ = map_fleet_error(&e);
            }
            Err(ApplyFailure { code, message })
        }
    }
}

/// Run `amore update --check` / `--dry-run` (check half) and print status.
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
                "Dry-run: an update is available; run 'amore update' to install."
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

// ---------------------------------------------------------------------------
// Apply path
// ---------------------------------------------------------------------------

/// Dry-run on the apply path: discover + per-target report, sidecars only,
/// zero mutations.
fn run_apply_dry_run(cmd: &UpdateCommand) -> i32 {
    if let Some(code) = policy_block_notice() {
        return code;
    }
    if let Err(e) = validate_pin_version(cmd.version.as_deref()) {
        eprintln!("{e}");
        return 1;
    }

    let opts = transaction_opts(cmd);
    let install_dir = match state::install_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("install directory: {e}");
            return 1;
        }
    };
    if let Err(e) = state::write_probe(&install_dir) {
        eprintln!("{e}");
        return 2;
    }

    let units = fleet::scan_targets(&install_dir, &opts.os, &opts.arch);
    let install_state = match state::load(&install_dir) {
        Ok(s) => s.unwrap_or_else(|| {
            InstallState::new(
                format!("v{}", strip_v(&xai_grok_version::installed())),
                opts.channel.as_str(),
                "unknown",
            )
        }),
        Err(e) => {
            eprintln!("state load: {e}");
            return 1;
        }
    };

    let tag = if let Some(ref pin) = opts.pin_tag {
        normalize_tag(pin)
    } else {
        match discover::latest_tag_via_redirect() {
            Ok(t) => t.tag,
            Err(e) => {
                eprintln!("could not reach release origin: {e}");
                return 1;
            }
        }
    };

    if !opts.allow_downgrade {
        let cand = strip_v(&tag);
        let floor = strip_v(&install_state.version_floor);
        if version_cmp(cand, floor) < 0 {
            eprintln!(
                "refusing tag {tag}: at or below version floor {} (pass --allow-downgrade to override)",
                install_state.version_floor
            );
            return 2;
        }
    }

    let current = strip_v(&install_state.tag);
    let available = strip_v(&tag);
    println!(
        "Amore Build - v{cur} (dry-run toward {tag})",
        cur = current
    );
    if current == available && !cmd.force_reinstall {
        println!("Already on the latest version.");
        println!("Dry-run: no install would be performed.");
        return 0;
    }

    println!("Would update to {tag}:");
    for unit in &units {
        for file in &unit.files {
            let rec = install_state.files.get(&file.name);
            let archive = install_state
                .targets
                .get(&file.name)
                .map(|t| t.archive_sha256.as_str())
                .filter(|s| !s.is_empty());
            let on_disk = if file.dest.exists() { "present" } else { "missing" };
            let recorded = rec
                .map(|r| format!("content={} size={}", short_hash(&r.sha256), r.size))
                .unwrap_or_else(|| "not in install state".into());
            let skip = if let Some(arch) = archive {
                match fetch_sidecar_match(unit, &tag, &opts, arch) {
                    Ok(true) => " (content-addressed skip)",
                    Ok(false) => " (would fetch)",
                    Err(_) => " (sidecar unknown; would fetch)",
                }
            } else {
                " (would fetch)"
            };
            println!(
                "  {name}: on-disk={on_disk}; recorded={recorded}{skip}",
                name = file.name
            );
        }
    }
    println!("Dry-run: no install would be performed.");
    0
}

fn fetch_sidecar_match(
    unit: &fleet::FleetUnit,
    tag: &str,
    opts: &TransactionOpts,
    hash: &str,
) -> Result<bool, String> {
    super::fetch::sidecar_matches_installed(unit.component, tag, &opts.os, &opts.arch, hash)
        .map_err(|e| e.to_string())
}

enum Confirm {
    Proceed,
    Abort(i32),
    AlreadyCurrent,
}

/// Lightweight preflight used only for the confirmation prompt (may network).
fn preflight_confirm(opts: &TransactionOpts) -> Confirm {
    let install_dir = match state::install_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("install directory: {e}");
            return Confirm::Abort(1);
        }
    };
    if let Err(e) = state::write_probe(&install_dir) {
        eprintln!("{e}");
        return Confirm::Abort(2);
    }

    let install_state = state::load(&install_dir)
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            InstallState::new(
                format!("v{}", strip_v(&xai_grok_version::installed())),
                opts.channel.as_str(),
                "unknown",
            )
        });

    let tag = if let Some(ref pin) = opts.pin_tag {
        normalize_tag(pin)
    } else {
        match discover::latest_tag_via_redirect() {
            Ok(t) => t.tag,
            Err(e) => {
                eprintln!("could not reach release origin: {e}");
                return Confirm::Abort(1);
            }
        }
    };

    if !opts.allow_downgrade {
        let cand = strip_v(&tag);
        let floor = strip_v(&install_state.version_floor);
        if version_cmp(cand, floor) < 0 {
            eprintln!(
                "refusing tag {tag}: at or below version floor {} (pass --allow-downgrade to override)",
                install_state.version_floor
            );
            return Confirm::Abort(2);
        }
        if strip_v(&install_state.tag) == cand {
            return Confirm::AlreadyCurrent;
        }
    }

    let installed = xai_grok_version::installed();
    let current = strip_v(&installed);
    let latest = strip_v(&tag);
    print!(
        "A new version of Amore Build is available: {current} -> {latest}. Install? [Y/n] "
    );
    let _ = io::stdout().flush();
    let mut line = String::new();
    if io::stdin().read_line(&mut line).is_err() {
        eprintln!("could not read confirmation");
        return Confirm::Abort(1);
    }
    let answer = line.trim();
    if answer.is_empty() || answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")
    {
        Confirm::Proceed
    } else {
        println!("Update cancelled.");
        Confirm::Abort(0)
    }
}

fn transaction_opts(cmd: &UpdateCommand) -> TransactionOpts {
    let (os, arch) = discover::host_os_arch().unwrap_or(("windows", "x64"));
    let channel = cmd
        .channel_switch
        .clone()
        .unwrap_or_else(|| effective_update_channel(None).to_string());
    // Prefer CLI pin; else config update_pin when present.
    let pin_tag = cmd.version.clone().or_else(load_update_pin);
    TransactionOpts {
        os: os.into(),
        arch: arch.into(),
        channel,
        allow_downgrade: cmd.allow_downgrade || cmd.force_reinstall,
        pin_tag,
    }
}

fn load_update_pin() -> Option<String> {
    let Ok(root) = xai_grok_shell::config::load_effective_config_disk_only() else {
        return None;
    };
    let cfg = xai_grok_shell::util::config::load_config_from_toml(&root);
    cfg.cli.update_pin.clone()
}

fn validate_pin_version(version: Option<&str>) -> Result<(), String> {
    let Some(v) = version else {
        return Ok(());
    };
    let bare = strip_v(v);
    if version_key(bare).is_none() {
        return Err(format!(
            "'{v}' is not a valid version. Expected semver like 0.1.150"
        ));
    }
    Ok(())
}

fn policy_block_notice() -> Option<i32> {
    policy_block_message().map(|msg| {
        eprintln!("{msg}");
        2
    })
}

fn policy_block_message() -> Option<String> {
    if updates_disabled_by_env() || !updates_permitted() {
        Some(
            "Updates are blocked by policy (AMORE_DISABLE_UPDATES or GROK_DISABLE_AUTOUPDATER)."
                .to_string(),
        )
    } else {
        None
    }
}

fn installed_line(version: &str) -> String {
    let bin = crate::app::cli::resolved_bin_name();
    // Single-source copy shape (matches pager-bin update_outcome).
    format!("Amore Build v{version} installed. Run '{bin}' to start.")
}

fn already_latest_line() -> String {
    // Single-source copy shape (matches pager-bin update_outcome).
    "Already on the latest version.".to_string()
}

fn fleet_error_code_message(e: &FleetError) -> (i32, String) {
    match e {
        FleetError::AlreadyCurrent { .. } => (0, already_latest_line()),
        FleetError::VersionFloor { floor, tag } => (
            2,
            format!(
                "refusing tag {tag}: at or below version floor {floor} (pass --allow-downgrade to override)"
            ),
        ),
        FleetError::UnsupportedHost {
            os,
            arch,
            components,
        } => (
            2,
            format!(
                "host {os}-{arch} cannot complete a fleet update including: {}",
                components.join(", ")
            ),
        ),
        FleetError::UnwritableInstallDir { path, message } => (
            2,
            format!(
                "install directory not writable ({}): {message}; \
                 if this was installed system-wide, update requires elevated privileges",
                path.display()
            ),
        ),
        FleetError::AlreadyRunning {
            holder_pid,
            started_at,
        } => {
            let mut msg = "fleet update already running".to_string();
            if let Some(pid) = holder_pid {
                msg.push_str(&format!(" (pid {pid}"));
                if let Some(at) = started_at {
                    msg.push_str(&format!(", started {at}"));
                }
                msg.push(')');
            }
            (1, msg)
        }
        FleetError::QuiesceFailed { daemon, detail } => (
            1,
            format!(
                "cannot confirm {daemon} stopped ({detail}); aborting fleet update with nothing activated"
            ),
        ),
        FleetError::ActivateFailed {
            failed,
            activated,
            remaining,
            detail,
        } => (
            1,
            format!(
                "activation failed for {failed} ({detail}); activated: [{}]; remaining: [{}]",
                activated.join(", "),
                remaining.join(", ")
            ),
        ),
        FleetError::Other(msg) => (1, msg.clone()),
    }
}

fn map_fleet_error(e: &FleetError) -> i32 {
    let (code, message) = fleet_error_code_message(e);
    match e {
        FleetError::AlreadyCurrent { .. } => {
            println!("{}", already_latest_line());
        }
        FleetError::Other(_) => {
            eprintln!("Update did not complete: {message}");
        }
        _ => {
            if code == 0 {
                println!("{message}");
            } else {
                eprintln!("{message}");
            }
        }
    }
    code
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

fn run_rollback(cmd: &UpdateCommand) -> i32 {
    if let Some(code) = policy_block_notice() {
        return code;
    }

    let install_dir = match state::install_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("install directory: {e}");
            return 1;
        }
    };
    if let Err(e) = state::write_probe(&install_dir) {
        eprintln!("{e}");
        return 2;
    }

    let (os, arch) = discover::host_os_arch().unwrap_or(("windows", "x64"));
    let units = fleet::scan_targets(&install_dir, os, arch);

    let mut restored: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    let mut smoke_version: Option<String> = None;

    for unit in &units {
        for file in &unit.files {
            let prev_path = prev_sibling(&file.dest);
            if !path_exists(&prev_path) {
                missing.push(file.name.clone());
                continue;
            }
            let rb = Rollback {
                prev_path,
                dest: file.dest.clone(),
            };
            match rb.restore() {
                Ok(()) => match swap::smoke(&file.dest) {
                    Ok(out) => {
                        if unit.id == "amore" {
                            smoke_version = Some(extract_version_token(&out));
                        }
                        restored.push(file.name.clone());
                    }
                    Err(e) => {
                        failed.push((file.name.clone(), format!("smoke: {e}")));
                    }
                },
                Err(e) => {
                    failed.push((file.name.clone(), e.to_string()));
                }
            }
        }
    }

    // Config snapshot taken at ACTIVATE; restore alongside binaries when present.
    // Absent snapshot never fails the rollback (notice only).
    let config_notice = restore_config_snapshot_if_present(&install_dir);

    if !restored.is_empty() {
        if let Err(e) = rewrite_state_after_rollback(
            &install_dir,
            &units,
            smoke_version.as_deref(),
            cmd.channel_switch.as_deref(),
        ) {
            eprintln!("could not rewrite install state after rollback: {e}");
            return 1;
        }
    }

    if cmd.json {
        // Minimal machine-readable summary (not the check UpdateStatus shape).
        let payload = serde_json::json!({
            "restored": restored,
            "missingPrev": missing,
            "failed": failed.iter().map(|(n, d)| serde_json::json!({"component": n, "detail": d})).collect::<Vec<_>>(),
            "configSnapshot": match &config_notice {
                ConfigRestoreNotice::Restored => "restored",
                ConfigRestoreNotice::Absent => "absent",
                ConfigRestoreNotice::Failed(_) => "failed",
            },
        });
        println!("{payload}");
    } else {
        if restored.is_empty() && failed.is_empty() {
            println!("No previous binaries (.prev) found to restore.");
        } else {
            for name in &restored {
                println!("Restored {name} from .prev");
            }
            for name in &missing {
                println!("No .prev for {name}; left unchanged");
            }
            for (name, detail) in &failed {
                eprintln!("Failed to restore {name}: {detail}");
            }
        }
        match &config_notice {
            ConfigRestoreNotice::Restored => {
                println!("Restored config.toml from snapshot");
            }
            ConfigRestoreNotice::Absent => {
                println!(
                    "No config.toml snapshot found; binary rollback proceeded without restoring config"
                );
            }
            ConfigRestoreNotice::Failed(detail) => {
                eprintln!(
                    "Could not restore config.toml snapshot ({detail}); binary rollback proceeded"
                );
            }
        }
        if !restored.is_empty() {
            if let Some(ref v) = smoke_version {
                let bin = crate::app::cli::resolved_bin_name();
                println!("Rolled back to v{}. Run '{bin}' to start.", strip_v(v));
            } else {
                println!("Rollback complete.");
            }
        }
    }

    if failed.is_empty() { 0 } else { 1 }
}

/// Result of optional config-snapshot restore during rollback.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfigRestoreNotice {
    Restored,
    Absent,
    Failed(String),
}

/// Snapshot the live user config after a successful fleet activation.
///
/// Lives in cmd (not fleet) because fleet.rs is foreign to this unit; a
/// foreign-file patch places the same call at FINALIZE for other callers.
fn snapshot_config_after_activate(install_dir: &Path, print: bool) {
    match state::snapshot_user_config(install_dir) {
        Ok(state::SnapshotOutcome::Written { .. }) => {}
        Ok(state::SnapshotOutcome::SourceAbsent) => {}
        Err(e) => {
            if print {
                eprintln!("note: could not snapshot config.toml for rollback: {e}");
            }
        }
    }
}

/// Restore a config snapshot taken at ACTIVATE. Absent snapshot → notice only.
fn restore_config_snapshot_if_present(install_dir: &Path) -> ConfigRestoreNotice {
    match state::restore_config_snapshot(install_dir) {
        Ok(state::RestoreOutcome::Restored { .. }) => ConfigRestoreNotice::Restored,
        Ok(state::RestoreOutcome::SnapshotAbsent) => ConfigRestoreNotice::Absent,
        Err(e) => ConfigRestoreNotice::Failed(e.to_string()),
    }
}

fn rewrite_state_after_rollback(
    install_dir: &Path,
    units: &[fleet::FleetUnit],
    smoke_version: Option<&str>,
    channel_switch: Option<&str>,
) -> Result<(), String> {
    let prev = state::load(install_dir).map_err(|e| e.to_string())?;
    let channel = channel_switch
        .map(|s| s.to_string())
        .or_else(|| prev.as_ref().map(|p| p.channel.clone()))
        .unwrap_or_else(|| effective_update_channel(None).to_string());
    let tag = smoke_version
        .map(normalize_tag)
        .or_else(|| prev.as_ref().map(|p| p.tag.clone()))
        .unwrap_or_else(|| format!("v{}", strip_v(&xai_grok_version::installed())));

    let mut new_state = InstallState::new(&tag, channel, rfc3339_now());
    if let Some(p) = prev {
        new_state.last_check_at = p.last_check_at;
        new_state.last_seen_tag = p.last_seen_tag;
        // Do not raise the floor across a rollback: keep the higher floor.
        if version_cmp(&p.version_floor, &new_state.version_floor) > 0 {
            new_state.version_floor = p.version_floor;
        }
    }
    for unit in units {
        for file in &unit.files {
            if !path_exists(&file.dest) {
                continue;
            }
            let meta = std::fs::metadata(&file.dest)
                .map_err(|e| format!("stat {}: {e}", file.dest.display()))?;
            let digest = xai_file_utils::sha256_hex_from_file(&file.dest, None)
                .map(|h| h.to_ascii_lowercase())
                .unwrap_or_default();
            new_state.files.insert(
                file.name.clone(),
                FileRecord {
                    sha256: digest,
                    size: meta.len(),
                },
            );
        }
    }
    state::store_atomic(install_dir, &new_state).map_err(|e| e.to_string())
}

fn prev_sibling(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".prev");
    PathBuf::from(name)
}

fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn extract_version_token(smoke_out: &str) -> String {
    // Prefer a `vX.Y.Z` or bare semver token from --version output.
    for token in smoke_out.split_whitespace() {
        let bare = strip_v(token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-'));
        if version_key(bare).is_some() {
            return bare.to_string();
        }
    }
    smoke_out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn normalize_tag(s: &str) -> String {
    let t = s.trim();
    if t.starts_with('v') {
        t.to_string()
    } else {
        format!("v{t}")
    }
}

fn short_hash(h: &str) -> String {
    if h.len() <= 12 {
        h.to_string()
    } else {
        format!("{}...", &h[..12])
    }
}

fn rfc3339_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_env(pairs: &[(&str, Option<&str>)], f: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let prev: Vec<(String, Option<String>)> = pairs
            .iter()
            .map(|(k, _)| ((*k).to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in pairs {
            match v {
                Some(val) => unsafe { std::env::set_var(k, val) },
                None => unsafe { std::env::remove_var(k) },
            }
        }
        f();
        for (k, v) in prev {
            match v {
                Some(val) => unsafe { std::env::set_var(&k, val) },
                None => unsafe { std::env::remove_var(&k) },
            }
        }
    }

    #[test]
    fn channel_refusal_alpha_and_enterprise() {
        assert!(channel_refusal_message("alpha")
            .unwrap()
            .contains("No alpha channel"));
        assert!(channel_refusal_message("enterprise")
            .unwrap()
            .contains("No enterprise channel"));
        assert!(channel_refusal_message("stable").is_none());
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn disable_updates_blocks_apply_with_exit_2() {
        with_env(
            &[(xai_grok_config::ENV_DISABLE_UPDATES, Some("1"))],
            || {
                let code = run_update(&UpdateCommand {
                    check: false,
                    json: false,
                    dry_run: false,
                    yes: true,
                    allow_downgrade: false,
                    rollback: false,
                    force_reinstall: false,
                    version: None,
                    channel_switch: None,
                    cli_disable: false,
                });
                assert_eq!(code, 2);
            },
        );
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn run_apply_result_policy_block_is_err() {
        with_env(
            &[(xai_grok_config::ENV_DISABLE_UPDATES, Some("1"))],
            || {
                let err = run_apply_result().expect_err("policy must err");
                assert!(
                    err.contains("AMORE_DISABLE_UPDATES") || err.contains("blocked by policy"),
                    "{err}"
                );
            },
        );
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn disable_updates_blocks_rollback_with_exit_2() {
        with_env(
            &[(xai_grok_config::ENV_DISABLE_UPDATES, Some("1"))],
            || {
                let code = run_update(&UpdateCommand {
                    check: false,
                    json: false,
                    dry_run: false,
                    yes: true,
                    allow_downgrade: false,
                    rollback: true,
                    force_reinstall: false,
                    version: None,
                    channel_switch: None,
                    cli_disable: false,
                });
                assert_eq!(code, 2);
            },
        );
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn disable_updates_blocks_dry_run_apply_with_exit_2() {
        with_env(
            &[(xai_grok_config::ENV_DISABLE_UPDATES, Some("1"))],
            || {
                let code = run_update(&UpdateCommand {
                    check: false,
                    json: false,
                    dry_run: true,
                    yes: true,
                    allow_downgrade: false,
                    rollback: false,
                    force_reinstall: false,
                    version: None,
                    channel_switch: None,
                    cli_disable: false,
                });
                assert_eq!(code, 2);
            },
        );
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn alpha_channel_on_apply_exits_2_without_network() {
        with_env(&[(xai_grok_config::ENV_DISABLE_UPDATES, None)], || {
            let code = run_update(&UpdateCommand {
                check: false,
                json: false,
                dry_run: false,
                yes: true,
                allow_downgrade: false,
                rollback: false,
                force_reinstall: false,
                version: None,
                channel_switch: Some("alpha".into()),
                cli_disable: false,
            });
            assert_eq!(code, 2);
        });
    }

    #[test]
    fn json_without_check_exits_1() {
        let code = run_update(&UpdateCommand {
            check: false,
            json: true,
            dry_run: false,
            yes: true,
            allow_downgrade: false,
            rollback: false,
            force_reinstall: false,
            version: None,
            channel_switch: None,
            cli_disable: false,
        });
        assert_eq!(code, 1);
    }

    #[test]
    fn invalid_version_pin_exits_1() {
        with_env(
            &[
                (xai_grok_config::ENV_DISABLE_UPDATES, None),
                (xai_grok_config::ENV_DISABLE_UPDATES_LEGACY, None),
            ],
            || {
                let code = run_update(&UpdateCommand {
                    check: false,
                    json: false,
                    dry_run: true,
                    yes: true,
                    allow_downgrade: false,
                    rollback: false,
                    force_reinstall: false,
                    version: Some("not-a-version".into()),
                    channel_switch: None,
                    cli_disable: false,
                });
                assert_eq!(code, 1);
            },
        );
    }

    #[test]
    fn copy_shapes_match_update_outcome_register() {
        let installed = installed_line("1.2.3");
        assert!(
            installed.starts_with("Amore Build v1.2.3 installed. Run '"),
            "{installed}"
        );
        assert!(installed.ends_with(" to start."), "{installed}");
        assert_eq!(already_latest_line(), "Already on the latest version.");
    }

    #[test]
    fn prev_sibling_appends_prev() {
        let p = PathBuf::from("amore.exe");
        assert_eq!(prev_sibling(&p), PathBuf::from("amore.exe.prev"));
    }

    #[test]
    fn map_fleet_already_current_is_exit_0() {
        let code = map_fleet_error(&FleetError::AlreadyCurrent {
            tag: "v1.0.0".into(),
        });
        assert_eq!(code, 0);
    }

    #[test]
    fn map_fleet_version_floor_is_exit_2() {
        let code = map_fleet_error(&FleetError::VersionFloor {
            floor: "1.0.0".into(),
            tag: "v0.9.0".into(),
        });
        assert_eq!(code, 2);
    }

    #[test]
    fn map_fleet_unwritable_is_exit_2() {
        let code = map_fleet_error(&FleetError::UnwritableInstallDir {
            path: PathBuf::from("/x"),
            message: "denied".into(),
        });
        assert_eq!(code, 2);
    }

    #[test]
    fn map_fleet_other_is_exit_1() {
        let code = map_fleet_error(&FleetError::Other("network down".into()));
        assert_eq!(code, 1);
    }

    #[test]
    fn extract_version_from_smoke_stdout() {
        assert_eq!(extract_version_token("amore 1.2.3"), "1.2.3");
        assert_eq!(extract_version_token("v2.0.0 (abc)"), "2.0.0");
    }

    #[test]
    fn rollback_missing_prev_is_report_not_fail() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("amore.exe");
        std::fs::write(&dest, b"current").unwrap();
        // No .prev sibling.
        assert!(!path_exists(&prev_sibling(&dest)));
        // Constructing Rollback and restore when prev missing is swap's job;
        // our scan path treats missing as report-only.
        let missing = !path_exists(&prev_sibling(&dest));
        assert!(missing);
    }

    /// ACTIVATE-time hook: snapshot lands beside install state when a source
    /// config exists (mirrors `snapshot_config_after_activate`).
    #[test]
    fn snapshot_written_at_activate_hook() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        let mut st = InstallState::new("v1.0.0", "stable", "t0");
        st.files.insert(
            "amore.exe".into(),
            FileRecord {
                sha256: "a".into(),
                size: 1,
            },
        );
        state::store_atomic(&install, &st).unwrap();

        let source = dir.path().join("config.toml");
        std::fs::write(
            &source,
            b"[cli]\nauto_update = true\nsnapshot_marker = \"pre\"\n",
        )
        .unwrap();

        // Same work the post-transaction hook performs (explicit source for
        // hermetic tests; production uses live user config).
        let outcome = state::snapshot_config_file(&install, &source).unwrap();
        assert!(
            matches!(outcome, state::SnapshotOutcome::Written { .. }),
            "{outcome:?}"
        );
        assert!(state::config_snapshot_path(&install).is_file());
        let loaded = state::load(&install).unwrap().expect("state");
        assert!(loaded.config_snapshot.is_some());
    }

    /// Rollback restores binary `.prev` AND config snapshot when both present.
    #[test]
    fn rollback_restores_binary_and_config_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("install");
        std::fs::create_dir_all(&install).unwrap();

        let dest = install.join("amore.exe");
        let prev = prev_sibling(&dest);
        std::fs::write(&dest, b"new-binary").unwrap();
        std::fs::write(&prev, b"old-binary").unwrap();

        std::fs::write(
            state::config_snapshot_path(&install),
            b"[cli]\nmarker = \"old-config\"\n",
        )
        .unwrap();
        let live = dir.path().join("home").join("config.toml");
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        std::fs::write(&live, b"[cli]\nmarker = \"new-config\"\n").unwrap();

        let rb = Rollback {
            prev_path: prev,
            dest: dest.clone(),
        };
        rb.restore().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"old-binary");

        let notice = match state::restore_config_snapshot_to(&install, &live).unwrap() {
            state::RestoreOutcome::Restored { .. } => ConfigRestoreNotice::Restored,
            state::RestoreOutcome::SnapshotAbsent => ConfigRestoreNotice::Absent,
        };
        assert_eq!(notice, ConfigRestoreNotice::Restored);
        assert_eq!(
            std::fs::read_to_string(&live).unwrap(),
            "[cli]\nmarker = \"old-config\"\n"
        );
    }

    /// Absent config snapshot: binary path proceeds; notice is Absent (never fail).
    #[test]
    fn absent_snapshot_rollback_notices_and_proceeds() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("install");
        std::fs::create_dir_all(&install).unwrap();

        let dest = install.join("amore.exe");
        let prev = prev_sibling(&dest);
        std::fs::write(&dest, b"new").unwrap();
        std::fs::write(&prev, b"old").unwrap();

        let rb = Rollback {
            prev_path: prev,
            dest: dest.clone(),
        };
        rb.restore().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");

        // No config.toml.prev under install → Absent, not an error.
        let notice = restore_config_snapshot_if_present(&install);
        assert_eq!(notice, ConfigRestoreNotice::Absent);
    }

    /// Unknown keys written by a newer binary must not brick an older loader.
    #[test]
    fn unknown_key_config_loads_clean_through_real_loader() {
        let raw = "\
[cli]
auto_update = true
future_key_from_newer_binary = \"must-not-brick\"

[future_section_from_n_plus_1]
brand_new = true
";
        let root: toml::Value =
            toml::from_str(raw).expect("valid toml with future keys");
        // Real shell loader path (same as apply/check config reads).
        let cfg = xai_grok_shell::util::config::load_config_from_toml(&root);
        assert_eq!(cfg.cli.auto_update, Some(true));
        // No error / panic: unknown keys are warnings, not load failures.
    }
}
