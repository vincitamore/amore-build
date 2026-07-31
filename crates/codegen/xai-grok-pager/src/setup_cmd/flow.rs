//! Guided setup flow: K3 provider → Grok native rail → Iris (opt-out).
//!
//! Interactive path is an auto-guided TUI screen (clear + numbered menus).
//! Headless path prints the same steps without reading stdin.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::state::{WizardState, WizardStatus};
use crate::iris_companion::detect_iris_on_path;

use super::writer::{
    ModelEntryPlan, iris_asset_shape, write_iris_pointer, write_model_entry,
};

/// Summary of what the wizard did (for the final screen + tests).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetupSummary {
    pub model: Option<ModelSummary>,
    pub grok_rail_note: Option<String>,
    pub iris: Option<IrisSummary>,
    pub skipped_steps: Vec<&'static str>,
    pub state_status: Option<WizardStatus>,
    pub config_path: Option<PathBuf>,
    pub state_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSummary {
    pub id: String,
    pub env_key: String,
    pub config_path: PathBuf,
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrisSummary {
    pub detected: bool,
    pub binary_path: Option<PathBuf>,
    pub pointer_path: Option<PathBuf>,
    pub asset_shape: String,
    pub planted: bool,
}

/// Runtime knobs (injectable for tests).
#[derive(Debug, Clone)]
pub struct FlowContext {
    pub home: PathBuf,
    pub dry_run: bool,
    /// When true, never read stdin — print headless steps only.
    pub headless: bool,
    pub stdin_is_terminal: bool,
    pub stdout_is_terminal: bool,
}

impl FlowContext {
    pub fn production(dry_run: bool, force_headless: bool) -> Self {
        use std::io::IsTerminal;
        let stdin_tty = std::io::stdin().is_terminal();
        let stdout_tty = std::io::stdout().is_terminal();
        Self {
            home: xai_grok_config::grok_home(),
            dry_run,
            headless: force_headless || !stdin_tty || !stdout_tty,
            stdin_is_terminal: stdin_tty,
            stdout_is_terminal: stdout_tty,
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.home.join("config.toml")
    }
}

/// Run the full three-step flow (interactive or headless).
pub fn run_flow(
    ctx: &FlowContext,
    input: &mut impl BufRead,
    out: &mut impl Write,
) -> Result<SetupSummary> {
    let mut summary = SetupSummary {
        config_path: Some(ctx.config_path()),
        state_path: Some(WizardState::path_in(&ctx.home)),
        ..Default::default()
    };

    if ctx.headless {
        run_headless(ctx, out, &mut summary)?;
    } else {
        run_interactive(ctx, input, out, &mut summary)?;
    }

    // Persist state unless dry-run.
    let status = summary.state_status.unwrap_or(WizardStatus::Done);
    if !ctx.dry_run {
        WizardState::new(status)
            .save(&ctx.home)
            .context("persist wizard state")?;
    }
    summary.state_status = Some(status);

    write_summary_screen(out, &summary)?;
    Ok(summary)
}

fn run_headless(ctx: &FlowContext, out: &mut impl Write, summary: &mut SetupSummary) -> Result<()> {
    writeln!(out, "Arcus Build — setup (headless)")?;
    writeln!(out, "Home: {}", ctx.home.display())?;
    writeln!(out)?;

    // Step 1 — print K3 config recipes (do not write unless -- with dry_run false
    // and user already has no way to pick). Headless default: print steps only,
    // do not mutate config unless dry_run is false AND we still write nothing
    // automatically (operator: "prints headless steps").
    writeln!(out, "Step 1/3 — Kimi K3 provider (headline)")?;
    writeln!(
        out,
        "  Choose one and either re-run `arcus setup` interactively, or paste into {}:",
        ctx.config_path().display()
    )?;
    writeln!(out)?;
    writeln!(out, "  [OpenRouter — recommended]")?;
    writeln!(out, "    env:  OPENROUTER_API_KEY")?;
    writeln!(out, "    model id: k3-openrouter  wire: moonshotai/kimi-k3")?;
    writeln!(out, "    base: https://openrouter.ai/api/v1")?;
    writeln!(out)?;
    writeln!(out, "  [Moonshot direct]")?;
    writeln!(out, "    env:  MOONSHOT_API_KEY")?;
    writeln!(out, "    model id: k3-moonshot  wire: kimi-k3")?;
    writeln!(out, "    base: https://api.moonshot.ai/v1")?;
    writeln!(out)?;
    writeln!(out, "  [Open-weight host]")?;
    writeln!(
        out,
        "    Provide base_url + env_key + model; system_prompt_label is mandatory."
    )?;
    writeln!(out, "    See docs/setup-k3.md for verified shapes.")?;
    writeln!(out)?;
    summary.skipped_steps.push("k3-provider (headless: printed only)");

    // Step 2 — Grok rail
    writeln!(out, "Step 2/3 — Grok native rail (second)")?;
    writeln!(
        out,
        "  One login covers the baked catalog + subagent freight (PKCE public client)."
    )?;
    writeln!(out, "  Option A:  arcus login")?;
    writeln!(out, "  Option B:  set XAI_API_KEY in your environment")?;
    writeln!(out)?;
    summary.grok_rail_note = Some(
        "Run `arcus login` (OAuth) or set XAI_API_KEY — one login covers catalog + subagent freight."
            .into(),
    );
    summary.skipped_steps.push("grok-rail (headless: printed only)");

    // Step 3 — Iris
    writeln!(out, "Step 3/3 — Iris companion (recommended, opt-out)")?;
    let detected = detect_iris_on_path();
    let asset = iris_asset_shape();
    match &detected {
        Some(p) => {
            writeln!(out, "  Detected on PATH: {}", p.display())?;
            writeln!(
                out,
                "  Re-run interactively to plant ~/.arcus/iris-companion.toml, or create it manually."
            )?;
        }
        None => {
            writeln!(out, "  Not on PATH.")?;
            writeln!(
                out,
                "  Recommended install asset shape (download deferred in v1): {asset}"
            )?;
            writeln!(
                out,
                "  See product docs for the companion install story (no auto-fetch in this release)."
            )?;
        }
    }
    writeln!(out)?;
    summary.iris = Some(IrisSummary {
        detected: detected.is_some(),
        binary_path: detected,
        pointer_path: None,
        asset_shape: asset,
        planted: false,
    });
    summary.skipped_steps.push("iris (headless: printed only)");
    summary.state_status = Some(WizardStatus::Skipped);
    Ok(())
}

fn run_interactive(
    ctx: &FlowContext,
    input: &mut impl BufRead,
    out: &mut impl Write,
    summary: &mut SetupSummary,
) -> Result<()> {
    clear_screen(out, ctx.stdout_is_terminal)?;
    banner(out)?;
    writeln!(
        out,
        "  First-run setup — configure a K3 path, optional Grok freight, and Iris."
    )?;
    writeln!(
        out,
        "  Escape hatch later: [agent] setup_on_first_run = false in config.toml"
    )?;
    writeln!(out, "  Re-run anytime: arcus setup   |  reset: arcus setup --reset")?;
    writeln!(out)?;

    // ── Step 1: K3 provider ─────────────────────────────────────────────
    step_header(out, 1, 3, "Kimi K3 provider (headline)")?;
    writeln!(out, "  [1] OpenRouter   (recommended)  moonshotai/kimi-k3")?;
    writeln!(out, "  [2] Moonshot direct             kimi-k3")?;
    writeln!(out, "  [3] Open-weight host            base URL + env key")?;
    writeln!(out, "  [s] Skip this step")?;
    writeln!(out, "  [q] Quit setup")?;
    writeln!(out)?;
    write!(out, "  Choice [1/2/3/s/q]: ")?;
    out.flush()?;

    let choice = read_choice(input)?;
    match choice.as_str() {
        "q" | "quit" => {
            writeln!(out, "  Setup cancelled.")?;
            summary.skipped_steps.push("k3-provider");
            summary.skipped_steps.push("grok-rail");
            summary.skipped_steps.push("iris");
            summary.state_status = Some(WizardStatus::Skipped);
            return Ok(());
        }
        "s" | "skip" => {
            writeln!(out, "  Skipped K3 provider.")?;
            summary.skipped_steps.push("k3-provider");
        }
        "1" | "openrouter" | "or" => {
            let plan = ModelEntryPlan::openrouter();
            apply_model(ctx, out, summary, plan)?;
        }
        "2" | "moonshot" | "ms" => {
            let plan = ModelEntryPlan::moonshot();
            apply_model(ctx, out, summary, plan)?;
        }
        "3" | "open" | "host" => {
            let plan = prompt_open_weight(input, out)?;
            apply_model(ctx, out, summary, plan)?;
        }
        other => {
            writeln!(out, "  Unrecognized choice `{other}` — skipping K3 step.")?;
            summary.skipped_steps.push("k3-provider");
        }
    }
    writeln!(out)?;

    // ── Step 2: Grok rail ───────────────────────────────────────────────
    step_header(out, 2, 3, "Grok native rail (second)")?;
    writeln!(
        out,
        "  One login covers the baked catalog + native subagent freight"
    )?;
    writeln!(out, "  (PKCE public client — no client secret).")?;
    writeln!(out)?;
    writeln!(out, "  [1] I'll run `arcus login` after this wizard")?;
    writeln!(out, "  [2] I'll set XAI_API_KEY in my environment")?;
    writeln!(out, "  [s] Skip")?;
    writeln!(out)?;
    write!(out, "  Choice [1/2/s]: ")?;
    out.flush()?;
    let choice = read_choice(input)?;
    match choice.as_str() {
        "1" | "login" => {
            summary.grok_rail_note = Some(
                "Next: run `arcus login` (OAuth). One login covers catalog + subagent freight."
                    .into(),
            );
            writeln!(out, "  Noted — run `arcus login` when ready.")?;
        }
        "2" | "key" | "api" => {
            summary.grok_rail_note = Some(
                "Next: export XAI_API_KEY (or set it in your shell profile).".into(),
            );
            writeln!(out, "  Noted — set XAI_API_KEY in your environment.")?;
        }
        _ => {
            summary.skipped_steps.push("grok-rail");
            writeln!(out, "  Skipped Grok rail.")?;
        }
    }
    writeln!(out)?;

    // ── Step 3: Iris ─────────────────────────────────────────────────
    step_header(out, 3, 3, "Iris companion (recommended, opt-out)")?;
    let detected = detect_iris_on_path();
    let asset = iris_asset_shape();
    match &detected {
        Some(p) => {
            writeln!(out, "  Detected on PATH: {}", p.display())?;
            writeln!(out, "  [1] Plant companion pointer config under arcus home (recommended)")?;
            writeln!(out, "  [s] Skip")?;
        }
        None => {
            writeln!(out, "  Not found on PATH.")?;
            writeln!(
                out,
                "  Recommended release asset shape (v1 names only; download deferred):"
            )?;
            writeln!(out, "    {asset}")?;
            writeln!(
                out,
                "  Install separately, then re-run setup — or plant a pointer now."
            )?;
            writeln!(out, "  [1] Plant companion pointer config (recommended)")?;
            writeln!(out, "  [s] Skip (opt-out)")?;
        }
    }
    writeln!(out)?;
    write!(out, "  Choice [1/s]: ")?;
    out.flush()?;
    let choice = read_choice(input)?;
    let plant = matches!(choice.as_str(), "1" | "y" | "yes" | "plant");
    if plant {
        let pointer = write_iris_pointer(&ctx.home, detected.as_deref(), ctx.dry_run)?;
        writeln!(
            out,
            "  {} companion pointer: {}",
            if ctx.dry_run { "Would write" } else { "Wrote" },
            pointer.display()
        )?;
        summary.iris = Some(IrisSummary {
            detected: detected.is_some(),
            binary_path: detected,
            pointer_path: Some(pointer),
            asset_shape: asset,
            planted: true,
        });
    } else {
        writeln!(out, "  Skipped Iris step.")?;
        summary.skipped_steps.push("iris");
        summary.iris = Some(IrisSummary {
            detected: detected.is_some(),
            binary_path: detected,
            pointer_path: None,
            asset_shape: asset,
            planted: false,
        });
    }

    // Done if we did anything meaningful; still mark done so auto doesn't re-fire.
    summary.state_status = Some(WizardStatus::Done);
    Ok(())
}

fn apply_model(
    ctx: &FlowContext,
    out: &mut impl Write,
    summary: &mut SetupSummary,
    plan: ModelEntryPlan,
) -> Result<()> {
    let report = write_model_entry(&ctx.config_path(), &plan, ctx.dry_run)?;
    writeln!(
        out,
        "  {} [model.{}] → {}",
        if report.dry_run {
            "Would write"
        } else {
            "Wrote"
        },
        report.model_id,
        report.config_path.display()
    )?;
    writeln!(
        out,
        "  Set env {} before launching (prefer env_key over literal api_key).",
        report.env_key
    )?;
    summary.model = Some(ModelSummary {
        id: report.model_id,
        env_key: report.env_key,
        config_path: report.config_path,
        dry_run: report.dry_run,
    });
    Ok(())
}

fn prompt_open_weight(input: &mut impl BufRead, out: &mut impl Write) -> Result<ModelEntryPlan> {
    write!(out, "  Base URL (OpenAI-compat, include /v1): ")?;
    out.flush()?;
    let base_url = read_line(input)?;
    if base_url.trim().is_empty() {
        anyhow::bail!("base_url is required for open-weight host");
    }
    write!(out, "  Env var name for API key [OPENWEIGHT_API_KEY]: ")?;
    out.flush()?;
    let env_key = {
        let v = read_line(input)?;
        if v.trim().is_empty() {
            "OPENWEIGHT_API_KEY".into()
        } else {
            v
        }
    };
    write!(out, "  Wire model id [moonshotai/Kimi-K3]: ")?;
    out.flush()?;
    let model = {
        let v = read_line(input)?;
        if v.trim().is_empty() {
            "moonshotai/Kimi-K3".into()
        } else {
            v
        }
    };
    Ok(ModelEntryPlan::open_weight(
        base_url.trim().to_string(),
        env_key.trim().to_string(),
        model.trim().to_string(),
    ))
}

fn write_summary_screen(out: &mut impl Write, summary: &SetupSummary) -> Result<()> {
    writeln!(out)?;
    writeln!(out, "────────────────────────────────────────")?;
    writeln!(out, "  Setup summary")?;
    writeln!(out, "────────────────────────────────────────")?;
    if let Some(ref m) = summary.model {
        writeln!(
            out,
            "  K3 model:  [model.{}] in {}{}",
            m.id,
            m.config_path.display(),
            if m.dry_run { " (dry-run)" } else { "" }
        )?;
        writeln!(out, "  Env key:   {}", m.env_key)?;
    } else {
        writeln!(out, "  K3 model:  (not written)")?;
    }
    match &summary.grok_rail_note {
        Some(n) => writeln!(out, "  Grok rail: {n}")?,
        None => writeln!(out, "  Grok rail: (skipped)")?,
    }
    match &summary.iris {
        Some(d) if d.planted => {
            writeln!(
                out,
                "  Iris:   pointer {}",
                d.pointer_path
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "(none)".into())
            )?;
        }
        Some(d) => {
            writeln!(
                out,
                "  Iris:   not planted (asset shape: {})",
                d.asset_shape
            )?;
        }
        None => writeln!(out, "  Iris:   (n/a)")?,
    }
    if !summary.skipped_steps.is_empty() {
        writeln!(out, "  Skipped:   {}", summary.skipped_steps.join(", "))?;
    }
    if let Some(ref p) = summary.state_path {
        writeln!(out, "  State:     {}", p.display())?;
    }
    writeln!(out)?;
    writeln!(out, "  Next: set any env keys above, then run `arcus`.")?;
    writeln!(
        out,
        "  Disable auto first-run: [agent] setup_on_first_run = false"
    )?;
    writeln!(out, "────────────────────────────────────────")?;
    Ok(())
}

fn banner(out: &mut impl Write) -> Result<()> {
    writeln!(out, "════════════════════════════════════════")?;
    writeln!(out, "  Arcus Build — first-run setup")?;
    writeln!(out, "════════════════════════════════════════")?;
    Ok(())
}

fn step_header(out: &mut impl Write, n: u32, total: u32, title: &str) -> Result<()> {
    writeln!(out, "── Step {n}/{total} — {title} ──")?;
    Ok(())
}

fn clear_screen(out: &mut impl Write, tty: bool) -> Result<()> {
    if tty {
        // CSI clear + home; harmless on most modern terminals.
        write!(out, "\x1b[2J\x1b[H")?;
        out.flush()?;
    }
    Ok(())
}

fn read_line(input: &mut impl BufRead) -> Result<String> {
    let mut buf = String::new();
    input.read_line(&mut buf).context("read stdin")?;
    Ok(buf.trim().to_string())
}

fn read_choice(input: &mut impl BufRead) -> Result<String> {
    Ok(read_line(input)?.to_ascii_lowercase())
}

/// Plant only the iris pointer (helper for tests / future flags).
#[allow(dead_code)]
pub fn plant_iris_only(home: &Path, dry_run: bool) -> Result<PathBuf> {
    let detected = detect_iris_on_path();
    write_iris_pointer(home, detected.as_deref(), dry_run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::tempdir;

    #[test]
    fn interactive_openrouter_then_skip_rest() {
        let dir = tempdir().unwrap();
        let ctx = FlowContext {
            home: dir.path().to_path_buf(),
            dry_run: false,
            headless: false,
            stdin_is_terminal: true,
            stdout_is_terminal: false,
        };
        // 1 = openrouter, s = skip grok, s = skip iris
        let mut input = Cursor::new("1\ns\ns\n");
        let mut out = Vec::new();
        let summary = run_flow(&ctx, &mut input, &mut out).unwrap();
        assert_eq!(summary.model.as_ref().unwrap().id, "k3-openrouter");
        let body = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        assert!(body.contains("moonshotai/kimi-k3"));
        assert!(body.contains("system_prompt_label"));
        assert_eq!(summary.state_status, Some(WizardStatus::Done));
        assert!(WizardState::path_in(dir.path()).exists());
    }

    #[test]
    fn headless_prints_without_writing_model() {
        let dir = tempdir().unwrap();
        let ctx = FlowContext {
            home: dir.path().to_path_buf(),
            dry_run: false,
            headless: true,
            stdin_is_terminal: false,
            stdout_is_terminal: false,
        };
        let mut input = Cursor::new("");
        let mut out = Vec::new();
        let summary = run_flow(&ctx, &mut input, &mut out).unwrap();
        assert!(summary.model.is_none());
        assert!(!dir.path().join("config.toml").exists());
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("OpenRouter"));
        assert!(text.contains("arcus login"));
        assert!(text.contains("iris-"));
    }

    #[test]
    fn quit_marks_skipped() {
        let dir = tempdir().unwrap();
        let ctx = FlowContext {
            home: dir.path().to_path_buf(),
            dry_run: false,
            headless: false,
            stdin_is_terminal: true,
            stdout_is_terminal: false,
        };
        let mut input = Cursor::new("q\n");
        let mut out = Vec::new();
        let summary = run_flow(&ctx, &mut input, &mut out).unwrap();
        assert_eq!(summary.state_status, Some(WizardStatus::Skipped));
    }
}
