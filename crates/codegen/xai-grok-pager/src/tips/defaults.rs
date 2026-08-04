//! Fork-owned default tip-of-the-day strings for the welcome screen.
//!
//! Upstream serves tips from the remote settings endpoint
//! (`RemoteSettings.tips`, fetched from `/v1/settings`), so when that source
//! is empty — offline, unreachable, or a provider that sends none — the fork
//! falls back to this compiled-in list rather than showing nothing.
//!
//! These are **Amore** tips: they teach real keystrokes, config keys, and
//! commands of this fork, and they carry zero Grok/GROK branding (the product
//! is Amore Build). Every string was verified against the fork tree and the
//! user guide on 2026-08-03; see
//! `forge/output/amore-tips/curated-tips.md` in the house tree for the
//! verification trail.
//!
//! Constraints (load-bearing):
//! - One line of plain text, no markdown. The welcome render wraps past the
//!   content width, so one short line is the target (all are ≤ ~70 chars).
//! - `[cli] show_tips = false` still suppresses all tips — the fallback is
//!   only consulted when the merged list is empty for other reasons, and the
//!   seed site checks the explicit kill switch first.

/// The fork's default tip-of-the-day rotation, in display order.
///
/// The rotation is a cycle (`pick_and_advance` advances a persisted cursor),
/// so order only matters aesthetically; the first handful are the ones a new
/// user sees first.
pub const DEFAULT_TIPS: &[&str] = &[
    "system_prompt_label names the harness, never the model",
    "Custom [model.*] blocks need system_prompt_label set",
    "Prefer env_key over api_key in ~/.amore/config.toml",
    "amore init --refresh never clobbers your house edits",
    "Auto-update is hard-off; install new amore builds yourself",
    "In multiline mode, Enter is newline and Shift+Enter sends.",
    "Alt+V pastes screenshots into the prompt on Windows.",
    "Ctrl+B backgrounds the running foreground command",
    "Shift+Tab cycles Normal, Plan, then Always-approve",
    "Put .rhai scripts in .amore/workflows/; run /workflow name",
    "Pin always-approve: [ui] permission_mode = \"always-approve\"",
    "amore -p \"prompt\" runs headless with full tool access",
    "Ctrl+Z undoes a wiped prompt draft.",
    "@path:10-50 attaches only those lines, not the whole file",
    "Prefix @ with ! to attach gitignored or dotfiles",
    "Left/Right fold or expand the selected scrollback entry.",
    "Shift+Left/Right jump to the previous or next turn.",
];

/// Apply the fork's compiled-in defaults as a backstop to a merged tip list.
///
/// Returns `merged` unchanged when it is non-empty (any source — remote,
/// requirements, user, or managed — provided tips), and when the user has
/// explicitly disabled tips via `[cli] show_tips = false` in the requirements
/// or user layer (the same kill switches `resolve_tips` honors). Otherwise —
/// the merged list is empty for other reasons (offline, unreachable remote,
/// provider sends none) — returns the fork's [`DEFAULT_TIPS`] as strings.
///
/// This is the single place the backstop decision lives, so both resolve
/// sites (startup and live remote-settings re-resolve) behave identically.
pub fn apply_fork_defaults(
    merged: Vec<String>,
    requirements: Option<&toml::Value>,
    user_config: Option<&toml::Value>,
) -> Vec<String> {
    if !merged.is_empty() {
        return merged;
    }
    use xai_grok_shell::util::config::show_tips_from_toml_opt;
    if requirements.and_then(show_tips_from_toml_opt) == Some(false)
        || user_config.and_then(show_tips_from_toml_opt) == Some(false)
    {
        return merged;
    }
    DEFAULT_TIPS.iter().map(|s| s.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_single_lines_within_welcome_width() {
        // The welcome render wraps past `content_width`; a default that
        // exceeds it just wraps, but the design target is one line. The
        // renderer prefixes "Tip: " (5 chars), so cap the tip text itself
        // well under a typical 80-col content width.
        for tip in DEFAULT_TIPS {
            assert!(
                !tip.contains('\n'),
                "tip must be a single line: {tip:?}"
            );
            assert!(
                tip.chars().count() <= 70,
                "tip too long for one welcome line ({} chars): {tip:?}",
                tip.chars().count()
            );
        }
    }

    #[test]
    fn defaults_carry_no_grok_branding() {
        // Product-native: these are Amore tips. The crate itself is named
        // xai-grok-* (upstream seam), but the *strings* must not name Grok.
        for tip in DEFAULT_TIPS {
            let lower = tip.to_lowercase();
            assert!(
                !lower.contains("grok"),
                "tip must not name Grok: {tip:?}"
            );
        }
    }

    #[test]
    fn defaults_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for tip in DEFAULT_TIPS {
            assert!(seen.insert(*tip), "duplicate default tip: {tip:?}");
        }
    }

    #[test]
    fn backstop_keeps_nonempty_merged_list() {
        let merged = vec!["a".to_string(), "b".to_string()];
        let out = apply_fork_defaults(merged.clone(), None, None);
        assert_eq!(out, merged, "non-empty merged list must pass through");
    }

    #[test]
    fn backstop_seeds_defaults_when_empty() {
        let out = apply_fork_defaults(Vec::new(), None, None);
        assert_eq!(out.len(), DEFAULT_TIPS.len());
        assert_eq!(out[0], DEFAULT_TIPS[0]);
    }

    #[test]
    fn backstop_respects_show_tips_false_in_requirements() {
        let req: toml::Value = toml::from_str("[cli]\nshow_tips = false\n").unwrap();
        let out = apply_fork_defaults(Vec::new(), Some(&req), None);
        assert!(out.is_empty(), "show_tips=false must suppress defaults");
    }

    #[test]
    fn backstop_respects_show_tips_false_in_user_config() {
        let user: toml::Value = toml::from_str("[cli]\nshow_tips = false\n").unwrap();
        let out = apply_fork_defaults(Vec::new(), None, Some(&user));
        assert!(out.is_empty(), "user show_tips=false must suppress defaults");
    }
}
