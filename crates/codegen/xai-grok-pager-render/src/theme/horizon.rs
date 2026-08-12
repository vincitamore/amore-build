//! Horizon theme — mirrored from the iris app's default palette.
//!
//! The iris dash (`instruments/iris/packages/tui/src/theme.ts`) ships Horizon
//! as its default theme. This is the pager's copy of that palette, by value —
//! the way the dash itself mirrors the GUI theme system. It is a dark theme:
//! rose is the brand accent (user turn, error, active border), green is
//! success/live, cyan is information (assistant, thinking, code, links), and
//! the indigo `muted` carries the secondary-text ramp.

use ratatui::style::{Color, Modifier};

use super::tokyonight::Theme;

/// Helper for concise const `Color::Rgb` definitions.
const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

/// Horizon palette — the six core semantic colors are the exact iris values;
/// the rest are derived tones within the same hue families.
#[allow(dead_code)]
mod palette {
    use super::*;

    // ── Backgrounds ─────────────────────────────────────────────────────
    // base #1c1e26; border/selection #2e303e; one and two steps up for
    // elevated, hover, and code surfaces; sunken surfaces sit near base.
    pub const BG_TERMINAL: Color = rgb(28, 30, 38); // #1c1e26 — iris background
    pub const BG_BASE: Color = rgb(28, 30, 38); // #1c1e26 — main bg
    pub const BG_LIGHT: Color = rgb(36, 38, 50); // #242632 — elevated surface
    pub const BG_DARK: Color = rgb(32, 34, 45); // #20222d — code / sunken
    pub const BG_HIGHLIGHT: Color = rgb(46, 48, 62); // #2e303e — iris border/selection
    pub const BG_HOVER: Color = rgb(53, 56, 71); // #353847 — hover
    pub const BG_VISUAL: Color = rgb(58, 61, 78); // #3a3d4e — visual selection (one step above highlight)

    // ── Text / grays ────────────────────────────────────────────────────
    pub const FG: Color = rgb(213, 216, 218); // #d5d8da — iris foreground
    pub const FG_DARK: Color = rgb(154, 160, 180); // #9aa0b4 — secondary text
    pub const MUTED: Color = rgb(108, 111, 147); // #6c6f93 — iris muted (indigo)
    pub const DIM: Color = rgb(79, 83, 104); // #4f5368 — dim, below muted

    // ── Accents ─────────────────────────────────────────────────────────
    pub const ROSE: Color = rgb(233, 86, 120); // #e95678 — iris primary/error/borderActive
    pub const GREEN: Color = rgb(41, 211, 152); // #29d398 — iris accent/success
    pub const CYAN: Color = rgb(38, 187, 217); // #26bbd9 — iris info
    pub const PEACH: Color = rgb(250, 183, 149); // #fab795 — iris secondary/warning
    pub const PATH_AMBER: Color = rgb(212, 147, 110); // #d4936e — warm path
    pub const SYSTEM_INDIGO: Color = rgb(138, 143, 176); // #8a8fb0 — system blue-gray
    pub const PLAN_PEACH: Color = rgb(224, 185, 138); // #e0b98a — plan gold-peach

    pub const RED_DARK: Color = rgb(58, 22, 34); // #3a1622 — diff delete bg
    pub const GREEN_DARK: Color = rgb(15, 46, 36); // #0f2e24 — diff insert bg
}
use palette::*;

impl Theme {
    /// Horizon theme — the iris app's default palette, ported to the pager.
    ///
    /// Dark, rose-accented, truecolor. Colors are defined in RGB; call
    /// [`Theme::quantized`] to downgrade to the terminal's color level.
    pub const fn horizon() -> Self {
        Self {
            bg_base: BG_BASE,
            bg_light: BG_LIGHT,
            bg_dark: BG_DARK,
            bg_highlight: BG_HIGHLIGHT,
            bg_hover: BG_HOVER,
            bg_terminal: BG_TERMINAL,

            accent_user: ROSE,
            accent_assistant: CYAN,
            accent_thinking: CYAN,
            accent_tool: MUTED,
            accent_system: SYSTEM_INDIGO,
            accent_error: ROSE,
            accent_success: GREEN,
            accent_running: GREEN,
            accent_skill: CYAN,

            text_primary: FG,
            text_secondary: FG_DARK,

            gray_dim: DIM,
            gray: MUTED,
            gray_bright: FG_DARK,

            command: PEACH,
            path: PATH_AMBER,
            running: CYAN,
            warning: PEACH,

            fuzzy_accent: CYAN,

            accent_plan: PLAN_PEACH,

            accent_verify: GREEN,

            accent_remember: GREEN,

            selection_border: BG_HIGHLIGHT,
            prompt_border: BG_HIGHLIGHT,
            prompt_border_active: ROSE,
            hover_border: BG_HOVER,

            accent_model: CYAN,

            scrollbar_bg: BG_DARK,
            scrollbar_fg: BG_HOVER,

            diff_delete_bg: RED_DARK,
            diff_delete_fg: ROSE,
            diff_insert_bg: GREEN_DARK,
            diff_insert_fg: GREEN,
            diff_equal_fg: MUTED,
            diff_gutter_fg: MUTED,

            bg_visual: BG_VISUAL,

            paste_bg: BG_DARK,
            paste_fg: FG,
            paste_dim: MUTED,

            md_heading_h1: ROSE,
            md_heading_h1_mod: Modifier::BOLD,
            md_heading_h2: CYAN,
            md_heading_h2_mod: Modifier::BOLD,
            md_heading_h3: GREEN,
            md_heading_h3_mod: Modifier::BOLD,
            md_heading_h4: FG_DARK,
            md_heading_h4_mod: Modifier::BOLD,
            md_heading_h5: MUTED,
            md_heading_h5_mod: Modifier::BOLD,
            md_heading_h6: DIM,
            md_heading_h6_mod: Modifier::empty(),
            md_code: CYAN,
            md_task_checked: GREEN,
            md_task_unchecked: FG_DARK,
            md_muted: MUTED,
            md_code_bg: BG_DARK,
            md_text: FG,
            link_fg: CYAN,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horizon_is_dark_with_distinct_accents() {
        let t = Theme::horizon();
        assert!(t.is_dark());
        // The iris brand rose is the user accent and the error color.
        assert!(matches!(t.accent_user, Color::Rgb(233, 86, 120)));
        assert!(matches!(t.accent_error, Color::Rgb(233, 86, 120)));
        // Assistant reads cyan (info), success reads green (accent).
        assert!(matches!(t.accent_assistant, Color::Rgb(38, 187, 217)));
        assert!(matches!(t.accent_success, Color::Rgb(41, 211, 152)));
        assert_ne!(t.accent_user, t.accent_assistant);
    }
}