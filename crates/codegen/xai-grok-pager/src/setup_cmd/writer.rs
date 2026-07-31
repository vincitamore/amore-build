//! Config.toml writer for first-run wizard model entries.
//!
//! Field set matches `ConfigModelOverride` + `docs/setup-k3.md` (wave-3
//! schema-verified shapes). `system_prompt_label` is mandatory on every write.

use std::path::Path;

use anyhow::{Context, Result, bail};

/// A planned `[model.<id>]` block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelEntryPlan {
    /// Catalog / config id (table key), e.g. `k3-openrouter`.
    pub id: String,
    pub model: String,
    pub base_url: String,
    pub name: String,
    pub env_key: String,
    pub system_prompt_label: String,
    pub context_window: u64,
    pub max_completion_tokens: u32,
    /// When true, also set `[models] default = <id>`.
    pub set_as_default: bool,
}

impl ModelEntryPlan {
    /// OpenRouter path — recommended public on-ramp (`docs/setup-k3.md` §1).
    pub fn openrouter() -> Self {
        Self {
            id: "k3-openrouter".into(),
            model: "moonshotai/kimi-k3".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            name: "Kimi K3 (OpenRouter)".into(),
            env_key: "OPENROUTER_API_KEY".into(),
            system_prompt_label: "Kimi K3 (via OpenRouter)".into(),
            context_window: 1_048_576,
            max_completion_tokens: 16_384,
            set_as_default: true,
        }
    }

    /// Moonshot direct (`docs/setup-k3.md` §2).
    pub fn moonshot() -> Self {
        Self {
            id: "k3-moonshot".into(),
            model: "kimi-k3".into(),
            base_url: "https://api.moonshot.ai/v1".into(),
            name: "Kimi K3 (Moonshot)".into(),
            env_key: "MOONSHOT_API_KEY".into(),
            system_prompt_label: "Kimi K3 (via Moonshot)".into(),
            context_window: 1_048_576,
            max_completion_tokens: 16_384,
            set_as_default: true,
        }
    }

    /// Open-weight host — user supplies base URL + env key + wire model id.
    pub fn open_weight(base_url: String, env_key: String, model: String) -> Self {
        Self {
            id: "k3-openweight".into(),
            model,
            base_url,
            name: "Kimi K3 (open-weight host)".into(),
            env_key,
            system_prompt_label: "Kimi K3 (via open-weight host)".into(),
            context_window: 1_048_576,
            max_completion_tokens: 16_384,
            set_as_default: true,
        }
    }
}

/// Result of a config write attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteReport {
    pub config_path: std::path::PathBuf,
    pub model_id: String,
    pub env_key: String,
    pub dry_run: bool,
}

/// Merge `plan` into `config.toml` at `config_path` (create parent dirs / file).
///
/// Refuses to clobber a non-empty unparseable file. Overwrites an existing
/// `[model.<id>]` table for the same id (idempotent re-run).
///
/// Real writes are atomic: temp file in the same directory then `rename`.
/// `--dry-run` builds the document in memory only — no directory creation,
/// no temp files, no rename.
pub fn write_model_entry(config_path: &Path, plan: &ModelEntryPlan, dry_run: bool) -> Result<WriteReport> {
    if plan.system_prompt_label.trim().is_empty() {
        bail!("system_prompt_label is mandatory for custom [model.*] entries");
    }
    if plan.env_key.trim().is_empty() {
        bail!("env_key is required (prefer env over literal api_key)");
    }

    // Dry-run: never create parents or touch disk.
    if !dry_run {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
    }

    let mut doc = read_or_empty(config_path)?;

    {
        let models = doc["model"]
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_mut()
            .context("config [model] is not a table")?;
        // Keep dotted keys as [model.id] tables.
        models.set_implicit(true);

        let mut table = toml_edit::Table::new();
        table["model"] = toml_edit::value(plan.model.as_str());
        table["base_url"] = toml_edit::value(plan.base_url.as_str());
        table["name"] = toml_edit::value(plan.name.as_str());
        table["env_key"] = toml_edit::value(plan.env_key.as_str());
        table["system_prompt_label"] = toml_edit::value(plan.system_prompt_label.as_str());
        table["context_window"] = toml_edit::value(plan.context_window as i64);
        table["max_completion_tokens"] =
            toml_edit::value(i64::from(plan.max_completion_tokens));
        models[&plan.id] = toml_edit::Item::Table(table);
    }

    if plan.set_as_default {
        let models_cfg = doc["models"]
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_mut()
            .context("config [models] is not a table")?;
        models_cfg["default"] = toml_edit::value(plan.id.as_str());
    }

    if !dry_run {
        atomic_write(config_path, doc.to_string().as_bytes())
            .with_context(|| format!("atomic write {}", config_path.display()))?;
    }

    Ok(WriteReport {
        config_path: config_path.to_path_buf(),
        model_id: plan.id.clone(),
        env_key: plan.env_key.clone(),
        dry_run,
    })
}

/// Write `contents` to `path` via same-dir temp + rename (crash-safe).
///
/// Temp name: `{filename}.tmp-{pid}` in the same directory as `path`, so
/// rename stays on one volume.
fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = parent.join(format!("{stem}.tmp-{}", std::process::id()));
    std::fs::write(&tmp, contents)
        .with_context(|| format!("write temp {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| {
        // Best-effort cleanup so a failed rename does not leave a stale temp.
        let _ = std::fs::remove_file(&tmp);
        format!("rename {} → {}", tmp.display(), path.display())
    })?;
    Ok(())
}

fn read_or_empty(path: &Path) -> Result<toml_edit::DocumentMut> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    if content.trim().is_empty() {
        return Ok(toml_edit::DocumentMut::new());
    }
    content
        .parse()
        .with_context(|| format!("parse {}; refusing to overwrite invalid TOML", path.display()))
}

/// Iris companion pointer planted under the arcus home (not a binary install).
pub const IRIS_POINTER_NAME: &str = "iris-companion.toml";

/// Expected public release-asset name shape (v1 documents only; no download).
pub fn iris_asset_shape() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    };
    format!("iris-{os}-{arch}")
}

// `detect_iris_on_path` re-homed to `crate::iris_companion` (TUI seam).

/// Write the companion pointer config. Returns the path written (or that would be).
pub fn write_iris_pointer(
    home: &Path,
    detected: Option<&Path>,
    dry_run: bool,
) -> Result<std::path::PathBuf> {
    let path = home.join(IRIS_POINTER_NAME);
    let asset = iris_asset_shape();
    let mut body = String::from(
        "# Iris companion pointer — written by `arcus setup` / first-run wizard.\n\
         # Iris is optional; this file is not an install.\n\
         # Expected release asset shape (fetch deferred; CI pipeline is a later unit):\n",
    );
    body.push_str(&format!("#   {asset}\n"));
    body.push_str(
        "# See product docs for the companion install story.\n\n\
         [iris]\n",
    );
    match detected {
        Some(p) => {
            body.push_str("detected = true\n");
            body.push_str(&format!("path = {}\n", toml_quote(&p.display().to_string())));
        }
        None => {
            body.push_str("detected = false\n");
            body.push_str(&format!("expected_asset = {}\n", toml_quote(&asset)));
        }
    }
    if !dry_run {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(&path, body.as_bytes())?;
    }
    Ok(path)
}

fn toml_quote(s: &str) -> String {
    // Minimal basic-string escape for paths.
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn write_openrouter_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[ui]\ntheme = \"dark\"\n").unwrap();
        let plan = ModelEntryPlan::openrouter();
        let report = write_model_entry(&path, &plan, false).unwrap();
        assert_eq!(report.model_id, "k3-openrouter");
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("theme"), "must preserve siblings: {body}");
        assert!(body.contains("moonshotai/kimi-k3"), "{body}");
        assert!(body.contains("OPENROUTER_API_KEY"), "{body}");
        assert!(body.contains("system_prompt_label"), "{body}");
        assert!(body.contains("Kimi K3 (via OpenRouter)"), "{body}");
        assert!(body.contains("default"), "{body}");
        assert!(body.contains("1048576") || body.contains("1_048_576"), "{body}");
    }

    #[test]
    fn dry_run_writes_nothing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        write_model_entry(&path, &ModelEntryPlan::moonshot(), true).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn dry_run_creates_no_parent_dir() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("never-created").join("config.toml");
        write_model_entry(&nested, &ModelEntryPlan::openrouter(), true).unwrap();
        assert!(
            !dir.path().join("never-created").exists(),
            "dry-run must not create parent directories"
        );
        assert!(!nested.exists());
    }

    #[test]
    fn atomic_write_happy_path_no_temp_left() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "[ui]\ntheme = \"dark\"\n").unwrap();
        write_model_entry(&path, &ModelEntryPlan::openrouter(), false).unwrap();
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains("k3-openrouter"), "{body}");
        assert!(body.contains("theme"), "sibling preserved: {body}");
        // No leftover temp files from atomic write.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files must be renamed away: {leftovers:?}"
        );
    }

    #[test]
    fn refuses_empty_system_prompt_label() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut plan = ModelEntryPlan::openrouter();
        plan.system_prompt_label = "  ".into();
        assert!(write_model_entry(&path, &plan, false).is_err());
    }

    #[test]
    fn iris_pointer_write() {
        let dir = tempdir().unwrap();
        let p = write_iris_pointer(dir.path(), None, false).unwrap();
        let body = fs::read_to_string(&p).unwrap();
        assert!(body.contains("iris-"));
        assert!(body.contains("detected = false"));
    }

    #[test]
    fn asset_shape_has_iris_prefix() {
        let s = iris_asset_shape();
        assert!(s.starts_with("iris-"), "{s}");
    }
}
