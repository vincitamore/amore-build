//! Lightweight credential-presence checks for the first-run gate.
//!
//! "Credentials resolve" means any of:
//! - non-empty `auth.json` session store under the arcus/grok home
//! - `XAI_API_KEY` (or legacy `GROK_CODE_XAI_API_KEY`) set in the process env
//! - a `[model.*]` block whose `api_key` is non-empty or whose `env_key` resolves

use std::path::Path;

/// Env var names checked for the native xAI rail (provider-named, not product-aliased).
pub const XAI_API_KEY_ENV: &str = "XAI_API_KEY";
pub const LEGACY_XAI_API_KEY_ENV: &str = "GROK_CODE_XAI_API_KEY";

/// Aggregate probe used by auto-launch guards.
#[must_use]
pub fn credentials_resolved(home: &Path) -> bool {
    has_xai_api_key_env()
        || auth_json_has_entries(home)
        || config_has_resolvable_model_key(&home.join("config.toml"))
}

/// True when `XAI_API_KEY` or the legacy alias is set and non-empty.
#[must_use]
pub fn has_xai_api_key_env() -> bool {
    env_nonempty(XAI_API_KEY_ENV) || env_nonempty(LEGACY_XAI_API_KEY_ENV)
}

fn env_nonempty(name: &str) -> bool {
    std::env::var(name)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// `auth.json` exists and parses as a non-empty JSON object (any scope entry).
#[must_use]
pub fn auth_json_has_entries(home: &Path) -> bool {
    let path = home.join("auth.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::Object(map)) => !map.is_empty(),
        _ => false,
    }
}

/// Walk `[model.*]` tables; true if any has a literal `api_key` or a resolvable `env_key`.
#[must_use]
pub fn config_has_resolvable_model_key(config_path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(config_path) else {
        return false;
    };
    // toml 0.9: `str::parse::<Value>` is not the document entrypoint; use from_str.
    let Ok(val) = toml::from_str::<toml::Value>(&raw) else {
        return false;
    };
    let Some(models) = val.get("model").and_then(|m| m.as_table()) else {
        return false;
    };
    for (_id, entry) in models {
        let Some(table) = entry.as_table() else {
            continue;
        };
        if table
            .get("api_key")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
        {
            return true;
        }
        if env_key_resolves(table.get("env_key")) {
            return true;
        }
    }
    // Provider blocks can also hold the key shared by several models.
    if let Some(providers) = val.get("model_providers").and_then(|m| m.as_table()) {
        for (_id, entry) in providers {
            let Some(table) = entry.as_table() else {
                continue;
            };
            if env_key_resolves(table.get("env_key")) {
                return true;
            }
            if table
                .get("api_key")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.trim().is_empty())
            {
                return true;
            }
        }
    }
    false
}

fn env_key_resolves(v: Option<&toml::Value>) -> bool {
    match v {
        Some(toml::Value::String(name)) => env_nonempty(name),
        Some(toml::Value::Array(arr)) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .any(env_nonempty),
        _ => false,
    }
}

/// Read `[agent] setup_on_first_run` from config.toml. `None` if absent/unparseable.
#[must_use]
pub fn read_setup_on_first_run(config_path: &Path) -> Option<bool> {
    let raw = std::fs::read_to_string(config_path).ok()?;
    let val: toml::Value = toml::from_str(&raw).ok()?;
    val.get("agent")?
        .get("setup_on_first_run")?
        .as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn empty_home_no_credentials() {
        let dir = tempdir().unwrap();
        // Do not assert against live XAI_API_KEY; only path-based probes here.
        assert!(!auth_json_has_entries(dir.path()));
        assert!(!config_has_resolvable_model_key(
            &dir.path().join("config.toml")
        ));
    }

    #[test]
    fn auth_json_empty_object_is_false() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("auth.json"), "{}\n").unwrap();
        assert!(!auth_json_has_entries(dir.path()));
    }

    #[test]
    fn auth_json_with_scope_is_true() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("auth.json"),
            r#"{"https://auth.x.ai":{"tokens":{"access_token":"t"}}}"#,
        )
        .unwrap();
        assert!(auth_json_has_entries(dir.path()));
    }

    #[test]
    fn model_api_key_counts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            r#"
[model.glm]
model = "z-ai/glm-5.2"
api_key = "sk-test"
system_prompt_label = "Arcus Build"
"#,
        )
        .unwrap();
        assert!(config_has_resolvable_model_key(&path));
    }

    #[test]
    fn model_env_key_unset_is_false() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // Use a nonsense env name that cannot be set in CI accidentally.
        fs::write(
            &path,
            r#"
[model.glm]
model = "z-ai/glm-5.2"
env_key = "ARCUS_WIZARD_TEST_ENV_KEY_UNSET_ZZZ"
system_prompt_label = "Arcus Build"
"#,
        )
        .unwrap();
        assert!(!config_has_resolvable_model_key(&path));
    }

    #[test]
    fn setup_on_first_run_false_parsed() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(
            &path,
            "[agent]\nsetup_on_first_run = false\nname = \"x\"\n",
        )
        .unwrap();
        assert_eq!(read_setup_on_first_run(&path), Some(false));
    }

    #[test]
    fn setup_on_first_run_absent_is_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[agent]\nname = \"x\"\n").unwrap();
        assert_eq!(read_setup_on_first_run(&path), None);
    }
}
