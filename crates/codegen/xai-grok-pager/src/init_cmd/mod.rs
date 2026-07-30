//! `selene init` — install the embedded cooperation harness into a git repo.
//!
//! Offline extract of `templates/house/**` with an ownership/refresh policy:
//! never silently overwrite user edits; `--refresh` only rewrites files whose
//! on-disk sha256 still matches the install manifest; `--force` overwrites.

use std::collections::BTreeMap;
use std::io::{IsTerminal as _, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::house_embed::{HouseEntry, embedded_house_entries};

/// Relative path of the install manifest inside the target repo.
pub const MANIFEST_REL: &str = ".selene/house-install.json";

/// Dioptra companion pointer note (only when `--with-dioptra`).
pub const DIOPTRA_NOTE_REL: &str = ".selene/dioptra-companion.note.md";

const MANIFEST_VERSION: u32 = 1;

const DIOPTRA_NOTE: &str = "\
# Dioptra companion (pointer)

Dioptra is an optional companion instrument for Selene Build — not installed by
`init`. Install and run it separately when you want the dash/regula surfaces.

See the product docs for the companion install story. This note is only a
pointer so the house tree records the opt-in.
";

#[derive(Clone, Debug, Eq, PartialEq, clap::Args)]
pub struct InitArgs {
    /// Overwrite user-modified files (requires confirmation unless `--yes`).
    #[arg(long)]
    pub force: bool,
    /// Rewrite files still matching the install manifest (untouched since install).
    #[arg(long)]
    pub refresh: bool,
    /// Install bundled skills (default: on; explicit opt-in, no-op when already default).
    #[arg(long = "skills", conflicts_with = "no_skills")]
    pub skills: bool,
    /// Skip bundled skills under `.selene/skills/`.
    #[arg(long = "no-skills", conflicts_with = "skills")]
    pub no_skills: bool,
    /// Skip `context/principle-lattice.md` (lattice is default-on).
    #[arg(long = "no-lattice")]
    pub no_lattice: bool,
    /// Plant a dioptra companion pointer note (default: off).
    #[arg(long = "with-dioptra", conflicts_with = "no_dioptra")]
    pub with_dioptra: bool,
    /// Explicitly skip the dioptra pointer note (default).
    #[arg(long = "no-dioptra", conflicts_with = "with_dioptra")]
    pub no_dioptra: bool,
    /// Print the plan; write nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// No prompts (headless-safe). Required for non-interactive `--force` overwrites.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

impl Default for InitArgs {
    fn default() -> Self {
        Self {
            force: false,
            refresh: false,
            skills: false,
            no_skills: false,
            no_lattice: false,
            with_dioptra: false,
            no_dioptra: false,
            dry_run: false,
            yes: false,
        }
    }
}

impl InitArgs {
    /// Skills install: default on; `--no-skills` off; `--skills` on.
    pub fn skills_enabled(&self) -> bool {
        !self.no_skills
    }

    /// Lattice install: default on; `--no-lattice` off.
    pub fn lattice_enabled(&self) -> bool {
        !self.no_lattice
    }

    /// Dioptra pointer note: default off; `--with-dioptra` on.
    pub fn dioptra_enabled(&self) -> bool {
        self.with_dioptra && !self.no_dioptra
    }
}

/// Per-file install bookkeeping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallManifest {
    pub version: u32,
    /// rel_path → sha256 hex of the content last written by init.
    pub files: BTreeMap<String, String>,
}

impl InstallManifest {
    pub fn new() -> Self {
        Self {
            version: MANIFEST_VERSION,
            files: BTreeMap::new(),
        }
    }

    pub fn load(path: &Path) -> Result<Option<Self>> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read install manifest {}", path.display()))?;
        let m: Self = serde_json::from_str(&raw)
            .with_context(|| format!("parse install manifest {}", path.display()))?;
        Ok(Some(m))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let raw = serde_json::to_string_pretty(self).context("serialize install manifest")?;
        std::fs::write(path, format!("{raw}\n"))
            .with_context(|| format!("write install manifest {}", path.display()))?;
        Ok(())
    }
}

impl Default for InstallManifest {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome for a single planned file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileAction {
    /// Will write (missing or force/refresh path).
    Write,
    /// Exists and matches planned content (or already up to date).
    SkipUnchanged,
    /// Exists, user-modified; left alone.
    Preserve,
    /// Would write under dry-run.
    DryRunWrite,
}

impl FileAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::Write => "written",
            Self::SkipUnchanged => "skipped",
            Self::Preserve => "preserved",
            Self::DryRunWrite => "would-write",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePlan {
    pub rel_path: String,
    pub action: FileAction,
    pub content_sha256: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitReport {
    pub root: PathBuf,
    pub plans: Vec<FilePlan>,
    pub hooks_registry: Option<HooksRegistryReport>,
    pub wrote_manifest: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HooksRegistryReport {
    pub registry_path: PathBuf,
    pub hooks_dir: PathBuf,
    pub action: HooksRegistryAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HooksRegistryAction {
    Added,
    AlreadyPresent,
    DryRunWouldAdd,
    SkippedNoHooks,
}

impl HooksRegistryAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::Added => "registered",
            Self::AlreadyPresent => "already-registered",
            Self::DryRunWouldAdd => "would-register",
            Self::SkippedNoHooks => "skipped-no-hooks",
        }
    }
}

/// Runtime knobs for tests (home override, custom source tree).
#[derive(Debug, Clone)]
pub struct InitContext {
    pub cwd: PathBuf,
    /// Global config home (`~/.selene` / `$GROK_HOME`). Never touch the real one in tests.
    pub grok_home: PathBuf,
    pub entries: Vec<HouseEntry>,
    pub stdin_is_terminal: bool,
}

impl InitContext {
    pub fn production() -> Result<Self> {
        let cwd = std::env::current_dir().context("resolve current directory")?;
        Ok(Self {
            cwd,
            grok_home: xai_grok_config::grok_home(),
            entries: embedded_house_entries(),
            stdin_is_terminal: std::io::stdin().is_terminal(),
        })
    }
}

/// CLI entrypoint.
pub fn run(args: InitArgs) -> Result<()> {
    let ctx = InitContext::production()?;
    let report = run_with_context(&args, &ctx, &mut std::io::stdout().lock())?;
    // Non-zero only on hard refuse (bail above). Soft preserves are still success.
    let _ = report;
    Ok(())
}

/// Core install with injectable context (used by golden tests).
pub fn run_with_context(
    args: &InitArgs,
    ctx: &InitContext,
    writer: &mut impl Write,
) -> Result<InitReport> {
    let root = find_git_root(&ctx.cwd).ok_or_else(|| {
        anyhow::anyhow!(
            "init requires a git repository (no .git found from {}). Run inside a repo.",
            ctx.cwd.display()
        )
    })?;

    let selected = select_entries(&ctx.entries, args);
    let manifest_path = root.join(MANIFEST_REL);
    let existing_manifest = InstallManifest::load(&manifest_path)?;

    let mut plans = plan_files(&root, &selected, existing_manifest.as_ref(), args)?;

    // Confirm --force overwrites of files that differ from the planned content.
    if args.force {
        let would_overwrite: Vec<&str> = plans
            .iter()
            .filter(|p| {
                p.action == FileAction::Write
                    && root.join(&p.rel_path).exists()
                    && existing_disk_differs(&root.join(&p.rel_path), &p.content_sha256)
            })
            .map(|p| p.rel_path.as_str())
            .collect();
        if !would_overwrite.is_empty() && !args.yes {
            if !ctx.stdin_is_terminal {
                bail!(
                    "refusing to overwrite {} file(s) without --yes in a non-interactive terminal",
                    would_overwrite.len()
                );
            }
            write!(
                writer,
                "Overwrite {} modified file(s)? [y/N] ",
                would_overwrite.len()
            )?;
            writer.flush()?;
            let mut answer = String::new();
            std::io::stdin().read_line(&mut answer)?;
            if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
                writeln!(writer, "init cancelled.")?;
                return Ok(InitReport {
                    root,
                    plans,
                    hooks_registry: None,
                    wrote_manifest: false,
                });
            }
        }
    }

    if args.dry_run {
        for p in &mut plans {
            if p.action == FileAction::Write {
                p.action = FileAction::DryRunWrite;
            }
        }
    }

    // Apply writes.
    let by_path: BTreeMap<&str, &HouseEntry> = selected
        .iter()
        .map(|e| (e.rel_path.as_str(), e))
        .collect();

    let mut new_manifest = existing_manifest.unwrap_or_default();
    if new_manifest.version == 0 {
        new_manifest.version = MANIFEST_VERSION;
    }

    let mut wrote_any = false;
    for plan in &plans {
        match plan.action {
            FileAction::Write => {
                let entry = by_path
                    .get(plan.rel_path.as_str())
                    .expect("planned path must be in selected entries");
                write_file(&root.join(&plan.rel_path), &entry.contents)?;
                new_manifest
                    .files
                    .insert(plan.rel_path.clone(), plan.content_sha256.clone());
                wrote_any = true;
            }
            FileAction::SkipUnchanged | FileAction::Preserve | FileAction::DryRunWrite => {
                // Still record planned sha for new files in dry-run? Only update
                // manifest for actual writes. For SkipUnchanged ensure manifest
                // has the entry (first-run edge after partial install).
                if plan.action == FileAction::SkipUnchanged
                    && !new_manifest.files.contains_key(&plan.rel_path)
                    && !args.dry_run
                {
                    new_manifest
                        .files
                        .insert(plan.rel_path.clone(), plan.content_sha256.clone());
                    wrote_any = true;
                }
            }
        }
    }

    // Drop manifest entries for files no longer selected (e.g. --no-lattice after lattice install)
    // only on force? Prefer leave stale entries; refresh won't touch unknown paths.
    // Keep simple: only update keys we write.

    let wrote_manifest = if args.dry_run {
        false
    } else if wrote_any || !manifest_path.exists() {
        // Always write manifest on a successful non-dry run that had work, or
        // first install with only skips (seed empty → still stamp).
        if !plans.is_empty() {
            new_manifest.save(&manifest_path)?;
            true
        } else {
            false
        }
    } else {
        false
    };

    // Hooks registry: register <root>/.selene/hooks when hooks files were in the plan.
    let hooks_registry = register_hooks_path(args, ctx, &root, &plans, writer)?;

    write_summary(writer, &root, &plans, wrote_manifest, &hooks_registry)?;

    Ok(InitReport {
        root,
        plans,
        hooks_registry: Some(hooks_registry),
        wrote_manifest,
    })
}

fn plan_files(
    root: &Path,
    selected: &[HouseEntry],
    manifest: Option<&InstallManifest>,
    args: &InitArgs,
) -> Result<Vec<FilePlan>> {
    let mut plans = Vec::with_capacity(selected.len());
    for entry in selected {
        let sha = xai_file_utils::sha256_hex(&entry.contents);
        let dest = root.join(&entry.rel_path);
        let action = if !dest.exists() {
            FileAction::Write
        } else if content_matches(&dest, &sha) {
            FileAction::SkipUnchanged
        } else if args.force {
            FileAction::Write
        } else if args.refresh {
            // Untouched since install ≡ on-disk sha still equals the manifest hash.
            let untouched = manifest
                .and_then(|m| m.files.get(&entry.rel_path))
                .is_some_and(|installed| {
                    disk_sha(&dest)
                        .ok()
                        .is_some_and(|d| d.eq_ignore_ascii_case(installed))
                });
            if untouched {
                FileAction::Write
            } else {
                FileAction::Preserve
            }
        } else {
            // Default: never clobber diverged content.
            FileAction::Preserve
        };
        plans.push(FilePlan {
            rel_path: entry.rel_path.clone(),
            action,
            content_sha256: sha,
        });
    }
    Ok(plans)
}

/// Filter embedded entries by CLI flags + inject dioptra note when requested.
pub fn select_entries(entries: &[HouseEntry], args: &InitArgs) -> Vec<HouseEntry> {
    let mut out: Vec<HouseEntry> = entries
        .iter()
        .filter(|e| keep_entry(&e.rel_path, args))
        .cloned()
        .collect();

    if args.dioptra_enabled() {
        out.push(HouseEntry {
            rel_path: DIOPTRA_NOTE_REL.to_string(),
            contents: DIOPTRA_NOTE.as_bytes().to_vec(),
        });
    }

    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn keep_entry(rel: &str, args: &InitArgs) -> bool {
    let norm = rel.replace('\\', "/");
    if !args.skills_enabled()
        && (norm.starts_with(".selene/skills/") || norm == ".selene/skills")
    {
        return false;
    }
    if !args.lattice_enabled()
        && (norm == "context/principle-lattice.md" || norm.ends_with("/principle-lattice.md"))
    {
        return false;
    }
    true
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    loop {
        if cur.join(".git").exists() {
            return Some(cur);
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn disk_sha(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(xai_file_utils::sha256_hex(&bytes))
}

fn content_matches(path: &Path, expected_sha: &str) -> bool {
    disk_sha(path)
        .ok()
        .is_some_and(|d| d.eq_ignore_ascii_case(expected_sha))
}

fn existing_disk_differs(path: &Path, planned_sha: &str) -> bool {
    !content_matches(path, planned_sha)
}

fn write_file(path: &Path, contents: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create directory {}", parent.display()))?;
    }
    std::fs::write(path, contents).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn register_hooks_path(
    args: &InitArgs,
    ctx: &InitContext,
    root: &Path,
    plans: &[FilePlan],
    writer: &mut impl Write,
) -> Result<HooksRegistryReport> {
    let hooks_dir = root.join(".selene").join("hooks");
    let has_hooks = plans.iter().any(|p| {
        let n = p.rel_path.replace('\\', "/");
        n.starts_with(".selene/hooks/") || n == ".selene/hooks"
    });

    let registry_path = ctx.grok_home.join("hooks-paths");

    if !has_hooks {
        return Ok(HooksRegistryReport {
            registry_path,
            hooks_dir,
            action: HooksRegistryAction::SkippedNoHooks,
        });
    }

    // Prefer absolute, non-verbatim path for the registry line.
    let hooks_abs = dunce::canonicalize(&hooks_dir).unwrap_or_else(|_| {
        if hooks_dir.is_absolute() {
            hooks_dir.clone()
        } else {
            root.join(".selene").join("hooks")
        }
    });
    // On dry-run the dir may not exist yet — still report the intended absolute path.
    let hooks_line = if hooks_abs.exists() {
        hooks_abs
    } else {
        root.join(".selene").join("hooks")
    };
    let hooks_line = if hooks_line.is_absolute() {
        hooks_line
    } else {
        // Best-effort absolute for registry (absolute paths only are accepted).
        std::env::current_dir()
            .map(|c| c.join(&hooks_line))
            .unwrap_or(hooks_line)
    };

    if args.dry_run {
        let _ = writer;
        return Ok(HooksRegistryReport {
            registry_path,
            hooks_dir: hooks_line,
            action: HooksRegistryAction::DryRunWouldAdd,
        });
    }

    // Ensure slots exist under the *overridden* grok home (not the real ~/.selene).
    std::fs::create_dir_all(&ctx.grok_home)
        .with_context(|| format!("create grok home {}", ctx.grok_home.display()))?;
    let hooks_slot = ctx.grok_home.join("hooks");
    if !hooks_slot.exists() {
        let _ = std::fs::create_dir_all(&hooks_slot);
    }
    if !registry_path.exists() {
        std::fs::write(&registry_path, "").with_context(|| {
            format!("create hooks-paths registry {}", registry_path.display())
        })?;
    }

    let content = std::fs::read_to_string(&registry_path)
        .with_context(|| format!("read hooks-paths {}", registry_path.display()))?;
    let line = hooks_line.to_string_lossy();
    let already = content.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && Path::new(t) == hooks_line.as_path()
    });

    if already {
        return Ok(HooksRegistryReport {
            registry_path,
            hooks_dir: hooks_line,
            action: HooksRegistryAction::AlreadyPresent,
        });
    }

    let mut new_content = content;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(&line);
    new_content.push('\n');
    std::fs::write(&registry_path, new_content)
        .with_context(|| format!("write hooks-paths {}", registry_path.display()))?;

    Ok(HooksRegistryReport {
        registry_path,
        hooks_dir: hooks_line,
        action: HooksRegistryAction::Added,
    })
}

fn write_summary(
    writer: &mut impl Write,
    root: &Path,
    plans: &[FilePlan],
    wrote_manifest: bool,
    hooks: &HooksRegistryReport,
) -> Result<()> {
    let mut written = Vec::new();
    let mut skipped = Vec::new();
    let mut preserved = Vec::new();
    let mut would = Vec::new();
    for p in plans {
        match p.action {
            FileAction::Write => written.push(p.rel_path.as_str()),
            FileAction::SkipUnchanged => skipped.push(p.rel_path.as_str()),
            FileAction::Preserve => preserved.push(p.rel_path.as_str()),
            FileAction::DryRunWrite => would.push(p.rel_path.as_str()),
        }
    }

    if !would.is_empty() {
        writeln!(
            writer,
            "Cooperation harness plan for {} (dry-run, nothing written)",
            root.display()
        )?;
    } else {
        writeln!(
            writer,
            "Cooperation harness initialized at {}",
            root.display()
        )?;
    }

    writeln!(writer, "  written:   {}", format_list(&written))?;
    writeln!(writer, "  skipped:   {}", format_list(&skipped))?;
    writeln!(writer, "  preserved: {}", format_list(&preserved))?;
    if !would.is_empty() {
        writeln!(writer, "  would-write: {}", format_list(&would))?;
    }
    if wrote_manifest {
        writeln!(writer, "  manifest:  {MANIFEST_REL}")?;
    }
    writeln!(
        writer,
        "  hooks-registry: {} ({}) → {}",
        hooks.action.label(),
        hooks.hooks_dir.display(),
        hooks.registry_path.display()
    )?;

    if would.is_empty() && !written.is_empty() {
        writeln!(writer, "Next:")?;
        writeln!(
            writer,
            "  1. Edit AGENTS.md — replace {{{{HOUSE_NAME}}}} / identity placeholders"
        )?;
        writeln!(
            writer,
            "  2. Run selene in this directory (trust dialog if first time)"
        )?;
        writeln!(
            writer,
            "  3. Commit project-tier .selene/ and AGENTS.md for CI/cloud agents"
        )?;
    }

    Ok(())
}

fn format_list(items: &[&str]) -> String {
    if items.is_empty() {
        "(none)".to_string()
    } else if items.len() <= 8 {
        items.join(", ")
    } else {
        format!(
            "{} … ({} files)",
            items[..5].join(", "),
            items.len()
        )
    }
}

/// Public helper for tests: walk a filesystem tree into HouseEntry list.
pub fn entries_from_dir(dir: &Path) -> Result<Vec<HouseEntry>> {
    let mut out = Vec::new();
    walk_collect(dir, dir, &mut out)?;
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

fn walk_collect(root: &Path, dir: &Path, out: &mut Vec<HouseEntry>) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_collect(root, &path, out)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(s) => Some(s.to_string_lossy()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
            let contents = std::fs::read(&path)
                .with_context(|| format!("read fixture {}", path.display()))?;
            out.push(HouseEntry {
                rel_path: rel,
                contents,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn keep_entry_respects_no_skills_and_no_lattice() {
        let mut args = InitArgs::default();
        assert!(args.skills_enabled());
        assert!(keep_entry(".selene/skills/foo/SKILL.md", &args));
        args.no_skills = true;
        assert!(!args.skills_enabled());
        assert!(!keep_entry(".selene/skills/foo/SKILL.md", &args));
        assert!(keep_entry("AGENTS.md", &args));

        args = InitArgs::default();
        assert!(args.lattice_enabled());
        assert!(keep_entry("context/principle-lattice.md", &args));
        args.no_lattice = true;
        assert!(!args.lattice_enabled());
        assert!(!keep_entry("context/principle-lattice.md", &args));
    }

    #[test]
    fn default_args_skills_on_lattice_on_dioptra_off() {
        let args = InitArgs::default();
        assert!(args.skills_enabled());
        assert!(args.lattice_enabled());
        assert!(!args.dioptra_enabled());
    }
}
