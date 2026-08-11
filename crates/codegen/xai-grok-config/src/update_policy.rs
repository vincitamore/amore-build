//! Update-check and update-path permission gates.
//!
//! Callers that would reach the release origin (or perform any update work)
//! must consult these helpers **before** any network call. Later units wire
//! the interactive check path; this module only resolves the policy.

/// Primary kill switch: blocks every update path, including the manual command.
pub const ENV_DISABLE_UPDATES: &str = "AMORE_DISABLE_UPDATES";

/// Legacy alias of [`ENV_DISABLE_UPDATES`] (upstream env name).
pub const ENV_DISABLE_UPDATES_LEGACY: &str = "GROK_DISABLE_AUTOUPDATER";

/// Env override for `cli.update_check` (`0` / `false` disables).
pub const ENV_UPDATE_CHECK: &str = "AMORE_UPDATE_CHECK";

/// Compiled default for `cli.update_check` when unset at every lower layer.
pub const DEFAULT_UPDATE_CHECK: bool = true;

/// Compiled default for `cli.auto_update` when unset.
pub const DEFAULT_AUTO_UPDATE: bool = false;

/// Compiled default for `cli.update_channel` when unset.
pub const DEFAULT_UPDATE_CHANNEL: &str = "stable";

/// Inputs for the background / startup version-check gate.
///
/// Config layers are expected to be merged by the caller already
/// (project config over user config). Precedence inside the resolver:
/// CLI flag > env > config > compiled default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateCheckContext {
    /// Highest-precedence disable from a CLI flag (for example `--no-auto-update`).
    pub cli_disable: bool,
    /// Effective `cli.update_check` after config merge (`None` = use default).
    pub config_update_check: Option<bool>,
    /// True only for the interactive TUI startup path. Non-interactive
    /// invocations (`amore agent`, `amore doctor`, `amore --version`, …)
    /// never resolve to permitted for background checks.
    pub interactive: bool,
}

/// True when `AMORE_DISABLE_UPDATES` or its legacy alias is set to a truthy value.
///
/// Honored before any network call on every update path (check and manual).
#[must_use]
pub fn updates_disabled_by_env() -> bool {
    env_flag_enabled(ENV_DISABLE_UPDATES) || env_flag_enabled(ENV_DISABLE_UPDATES_LEGACY)
}

/// True when no kill-switch blocks update work (manual command included).
#[must_use]
pub fn updates_permitted() -> bool {
    !updates_disabled_by_env()
}

/// Resolved `AMORE_UPDATE_CHECK` when set and recognized; otherwise `None`.
#[must_use]
pub fn update_check_env_override() -> Option<bool> {
    parse_env_bool(ENV_UPDATE_CHECK)
}

/// Effective `cli.update_check` after env override, ignoring interactivity
/// and the global kill switch. Useful for diagnostics and settings display.
#[must_use]
pub fn effective_update_check(config_update_check: Option<bool>) -> bool {
    if let Some(env) = update_check_env_override() {
        return env;
    }
    config_update_check.unwrap_or(DEFAULT_UPDATE_CHECK)
}

/// Whether a background / startup version check is permitted.
///
/// Returns false when:
/// - the invocation is not interactive,
/// - `AMORE_DISABLE_UPDATES` / `GROK_DISABLE_AUTOUPDATER` is set,
/// - a CLI disable flag is set,
/// - `AMORE_UPDATE_CHECK` is falsey, or
/// - config / default has update checks off.
///
/// Precedence: CLI flag > env > project/user config (pre-merged) > compiled default.
#[must_use]
pub fn update_checks_permitted(ctx: &UpdateCheckContext) -> bool {
    if !ctx.interactive {
        return false;
    }
    if updates_disabled_by_env() {
        return false;
    }
    if ctx.cli_disable {
        return false;
    }
    effective_update_check(ctx.config_update_check)
}

/// Effective auto-apply preference after config merge. Env does not override
/// this higher-privilege setting (config file / settings only).
#[must_use]
pub fn effective_auto_update(config_auto_update: Option<bool>) -> bool {
    config_auto_update.unwrap_or(DEFAULT_AUTO_UPDATE)
}

/// Effective update channel after config merge.
#[must_use]
pub fn effective_update_channel(config_channel: Option<&str>) -> &str {
    match config_channel {
        Some(s) if !s.is_empty() => s,
        _ => DEFAULT_UPDATE_CHANNEL,
    }
}

/// Truthy parse matching the product on/off env convention: everything enables
/// except the common falsy spellings (`0`, `false`, `off`, `no`, empty).
fn env_flag_enabled(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "off" | "no"
        ),
        Err(_) => false,
    }
}

/// Strict bool parse for preference overrides (`1`/`true`/`yes`/`on` vs
/// `0`/`false`/`no`/`off`). Unrecognized values are treated as unset.
fn parse_env_bool(name: &str) -> Option<bool> {
    let value = std::env::var(name).ok()?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Process-global env is shared; serialize these tests.
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

    fn clear_update_env(f: impl FnOnce()) {
        with_env(
            &[
                (ENV_DISABLE_UPDATES, None),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, None),
            ],
            f,
        );
    }

    fn interactive(config: Option<bool>) -> UpdateCheckContext {
        UpdateCheckContext {
            cli_disable: false,
            config_update_check: config,
            interactive: true,
        }
    }

    #[test]
    fn compiled_default_permits_interactive_check() {
        clear_update_env(|| {
            assert!(update_checks_permitted(&interactive(None)));
            assert_eq!(effective_update_check(None), true);
            assert_eq!(effective_auto_update(None), false);
            assert_eq!(effective_update_channel(None), "stable");
        });
    }

    #[test]
    fn non_interactive_never_permitted() {
        clear_update_env(|| {
            let ctx = UpdateCheckContext {
                cli_disable: false,
                config_update_check: Some(true),
                interactive: false,
            };
            assert!(!update_checks_permitted(&ctx));
        });
    }

    #[test]
    fn config_false_disables_when_env_unset() {
        clear_update_env(|| {
            assert!(!update_checks_permitted(&interactive(Some(false))));
            assert!(!effective_update_check(Some(false)));
        });
    }

    #[test]
    fn env_beats_config_true() {
        with_env(
            &[
                (ENV_DISABLE_UPDATES, None),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, Some("0")),
            ],
            || {
                assert!(!update_checks_permitted(&interactive(Some(true))));
                assert!(!effective_update_check(Some(true)));
            },
        );
    }

    #[test]
    fn env_true_beats_config_false() {
        with_env(
            &[
                (ENV_DISABLE_UPDATES, None),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, Some("true")),
            ],
            || {
                assert!(update_checks_permitted(&interactive(Some(false))));
            },
        );
    }

    #[test]
    fn cli_flag_beats_env_and_config() {
        with_env(
            &[
                (ENV_DISABLE_UPDATES, None),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, Some("1")),
            ],
            || {
                let ctx = UpdateCheckContext {
                    cli_disable: true,
                    config_update_check: Some(true),
                    interactive: true,
                };
                assert!(!update_checks_permitted(&ctx));
            },
        );
    }

    #[test]
    fn amore_disable_updates_blocks_all_paths() {
        with_env(
            &[
                (ENV_DISABLE_UPDATES, Some("1")),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, None),
            ],
            || {
                assert!(updates_disabled_by_env());
                assert!(!updates_permitted());
                assert!(!update_checks_permitted(&interactive(Some(true))));
            },
        );
    }

    #[test]
    fn legacy_grok_disable_autoupdater_alias_honored() {
        with_env(
            &[
                (ENV_DISABLE_UPDATES, None),
                (ENV_DISABLE_UPDATES_LEGACY, Some("1")),
                (ENV_UPDATE_CHECK, None),
            ],
            || {
                assert!(updates_disabled_by_env());
                assert!(!updates_permitted());
                assert!(!update_checks_permitted(&interactive(None)));
            },
        );
    }

    #[test]
    fn disable_updates_falsy_does_not_block() {
        with_env(
            &[
                (ENV_DISABLE_UPDATES, Some("0")),
                (ENV_DISABLE_UPDATES_LEGACY, Some("false")),
                (ENV_UPDATE_CHECK, None),
            ],
            || {
                assert!(!updates_disabled_by_env());
                assert!(updates_permitted());
                assert!(update_checks_permitted(&interactive(None)));
            },
        );
    }

    #[test]
    fn precedence_ladder_cli_over_env_over_config_over_default() {
        // default on
        clear_update_env(|| {
            assert!(update_checks_permitted(&interactive(None)));
        });
        // config off
        clear_update_env(|| {
            assert!(!update_checks_permitted(&interactive(Some(false))));
        });
        // env on over config off
        with_env(
            &[
                (ENV_DISABLE_UPDATES, None),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, Some("1")),
            ],
            || assert!(update_checks_permitted(&interactive(Some(false)))),
        );
        // cli off over env on
        with_env(
            &[
                (ENV_DISABLE_UPDATES, None),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, Some("1")),
            ],
            || {
                let ctx = UpdateCheckContext {
                    cli_disable: true,
                    config_update_check: Some(true),
                    interactive: true,
                };
                assert!(!update_checks_permitted(&ctx));
            },
        );
    }

    #[test]
    fn kill_switch_beats_everything_including_cli_enable_path() {
        // Even with interactive + config true + no cli disable, kill switch wins.
        with_env(
            &[
                (ENV_DISABLE_UPDATES, Some("true")),
                (ENV_DISABLE_UPDATES_LEGACY, None),
                (ENV_UPDATE_CHECK, Some("1")),
            ],
            || {
                assert!(!update_checks_permitted(&interactive(Some(true))));
            },
        );
    }
}
