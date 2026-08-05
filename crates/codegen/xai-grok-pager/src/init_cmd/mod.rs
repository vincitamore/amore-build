//! `amore init` — create a house and install the cooperation harness into it.
//!
//! The house tree itself is extracted from `templates/house/**`, compiled into
//! this binary, with an ownership/refresh policy: never silently overwrite user
//! edits; `--refresh` only rewrites files whose on-disk sha256 still matches the
//! install manifest; `--force` overwrites.
//!
//! `init` then installs the **iris** companion into `instruments/iris/`,
//! which fetches it from the matching release — so `init` is not a network-free
//! operation unless you pass `--no-iris`. Iris is part of the house, and the
//! honest install story is better than a "no network required" claim kept
//! true by shipping a house without its instrument. After iris is linked,
//! init runs `iris qmd setup` so semantic search is ready in the new house
//! (skip with `--no-qmd`; `--no-iris` implies skip). Optional companions
//! (`--with-lucerna`, `--with-speculum`) ride the same release tag and the
//! same fetch path, default off. A fetch or setup failure never fails the
//! house: the tree is already complete, and the failure is reported with the
//! command to finish later.

use std::collections::BTreeMap;
use std::io::{IsTerminal as _, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::house_embed::{HouseEntry, embedded_house_entries};

/// Relative path of the install manifest inside the target repo.
pub const MANIFEST_REL: &str = ".amore/house-install.json";

pub mod instrument_fetch;
pub mod iris_fetch;
pub mod qmd_setup;

const MANIFEST_VERSION: u32 = 1;

/// Default directory name for a new house.
///
/// `init` **creates** the house; it does not overlay an existing repository.
/// The house is the directory you launch from every session — it holds your
/// tasks, conventions and running context, and the work itself lives in
/// `projects/` inside it. That is why it owns its own git history rather than
/// borrowing a host repo's.
pub const DEFAULT_HOUSE_DIR: &str = "amore";

#[derive(Clone, Debug, Eq, PartialEq, clap::Args)]
pub struct InitArgs {
    /// Directory to create the house in, relative to the current directory.
    #[arg(value_name = "DIR", default_value = DEFAULT_HOUSE_DIR)]
    pub dir: String,
    /// Overwrite user-modified files (requires confirmation unless `--yes`).
    #[arg(long)]
    pub force: bool,
    /// Rewrite files still matching the install manifest (untouched since install).
    #[arg(long)]
    pub refresh: bool,
    /// Install bundled skills (default: on; explicit opt-in, no-op when already default).
    #[arg(long = "skills", conflicts_with = "no_skills")]
    pub skills: bool,
    /// Skip bundled skills under `.amore/skills/`.
    #[arg(long = "no-skills", conflicts_with = "skills")]
    pub no_skills: bool,
    /// Install project hooks (default: on; explicit opt-in, no-op when already default).
    #[arg(long = "hooks", conflicts_with = "no_hooks")]
    pub hooks: bool,
    /// Skip `.amore/hooks/**` install and global hooks-paths registration.
    #[arg(long = "no-hooks", conflicts_with = "hooks")]
    pub no_hooks: bool,
    /// Skip `context/principle-lattice.md` (lattice is default-on).
    #[arg(long = "no-lattice")]
    pub no_lattice: bool,
    /// Install the iris companion (default: on; explicit opt-in, no-op when already default).
    #[arg(long = "with-iris", conflicts_with = "no_iris")]
    pub with_iris: bool,
    /// Skip installing iris. Combined with no optional companions, `init`
    /// makes no network request at all.
    #[arg(long = "no-iris", conflicts_with = "with_iris")]
    pub no_iris: bool,
    /// Skip automatic semantic search setup (`iris qmd setup`) after iris.
    /// Implied by `--no-iris`. Finish later with `iris qmd setup` from the
    /// house root.
    #[arg(long = "no-qmd")]
    pub no_qmd: bool,
    /// Install the lucerna house steward from the matching release (default: off).
    #[arg(long = "with-lucerna")]
    pub with_lucerna: bool,
    /// Install the speculum session mirror from the matching release (default: off).
    #[arg(long = "with-speculum")]
    pub with_speculum: bool,
    /// Allow creating a new house even when the current directory sits inside
    /// an existing house (default: refuse, so bare `init` never nests).
    #[arg(long = "force-new")]
    pub force_new: bool,
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
            dir: DEFAULT_HOUSE_DIR.to_string(),
            force: false,
            refresh: false,
            skills: false,
            no_skills: false,
            hooks: false,
            no_hooks: false,
            no_lattice: false,
            with_iris: false,
            no_iris: false,
            no_qmd: false,
            with_lucerna: false,
            with_speculum: false,
            force_new: false,
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

    /// Hooks install: default on; `--no-hooks` off; `--hooks` on.
    pub fn hooks_enabled(&self) -> bool {
        !self.no_hooks
    }

    /// Lattice install: default on; `--no-lattice` off.
    pub fn lattice_enabled(&self) -> bool {
        !self.no_lattice
    }

    /// Iris install: default ON; `--no-iris` off.
    ///
    /// Iris is part of the house rather than an optional extra, so it is
    /// installed unless refused — the same shape as skills, hooks and the
    /// lattice. `--no-iris` alone is the offline switch only when no optional
    /// companions are requested; `--with-lucerna` / `--with-speculum` also
    /// reach the network.
    pub fn iris_enabled(&self) -> bool {
        !self.no_iris
    }

    /// Lucerna install: default OFF; `--with-lucerna` on.
    pub fn lucerna_enabled(&self) -> bool {
        self.with_lucerna
    }

    /// Speculum install: default OFF; `--with-speculum` on.
    pub fn speculum_enabled(&self) -> bool {
        self.with_speculum
    }

    /// Semantic search setup: default ON when iris installs; `--no-qmd` off.
    ///
    /// `--no-iris` also skips setup (no iris binary to invoke). Callers still
    /// pass `no_qmd` into the setup step so the summary can name the opt-out.
    pub fn qmd_enabled(&self) -> bool {
        !self.no_qmd && self.iris_enabled()
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
    /// Suppressed by a CLI opt-out (`--no-hooks`, etc.); still listed in the plan.
    SkipOptOut,
}

impl FileAction {
    pub fn label(self) -> &'static str {
        match self {
            Self::Write => "written",
            Self::SkipUnchanged | Self::SkipOptOut => "skipped",
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
    /// Global config home (`~/.amore` / `$GROK_HOME`). Never touch the real one in tests.
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
    let root = resolve_house_root(args, ctx, writer)?;

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
            FileAction::SkipUnchanged
            | FileAction::Preserve
            | FileAction::DryRunWrite
            | FileAction::SkipOptOut => {
                // Only update manifest for actual writes. For SkipUnchanged ensure
                // manifest has the entry (first-run edge after partial install).
                // SkipOptOut never enters the manifest.
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

    // Hooks registry: register <root>/.amore/hooks when hooks files were in the plan.
    let hooks_registry = register_hooks_path(args, ctx, &root, &plans, writer)?;

    // Companion install runs LAST: the house is already complete on disk, so a
    // network failure here degrades to a note instead of taking the tree down.
    let iris = if args.iris_enabled() {
        iris_fetch::install(&root, xai_grok_version::VERSION, args.dry_run)
    } else {
        iris_fetch::IrisOutcome::OptedOut
    };
    let lucerna = if args.lucerna_enabled() {
        instrument_fetch::install(
            &instrument_fetch::LUCERNA,
            &root,
            xai_grok_version::VERSION,
            args.dry_run,
        )
    } else {
        instrument_fetch::Outcome::OptedOut
    };
    let speculum = if args.speculum_enabled() {
        instrument_fetch::install(
            &instrument_fetch::SPECULUM,
            &root,
            xai_grok_version::VERSION,
            args.dry_run,
        )
    } else {
        instrument_fetch::Outcome::OptedOut
    };

    write_summary(
        writer,
        &root,
        &plans,
        wrote_manifest,
        &hooks_registry,
        &iris,
        &lucerna,
        &speculum,
        // Semantic search setup runs after iris is linked so the binary path
        // is known. Failures degrade to a summary note; the house stays complete.
        |w| qmd_setup::run(&root, &iris, args.no_qmd, args.dry_run, w),
    )?;

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
        // `--no-hooks`: keep hooks lines visible in the plan as skipped; never write.
        if is_hooks_rel(&entry.rel_path) && !args.hooks_enabled() {
            plans.push(FilePlan {
                rel_path: entry.rel_path.clone(),
                action: FileAction::SkipOptOut,
                content_sha256: sha,
            });
            continue;
        }
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

fn is_hooks_rel(rel: &str) -> bool {
    let norm = rel.replace('\\', "/");
    norm.starts_with(".amore/hooks/") || norm == ".amore/hooks"
}

/// The house's own name, taken from the directory being created.
///
/// `amore init` → `amore`; `amore init ../work/atelier` → `atelier`. Falls
/// back to the default rather than producing an empty name for an odd path.
fn house_name_from(dir: &str) -> String {
    Path::new(dir)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| DEFAULT_HOUSE_DIR.to_string())
}

/// Substitute `{{PLACEHOLDER}}` tokens in template text.
///
/// `init` knows the house name — it is the directory being created — so there is
/// no reason to hand a new user a file full of `{{HOUSE_NAME}}` and ask them to
/// find and replace it. Substitution happens before the content hash is taken,
/// so `--refresh` compares like with like and a user's later edits are still
/// detected as theirs.
fn expand_placeholders(contents: &[u8], house_name: &str) -> Vec<u8> {
    // Binary assets (and anything non-UTF-8) pass through untouched.
    let Ok(text) = std::str::from_utf8(contents) else {
        return contents.to_vec();
    };
    if !text.contains("{{") {
        return contents.to_vec();
    }
    text.replace("{{HOUSE_NAME}}", house_name)
        .replace("{{HOUSE_ROOT_LABEL}}", house_name)
        .into_bytes()
}

/// Filter embedded entries by CLI flags and expand house-name placeholders.
pub fn select_entries(entries: &[HouseEntry], args: &InitArgs) -> Vec<HouseEntry> {
    let house_name = house_name_from(&args.dir);
    let mut out: Vec<HouseEntry> = entries
        .iter()
        .filter(|e| keep_entry(&e.rel_path, args))
        .map(|e| HouseEntry {
            rel_path: e.rel_path.clone(),
            contents: expand_placeholders(&e.contents, &house_name),
        })
        .collect();

    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn keep_entry(rel: &str, args: &InitArgs) -> bool {
    let norm = rel.replace('\\', "/");

    // Test fixtures never ship. They exist to exercise house tooling inside
    // this repository; planted into a house they would deliver synthetic
    // `AGENTS.md` files and stub lattices sitting beside the real ones, with
    // no way for the adopter to tell which files are theirs.
    if norm.starts_with("scripts/tests/") {
        return false;
    }

    if !args.skills_enabled()
        && (norm.starts_with(".amore/skills/") || norm == ".amore/skills")
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

/// Walk from `start` upward looking for `.amore/house-install.json`.
///
/// Used by the ancestor-house guard so bare `amore init` from inside a house
/// never silently nests a second house under it.
pub fn find_ancestor_house(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        if dir.join(MANIFEST_REL).is_file() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// When creating a **new** house at `root`, return the enclosing house that
/// should block the create (if any). Refresh of a manifested house is never
/// blocked. Pass `force_new` to skip the guard.
pub fn ancestor_house_blocks_new_init(
    cwd: &Path,
    root: &Path,
    force_new: bool,
) -> Option<PathBuf> {
    if force_new {
        return None;
    }
    // Target is already a house: refresh / re-run path, not a nested create.
    if root.join(MANIFEST_REL).is_file() {
        return None;
    }
    find_ancestor_house(cwd)
}

/// Resolve — and, unless this is a dry run, create — the house directory.
///
/// `init` creates a house rather than overlaying an existing repository. It is
/// safe to re-run: a directory that already carries an install manifest is
/// treated as this house and refreshed in place. A directory that holds
/// something else is refused rather than merged into, because silently
/// scattering a house across someone's unrelated project is not recoverable by
/// reading the summary afterwards. Creating a new house while the current
/// directory sits inside an existing house is refused (see
/// [`ancestor_house_blocks_new_init`]) so bare `init` never nests.
fn resolve_house_root(
    args: &InitArgs,
    ctx: &InitContext,
    writer: &mut impl Write,
) -> Result<PathBuf> {
    let root = ctx.cwd.join(&args.dir);

    if let Some(house) = ancestor_house_blocks_new_init(&ctx.cwd, &root, args.force_new) {
        bail!(
            "refusing to create a new house under an existing house at {}.\n\
             Run `amore init .` from that directory to refresh the house, \
             or pass `--force-new` to create a nested house deliberately.",
            house.display()
        );
    }

    if root.exists() {
        if !root.is_dir() {
            bail!("{} exists and is not a directory", root.display());
        }
        let already_a_house = root.join(MANIFEST_REL).exists();
        let is_empty = std::fs::read_dir(&root)
            .with_context(|| format!("read {}", root.display()))?
            .next()
            .is_none();
        if !already_a_house && !is_empty {
            bail!(
                "{} already exists and is not a house.\n\
                 Choose another name (`amore init <dir>`), or remove it first.",
                root.display()
            );
        }
    } else if !args.dry_run {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("create {}", root.display()))?;
    }

    // The house owns its history: continuity lives in what is committed, not in
    // what the last session happened to remember. Not fatal if git is missing —
    // every other part of the house still works.
    if !args.dry_run && !root.join(".git").exists() {
        if let Err(err) = git_init(&root) {
            writeln!(
                writer,
                "  note: skipped `git init` ({err}). The house works without it, \
                 but commit history is how it survives across sessions."
            )?;
        }
    }

    Ok(root)
}

fn git_init(root: &Path) -> Result<()> {
    let out = std::process::Command::new("git")
        .arg("init")
        .arg("--quiet")
        .current_dir(root)
        .output()
        .context("run git init")?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
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
    let hooks_dir = root.join(".amore").join("hooks");
    let registry_path = ctx.grok_home.join("hooks-paths");

    // `--no-hooks` suppresses both file install and global registry write.
    if !args.hooks_enabled() {
        return Ok(HooksRegistryReport {
            registry_path,
            hooks_dir,
            action: HooksRegistryAction::SkippedNoHooks,
        });
    }

    let has_hooks = plans.iter().any(|p| {
        is_hooks_rel(&p.rel_path)
            && matches!(
                p.action,
                FileAction::Write | FileAction::DryRunWrite | FileAction::SkipUnchanged
            )
    });

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
            root.join(".amore").join("hooks")
        }
    });
    // On dry-run the dir may not exist yet — still report the intended absolute path.
    let hooks_line = if hooks_abs.exists() {
        hooks_abs
    } else {
        root.join(".amore").join("hooks")
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

    // Ensure slots exist under the *overridden* grok home (not the real ~/.amore).
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
    iris: &iris_fetch::IrisOutcome,
    lucerna: &instrument_fetch::Outcome,
    speculum: &instrument_fetch::Outcome,
    qmd_step: impl FnOnce(&mut dyn Write) -> qmd_setup::QmdSetupOutcome,
) -> Result<()> {
    let mut written = Vec::new();
    let mut skipped = Vec::new();
    let mut preserved = Vec::new();
    let mut would = Vec::new();
    for p in plans {
        match p.action {
            FileAction::Write => written.push(p.rel_path.as_str()),
            FileAction::SkipUnchanged | FileAction::SkipOptOut => {
                skipped.push(p.rel_path.as_str())
            }
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

    if let Some(line) = iris.summary_line() {
        writeln!(writer, "{line}")?;
    }
    if let Some(line) = lucerna.summary_line() {
        writeln!(writer, "{line}")?;
    }
    if let Some(line) = speculum.summary_line() {
        writeln!(writer, "{line}")?;
    }

    // qmd setup after companion lines so progress streams under the summary.
    let qmd = qmd_step(writer);
    if let Some(line) = qmd.summary_line() {
        writeln!(writer, "{line}")?;
    }

    if would.is_empty() && !written.is_empty() {
        let house = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.display().to_string());
        writeln!(writer, "Next:")?;
        writeln!(writer, "  1. cd {house}")?;
        writeln!(
            writer,
            "  2. Run amore from there (trust dialog if first time)"
        )?;
        writeln!(
            writer,
            "  3. Put your work in projects/ — the house is where you launch from,"
        )?;
        writeln!(
            writer,
            "     and projects/ is git-ignored so each one keeps its own history"
        )?;
        writeln!(
            writer,
            "  AGENTS.md is yours to edit — it is the house's constitution."
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
    fn keep_entry_never_plants_test_fixtures() {
        // Fixtures under scripts/tests/ never ship — they exercise house tooling
        // in-repo, and a planted copy would look indistinguishable from house
        // content (synthetic AGENTS.md files, stub lattices).
        let args = InitArgs::default();
        assert!(!keep_entry("scripts/tests/fixtures/sync-tree/AGENTS.md", &args));
        assert!(!keep_entry(
            "scripts/tests/fixtures/sync-tree/context/principle-lattice.md",
            &args
        ));
        // Backslash-separated paths normalize the same way.
        assert!(!keep_entry("scripts\\tests\\fixtures\\sync-tree\\AGENTS.md", &args));

        // The house tooling itself ships — it is the adopter's to run and edit.
        assert!(keep_entry("scripts/sync_orientation_rules.py", &args));
        // As do the hooks fixtures: canned envelopes for a script they own,
        // documented by the hooks README, and not mistakable for house content.
        assert!(keep_entry(
            ".amore/hooks/fixtures/stop-gate/01-first-fire-block.json",
            &args
        ));
    }

    #[test]
    fn placeholders_are_filled_in_at_install_time() {
        // The user should never receive a file telling them to find-and-replace
        // a token the tool already knows the value of.
        let out = expand_placeholders(b"# {{HOUSE_NAME}}\n{{HOUSE_ROOT_LABEL}}/", "atelier");
        assert_eq!(String::from_utf8(out).unwrap(), "# atelier\natelier/");

        // Non-UTF-8 assets pass through byte-identical.
        let png = [0x89u8, 0x50, 0x4E, 0x47, 0xFF, 0xFE];
        assert_eq!(expand_placeholders(&png, "atelier"), png.to_vec());

        // Text without placeholders is untouched.
        let plain = b"nothing to expand";
        assert_eq!(expand_placeholders(plain, "atelier"), plain.to_vec());
    }

    #[test]
    fn house_name_comes_from_the_directory() {
        assert_eq!(house_name_from("amore"), "amore");
        assert_eq!(house_name_from("my-house"), "my-house");
        assert_eq!(house_name_from("../work/atelier"), "atelier");
        // Degenerate input falls back rather than yielding an empty name.
        assert_eq!(house_name_from(""), DEFAULT_HOUSE_DIR);
    }

    #[test]
    fn default_house_dir_is_amore() {
        assert_eq!(InitArgs::default().dir, DEFAULT_HOUSE_DIR);
        assert_eq!(DEFAULT_HOUSE_DIR, "amore");
    }

    #[test]
    fn keep_entry_respects_no_skills_and_no_lattice() {
        let mut args = InitArgs::default();
        assert!(args.skills_enabled());
        assert!(keep_entry(".amore/skills/foo/SKILL.md", &args));
        args.no_skills = true;
        assert!(!args.skills_enabled());
        assert!(!keep_entry(".amore/skills/foo/SKILL.md", &args));
        assert!(keep_entry("AGENTS.md", &args));

        args = InitArgs::default();
        assert!(args.lattice_enabled());
        assert!(keep_entry("context/principle-lattice.md", &args));
        args.no_lattice = true;
        assert!(!args.lattice_enabled());
        assert!(!keep_entry("context/principle-lattice.md", &args));

        // Hooks stay in the pack (plan marks SkipOptOut); keep_entry does not drop them.
        args = InitArgs::default();
        args.no_hooks = true;
        assert!(!args.hooks_enabled());
        assert!(
            keep_entry(".amore/hooks/demo.json", &args),
            "hooks remain selectable so the plan can list them as skipped"
        );
    }

    #[test]
    fn everything_the_house_needs_is_on_by_default() {
        // Iris joined this list when it stopped being an optional extra: a
        // plain `amore init` gives you the whole house, and each piece has an
        // explicit opt-out rather than an opt-in nobody discovers. Semantic
        // search setup follows iris by default.
        let args = InitArgs::default();
        assert!(args.skills_enabled());
        assert!(args.hooks_enabled());
        assert!(args.lattice_enabled());
        assert!(args.iris_enabled());
        assert!(args.qmd_enabled());
        // Optional companions stay off until asked for.
        assert!(!args.lucerna_enabled());
        assert!(!args.speculum_enabled());
    }

    #[test]
    fn each_piece_has_a_working_opt_out() {
        let off = |f: fn(&mut InitArgs)| {
            let mut a = InitArgs::default();
            f(&mut a);
            a
        };
        assert!(!off(|a| a.no_skills = true).skills_enabled());
        assert!(!off(|a| a.no_hooks = true).hooks_enabled());
        assert!(!off(|a| a.no_lattice = true).lattice_enabled());
        // --no-iris is also the offline switch: it must actually disable the
        // default-on network path in `init`.
        assert!(!off(|a| a.no_iris = true).iris_enabled());
        assert!(!off(|a| a.no_iris = true).qmd_enabled());
        assert!(!off(|a| a.no_qmd = true).qmd_enabled());
        // --no-qmd leaves iris on.
        assert!(off(|a| a.no_qmd = true).iris_enabled());
    }

    #[test]
    fn optional_companions_default_off_and_opt_in() {
        let args = InitArgs::default();
        assert!(!args.lucerna_enabled());
        assert!(!args.speculum_enabled());
        assert!(!args.with_lucerna);
        assert!(!args.with_speculum);

        let mut on = InitArgs::default();
        on.with_lucerna = true;
        on.with_speculum = true;
        assert!(on.lucerna_enabled());
        assert!(on.speculum_enabled());
        // Opt-in companions do not flip iris polarity.
        assert!(on.iris_enabled());
        on.no_iris = true;
        assert!(!on.iris_enabled());
        assert!(on.lucerna_enabled());
        assert!(on.speculum_enabled());
    }

    #[test]
    fn find_ancestor_house_walks_up_to_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let house = tmp.path().join("house");
        let nested = house.join("projects").join("work");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(house.join(".amore")).unwrap();
        std::fs::write(house.join(MANIFEST_REL), r#"{"version":1,"files":{}}"#).unwrap();

        assert_eq!(find_ancestor_house(&nested).as_deref(), Some(house.as_path()));
        assert_eq!(find_ancestor_house(&house).as_deref(), Some(house.as_path()));
        assert_eq!(find_ancestor_house(tmp.path()), None);
    }

    #[test]
    fn ancestor_guard_refuses_nested_create_inside_house() {
        let tmp = tempfile::tempdir().unwrap();
        let house = tmp.path().join("house");
        std::fs::create_dir_all(house.join(".amore")).unwrap();
        std::fs::write(house.join(MANIFEST_REL), r#"{"version":1,"files":{}}"#).unwrap();

        // Bare default: cwd=house, root=house/amore (new nested path).
        let nested_root = house.join(DEFAULT_HOUSE_DIR);
        let blocked = ancestor_house_blocks_new_init(&house, &nested_root, false);
        assert_eq!(blocked.as_deref(), Some(house.as_path()));

        // Escape hatch.
        assert_eq!(
            ancestor_house_blocks_new_init(&house, &nested_root, true),
            None
        );
    }

    #[test]
    fn ancestor_guard_allows_refresh_of_manifested_house() {
        let tmp = tempfile::tempdir().unwrap();
        let house = tmp.path().join("house");
        std::fs::create_dir_all(house.join(".amore")).unwrap();
        std::fs::write(house.join(MANIFEST_REL), r#"{"version":1,"files":{}}"#).unwrap();

        // `amore init .` from the house: root is the house itself.
        assert_eq!(
            ancestor_house_blocks_new_init(&house, &house, false),
            None
        );
    }

    #[test]
    fn ancestor_guard_allows_fresh_dir_outside_any_house() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        let root = cwd.join(DEFAULT_HOUSE_DIR);
        assert_eq!(ancestor_house_blocks_new_init(cwd, &root, false), None);
    }

    #[test]
    fn resolve_house_root_refuses_nested_init_via_context() {
        let tmp = tempfile::tempdir().unwrap();
        let house = tmp.path().join("house");
        std::fs::create_dir_all(house.join(".amore")).unwrap();
        std::fs::write(house.join(MANIFEST_REL), r#"{"version":1,"files":{}}"#).unwrap();

        let grok_home = tmp.path().join("grok-home");
        std::fs::create_dir_all(&grok_home).unwrap();
        let ctx = InitContext {
            cwd: house.clone(),
            grok_home,
            entries: vec![],
            stdin_is_terminal: false,
        };
        let args = InitArgs {
            no_iris: true,
            no_qmd: true,
            ..InitArgs::default()
        };
        let mut out = Vec::new();
        let err = run_with_context(&args, &ctx, &mut out).expect_err("must refuse nested init");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("refusing to create a new house") || msg.contains("existing house"),
            "unexpected message: {msg}"
        );
        assert!(
            msg.contains("amore init .") || msg.contains("init ."),
            "message should suggest init . : {msg}"
        );
        // Nested directory must not have been created.
        assert!(!house.join(DEFAULT_HOUSE_DIR).exists());
    }

    #[test]
    fn resolve_house_root_refresh_manifested_dot_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let house = tmp.path().join("house");
        std::fs::create_dir_all(house.join(".amore")).unwrap();
        std::fs::write(house.join(MANIFEST_REL), r#"{"version":1,"files":{}}"#).unwrap();

        let grok_home = tmp.path().join("grok-home");
        std::fs::create_dir_all(&grok_home).unwrap();
        let ctx = InitContext {
            cwd: house.clone(),
            grok_home,
            entries: vec![HouseEntry {
                rel_path: "AGENTS.md".into(),
                contents: b"# house\n".to_vec(),
            }],
            stdin_is_terminal: false,
        };
        let args = InitArgs {
            dir: ".".into(),
            no_iris: true,
            no_qmd: true,
            no_hooks: true,
            yes: true,
            ..InitArgs::default()
        };
        let mut out = Vec::new();
        let report = run_with_context(&args, &ctx, &mut out).expect("init . should refresh house");
        assert_eq!(report.root, house);
        // Customized? New AGENTS should write if missing.
        assert!(house.join("AGENTS.md").exists());
    }
}
