/// Legacy env name; primary is `ARCUS_SYSTEM_PROMPT_LABEL` (identity layer).
pub const ENV_SYSTEM_PROMPT_LABEL: &str = "GROK_SYSTEM_PROMPT_LABEL";
/// Primary env name for the system-prompt identity label.
pub const ENV_SYSTEM_PROMPT_LABEL_PRIMARY: &str = "ARCUS_SYSTEM_PROMPT_LABEL";

pub const DEFAULT_SYSTEM_PROMPT_LABEL: &str = xai_grok_agent::DEFAULT_SYSTEM_PROMPT_LABEL;

/// Resolve system-prompt identity label.
/// Precedence: env (`ARCUS_SYSTEM_PROMPT_LABEL` primary / `GROK_SYSTEM_PROMPT_LABEL`
/// legacy) → config per-model → `[agent]` → GB per-model → GB global →
/// public default (`Arcus Build` via [`DEFAULT_SYSTEM_PROMPT_LABEL`]).
/// Empty/whitespace falls through.
///
/// Per-model TOML is looked up by session catalog id, then routing slug
/// (`ModelInfo.model`). Do not use CLI `-m` alone — it may outlive a mid-session
/// model switch.
pub fn resolve_system_prompt_label(
    cfg: &crate::agent::config::Config,
    model_id: &str,
    model: Option<&crate::agent::config::ModelInfo>,
) -> String {
    let label_for = |key: &str| {
        cfg.config_models
            .get(key)
            .and_then(|m| m.system_prompt_label.clone())
    };
    let user_per_model =
        label_for(model_id).or_else(|| model.map(|m| m.model.as_str()).and_then(label_for));

    resolve_system_prompt_label_from_tiers(
        user_per_model,
        cfg.agent.system_prompt_label.clone(),
        model.and_then(|m| m.system_prompt_label.clone()),
        cfg.remote_settings
            .as_ref()
            .and_then(|r| r.system_prompt_label.clone()),
    )
}

pub fn resolve_system_prompt_label_from_tiers(
    user_per_model: Option<String>,
    user_global: Option<String>,
    gb_per_model: Option<String>,
    gb_global: Option<String>,
) -> String {
    let non_empty = |s: Option<String>| {
        s.and_then(|v| {
            let t = v.trim();
            (!t.is_empty()).then(|| t.to_string())
        })
    };
    xai_grok_env::var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY)
        .ok()
        .and_then(|s| non_empty(Some(s)))
        .or_else(|| non_empty(user_per_model))
        .or_else(|| non_empty(user_global))
        .or_else(|| non_empty(gb_per_model))
        .or_else(|| non_empty(gb_global))
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT_LABEL.to_string())
}

#[cfg(test)]
mod system_prompt_label_tests {
    use super::{
        DEFAULT_SYSTEM_PROMPT_LABEL, ENV_SYSTEM_PROMPT_LABEL, ENV_SYSTEM_PROMPT_LABEL_PRIMARY,
        resolve_system_prompt_label_from_tiers,
    };

    /// Serialize access to label env vars and clear both for tier tests.
    /// `env_wins_over_all_tiers` mutates the env; without this lock, parallel tests
    /// that expect the var unset (e.g. `gb_per_model_beats_gb_global`) flake.
    fn with_env_cleared<R>(f: impl FnOnce() -> R) -> R {
        let _guard = ENV_LOCK.lock().unwrap();
        let prev_primary = std::env::var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY).ok();
        let prev_legacy = std::env::var(ENV_SYSTEM_PROMPT_LABEL).ok();
        // Safety: test-only, locked.
        unsafe {
            std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY);
            std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL);
        }
        let r = f();
        match prev_primary {
            Some(v) => unsafe { std::env::set_var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY, v) },
            None => unsafe { std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY) },
        }
        match prev_legacy {
            Some(v) => unsafe { std::env::set_var(ENV_SYSTEM_PROMPT_LABEL, v) },
            None => unsafe { std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL) },
        }
        r
    }

    #[test]
    fn default_when_all_unset() {
        with_env_cleared(|| {
            assert_eq!(
                resolve_system_prompt_label_from_tiers(None, None, None, None),
                DEFAULT_SYSTEM_PROMPT_LABEL
            );
        });
    }

    #[test]
    fn per_model_beats_global_and_gb() {
        with_env_cleared(|| {
            assert_eq!(
                resolve_system_prompt_label_from_tiers(
                    Some("PerModel".into()),
                    Some("Global".into()),
                    Some("GbPer".into()),
                    Some("GbGlobal".into()),
                ),
                "PerModel"
            );
        });
    }

    #[test]
    fn global_beats_gb() {
        with_env_cleared(|| {
            assert_eq!(
                resolve_system_prompt_label_from_tiers(
                    None,
                    Some("Global".into()),
                    Some("GbPer".into()),
                    Some("GbGlobal".into()),
                ),
                "Global"
            );
        });
    }

    #[test]
    fn gb_per_model_beats_gb_global() {
        with_env_cleared(|| {
            assert_eq!(
                resolve_system_prompt_label_from_tiers(
                    None,
                    None,
                    Some("GbPer".into()),
                    Some("GbGlobal".into()),
                ),
                "GbPer"
            );
        });
    }

    #[test]
    fn empty_and_whitespace_fall_through() {
        with_env_cleared(|| {
            assert_eq!(
                resolve_system_prompt_label_from_tiers(
                    Some("  ".into()),
                    Some("".into()),
                    None,
                    Some("GbGlobal".into()),
                ),
                "GbGlobal"
            );
        });
    }

    #[test]
    fn env_wins_over_all_tiers() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Safety: test-only, locked.
        unsafe {
            std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY);
            std::env::set_var(ENV_SYSTEM_PROMPT_LABEL, "FromEnv");
        }
        let got = resolve_system_prompt_label_from_tiers(
            Some("PerModel".into()),
            Some("Global".into()),
            Some("GbPer".into()),
            Some("GbGlobal".into()),
        );
        unsafe {
            std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL);
            std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY);
        }
        assert_eq!(got, "FromEnv");
    }

    #[test]
    fn arcus_primary_wins_over_grok_legacy() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY, "ArcusPrimary");
            std::env::set_var(ENV_SYSTEM_PROMPT_LABEL, "GrokLegacy");
        }
        let got = resolve_system_prompt_label_from_tiers(
            Some("PerModel".into()),
            Some("Global".into()),
            None,
            None,
        );
        unsafe {
            std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL_PRIMARY);
            std::env::remove_var(ENV_SYSTEM_PROMPT_LABEL);
        }
        assert_eq!(got, "ArcusPrimary");
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
