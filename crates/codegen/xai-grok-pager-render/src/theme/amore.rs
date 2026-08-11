//! Amore theme — rain-dark ground, light resolved against it.
//!
//! A dark-only theme in the house of night themes: cool tinted backgrounds
//! like TokyoNight/Oscura. The ground is the storm side of the sky, which is
//! what a bow is always seen against; the accents are drawn off the bow
//! itself, blue where refraction bends hardest and gold for the incident
//! light that has not been divided yet.

use ratatui::style::{Color, Modifier};

use super::tokyonight::Theme;

/// Helper for concise const `Color::Rgb` definitions.
const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

// Amore palette — rain-dark blues, accents taken from the bow.
#[allow(dead_code)]
mod palette {
    use super::*;

    // ── Backgrounds ─────────────────────────────────────────────────────
    pub const BG: Color = rgb(11, 13, 20); // #0b0d14 — terminal bg
    pub const BG_STORM_DARK: Color = rgb(14, 17, 32); // #0e1120 — darkest surface
    pub const BG_STORM: Color = rgb(17, 20, 31); // #11141f — main bg
    pub const BG_HIGHLIGHT: Color = rgb(29, 34, 51); // #1d2233 — highlight bg
    pub const BG_CODE: Color = rgb(24, 30, 46); // #181e2e — lighter than base, code blocks
    pub const BG_HOVER: Color = rgb(37, 44, 64); // #252c40
    pub const BG_VISUAL: Color = rgb(44, 52, 74); // #2c344a

    // ── Text / grays ────────────────────────────────────────────────────
    pub const FG: Color = rgb(211, 218, 240); // #d3daf0 — rain-light, primary text
    pub const FG_DARK: Color = rgb(173, 182, 212); // #adb6d4 — secondary text
    pub const FG_GUTTER: Color = rgb(63, 69, 94); // #3f455e — dim
    pub const COMMENT: Color = rgb(97, 106, 138); // #616a8a — muted slate-blue
    pub const DARK3: Color = rgb(86, 95, 126); // #565f7e
    pub const DARK5: Color = rgb(124, 134, 166); // #7c86a6 — bright gray

    // ── Accents ─────────────────────────────────────────────────────────
    pub const GOLD: Color = rgb(217, 198, 155); // #d9c69b — user; the incident light
    // Blue refracts hardest, which is why it rides the inner edge of a primary bow.
    pub const REFRACT: Color = rgb(159, 184, 242); // #9fb8f2 — assistant/thinking
    pub const STEEL: Color = rgb(114, 134, 168); // #7286a8 — system blue-gray
    pub const SKILL_BLUE: Color = rgb(143, 184, 216); // #8fb8d8 — skill accents
    pub const SOFT_RED: Color = rgb(229, 123, 140); // #e57b8c
    pub const SOFT_GREEN: Color = rgb(150, 201, 160); // #96c9a0
    pub const COMMAND_GOLD: Color = rgb(216, 184, 120); // #d8b878
    pub const PATH_AMBER: Color = rgb(201, 160, 110); // #c9a06e
    pub const RUNNING_CYAN: Color = rgb(159, 198, 216); // #9fc6d8
    pub const PLAN_GOLD: Color = rgb(224, 214, 168); // #e0d6a8
    pub const VERIFY_LILAC: Color = rgb(179, 162, 220); // #b3a2dc
    pub const REMEMBER_GREEN: Color = rgb(154, 194, 143); // #9ac28f
    pub const LINK_BLUE: Color = rgb(137, 174, 222); // #89aede
    pub const CODE_BLUE: Color = rgb(127, 168, 201); // #7fa8c9

    pub const RED_DARK: Color = rgb(58, 22, 32); // #3a1620 — diff delete bg
    pub const GREEN_DARK: Color = rgb(18, 48, 30); // #12301e — diff insert bg
}
use palette::*;

impl Theme {
    /// Amore theme — rain-dark ground; bow-blue accents, gold user accent.
    ///
    /// Colors are defined in RGB. Call [`Theme::quantized`] to downgrade
    /// them to the terminal's supported color level before rendering.
    pub const fn amore() -> Self {
        Self {
            bg_base: BG_STORM,
            bg_light: BG_HIGHLIGHT,
            bg_dark: BG_CODE, // lighter than bg_base for visible code blocks
            bg_highlight: BG_HIGHLIGHT,
            bg_hover: BG_HOVER,
            bg_terminal: BG,

            accent_user: GOLD,
            accent_assistant: REFRACT,
            accent_thinking: REFRACT,
            accent_tool: DARK5,
            accent_system: STEEL,
            accent_error: SOFT_RED,
            accent_success: SOFT_GREEN,
            accent_running: REFRACT,
            accent_skill: SKILL_BLUE,

            text_primary: FG,
            text_secondary: FG_DARK,

            gray_dim: rgb(82, 91, 120), // #525b78
            gray: COMMENT,
            gray_bright: DARK5,

            command: COMMAND_GOLD,
            path: PATH_AMBER,
            running: RUNNING_CYAN,
            warning: COMMAND_GOLD,

            fuzzy_accent: REFRACT,

            accent_plan: PLAN_GOLD,

            accent_verify: VERIFY_LILAC,

            accent_remember: REMEMBER_GREEN,

            selection_border: rgb(50, 57, 72),
            prompt_border: rgb(42, 48, 68),
            prompt_border_active: rgb(70, 80, 110),
            hover_border: rgb(28, 33, 48),

            accent_model: SKILL_BLUE,

            scrollbar_bg: BG_STORM_DARK,
            scrollbar_fg: BG_HIGHLIGHT,

            diff_delete_bg: RED_DARK,
            diff_delete_fg: SOFT_RED,
            diff_insert_bg: GREEN_DARK,
            diff_insert_fg: SOFT_GREEN,
            diff_equal_fg: COMMENT,
            diff_gutter_fg: COMMENT,

            bg_visual: BG_VISUAL,

            paste_bg: BG_STORM_DARK,
            paste_fg: FG_DARK,
            paste_dim: FG_GUTTER,

            md_heading_h1: REFRACT,
            md_heading_h1_mod: Modifier::BOLD,
            md_heading_h2: SKILL_BLUE,
            md_heading_h2_mod: Modifier::BOLD,
            md_heading_h3: VERIFY_LILAC,
            md_heading_h3_mod: Modifier::BOLD,
            md_heading_h4: DARK5,
            md_heading_h4_mod: Modifier::BOLD,
            md_heading_h5: COMMENT,
            md_heading_h5_mod: Modifier::BOLD,
            md_heading_h6: DARK3,
            md_heading_h6_mod: Modifier::empty(),
            md_code: CODE_BLUE,
            md_task_checked: SOFT_GREEN,
            md_task_unchecked: FG_DARK,
            md_muted: COMMENT,
            md_code_bg: BG_CODE,
            md_text: FG_DARK,
            link_fg: LINK_BLUE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amore_is_dark_with_distinct_accents() {
        let t = Theme::amore();
        assert!(t.is_dark());
        assert!(matches!(t.accent_user, Color::Rgb(217, 198, 155)));
        assert!(matches!(t.accent_assistant, Color::Rgb(159, 184, 242)));
        assert_ne!(t.accent_user, t.accent_assistant);
    }
}
