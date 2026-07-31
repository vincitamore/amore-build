//! Logo component — renders the braille art logo.
//!
//! Hidden entirely on legacy Windows consoles: the U+2800 braille block is
//! not covered by the ConHost raster fonts and would render as tofu.

use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};

use crate::render::color::blend_color;
use crate::theme::Theme;

/// Braille art paired with its per-cell hue map. Both are generated together
/// by `scripts/gen_arcus.py` and must stay in lockstep: the hue file has one
/// character per cell (`0`–`6` naming a band, `.` for an unlit cell) on lines
/// padded to the same width as the art.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Art {
    cells: &'static str,
    hues: &'static str,
}

const LOGO: Art = Art {
    cells: include_str!("../../../assets/logo/logo07.txt"),
    hues: include_str!("../../../assets/logo/logo07.hue.txt"),
};
const LOGO_SMALL: Art = Art {
    cells: include_str!("../../../assets/logo/logo05.txt"),
    hues: include_str!("../../../assets/logo/logo05.hue.txt"),
};

/// Primary-bow palette, outermost band first — red outside, violet inside, the
/// way a real bow orders them. Indices match the digits in the hue map.
const BOW: [(u8, u8, u8); 7] = [
    (219, 78, 66),   // red
    (226, 132, 51),  // orange
    (222, 188, 62),  // yellow
    (104, 184, 96),  // green
    (72, 148, 219),  // blue
    (88, 101, 196),  // indigo
    (150, 94, 201),  // violet
];

/// Resting scale for a band color — the logo sits at this dimmed level between
/// shine sweeps, so the art reads as colored rather than glaring.
const REST: f32 = 0.58;
/// How far the shine peak lifts a band toward white.
const LIFT: f32 = 0.42;

/// Quantize `c` to the 256-color palette when the theme has been quantized —
/// an `Indexed` theme color is the signal that the terminal cannot take raw
/// RGB. Blending fully toward `c` against an indexed base reuses
/// `blend_color`'s own quantization rather than duplicating it.
fn adapt(theme: &Theme, c: Color) -> Color {
    match theme.gray {
        Color::Indexed(_) => blend_color(Color::Indexed(0), c, 1.0).unwrap_or(c),
        _ => c,
    }
}

/// Resting and full-shine colors for hue digit `h`.
fn band_colors(theme: &Theme, h: u8) -> (Color, Color) {
    let (r, g, b) = BOW[(h as usize).min(BOW.len() - 1)];
    let dim = |v: u8| (v as f32 * REST) as u8;
    let lift = |v: u8| (v as f32 + (255.0 - v as f32) * LIFT) as u8;
    (
        adapt(theme, Color::Rgb(dim(r), dim(g), dim(b))),
        adapt(theme, Color::Rgb(lift(r), lift(g), lift(b))),
    )
}

/// Height at or above which the small logo is shown (below it, no logo).
const SMALL_LOGO_MIN_HEIGHT: u16 = 22;
/// Height at or above which the full logo is shown.
const FULL_LOGO_MIN_HEIGHT: u16 = 26;

fn pick_logo(window_height: u16) -> Option<Art> {
    pick_logo_for(window_height, logo_hidden())
}

/// Pure tier selection so tests can drive the legacy-console flag directly.
fn pick_logo_for(window_height: u16, hidden: bool) -> Option<Art> {
    if hidden || window_height < SMALL_LOGO_MIN_HEIGHT {
        None
    } else if window_height < FULL_LOGO_MIN_HEIGHT {
        Some(LOGO_SMALL)
    } else {
        Some(LOGO)
    }
}

/// The braille art has no ASCII stand-in; see the module doc.
fn logo_hidden() -> bool {
    crate::glyphs::is_legacy_windows_console()
}

fn non_empty_lines(logo: &str) -> impl Iterator<Item = &str> {
    logo.lines().filter(|l| !l.is_empty())
}

fn count_lines(logo: &str) -> u16 {
    non_empty_lines(logo).count() as u16
}

fn visual_width(logo: &str) -> u16 {
    non_empty_lines(logo)
        .map(unicode_width::UnicodeWidthStr::width)
        .max()
        .unwrap_or(24) as u16
}

/// Animation phase in seconds since the first render. Wall-clock based so the
/// shimmer speed is independent of the frame rate.
fn anim_phase_secs() -> f32 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f32()
}

/// Shimmer redraw cadence in frames per second. The sweep is slow, so a few fps
/// looks smooth while sparing the long-lived welcome screen from full-rate
/// repaints.
const SHIMMER_FPS: f32 = 12.0;

/// Quantized shimmer frame for the current wall-clock phase. The welcome screen
/// redraws only when this advances, throttling the animation to ~`SHIMMER_FPS`
/// rather than the full event-loop tick rate. Pinned to 0 when the logo is
/// hidden.
pub fn shimmer_frame() -> u64 {
    if logo_hidden() {
        return 0;
    }
    (anim_phase_secs() * SHIMMER_FPS) as u64
}

/// Per-glyph shine opacity in `[0, 1]` at normalized diagonal position `diag`
/// (0 = bottom-left .. 1 = top-right) and animation time `secs`. A raised-cosine
/// band sweeps bottom-left → top-right and parks off-screen between sweeps; a
/// gentle global pulse breathes underneath it. 0 keeps the resting gray, 1 is
/// full bright.
fn shine_opacity(diag: f32, secs: f32) -> f32 {
    const BAND: f32 = 0.38; // half-width of the shine band — wider = more gradual falloff
    const CYCLE: f32 = 4.0; // seconds per sweep + rest
    const SWEEP_FRAC: f32 = 0.32; // portion of the cycle spent sweeping (~1.3s glint, rest idles)
    const SHINE: f32 = 0.33; // peak shine strength
    const PULSE: f32 = 0.06; // global breathing amount
    const PULSE_SECS: f32 = 5.0; // breathing period

    let p = (secs % CYCLE) / CYCLE;
    let q = (p / SWEEP_FRAC).min(1.0); // parks the band off-screen during the rest
    let band_pos = -BAND + q * (1.0 + 2.0 * BAND);
    let pulse = PULSE * (0.5 - 0.5 * (std::f32::consts::TAU * secs / PULSE_SECS).cos());

    let d = (diag - band_pos).abs();
    let shine = if d < BAND {
        0.5 * (1.0 + (std::f32::consts::PI * d / BAND).cos())
    } else {
        0.0
    };
    (pulse + SHINE * shine).clamp(0.0, 1.0)
}

fn render_into(area: Rect, buf: &mut Buffer, theme: &Theme, logo: Art) {
    let lines: Vec<&str> = non_empty_lines(logo.cells).collect();
    let hue_rows: Vec<Vec<u8>> = non_empty_lines(logo.hues)
        .map(|l| {
            l.chars()
                .map(|c| c.to_digit(10).map_or(u8::MAX, |d| d as u8))
                .collect()
        })
        .collect();
    let rows = lines.len().max(1) as f32;
    let cols = lines
        .iter()
        .map(|l| l.chars().count())
        .max()
        .unwrap_or(1)
        .max(1) as f32;
    let secs = anim_phase_secs();

    // Each glyph belongs to a band of the bow and blends from that band's
    // resting color toward its lit color by the shine opacity, so the sweep
    // reads as light moving through the colors rather than a gray sheen.
    // Adjacent glyphs that land on the same blended color share one Span to
    // hold down the per-frame allocation.
    let logo_lines: Vec<Line> = lines
        .iter()
        .enumerate()
        .map(|(row, line)| {
            let mut spans: Vec<Span> = Vec::new();
            let mut run = String::new();
            let mut run_color: Option<Color> = None;
            for (col, ch) in line.chars().enumerate() {
                // Sweep along the bottom-left → top-right diagonal: the
                // coordinate grows as col increases and row decreases.
                let diag = (col as f32 + (rows - 1.0 - row as f32)) / (cols + rows);
                // An unlit cell (`.` in the hue map, or a hue map shorter than
                // the art) keeps the theme gray; the glyph there is blank
                // anyway, so the color is never actually seen.
                let hue = hue_rows.get(row).and_then(|r| r.get(col)).copied();
                let color = match hue {
                    Some(h) if h < BOW.len() as u8 => {
                        let (rest, lit) = band_colors(theme, h);
                        blend_color(rest, lit, shine_opacity(diag, secs)).unwrap_or(rest)
                    }
                    _ => theme.gray,
                };
                if run_color != Some(color) {
                    if let Some(prev) = run_color {
                        spans.push(Span::styled(
                            std::mem::take(&mut run),
                            Style::default().fg(prev),
                        ));
                    }
                    run_color = Some(color);
                }
                run.push(ch);
            }
            if let Some(prev) = run_color {
                spans.push(Span::styled(run, Style::default().fg(prev)));
            }
            Line::from(spans).alignment(Alignment::Center)
        })
        .collect();
    Paragraph::new(logo_lines).render(area, buf);
}

pub fn logo_line_count(window_height: u16) -> u16 {
    pick_logo(window_height).map_or(0, |a| count_lines(a.cells))
}

pub fn logo_visual_width(window_height: u16) -> u16 {
    pick_logo(window_height).map_or(24, |a| visual_width(a.cells))
}

pub fn render_logo(area: Rect, buf: &mut Buffer, theme: &Theme, window_height: u16) {
    if let Some(logo) = pick_logo(window_height) {
        render_into(area, buf, theme, logo);
    }
}

/// The hero box always shows the full logo: it is laid out beside the menu, so
/// it fits whenever the box does. These report and render that logo directly,
/// independent of the height-based [`pick_logo`] tiers used by the stacked
/// layout. When [`logo_hidden`], they report 0 and render nothing.
pub fn full_logo_line_count() -> u16 {
    full_logo_line_count_for(logo_hidden())
}

fn full_logo_line_count_for(hidden: bool) -> u16 {
    if hidden { 0 } else { count_lines(LOGO.cells) }
}

pub fn full_logo_visual_width() -> u16 {
    full_logo_visual_width_for(logo_hidden())
}

fn full_logo_visual_width_for(hidden: bool) -> u16 {
    if hidden { 0 } else { visual_width(LOGO.cells) }
}

pub fn render_full_logo(area: Rect, buf: &mut Buffer, theme: &Theme) {
    if !logo_hidden() {
        render_into(area, buf, theme, LOGO);
    }
}

/// Line count of the small logo used in minimal's committed welcome card
/// (0 on a legacy Windows console, where the braille art is suppressed).
pub fn compact_logo_line_count() -> u16 {
    if logo_hidden() {
        0
    } else {
        count_lines(LOGO_SMALL.cells)
    }
}

/// Render the small braille logo (centered) into `area` for minimal's welcome
/// card. No-op when the logo is hidden.
pub fn render_compact_logo(area: Rect, buf: &mut Buffer, theme: &Theme) {
    if !logo_hidden() {
        render_into(area, buf, theme, LOGO_SMALL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_sizes_by_height() {
        assert!(pick_logo_for(SMALL_LOGO_MIN_HEIGHT - 1, false).is_none());
        assert_eq!(
            pick_logo_for(SMALL_LOGO_MIN_HEIGHT, false),
            Some(LOGO_SMALL)
        );
        assert_eq!(
            pick_logo_for(FULL_LOGO_MIN_HEIGHT - 1, false),
            Some(LOGO_SMALL)
        );
        assert_eq!(pick_logo_for(FULL_LOGO_MIN_HEIGHT, false), Some(LOGO));
    }

    // The braille art has no legacy-safe stand-in, so every height tier must
    // collapse to no logo when the legacy-console flag is set.
    #[test]
    fn logo_hidden_on_legacy_console_at_every_height() {
        for h in [0, SMALL_LOGO_MIN_HEIGHT, FULL_LOGO_MIN_HEIGHT, u16::MAX] {
            assert!(pick_logo_for(h, true).is_none(), "height {h}");
        }
    }

    #[test]
    fn hero_box_always_uses_full_logo() {
        // The box renders the full logo regardless of height (it's laid out
        // beside the menu), and it's the large variant — never the small one.
        assert_eq!(full_logo_line_count_for(false), count_lines(LOGO.cells));
        assert_eq!(full_logo_visual_width_for(false), visual_width(LOGO.cells));
        assert!(full_logo_line_count_for(false) > count_lines(LOGO_SMALL.cells));
        assert!(full_logo_visual_width_for(false) > visual_width(LOGO_SMALL.cells));
    }

    #[test]
    fn full_logo_helpers_collapse_when_hidden() {
        assert_eq!(full_logo_line_count_for(true), 0);
        assert_eq!(full_logo_visual_width_for(true), 0);
    }

    #[test]
    fn compact_logo_line_count_matches_small_logo_when_visible() {
        // The minimal welcome card budgets exactly the small logo's rows. When
        // the logo isn't hidden, the count equals the small art's line count and
        // is strictly shorter than the full logo.
        if !logo_hidden() {
            assert_eq!(compact_logo_line_count(), count_lines(LOGO_SMALL.cells));
            assert!(compact_logo_line_count() < count_lines(LOGO.cells));
            assert!(compact_logo_line_count() > 0);
        } else {
            assert_eq!(compact_logo_line_count(), 0);
        }
    }

    // The art and its hue map are two files generated from one shape. Nothing
    // in the type system holds them together, so regenerating one without the
    // other would silently mis-color the bow — or drop it to gray — with every
    // other test still green. This is the pin.
    #[test]
    fn hue_map_matches_art_cell_for_cell() {
        for (name, art) in [("logo07", LOGO), ("logo05", LOGO_SMALL)] {
            let cells: Vec<&str> = non_empty_lines(art.cells).collect();
            let hues: Vec<&str> = non_empty_lines(art.hues).collect();
            assert_eq!(
                cells.len(),
                hues.len(),
                "{name}: art has {} rows, hue map has {}",
                cells.len(),
                hues.len()
            );
            for (row, (c, h)) in cells.iter().zip(&hues).enumerate() {
                let (cw, hw) = (c.chars().count(), h.chars().count());
                assert_eq!(cw, hw, "{name} row {row}: {cw} cells vs {hw} hues");
                for (col, (glyph, hue)) in c.chars().zip(h.chars()).enumerate() {
                    // U+2800 is the blank braille cell used for padding.
                    let lit = glyph != '\u{2800}';
                    let hued = hue != '.';
                    assert_eq!(
                        lit, hued,
                        "{name} row {row} col {col}: glyph {glyph:?} lit={lit} \
                         but hue {hue:?} hued={hued}"
                    );
                    if hued {
                        let d = hue.to_digit(10).unwrap_or(99) as usize;
                        assert!(d < BOW.len(), "{name} row {row} col {col}: band {d}");
                    }
                }
            }
        }
    }

    // The pty e2e probe asserts these two glyphs survive the terminal writer.
    // Regenerating the art with different geometry could drop them and turn
    // that test into a false negative about code-page handling.
    #[test]
    fn art_contains_the_pty_probe_glyphs() {
        for ch in ['⣷', '⣿'] {
            assert!(
                LOGO.cells.contains(ch),
                "logo07 lost the pty probe glyph {ch:?}"
            );
        }
    }

    #[test]
    fn shine_opacity_stays_in_unit_range() {
        let mut secs = 0.0;
        while secs < 10.0 {
            for i in 0..=20 {
                let diag = i as f32 / 20.0;
                let op = shine_opacity(diag, secs);
                assert!(
                    (0.0..=1.0).contains(&op),
                    "opacity {op} out of range at diag {diag}, secs {secs}"
                );
            }
            secs += 0.13;
        }
    }

    #[test]
    fn shine_band_sweeps_across() {
        // The brightest point along the diagonal advances left → right as the
        // sweep progresses through its active phase.
        let brightest = |secs: f32| -> f32 {
            (0..=100)
                .map(|i| i as f32 / 100.0)
                .max_by(|a, b| {
                    shine_opacity(*a, secs)
                        .partial_cmp(&shine_opacity(*b, secs))
                        .unwrap()
                })
                .unwrap()
        };
        let early = brightest(0.1);
        let mid = brightest(0.4);
        let late = brightest(0.7);
        assert!(early < mid, "early {early} should precede mid {mid}");
        assert!(mid < late, "mid {mid} should precede late {late}");
    }

    #[test]
    fn shine_rests_dim_between_sweeps() {
        // During the rest phase the band is parked off-screen, so an interior
        // glyph falls back to at most the gentle pulse — never full bright.
        let op = shine_opacity(0.5, 6.0); // secs % 4.0 = 2.0 → past SWEEP_FRAC, in the rest phase
        assert!(op < 0.2, "resting opacity {op} should stay dim");
    }
}
