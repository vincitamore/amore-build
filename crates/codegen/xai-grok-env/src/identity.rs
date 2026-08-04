//! Amore Build env identity layer: `AMORE_*` primary with `GROK_*` legacy aliases.
//!
//! Semantics (v1):
//! - When both primary and legacy are set, **primary wins**.
//! - When only legacy is set, it is read silently (no deprecation spam).
//! - Names outside the alias table are resolved as plain `std::env` keys
//!   (unknown untouched).
//! - Provider-named keys such as `XAI_API_KEY` / `XAI_*` stay provider-named
//!   and are **not** aliased (they name the provider, not the product).

use std::env::VarError;
use std::ffi::OsString;

/// Exact suffixes (after `AMORE_` / `GROK_`) that participate in aliasing.
const EXACT_SUFFIXES: &[&str] = &[
    "HOME",
    "DEFAULT_MODEL",
    "SYSTEM_PROMPT_LABEL",
    "SHELL",
    "CAMPAIGNS",
    "CAMPAIGNS_OVERRIDE",
    "DEPLOYMENT_CONFIG_CACHE_TTL_SECS",
    "MANAGED_CONFIG_FAIL_CLOSED",
    "AUTH",
];

/// Prefix wildcards (after `AMORE_` / `GROK_`): every `AUTH_*`, `MDM_*`,
/// `CLI_*` key is aliased.
const PREFIX_SUFFIXES: &[&str] = &["AUTH_", "MDM_", "CLI_"];

/// True when `suffix` (without `AMORE_`/`GROK_` prefix) is in the alias table.
pub fn is_mapped_suffix(suffix: &str) -> bool {
    if EXACT_SUFFIXES.iter().any(|s| *s == suffix) {
        return true;
    }
    PREFIX_SUFFIXES.iter().any(|p| suffix.starts_with(p))
}

/// If `name` is a primary or legacy key in the alias table, return
/// `(AMORE_…, GROK_…)`. Otherwise `None` (caller should use plain env).
pub fn alias_pair(name: &str) -> Option<(String, String)> {
    let suffix = name
        .strip_prefix("AMORE_")
        .or_else(|| name.strip_prefix("GROK_"))?;
    if !is_mapped_suffix(suffix) {
        return None;
    }
    Some((format!("AMORE_{suffix}"), format!("GROK_{suffix}")))
}

/// Resolve `name` with AMORE primary / GROK legacy semantics when mapped;
/// otherwise plain `std::env::var(name)`.
pub fn var(name: &str) -> Result<String, VarError> {
    if let Some((primary, legacy)) = alias_pair(name) {
        match std::env::var(&primary) {
            Ok(v) => Ok(v),
            Err(VarError::NotPresent) => std::env::var(&legacy),
            Err(e) => Err(e),
        }
    } else {
        std::env::var(name)
    }
}

/// Like [`var`] but returns `OsString`.
pub fn var_os(name: &str) -> Option<OsString> {
    if let Some((primary, legacy)) = alias_pair(name) {
        std::env::var_os(&primary).or_else(|| std::env::var_os(&legacy))
    } else {
        std::env::var_os(name)
    }
}

/// True when the aliased (or plain) name resolves to some value.
pub fn is_set(name: &str) -> bool {
    var_os(name).is_some()
}

/// Parse a boolean env var with alias resolution. `None` if unset or unrecognized.
pub fn env_bool(name: &str) -> Option<bool> {
    let value = var(name).ok()?;
    match value.trim().to_ascii_lowercase().as_str() {
        "" => None,
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

/// Public alias table snapshot for docs/tests (primary, legacy) pairs for exact keys
/// plus one representative wildcard each.
pub fn alias_table_snapshot() -> Vec<(&'static str, &'static str)> {
    let mut rows: Vec<(&'static str, &'static str)> = EXACT_SUFFIXES
        .iter()
        .map(|s| {
            // Leak is fine for static table construction in tests/docs only —
            // we return static-looking pairs via format for exact keys.
            // Use const strings for the known exact set:
            match *s {
                "HOME" => ("AMORE_HOME", "GROK_HOME"),
                "DEFAULT_MODEL" => ("AMORE_DEFAULT_MODEL", "GROK_DEFAULT_MODEL"),
                "SYSTEM_PROMPT_LABEL" => ("AMORE_SYSTEM_PROMPT_LABEL", "GROK_SYSTEM_PROMPT_LABEL"),
                "SHELL" => ("AMORE_SHELL", "GROK_SHELL"),
                "CAMPAIGNS" => ("AMORE_CAMPAIGNS", "GROK_CAMPAIGNS"),
                "CAMPAIGNS_OVERRIDE" => ("AMORE_CAMPAIGNS_OVERRIDE", "GROK_CAMPAIGNS_OVERRIDE"),
                "DEPLOYMENT_CONFIG_CACHE_TTL_SECS" => (
                    "AMORE_DEPLOYMENT_CONFIG_CACHE_TTL_SECS",
                    "GROK_DEPLOYMENT_CONFIG_CACHE_TTL_SECS",
                ),
                "MANAGED_CONFIG_FAIL_CLOSED" => (
                    "AMORE_MANAGED_CONFIG_FAIL_CLOSED",
                    "GROK_MANAGED_CONFIG_FAIL_CLOSED",
                ),
                "AUTH" => ("AMORE_AUTH", "GROK_AUTH"),
                _ => unreachable!("exact suffix not in match: {s}"),
            }
        })
        .collect();
    // Wildcard representatives (the resolver accepts any AUTH_*/MDM_*/CLI_*).
    rows.push(("AMORE_AUTH_PATH", "GROK_AUTH_PATH"));
    rows.push(("AMORE_MDM_DOMAIN", "GROK_MDM_DOMAIN"));
    rows.push(("AMORE_CLI_CHAT_PROXY_BASE_URL", "GROK_CLI_CHAT_PROXY_BASE_URL"));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Multi-key env fixture under the process-wide env lock (nested
    /// [`crate::EnvVarGuard`] would deadlock on the same mutex).
    fn with_env(pairs: &[(&str, Option<&str>)], f: impl FnOnce()) {
        let _lock = crate::env_lock();
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
    fn primary_wins_when_both_present() {
        with_env(
            &[
                ("AMORE_HOME", Some("/amore-home")),
                ("GROK_HOME", Some("/grok-home")),
            ],
            || {
                assert_eq!(var("GROK_HOME").unwrap(), "/amore-home");
                assert_eq!(var("AMORE_HOME").unwrap(), "/amore-home");
            },
        );
    }

    #[test]
    fn legacy_fallback_when_primary_absent() {
        with_env(
            &[
                ("AMORE_DEFAULT_MODEL", None),
                ("GROK_DEFAULT_MODEL", Some("legacy-model")),
            ],
            || {
                assert_eq!(var("GROK_DEFAULT_MODEL").unwrap(), "legacy-model");
                assert_eq!(var("AMORE_DEFAULT_MODEL").unwrap(), "legacy-model");
            },
        );
    }

    #[test]
    fn both_absent_is_not_present() {
        with_env(&[("AMORE_SHELL", None), ("GROK_SHELL", None)], || {
            assert!(matches!(var("GROK_SHELL"), Err(VarError::NotPresent)));
            assert!(var_os("AMORE_SHELL").is_none());
        });
    }

    #[test]
    fn unknown_untouched_no_phantom_amore() {
        // GROK_TELEMETRY_ENABLED is intentionally NOT in the alias table.
        with_env(
            &[
                ("AMORE_TELEMETRY_ENABLED", Some("should-not-win")),
                ("GROK_TELEMETRY_ENABLED", None),
                ("XAI_API_KEY", Some("provider-key")),
            ],
            || {
                assert!(
                    matches!(var("GROK_TELEMETRY_ENABLED"), Err(VarError::NotPresent)),
                    "unmapped GROK_* must not invent a AMORE_* alias"
                );
                assert_eq!(var("XAI_API_KEY").unwrap(), "provider-key");
            },
        );
    }

    #[test]
    fn auth_wildcard_primary_wins() {
        with_env(
            &[
                ("AMORE_AUTH_PATH", Some("/amore/auth.json")),
                ("GROK_AUTH_PATH", Some("/grok/auth.json")),
            ],
            || {
                assert_eq!(var("GROK_AUTH_PATH").unwrap(), "/amore/auth.json");
            },
        );
    }

    #[test]
    fn cli_wildcard_legacy_fallback() {
        with_env(
            &[
                ("AMORE_CLI_CHAT_PROXY_BASE_URL", None),
                ("GROK_CLI_CHAT_PROXY_BASE_URL", Some("http://legacy")),
            ],
            || {
                assert_eq!(
                    var("GROK_CLI_CHAT_PROXY_BASE_URL").unwrap(),
                    "http://legacy"
                );
            },
        );
    }

    #[test]
    fn mdm_wildcard_mapped() {
        assert!(is_mapped_suffix("MDM_ANYTHING"));
        with_env(
            &[
                ("AMORE_MDM_PROBE", None),
                ("GROK_MDM_PROBE", Some("mdm-val")),
            ],
            || {
                assert_eq!(var("AMORE_MDM_PROBE").unwrap(), "mdm-val");
            },
        );
    }

    #[test]
    fn system_prompt_label_aliased() {
        with_env(
            &[
                ("AMORE_SYSTEM_PROMPT_LABEL", Some("Amore From Env")),
                ("GROK_SYSTEM_PROMPT_LABEL", Some("Grok From Env")),
            ],
            || {
                assert_eq!(
                    var("GROK_SYSTEM_PROMPT_LABEL").unwrap(),
                    "Amore From Env"
                );
            },
        );
    }

    #[test]
    fn env_bool_respects_primary() {
        with_env(
            &[
                ("AMORE_CAMPAIGNS", Some("0")),
                ("GROK_CAMPAIGNS", Some("1")),
            ],
            || {
                assert_eq!(env_bool("GROK_CAMPAIGNS"), Some(false));
            },
        );
    }

    #[test]
    fn alias_table_covers_required_surface() {
        let table = alias_table_snapshot();
        let primaries: Vec<_> = table.iter().map(|(p, _)| *p).collect();
        for need in [
            "AMORE_HOME",
            "AMORE_DEFAULT_MODEL",
            "AMORE_SYSTEM_PROMPT_LABEL",
            "AMORE_SHELL",
            "AMORE_CAMPAIGNS",
            "AMORE_DEPLOYMENT_CONFIG_CACHE_TTL_SECS",
            "AMORE_MANAGED_CONFIG_FAIL_CLOSED",
            "AMORE_AUTH",
            "AMORE_AUTH_PATH",
            "AMORE_CLI_CHAT_PROXY_BASE_URL",
        ] {
            assert!(
                primaries.contains(&need),
                "alias table missing {need}; got {primaries:?}"
            );
        }
    }
}
