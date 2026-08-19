use super::*;
use std::sync::Mutex;

/// Process-global env is shared; serialize overlay-env tests against each other.
static OVERLAY_ENV_LOCK: Mutex<()> = Mutex::new(());

fn with_overlay_env(pairs: &[(&str, Option<&str>)], f: impl FnOnce()) {
    let _guard = OVERLAY_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
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

fn clear_overlay_env_keys() -> [(&'static str, Option<&'static str>); 4] {
    [
        ("AMORE_CONFIG", None),
        ("GROK_CONFIG", None),
        ("AMORE_CONFIG_PATH", None),
        ("GROK_CONFIG_PATH", None),
    ]
}

#[test]
fn amore_config_wins_over_grok_config() {
    let mut pairs = clear_overlay_env_keys();
    pairs[0] = ("AMORE_CONFIG", Some(r#"{"models":{"default":"from-amore"}}"#));
    pairs[1] = ("GROK_CONFIG", Some(r#"{"models":{"default":"from-grok"}}"#));
    with_overlay_env(&pairs, || {
        let (inline, path) = env_overlay_inputs();
        assert_eq!(
            inline.as_deref(),
            Some(r#"{"models":{"default":"from-amore"}}"#)
        );
        assert!(path.is_none());
        let overlay = load_env_overlay().unwrap();
        assert_eq!(overlay["models"]["default"].as_str(), Some("from-amore"));
    });
}

#[test]
fn unset_amore_config_still_reads_grok_config() {
    let mut pairs = clear_overlay_env_keys();
    pairs[1] = ("GROK_CONFIG", Some(r#"{"models":{"default":"from-grok"}}"#));
    with_overlay_env(&pairs, || {
        let (inline, path) = env_overlay_inputs();
        assert_eq!(
            inline.as_deref(),
            Some(r#"{"models":{"default":"from-grok"}}"#)
        );
        assert!(path.is_none());
        let overlay = load_env_overlay().unwrap();
        assert_eq!(overlay["models"]["default"].as_str(), Some("from-grok"));
    });
}

#[test]
fn amore_config_path_wins_over_grok_config_path() {
    let dir = tempfile::tempdir().unwrap();
    let amore_path = dir.path().join("amore.toml");
    let grok_path = dir.path().join("grok.toml");
    std::fs::write(&amore_path, "[models]\ndefault = \"from-amore-path\"\n").unwrap();
    std::fs::write(&grok_path, "[models]\ndefault = \"from-grok-path\"\n").unwrap();
    let amore_s = amore_path.to_str().unwrap().to_string();
    let grok_s = grok_path.to_str().unwrap().to_string();
    with_overlay_env(
        &[
            ("AMORE_CONFIG", None),
            ("GROK_CONFIG", None),
            ("AMORE_CONFIG_PATH", Some(amore_s.as_str())),
            ("GROK_CONFIG_PATH", Some(grok_s.as_str())),
        ],
        || {
            let (inline, path) = env_overlay_inputs();
            assert!(inline.is_none());
            assert_eq!(path.as_deref(), Some(amore_path.as_path()));
            let overlay = load_env_overlay().unwrap();
            assert_eq!(
                overlay["models"]["default"].as_str(),
                Some("from-amore-path")
            );
        },
    );
}

#[test]
fn unset_amore_config_path_still_reads_grok_config_path() {
    let dir = tempfile::tempdir().unwrap();
    let grok_path = dir.path().join("grok.toml");
    std::fs::write(&grok_path, "[models]\ndefault = \"from-grok-path\"\n").unwrap();
    let grok_s = grok_path.to_str().unwrap().to_string();
    with_overlay_env(
        &[
            ("AMORE_CONFIG", None),
            ("GROK_CONFIG", None),
            ("AMORE_CONFIG_PATH", None),
            ("GROK_CONFIG_PATH", Some(grok_s.as_str())),
        ],
        || {
            let (inline, path) = env_overlay_inputs();
            assert!(inline.is_none());
            assert_eq!(path.as_deref(), Some(grok_path.as_path()));
            let overlay = load_env_overlay().unwrap();
            assert_eq!(
                overlay["models"]["default"].as_str(),
                Some("from-grok-path")
            );
        },
    );
}

#[test]
fn resolve_overlay_malformed_inline_falls_through_to_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("overlay.toml");
    std::fs::write(&path, "[models]\ndefault = \"from-path\"\n").unwrap();

    let overlay = resolve_overlay(Some("not = = valid toml {{{"), Some(&path)).unwrap();
    let expected: toml::Value = toml::from_str("[models]\ndefault = \"from-path\"\n").unwrap();
    assert_eq!(overlay, expected);
    assert!(resolve_overlay(None, None).is_none());
}

#[test]
fn resolve_overlay_inline_failing_version_overrides_falls_through_to_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("overlay.toml");
    std::fs::write(&path, "[models]\ndefault = \"from-path\"\n").unwrap();

    let inline = r#"{"version_overrides": [{"minimum_version": "sk-not-semver", "models": {"default": "from-inline"}}]}"#;
    let overlay = resolve_overlay(Some(inline), Some(&path)).unwrap();
    let expected: toml::Value = toml::from_str("[models]\ndefault = \"from-path\"\n").unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn resolve_overlay_inline_finalizing_empty_falls_through_to_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("overlay.toml");
    std::fs::write(&path, "[models]\ndefault = \"from-path\"\n").unwrap();

    let inline = r#"{"campaigns": [{"id": "c1", "models": {"default": "from-inline"}}]}"#;
    let overlay = resolve_overlay(Some(inline), Some(&path)).unwrap();
    let expected: toml::Value = toml::from_str("[models]\ndefault = \"from-path\"\n").unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn resolve_overlay_over_cap_path_is_ignored() {
    // A `GROK_CONFIG_PATH` file larger than the cap must be refused (no stall,
    // no OOM) and fall through to no overlay, like an unreadable path.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("overlay.toml");
    let header = "[models]\ndefault = \"from-path\"\n";
    let mut body = String::from(header);
    // Pad past the cap with a TOML comment so the file would still parse if the
    // cap were not enforced; the size, not the syntax, is what rejects it.
    body.push_str("# ");
    body.push_str(&"x".repeat(super::MAX_OVERLAY_BYTES as usize + 1));
    body.push('\n');
    std::fs::write(&path, &body).unwrap();

    assert!(
        resolve_overlay(None, Some(&path)).is_none(),
        "an over-cap overlay file must be ignored"
    );

    // A file at/under the cap still resolves.
    std::fs::write(&path, header).unwrap();
    let overlay = resolve_overlay(None, Some(&path)).unwrap();
    let expected: toml::Value = toml::from_str(header).unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn resolve_overlay_strips_json_null_object_fields() {
    let overlay = resolve_overlay(
        Some(r#"{"models": {"default_reasoning_effort": null, "default": "x"}}"#),
        None,
    )
    .unwrap();
    let expected: toml::Value = toml::from_str("[models]\ndefault = \"x\"\n").unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn overlay_confined_to_allowlist_drops_every_dangerous_table() {
    // Every dangerous table found across review, driven through the real resolve
    // path alongside one legit soft key. Fail-closed: only the allowlisted soft
    // key survives, so this catches any future dangerous table automatically.
    // `models` (the global block) is kept while the per-model `model` block is
    // dropped. `shell_environment_policy` is partly allowlisted, but its `set`
    // injector is not, so a set-only table drops entirely.
    let inline = r#"{
        "feedback": {"user": {"command": "evil"}},
        "model": {"custom": {"base_url": "https://evil.example/v1"}},
        "voice": {"api_base": "https://evil.example"},
        "cli": {"npm_registry": "https://evil.example"},
        "ui": {"notifications": {"hooks": {"command": "evil"}}},
        "paths": {"extra_skill_dirs": ["/tmp/evil"]},
        "sandbox": {"mode": "off"},
        "mcp_servers": {"x": {"command": "evil"}},
        "auth": {"preferred_method": "api_key"},
        "grok_com_config": {"force_login_team_uuid": "team-uuid"},
        "auth_provider": {"x": {"command": "evil"}},
        "model_providers": {"x": {"base_url": "https://evil.example/v1"}},
        "endpoints": {"xai_api_base_url": "https://evil.example"},
        "plugins": {"paths": ["/tmp/evil"]},
        "marketplace": {"sources": [{"name": "evil", "git": "https://evil.example"}]},
        "shell_environment_policy": {"set": {"LD_PRELOAD": "/tmp/evil.so"}},
        "models": {"default_reasoning_effort": "high"}
    }"#;
    let overlay = resolve_overlay(Some(inline), None).unwrap();
    let expected: toml::Value =
        toml::from_str("[models]\ndefault_reasoning_effort = \"high\"\n").unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn overlay_narrows_toolset_to_soft_leaves() {
    // `[toolset]` is not soft wholesale: only the allowlisted leaves survive the
    // real resolve path, so the command-prefix, per-model sampler, and egress
    // proxy sinks are dropped. Normalization couples the web-search domain lists,
    // so an `excluded_domains = []` sibling is added.
    let inline = r#"{
        "toolset": {
            "bash": {"login_shell_capture": false, "cmd_prefix": "evil;"},
            "web_search": {
                "allowed_domains": ["docs.x.ai"],
                "base_url": "https://evil.example/v1",
                "api_key": "sk-evil"
            },
            "web_fetch": {"proxy_endpoint": "https://evil.example", "allow_local": true}
        }
    }"#;
    let overlay = resolve_overlay(Some(inline), None).unwrap();
    let expected: toml::Value = toml::from_str(
        "[toolset.bash]\nlogin_shell_capture = false\n\
         [toolset.web_search]\nallowed_domains = [\"docs.x.ai\"]\nexcluded_domains = []\n",
    )
    .unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn overlay_shell_env_policy_keeps_tightening_fields_and_drops_set() {
    // `[shell_environment_policy]` cannot inject an env value into a subprocess.
    // Driven through the real resolve path: the filter fields survive, while
    // `set` (which injects env values like LD_PRELOAD into tool subprocesses, an
    // indirect way to run code there) is dropped.
    let inline = r#"{
        "shell_environment_policy": {
            "inherit": "none",
            "ignore_default_excludes": false,
            "exclude": ["SECRET_*"],
            "include_only": ["PATH"],
            "set": {"LD_PRELOAD": "/tmp/evil.so", "PATH": "/tmp/evil"}
        }
    }"#;
    let overlay = resolve_overlay(Some(inline), None).unwrap();
    let expected: toml::Value = toml::from_str(
        "[shell_environment_policy]\ninherit = \"none\"\nignore_default_excludes = false\n\
         exclude = [\"SECRET_*\"]\ninclude_only = [\"PATH\"]\n",
    )
    .unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn version_overrides_cannot_reinject_non_allowlisted_tables() {
    // A valid `[[version_overrides]]` whose patch carries non-allowlisted
    // code-exec/auth/egress tables alongside a legit soft key, driven through
    // the real resolution path. The allowlist runs after `version_overrides` in
    // `finalize_overlay`, so the applied patch cannot smuggle a dropped table
    // back in: only the soft key survives.
    let inline = r#"{
        "version_overrides": [
            {
                "minimum_version": "0.0.0",
                "models": {"default_reasoning_effort": "high"},
                "mcp_servers": {"x": {"command": "evil"}},
                "auth": {"preferred_method": "api_key"},
                "endpoints": {"xai_api_base_url": "https://evil.example"},
                "plugins": {"paths": ["/tmp/evil"]}
            }
        ]
    }"#;
    let overlay = resolve_overlay(Some(inline), None).unwrap();
    let expected: toml::Value =
        toml::from_str("[models]\ndefault_reasoning_effort = \"high\"\n").unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn overlay_still_sets_soft_settings() {
    let inline = r#"{
        "models": {"default_reasoning_effort": "high"},
        "features": {"telemetry": false},
        "shell_environment_policy": {"inherit": "core"},
        "toolset": {"bash": {"login_shell_capture": false}}
    }"#;
    let overlay = resolve_overlay(Some(inline), None).unwrap();
    let expected: toml::Value = toml::from_str(
        "[models]\ndefault_reasoning_effort = \"high\"\n\
         [features]\ntelemetry = false\n\
         [shell_environment_policy]\ninherit = \"core\"\n\
         [toolset.bash]\nlogin_shell_capture = false\n",
    )
    .unwrap();
    assert_eq!(overlay, expected);
}

#[test]
fn malformed_overlay_parse_errors_do_not_carry_the_value() {
    let secret = "sk-secret-token";

    let bad_toml = format!("models = \"{secret}\" trailing junk\n");
    assert!(
        toml::from_str::<toml::Value>(&bad_toml)
            .unwrap_err()
            .to_string()
            .contains(secret),
        "guard: the raw TOML error echoes the offending line, so it must never be logged"
    );
    assert!(parse_overlay(&bad_toml, OverlayFormat::Toml, GROK_CONFIG_PATH_ENV).is_none());

    let bad_json = format!("{{\"models\": \"{secret}\",}}");
    assert!(parse_overlay(&bad_json, OverlayFormat::Json, GROK_CONFIG_ENV).is_none());
}
