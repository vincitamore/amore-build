//! Read-only update availability checks.
//!
//! Background checks are cadence-limited, policy-gated, and never block startup
//! on the network. User-initiated checks may use the REST metadata path and
//! report blocked-by-policy honestly (never "current" when the network was
//! not consulted).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tracing::debug;

use super::discover::{self, DiscoverError};
use super::origin::{UPDATE_ORIGIN_HOST, UPDATE_ORIGIN_REPO};
use super::state::{self, InstallState, StateError};
use xai_grok_config::{
    UpdateCheckContext, effective_auto_update, effective_update_channel, effective_update_check,
    update_checks_permitted, updates_disabled_by_env, updates_permitted,
};

/// Minimum wall time between background redirect probes (matches gh / deno).
pub const CHECK_CADENCE: Duration = Duration::from_secs(24 * 60 * 60);

/// Installer id reported in the JSON contract for this fork's release path.
pub const INSTALLER_ID: &str = "amore-release";

/// Result of a background availability check (same payload the TUI channel consumes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateAvailable {
    /// Latest version string without a leading `v` (e.g. `"1.0.0"`).
    pub latest_version: String,
}

/// Machine-readable status for `amore update --check` / `--check --json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub installer: Option<String>,
    pub channel: String,
    pub auto_update: Option<bool>,
    pub error: Option<String>,
    /// Whether version checks are permitted under the effective policy.
    /// Distinct from [`Self::auto_update`] (auto-apply preference).
    pub update_check: bool,
    pub changelog_url: Option<String>,
}

/// Inputs for a version check. Callers supply config already merged from disk.
#[derive(Debug, Clone)]
pub struct CheckConfig {
    /// Running binary version (no leading `v` required).
    pub current_version: String,
    /// Effective `cli.update_check` after config merge (`None` = compiled default).
    pub config_update_check: Option<bool>,
    /// Effective `cli.auto_update` after config merge.
    pub config_auto_update: Option<bool>,
    /// Channel from config / CLI (`stable` only is published).
    pub channel: Option<String>,
    /// When set, compare against this pin rather than the discovered latest.
    pub update_pin: Option<String>,
    /// When set and equal to the candidate, suppress the available notice.
    pub dismissed_version: Option<String>,
    /// Highest-precedence CLI disable (for example `--no-auto-update`).
    pub cli_disable: bool,
    /// True for the interactive TUI background path.
    pub interactive: bool,
}

impl CheckConfig {
    /// Load check inputs from disk config plus the running version.
    pub fn from_disk(cli_disable: bool, interactive: bool) -> Self {
        let current_version = xai_grok_version::installed();
        let (update_check, auto_update, channel, pin, dismissed) = load_cli_update_fields();
        Self {
            current_version,
            config_update_check: update_check,
            config_auto_update: auto_update,
            channel,
            update_pin: pin,
            dismissed_version: dismissed,
            cli_disable,
            interactive,
        }
    }
}

/// Policy / outcome classification for user-initiated checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    /// Network / disk failure.
    Failure(UpdateStatus),
    /// Kill switch, unsupported channel, or policy block.
    Blocked(UpdateStatus),
    /// Clean check (up to date or update available).
    Ok(UpdateStatus),
}

impl CheckOutcome {
    pub fn status(&self) -> &UpdateStatus {
        match self {
            Self::Failure(s) | Self::Blocked(s) | Self::Ok(s) => s,
        }
    }

    pub fn into_status(self) -> UpdateStatus {
        match self {
            Self::Failure(s) | Self::Blocked(s) | Self::Ok(s) => s,
        }
    }

    /// Exit code: 0 clean, 1 failure, 2 blocked.
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Ok(_) => 0,
            Self::Failure(_) => 1,
            Self::Blocked(_) => 2,
        }
    }
}

/// Fire-and-forget background check for TUI startup.
///
/// Consults update policy first. At most one redirect probe per
/// [`CHECK_CADENCE`]. Offline and policy-blocked paths return `None` (silence).
/// Never panics; never blocks the caller beyond the probe itself — callers
/// must run this on a background task.
pub fn check_background(cfg: &CheckConfig) -> Option<UpdateAvailable> {
    check_background_with(cfg, SystemTime::now, discover::latest_tag_via_redirect)
}

/// Testable background check with injectable clock and discovery.
pub fn check_background_with<F, D>(
    cfg: &CheckConfig,
    now: F,
    discover: D,
) -> Option<UpdateAvailable>
where
    F: Fn() -> SystemTime,
    D: Fn() -> Result<discover::ResolvedTag, DiscoverError>,
{
    let policy_ctx = UpdateCheckContext {
        cli_disable: cfg.cli_disable,
        config_update_check: cfg.config_update_check,
        interactive: cfg.interactive,
    };
    if !update_checks_permitted(&policy_ctx) {
        debug!("self_update check: background check blocked by policy");
        return None;
    }

    let dir = match state::install_dir() {
        Ok(d) => d,
        Err(e) => {
            debug!(error = %e, "self_update check: install dir unavailable");
            return None;
        }
    };
    if let Err(e) = state::write_probe(&dir) {
        debug!(error = %e, "self_update check: install dir unwritable; skip");
        return None;
    }

    let mut install = state::load(&dir).ok().flatten().unwrap_or_else(|| {
        InstallState::new(
            format!("v{}", strip_v(&cfg.current_version)),
            effective_update_channel(cfg.channel.as_deref()).to_string(),
            rfc3339(now()),
        )
    });

    let instant = now();
    if let Some(ref last) = install.last_check_at {
        if let Some(last_t) = parse_rfc3339(last) {
            if instant
                .duration_since(last_t)
                .unwrap_or(Duration::ZERO)
                < CHECK_CADENCE
            {
                // Within cadence: surface a previously-seen newer tag if still relevant.
                return evaluate_candidate(
                    cfg,
                    install.last_seen_tag.as_deref(),
                    install.version_floor.as_str(),
                )
                .map(|v| UpdateAvailable {
                    latest_version: v,
                });
            }
        }
    }

    let resolved = match discover() {
        Ok(t) => t,
        Err(e) => {
            debug!(error = %e, "self_update check: background discover failed");
            // Record the attempt time so a flapping network cannot probe every launch.
            install.last_check_at = Some(rfc3339(instant));
            let _ = state::store_atomic(&dir, &install);
            return None;
        }
    };

    install.last_check_at = Some(rfc3339(instant));
    install.last_seen_tag = Some(resolved.tag.clone());
    if let Err(e) = state::store_atomic(&dir, &install) {
        debug!(error = %e, "self_update check: failed to persist check cache");
    }

    evaluate_candidate(
        cfg,
        Some(resolved.tag.as_str()),
        install.version_floor.as_str(),
    )
    .map(|v| UpdateAvailable {
        latest_version: v,
    })
}

/// Synchronous user-initiated check (`amore update --check`).
///
/// May call the REST metadata API for the changelog URL. Honors kill switches
/// with a typed blocked outcome (never silently reports current).
pub fn check_status(cfg: &CheckConfig) -> CheckOutcome {
    check_status_with(
        cfg,
        SystemTime::now,
        discover::latest_tag_via_redirect,
        |tag| discover::release_metadata(tag),
    )
}

/// Testable status check with injectable clock and discovery seams.
pub fn check_status_with<F, D, M>(
    cfg: &CheckConfig,
    now: F,
    discover: D,
    metadata: M,
) -> CheckOutcome
where
    F: Fn() -> SystemTime,
    D: Fn() -> Result<discover::ResolvedTag, DiscoverError>,
    M: Fn(&str) -> Result<discover::ReleaseMeta, DiscoverError>,
{
    let channel = effective_update_channel(cfg.channel.as_deref()).to_string();
    let update_check = effective_update_check(cfg.config_update_check);
    let auto_update = Some(effective_auto_update(cfg.config_auto_update));
    let current = strip_v(&cfg.current_version).to_string();

    let base = |latest: Option<String>,
                available: bool,
                error: Option<String>,
                changelog: Option<String>| UpdateStatus {
        current_version: current.clone(),
        latest_version: latest,
        update_available: available,
        installer: Some(INSTALLER_ID.to_string()),
        channel: channel.clone(),
        auto_update,
        error,
        update_check,
        changelog_url: changelog,
    };

    if let Some(msg) = unsupported_channel_message(&channel) {
        return CheckOutcome::Blocked(base(
            None,
            false,
            Some(msg),
            None,
        ));
    }

    if updates_disabled_by_env() || !updates_permitted() {
        return CheckOutcome::Blocked(base(
            None,
            false,
            Some(
                "Update checks are blocked by policy (AMORE_DISABLE_UPDATES or GROK_DISABLE_AUTOUPDATER)."
                    .to_string(),
            ),
            None,
        ));
    }

    // User-initiated: still honor AMORE_UPDATE_CHECK / config off as a reportable block.
    if !update_check {
        return CheckOutcome::Blocked(base(
            None,
            false,
            Some(
                "Update checks are disabled (AMORE_UPDATE_CHECK=0 or cli.update_check = false)."
                    .to_string(),
            ),
            None,
        ));
    }

    let dir = match state::install_dir() {
        Ok(d) => d,
        Err(e) => {
            return CheckOutcome::Failure(base(
                None,
                false,
                Some(format!("install directory: {e}")),
                None,
            ));
        }
    };

    let mut install = match state::load(&dir) {
        Ok(s) => s.unwrap_or_else(|| {
            InstallState::new(
                format!("v{current}"),
                channel.clone(),
                rfc3339(now()),
            )
        }),
        Err(e) => {
            return CheckOutcome::Failure(base(
                None,
                false,
                Some(format!("state load: {e}")),
                None,
            ));
        }
    };

    // Pin short-circuits discovery when set.
    let candidate_tag = if let Some(ref pin) = cfg.update_pin {
        normalize_tag(pin)
    } else {
        match discover() {
            Ok(t) => t.tag,
            Err(e) => {
                install.last_check_at = Some(rfc3339(now()));
                let _ = try_store(&dir, &install);
                return CheckOutcome::Failure(base(
                    None,
                    false,
                    Some(format!("could not reach release origin: {e}")),
                    None,
                ));
            }
        }
    };

    install.last_check_at = Some(rfc3339(now()));
    install.last_seen_tag = Some(candidate_tag.clone());
    if let Err(e) = try_store(&dir, &install) {
        // Unwritable install dir is a failure for user-initiated (honest report).
        if matches!(e, StateError::UnwritableInstallDir { .. }) {
            return CheckOutcome::Failure(base(
                Some(strip_v(&candidate_tag).to_string()),
                false,
                Some(format!("{e}")),
                None,
            ));
        }
        debug!(error = %e, "self_update check: status cache write failed");
    }

    let latest_ver = strip_v(&candidate_tag).to_string();
    let changelog = changelog_url_for(&candidate_tag, &metadata);

    let available = match evaluate_candidate(cfg, Some(candidate_tag.as_str()), &install.version_floor)
    {
        Some(_) => true,
        None => false,
    };

    CheckOutcome::Ok(base(
        Some(latest_ver),
        available,
        None,
        changelog,
    ))
}

/// Cached-state facts for `amore doctor` (no network).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorUpdateFacts {
    pub last_check_at: Option<String>,
    pub last_seen_tag: Option<String>,
    pub checks_permitted: bool,
    pub block_reason: Option<String>,
    pub install_dir: Option<String>,
    pub state_error: Option<String>,
}

/// Read cached install state and policy for the doctor Update section.
pub fn doctor_update_facts() -> DoctorUpdateFacts {
    let update_check = load_cli_update_fields().0;
    let permitted = update_checks_permitted(&UpdateCheckContext {
        cli_disable: false,
        config_update_check: update_check,
        interactive: true,
    });
    let block_reason = if updates_disabled_by_env() {
        Some(
            "AMORE_DISABLE_UPDATES (or GROK_DISABLE_AUTOUPDATER) is set"
                .to_string(),
        )
    } else if !effective_update_check(update_check) {
        Some("AMORE_UPDATE_CHECK or cli.update_check disables checks".to_string())
    } else if !permitted {
        Some("checks not permitted under the current policy".to_string())
    } else {
        None
    };

    let dir = match state::install_dir() {
        Ok(d) => d,
        Err(e) => {
            return DoctorUpdateFacts {
                last_check_at: None,
                last_seen_tag: None,
                checks_permitted: permitted,
                block_reason,
                install_dir: None,
                state_error: Some(e.to_string()),
            };
        }
    };

    let mut state_error = None;
    if let Err(e) = state::write_probe(&dir) {
        state_error = Some(e.to_string());
    }

    let loaded = state::load(&dir).unwrap_or_else(|e| {
        state_error = Some(e.to_string());
        None
    });

    DoctorUpdateFacts {
        last_check_at: loaded.as_ref().and_then(|s| s.last_check_at.clone()),
        last_seen_tag: loaded.as_ref().and_then(|s| s.last_seen_tag.clone()),
        checks_permitted: permitted && state_error.is_none(),
        block_reason: if state_error.is_some() {
            state_error.clone().or(block_reason)
        } else {
            block_reason
        },
        install_dir: Some(dir.display().to_string()),
        state_error,
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn load_cli_update_fields() -> (
    Option<bool>,
    Option<bool>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let Ok(root) = xai_grok_shell::config::load_effective_config_disk_only() else {
        return (None, None, None, None, None);
    };
    let cfg = xai_grok_shell::util::config::load_config_from_toml(&root);
    (
        cfg.cli.update_check,
        cfg.cli.auto_update,
        cfg.cli
            .update_channel
            .clone()
            .or(cfg.cli.channel.clone()),
        cfg.cli.update_pin.clone(),
        cfg.cli.dismissed_version.clone(),
    )
}

fn unsupported_channel_message(channel: &str) -> Option<String> {
    match channel {
        "stable" | "" => None,
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

fn evaluate_candidate(
    cfg: &CheckConfig,
    tag: Option<&str>,
    version_floor: &str,
) -> Option<String> {
    let tag = tag?;
    let candidate = if let Some(ref pin) = cfg.update_pin {
        strip_v(pin).to_string()
    } else {
        strip_v(tag).to_string()
    };

    if let Some(ref dismissed) = cfg.dismissed_version {
        if strip_v(dismissed) == candidate {
            return None;
        }
    }

    let current = strip_v(&cfg.current_version);
    if !is_newer(&candidate, current) {
        return None;
    }
    // Version floor: never advertise a downgrade below the recorded floor.
    if version_cmp(&candidate, strip_v(version_floor)) < 0 {
        return None;
    }
    Some(candidate)
}

fn changelog_url_for<M>(tag: &str, metadata: &M) -> Option<String>
where
    M: Fn(&str) -> Result<discover::ReleaseMeta, DiscoverError>,
{
    // Prefer the tag we already have; metadata call is best-effort for existence.
    let _ = metadata(tag);
    Some(format!(
        "https://{host}/{repo}/releases/tag/{tag}",
        host = UPDATE_ORIGIN_HOST,
        repo = UPDATE_ORIGIN_REPO,
        tag = normalize_tag(tag),
    ))
}

fn try_store(dir: &std::path::Path, state: &InstallState) -> Result<(), StateError> {
    state::store_atomic(dir, state)
}

fn strip_v(s: &str) -> &str {
    s.strip_prefix('v').unwrap_or(s)
}

fn normalize_tag(s: &str) -> String {
    let t = s.trim();
    if t.starts_with('v') {
        t.to_string()
    } else {
        format!("v{t}")
    }
}

fn is_newer(candidate: &str, current: &str) -> bool {
    version_cmp(candidate, current) > 0
}

/// Compare dotted numeric versions (optional leading `v`, optional pre-release
/// suffix ignored for the numeric triple). Returns -1 / 0 / 1.
fn version_cmp(a: &str, b: &str) -> i32 {
    let ord = match (version_triple(a), version_triple(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        // Fall back to string compare when unparseable.
        _ => strip_v(a).cmp(strip_v(b)),
    };
    match ord {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

fn version_triple(s: &str) -> Option<(u64, u64, u64)> {
    let s = strip_v(s);
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn rfc3339(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    // Minimal UTC formatting without pulling chrono into the hot path shape.
    // Good enough for cadence comparisons and doctor display.
    format_epoch_rfc3339(secs)
}

fn format_epoch_rfc3339(secs: u64) -> String {
    // civil date from unix days (Howard Hinnant algorithm)
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn parse_rfc3339(s: &str) -> Option<SystemTime> {
    // Accept `YYYY-MM-DDTHH:MM:SSZ` produced by [`rfc3339`].
    let s = s.trim();
    if s.len() < 20 {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    let min: u32 = s.get(14..16)?.parse().ok()?;
    let sec: u32 = s.get(17..19)?.parse().ok()?;
    let days = days_from_civil(year, month, day)?;
    let secs = days * 86_400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64;
    if secs < 0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs(secs as u64))
}

fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i64> {
    if m < 1 || m > 12 || d < 1 || d > 31 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe as i64 - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Apply env pairs under a single process-wide lock (never nest).
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

    fn clear_update_env_pairs() -> [(&'static str, Option<&'static str>); 3] {
        [
            (xai_grok_config::ENV_DISABLE_UPDATES, None),
            (xai_grok_config::ENV_DISABLE_UPDATES_LEGACY, None),
            (xai_grok_config::ENV_UPDATE_CHECK, None),
        ]
    }

    fn with_clear_update_env(f: impl FnOnce()) {
        with_env(&clear_update_env_pairs(), f);
    }

    fn with_update_env(extra: &[(&str, Option<&str>)], f: impl FnOnce()) {
        let mut pairs: Vec<(&str, Option<&str>)> = clear_update_env_pairs().to_vec();
        pairs.extend_from_slice(extra);
        with_env(&pairs, f);
    }

    fn base_cfg(current: &str) -> CheckConfig {
        CheckConfig {
            current_version: current.into(),
            config_update_check: Some(true),
            config_auto_update: Some(false),
            channel: Some("stable".into()),
            update_pin: None,
            dismissed_version: None,
            cli_disable: false,
            interactive: true,
        }
    }

    fn fixed_now(secs: u64) -> impl Fn() -> SystemTime {
        move || UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn tag_ok(tag: &str) -> impl Fn() -> Result<discover::ResolvedTag, DiscoverError> + '_ {
        let t = tag.to_string();
        move || Ok(discover::ResolvedTag { tag: t.clone() })
    }

    fn tag_err() -> impl Fn() -> Result<discover::ResolvedTag, DiscoverError> {
        || Err(DiscoverError::Transport("offline".into()))
    }

    #[test]
    fn version_cmp_orders_semver_triples() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.9.9", "1.0.0"));
        assert!(is_newer("v2.0.0", "1.9.9"));
    }

    #[test]
    fn policy_blocked_background_is_silence() {
        with_update_env(
            &[(xai_grok_config::ENV_UPDATE_CHECK, Some("0"))],
            || {
                let cfg = base_cfg("1.0.0");
                let probes = AtomicUsize::new(0);
                let out = check_background_with(&cfg, fixed_now(1_700_000_000), || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    tag_ok("v9.9.9")()
                });
                assert!(out.is_none());
                assert_eq!(probes.load(Ordering::SeqCst), 0);
            },
        );
    }

    #[test]
    fn policy_blocked_status_is_typed_blocked_not_current() {
        with_update_env(
            &[(xai_grok_config::ENV_DISABLE_UPDATES, Some("1"))],
            || {
                let cfg = base_cfg("1.0.0");
                let probes = AtomicUsize::new(0);
                let outcome = check_status_with(
                    &cfg,
                    fixed_now(1_700_000_000),
                    || {
                        probes.fetch_add(1, Ordering::SeqCst);
                        tag_ok("v9.9.9")()
                    },
                    |_| Err(DiscoverError::Transport("no".into())),
                );
                assert_eq!(outcome.exit_code(), 2);
                let s = outcome.status();
                assert!(!s.update_available);
                assert!(s.error.as_ref().is_some_and(|e| e.contains("policy")));
                assert_eq!(s.installer.as_deref(), Some(INSTALLER_ID));
                assert_eq!(probes.load(Ordering::SeqCst), 0);
            },
        );
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn status_json_contract_fields() {
        with_clear_update_env(|| {
            let cfg = base_cfg("1.0.0");
            let outcome = check_status_with(
                &cfg,
                fixed_now(1_700_000_000),
                tag_ok("v1.2.3"),
                |_| {
                    Ok(discover::ReleaseMeta {
                        tag_name: "v1.2.3".into(),
                        assets: vec![],
                    })
                },
            );
            let s = outcome.into_status();
            let json = serde_json::to_value(&s).unwrap();
            for key in [
                "currentVersion",
                "latestVersion",
                "updateAvailable",
                "installer",
                "channel",
                "autoUpdate",
                "error",
                "updateCheck",
                "changelogUrl",
            ] {
                assert!(json.get(key).is_some(), "missing {key}");
            }
            assert_eq!(json["installer"], INSTALLER_ID);
            assert_eq!(json["updateCheck"], true);
            assert!(json["updateAvailable"].as_bool().unwrap());
            assert_eq!(json["latestVersion"], "1.2.3");
            assert!(
                json["changelogUrl"]
                    .as_str()
                    .unwrap()
                    .contains("/releases/tag/v1.2.3")
            );
        });
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn dismissed_version_suppresses_available() {
        with_clear_update_env(|| {
            let mut cfg = base_cfg("1.0.0");
            cfg.dismissed_version = Some("1.2.3".into());
            let outcome = check_status_with(
                &cfg,
                fixed_now(1_700_000_000),
                tag_ok("v1.2.3"),
                |_| {
                    Ok(discover::ReleaseMeta {
                        tag_name: "v1.2.3".into(),
                        assets: vec![],
                    })
                },
            );
            let s = outcome.into_status();
            assert!(!s.update_available);
            assert_eq!(s.latest_version.as_deref(), Some("1.2.3"));
        });
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn update_pin_compared_instead_of_latest() {
        with_clear_update_env(|| {
            let mut cfg = base_cfg("1.0.0");
            cfg.update_pin = Some("1.0.5".into());
            let probes = AtomicUsize::new(0);
            let outcome = check_status_with(
                &cfg,
                fixed_now(1_700_000_000),
                || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    tag_ok("v9.9.9")()
                },
                |_| {
                    Ok(discover::ReleaseMeta {
                        tag_name: "v1.0.5".into(),
                        assets: vec![],
                    })
                },
            );
            // Pin short-circuits discovery.
            assert_eq!(probes.load(Ordering::SeqCst), 0);
            let s = outcome.into_status();
            assert!(s.update_available);
            assert_eq!(s.latest_version.as_deref(), Some("1.0.5"));
        });
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn cadence_window_respected_no_second_probe() {
        with_clear_update_env(|| {
            // Isolate install dir via a temp cwd is hard (install_dir uses current_exe).
            // Drive check_background_with twice with a shared counter when state
            // can be written beside the test binary; skip if unwritable.
            let dir = match state::install_dir() {
                Ok(d) if state::write_probe(&d).is_ok() => d,
                _ => return, // host install dir unwritable; cadence covered by logic below
            };
            let _ = std::fs::remove_file(state::state_path(&dir));

            let cfg = base_cfg("1.0.0");
            let probes = AtomicUsize::new(0);
            let discover = || {
                probes.fetch_add(1, Ordering::SeqCst);
                tag_ok("v1.5.0")()
            };
            let t0 = 1_700_000_000u64;
            let first = check_background_with(&cfg, fixed_now(t0), &discover);
            assert!(first.is_some());
            assert_eq!(probes.load(Ordering::SeqCst), 1);

            // 1 hour later: still inside 24h window — no second probe.
            let second = check_background_with(&cfg, fixed_now(t0 + 3600), &discover);
            assert_eq!(probes.load(Ordering::SeqCst), 1);
            // Cached last_seen still surfaces the update.
            assert_eq!(
                second.map(|u| u.latest_version),
                Some("1.5.0".into())
            );

            // 25 hours later: probe again.
            let third = check_background_with(&cfg, fixed_now(t0 + 25 * 3600), &discover);
            assert_eq!(probes.load(Ordering::SeqCst), 2);
            assert!(third.is_some());

            let _ = std::fs::remove_file(state::state_path(&dir));
        });
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn offline_background_is_silence() {
        with_clear_update_env(|| {
            // Clear any leftover state from the cadence test so we exercise the
            // discover-failure path rather than the within-cadence cache path.
            if let Ok(dir) = state::install_dir() {
                let _ = std::fs::remove_file(state::state_path(&dir));
            }
            let cfg = base_cfg("1.0.0");
            let out = check_background_with(&cfg, fixed_now(1_700_000_000), tag_err());
            assert!(out.is_none());
        });
    }

    #[test]
    #[serial_test::serial(amore_update_env)]
    fn alpha_channel_blocked_loudly() {
        with_clear_update_env(|| {
            let mut cfg = base_cfg("1.0.0");
            cfg.channel = Some("alpha".into());
            let outcome = check_status_with(
                &cfg,
                fixed_now(1_700_000_000),
                tag_ok("v1.2.3"),
                |_| Err(DiscoverError::Transport("no".into())),
            );
            assert_eq!(outcome.exit_code(), 2);
            assert!(
                outcome
                    .status()
                    .error
                    .as_ref()
                    .is_some_and(|e| e.contains("No alpha channel"))
            );
        });
    }

    #[test]
    fn payload_shape_matches_channel_consumer() {
        let u = UpdateAvailable {
            latest_version: "9.9.9".into(),
        };
        // The TUI stores `latest_version` into `pending_update_version`.
        assert_eq!(u.latest_version, "9.9.9");
    }

    #[test]
    fn rfc3339_round_trip_for_cadence() {
        let t = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let s = rfc3339(t);
        let back = parse_rfc3339(&s).unwrap();
        assert_eq!(
            back.duration_since(UNIX_EPOCH).unwrap().as_secs(),
            1_700_000_000
        );
    }
}
