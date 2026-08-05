//! Companion instrument presence for `amore doctor`.
//!
//! Probes iris (default-on), lucerna (opt-in), speculum (opt-in), and managed
//! qmd semantic search without starting daemons, downloading packages, or
//! spawning the qmd runtime. Binary resolution prefers the directory beside
//! the running `amore` executable (init's PATH-link layout), then PATH.
//! Version probes use a short wall timeout and never hang doctor.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{
    CompanionInstall, DiagnosticFinding, DiagnosticId, DiagnosticReport, FindingDisposition,
    InstrumentsFacts, IrisDaemonHome, IrisHomeLayout, JsRuntimeFact, LucernaEnablementFact,
    ManualRemediation, QmdHouseIndexFact, QmdModelsFact, QmdRuntimeFact, QmdSearchFacts,
};

/// Finding when the default-on iris companion is not installed.
pub const IRIS_MISSING_ID: DiagnosticId = DiagnosticId::new("instruments", "iris-missing");

/// Finding when semantic search needs a JS runtime (node >= 22 or bun) on PATH.
pub const QMD_JS_RUNTIME_MISSING_ID: DiagnosticId =
    DiagnosticId::new("instruments", "qmd-js-runtime-missing");

/// Wall timeout for companion `--version` probes.
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

/// Install manifest relative path (same as init) used to locate the house root.
const HOUSE_MANIFEST_REL: &str = ".amore/house-install.json";

/// Probe companions on the live host and attach facts (+ optional findings).
///
/// Never starts processes beyond a short `--version` / runtime version read.
/// Never writes enablement. Opt-in companions that are absent add facts only
/// — no issues. Missing qmd pieces are informational rows; a missing JS
/// runtime is a Recommendation (prerequisite), never an Issue.
pub fn apply_instruments_probe(report: &mut DiagnosticReport) {
    let facts = probe_instruments();
    if matches!(facts.iris, CompanionInstall::NotInstalled) {
        report.findings.push(iris_missing_finding());
    }
    if matches!(facts.qmd.js_runtime, JsRuntimeFact::Missing) {
        report.findings.push(qmd_js_runtime_missing_finding());
    }
    report.facts.instruments = facts;
}

fn iris_missing_finding() -> DiagnosticFinding {
    let bin = super::fix::invoked_bin();
    DiagnosticFinding {
        id: IRIS_MISSING_ID,
        disposition: FindingDisposition::Recommendation,
        message: "iris companion is not installed beside this binary or on PATH".to_owned(),
        remediation: Some(ManualRemediation {
            fix: format!(
                "{bin} init installs iris by default into a new house and links it beside {bin}"
            ),
            config_path: None,
        }),
        automatic_remediation: None,
        note: Some(
            "Iris is the default house companion. Absence is quiet at runtime; install via \
             init or place `iris` on PATH. Doctor never starts the iris daemon."
                .to_owned(),
        ),
    }
}

fn qmd_js_runtime_missing_finding() -> DiagnosticFinding {
    DiagnosticFinding {
        id: QMD_JS_RUNTIME_MISSING_ID,
        disposition: FindingDisposition::Recommendation,
        message: "semantic search needs Node.js >= 22 or Bun on PATH".to_owned(),
        remediation: Some(ManualRemediation {
            fix: "install Node.js 22+ (https://nodejs.org) or Bun, then run `iris qmd setup` from the house root".to_owned(),
            config_path: None,
        }),
        automatic_remediation: None,
        note: Some(
            "The managed qmd package runs under Node or Bun. Doctor never installs a runtime \
             or downloads search models."
                .to_owned(),
        ),
    }
}

/// Live probe of companions and managed search.
pub fn probe_instruments() -> InstrumentsFacts {
    let iris = probe_companion("iris");
    let lucerna = probe_companion("lucerna");
    let speculum = probe_companion("speculum");
    let iris_daemon_home = probe_iris_daemon_home();
    let lucerna_enablement = if lucerna.is_installed() {
        probe_lucerna_enablement(std::env::current_dir().ok().as_deref())
    } else {
        LucernaEnablementFact::NotObserved
    };
    let qmd = probe_qmd_search(std::env::current_dir().ok().as_deref());
    InstrumentsFacts {
        iris,
        iris_daemon_home,
        lucerna,
        lucerna_enablement,
        speculum,
        qmd,
    }
}

/// Resolve `name` beside the running binary, then on PATH; run `--version`.
///
/// The binary is reported as installed when found. The version string is kept
/// only when the first output line matches a companion version shape
/// (`name` + dotted numeric version). JSON errors, usage blurbs, and empty
/// output never become version facts.
pub fn probe_companion(name: &str) -> CompanionInstall {
    let Some(path) = resolve_companion_bin(name) else {
        return CompanionInstall::NotInstalled;
    };
    match run_version(&path) {
        Ok(line) => CompanionInstall::Installed {
            path,
            version: parse_companion_version_line(&line),
        },
        Err(error) => CompanionInstall::ProbeFailed { path, error },
    }
}

/// Accept a companion `--version` first line only when it looks like a real
/// version: a non-space name token, then a dotted numeric version
/// (`^\S+ v?[0-9]+\.[0-9]+` …). Rejects JSON envelopes, description/usage
/// lines, and empty input. Returns the truncated original line when valid.
pub fn parse_companion_version_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // Name token: one or more non-whitespace chars, then whitespace, then version.
    let mut parts = line.split_whitespace();
    let name = parts.next()?;
    if name.is_empty() {
        return None;
    }
    let ver_token = parts.next()?;
    if !version_token_has_dotted_numeric(ver_token) {
        return None;
    }
    Some(truncate_version(line))
}

/// `v?[0-9]+\.[0-9]+` at the start of the token (more components / suffix ok).
fn version_token_has_dotted_numeric(token: &str) -> bool {
    let body = token.strip_prefix('v').unwrap_or(token);
    let bytes = body.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    // [0-9]+
    if !bytes[i].is_ascii_digit() {
        return false;
    }
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    // \.
    if i >= bytes.len() || bytes[i] != b'.' {
        return false;
    }
    i += 1;
    // [0-9]+
    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
        return false;
    }
    true
}

/// Prefer the directory of `current_exe` (init links companions there), else PATH.
pub fn resolve_companion_bin(name: &str) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    if let Ok(current) = std::env::current_exe()
        && let Some(dir) = current.parent()
    {
        let beside = dir.join(&exe_name);
        if beside.is_file() || beside.exists() {
            return Some(beside);
        }
    }
    which::which(name).ok().filter(|p| !p.as_os_str().is_empty())
}

/// Iris state home: managed `~/.amore/instruments/iris/` first, then legacy `~/.iris`.
pub fn probe_iris_daemon_home() -> IrisDaemonHome {
    #[allow(deprecated)]
    let Some(home) = std::env::home_dir() else {
        return IrisDaemonHome::HomeUnavailable;
    };
    probe_iris_daemon_home_at(&home)
}

/// Testable iris-home probe with an explicit user home root.
pub fn probe_iris_daemon_home_at(user_home: &Path) -> IrisDaemonHome {
    let managed = user_home
        .join(".amore")
        .join("instruments")
        .join("iris");
    let legacy = user_home.join(".iris");
    if managed.is_dir() {
        return IrisDaemonHome::Present {
            path: managed,
            layout: IrisHomeLayout::Managed,
        };
    }
    if legacy.is_dir() {
        let moved_marker = legacy.join("MOVED.md").is_file();
        return IrisDaemonHome::Present {
            path: legacy,
            layout: IrisHomeLayout::Legacy { moved_marker },
        };
    }
    IrisDaemonHome::Absent {
        managed_path: managed,
        legacy_path: legacy,
    }
}

/// Probe managed qmd search state under `~/.amore/instruments/qmd/` (no spawn of qmd).
pub fn probe_qmd_search(cwd: Option<&Path>) -> QmdSearchFacts {
    #[allow(deprecated)]
    let Some(home) = std::env::home_dir() else {
        return QmdSearchFacts {
            runtime: QmdRuntimeFact::HomeUnavailable,
            models: QmdModelsFact::HomeUnavailable,
            house_index: QmdHouseIndexFact::HomeUnavailable,
            js_runtime: probe_js_runtime(),
        };
    };
    probe_qmd_search_at(&home, cwd)
}

/// Testable qmd probe with explicit amore home and optional house cwd.
pub fn probe_qmd_search_at(user_home: &Path, cwd: Option<&Path>) -> QmdSearchFacts {
    let qmd_home = user_home.join(".amore").join("instruments").join("qmd");
    let runtime_path = qmd_home.join("runtime");
    let models_path = qmd_home.join("models");

    let runtime = if runtime_path.is_dir() {
        QmdRuntimeFact::Present {
            version: read_qmd_runtime_version(&runtime_path),
            path: runtime_path,
        }
    } else {
        QmdRuntimeFact::Absent {
            path: runtime_path,
        }
    };

    let models = probe_qmd_models(&models_path);
    let house_index = probe_qmd_house_index(&qmd_home, cwd);
    let js_runtime = probe_js_runtime();

    QmdSearchFacts {
        runtime,
        models,
        house_index,
        js_runtime,
    }
}

fn read_qmd_runtime_version(runtime: &Path) -> Option<String> {
    // Prefer a top-level package.json, then the nested @tobilu/qmd pin.
    for rel in [
        "package.json",
        "node_modules/@tobilu/qmd/package.json",
        "node_modules/@tobilu/qmd/package.json",
    ] {
        let path = runtime.join(rel);
        if let Some(v) = read_package_json_version(&path) {
            return Some(v);
        }
    }
    // Plain VERSION / pin file if the installer wrote one.
    for name in ["VERSION", "version", ".qmd-version"] {
        let path = runtime.join(name);
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let line = raw.lines().map(str::trim).find(|l| !l.is_empty());
            if let Some(v) = line {
                return Some(v.to_owned());
            }
        }
    }
    None
}

fn read_package_json_version(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_owned())
}

fn probe_qmd_models(models_path: &Path) -> QmdModelsFact {
    if !models_path.is_dir() {
        return QmdModelsFact::Absent {
            path: models_path.to_path_buf(),
        };
    }
    let mut names = Vec::new();
    let mut total_bytes: u64 = 0;
    let entries = match std::fs::read_dir(models_path) {
        Ok(e) => e,
        Err(_) => {
            return QmdModelsFact::Absent {
                path: models_path.to_path_buf(),
            };
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Model weights are typically .gguf; count other files too if present.
        let meta = entry.metadata().ok();
        let len = meta.map(|m| m.len()).unwrap_or(0);
        total_bytes = total_bytes.saturating_add(len);
        names.push(name);
    }
    names.sort();
    if names.is_empty() {
        return QmdModelsFact::Absent {
            path: models_path.to_path_buf(),
        };
    }
    let count = names.len();
    QmdModelsFact::Present {
        path: models_path.to_path_buf(),
        count,
        total_bytes,
        names,
    }
}

fn probe_qmd_house_index(qmd_home: &Path, cwd: Option<&Path>) -> QmdHouseIndexFact {
    let Some(cwd) = cwd else {
        return QmdHouseIndexFact::HouseNotResolved;
    };
    let Some(house_root) = find_house_root(cwd) else {
        return QmdHouseIndexFact::HouseNotResolved;
    };
    // Same id scheme as iris `deriveHouseId` (houses/<base>-<hash12>/).
    let house_id = derive_house_id(&house_root, Some(cwd));
    let path = qmd_home.join("houses").join(&house_id);
    // Present when the house directory exists and holds an index or config.
    let has_index = path.is_dir()
        && (path.join("index.sqlite").is_file()
            || path.join("index.yml").is_file()
            || path.join("config").is_dir()
            || dir_nonempty(&path));
    if has_index {
        QmdHouseIndexFact::Present { path, house_id }
    } else {
        QmdHouseIndexFact::Absent { path, house_id }
    }
}

/// Stable filesystem-safe house id matching iris `deriveHouseId`.
///
/// Contract (iris `packages/daemon/src/proxies/qmd.ts`):
/// 1. Absolutize lexically (join cwd if relative, normalize `.`/`..`; no
///    symlink resolution). Root-absolute paths without a drive letter pick
///    up the drive from `cwd` when `cwd` is Windows-style (Node `path.resolve`
///    on Windows). Convert backslashes to forward slashes.
/// 2. If the result starts with a drive letter, uppercase that letter.
/// 3. `hash` = first 12 hex chars of sha256 of the lowercased string.
/// 4. `base` = final path component, non-`[a-zA-Z0-9._-]` runs → `_`, trim
///    underscores, cap 40 chars, fallback `house`.
/// 5. `id` = `{base}-{hash}`.
pub fn derive_house_id(org_root: &Path, cwd: Option<&Path>) -> String {
    let root = org_root.to_string_lossy();
    let cwd_s = cwd
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    derive_house_id_str(&root, &cwd_s)
}

/// String entry for tests and path-lossy callers. See [`derive_house_id`].
pub fn derive_house_id_str(org_root: &str, cwd: &str) -> String {
    let abs = lexical_absolutize(org_root, cwd);
    let mut abs = abs.replace('\\', "/");
    if let Some((drive, rest)) = split_drive(&abs) {
        abs = format!("{}:{}", drive.to_ascii_uppercase(), rest);
    }
    let digest = xai_file_utils::sha256_hex(abs.to_ascii_lowercase().as_bytes());
    let hash = &digest[..12.min(digest.len())];
    let base_raw = abs
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("");
    let base = sanitize_house_base(base_raw);
    format!("{base}-{hash}")
}

/// Lexical absolute path with `/` separators (no symlink resolution).
fn lexical_absolutize(org_root: &str, cwd: &str) -> String {
    let root = org_root.replace('\\', "/");
    let cwd = cwd.replace('\\', "/");
    let joined = if is_drive_absolute(&root) {
        root
    } else if root.starts_with('/') {
        // Node win32 resolve: `/foo` is absolute on the current drive.
        if let Some((drive, _)) = split_drive(&cwd) {
            format!("{drive}:{root}")
        } else {
            root
        }
    } else if cwd.is_empty() {
        root
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), root.trim_start_matches('/'))
    };
    normalize_lexical_path(&joined)
}

fn is_drive_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Split `C:/foo` → (`C`, `/foo`). Input may use `/` or already be mixed.
fn split_drive(path: &str) -> Option<(char, &str)> {
    let mut chars = path.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if chars.next() != Some(':') {
        return None;
    }
    Some((first, &path[first.len_utf8() + 1..]))
}

/// Collapse `.` / `..` and duplicate slashes without touching the filesystem.
fn normalize_lexical_path(path: &str) -> String {
    let (drive_prefix, body) = if let Some((d, rest)) = split_drive(path) {
        (Some(d), rest)
    } else {
        (None, path)
    };
    let absolute = body.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for part in body.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if !stack.is_empty() {
                stack.pop();
            }
            continue;
        }
        stack.push(part);
    }
    let mut out = String::new();
    if let Some(d) = drive_prefix {
        out.push(d);
        out.push(':');
    }
    // Preserve root slash for absolute bodies; drive-absolute forms use
    // `C:/foo` (Node path.resolve style).
    if absolute || drive_prefix.is_some() {
        out.push('/');
    }
    out.push_str(&stack.join("/"));
    // Bare drive `C:` → `C:/` so basename logic stays defined.
    if out.ends_with(':') {
        out.push('/');
    }
    out
}

fn sanitize_house_base(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_us = false;
    for ch in name.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-';
        if ok {
            out.push(ch);
            prev_us = false;
        } else if !prev_us {
            out.push('_');
            prev_us = true;
        }
    }
    let trimmed = out.trim_matches('_');
    let capped: String = trimmed.chars().take(40).collect();
    if capped.is_empty() {
        "house".to_owned()
    } else {
        capped
    }
}

fn dir_nonempty(path: &Path) -> bool {
    std::fs::read_dir(path)
        .ok()
        .map(|mut d| d.next().is_some())
        .unwrap_or(false)
}

fn find_house_root(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        if dir.join(HOUSE_MANIFEST_REL).is_file() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Resolve Node >= 22 or Bun on PATH. Never treats an old Node as available.
pub fn probe_js_runtime() -> JsRuntimeFact {
    if let Some(version) = probe_node_version_ge_22() {
        return JsRuntimeFact::Available {
            kind: "node".to_owned(),
            version,
        };
    }
    if let Some(version) = probe_command_version("bun") {
        return JsRuntimeFact::Available {
            kind: "bun".to_owned(),
            version,
        };
    }
    JsRuntimeFact::Missing
}

fn probe_node_version_ge_22() -> Option<String> {
    let version = probe_command_version("node")?;
    // Accept "v22.0.0", "22.1.0", etc.
    let digits = version.trim().trim_start_matches('v');
    let major = digits.split('.').next()?.parse::<u32>().ok()?;
    if major >= 22 {
        Some(version)
    } else {
        None
    }
}

fn probe_command_version(name: &str) -> Option<String> {
    let path = which::which(name).ok()?;
    run_version(&path).ok()
}

/// Walk from `start` upward for `instruments/lucerna/lucerna.enable.json`.
pub fn probe_lucerna_enablement(start: Option<&Path>) -> LucernaEnablementFact {
    let Some(start) = start else {
        return LucernaEnablementFact::NotObserved;
    };
    let Some(path) = find_enablement_file(start) else {
        return LucernaEnablementFact::NotObserved;
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => match parse_enablement_json(&raw) {
            Ok((dreams_enabled, auto_commit_live)) => LucernaEnablementFact::Observed {
                path,
                dreams_enabled,
                auto_commit_live,
                error: None,
            },
            Err(error) => LucernaEnablementFact::Observed {
                path,
                dreams_enabled: false,
                auto_commit_live: false,
                error: Some(error),
            },
        },
        Err(err) => LucernaEnablementFact::Observed {
            path,
            dreams_enabled: false,
            auto_commit_live: false,
            error: Some(format!("read failed: {err}")),
        },
    }
}

fn find_enablement_file(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        let candidate = dir
            .join("instruments")
            .join("lucerna")
            .join("lucerna.enable.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Parse lucerna enablement JSON. Invalid JSON → error; missing keys → false.
pub fn parse_enablement_json(raw: &str) -> Result<(bool, bool), String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("malformed enablement JSON: {e}"))?;
    let obj = value
        .as_object()
        .ok_or_else(|| "malformed enablement JSON: expected object".to_owned())?;
    let dreams_enabled = obj.get("dreamsEnabled").and_then(|v| v.as_bool()) == Some(true);
    let auto_commit_live = obj.get("autoCommitLive").and_then(|v| v.as_bool()) == Some(true);
    Ok((dreams_enabled, auto_commit_live))
}

fn run_version(bin: &Path) -> Result<String, String> {
    use std::io::Read as _;

    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;

    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "timed out after {}s",
                        VERSION_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("wait: {e}")),
        }
    }

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut stdout_buf);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_end(&mut stderr_buf);
    }
    let stdout = String::from_utf8_lossy(&stdout_buf);
    let stderr = String::from_utf8_lossy(&stderr_buf);
    let text = if !stdout.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_owned();
    if line.is_empty() {
        return Err("empty --version output".to_owned());
    }
    Ok(truncate_version(&line))
}

fn truncate_version(line: &str) -> String {
    const MAX: usize = 120;
    if line.chars().count() <= MAX {
        return line.to_owned();
    }
    let mut out: String = line.chars().take(MAX).collect();
    out.push('…');
    out
}

/// Human-readable one-line install status for doctor rows.
pub fn format_install_line(install: &CompanionInstall) -> String {
    match install {
        CompanionInstall::Installed { path, version } => match version {
            Some(v) => format!("installed {v} ({})", path.display()),
            None => format!("installed, version unreported ({})", path.display()),
        },
        CompanionInstall::NotInstalled => "not installed".to_owned(),
        CompanionInstall::ProbeFailed { path, error } => {
            format!(
                "present, version check failed ({error}) ({})",
                path.display()
            )
        }
    }
}

/// Human-readable lucerna enablement lines (dreams / auto-commit).
pub fn format_lucerna_enablement(fact: &LucernaEnablementFact) -> (String, String) {
    match fact {
        LucernaEnablementFact::NotObserved => (
            "not observed (no house enablement file from cwd)".to_owned(),
            "not observed".to_owned(),
        ),
        LucernaEnablementFact::Observed {
            dreams_enabled: _,
            auto_commit_live: _,
            error: Some(err),
            path,
        } => (
            format!("off (defaults; {err}) ({})", path.display()),
            format!("dry-run (defaults; {err})"),
        ),
        LucernaEnablementFact::Observed {
            dreams_enabled,
            auto_commit_live,
            path,
            error: None,
        } => {
            let dreams = if *dreams_enabled { "on" } else { "off" };
            let commit = if *auto_commit_live {
                "live"
            } else {
                "dry-run"
            };
            (
                format!("{dreams} ({})", path.display()),
                commit.to_owned(),
            )
        }
    }
}

/// Human-readable iris daemon home line (managed vs legacy).
pub fn format_iris_daemon_home(home: &IrisDaemonHome) -> String {
    match home {
        IrisDaemonHome::Present { path, layout } => match layout {
            IrisHomeLayout::Managed => {
                format!("present, managed ({})", path.display())
            }
            IrisHomeLayout::Legacy { moved_marker: true } => {
                format!(
                    "present, legacy with MOVED.md pointer ({})",
                    path.display()
                )
            }
            IrisHomeLayout::Legacy {
                moved_marker: false,
            } => {
                format!("present, legacy ({})", path.display())
            }
        },
        IrisDaemonHome::Absent {
            managed_path,
            legacy_path,
        } => {
            format!(
                "absent (checked {} then {})",
                managed_path.display(),
                legacy_path.display()
            )
        }
        IrisDaemonHome::HomeUnavailable => "home unavailable".to_owned(),
    }
}

/// Human-readable qmd/search block lines for doctor.
pub fn format_qmd_search_lines(qmd: &QmdSearchFacts) -> Vec<(&'static str, String)> {
    let mut rows = Vec::new();

    let runtime = match &qmd.runtime {
        QmdRuntimeFact::Present { path, version } => match version {
            Some(v) => format!("present {v} ({})", path.display()),
            None => format!("present ({})", path.display()),
        },
        QmdRuntimeFact::Absent { path } => {
            format!(
                "absent ({}); finish with `iris qmd setup`",
                path.display()
            )
        }
        QmdRuntimeFact::HomeUnavailable => "home unavailable".to_owned(),
    };
    rows.push(("qmd runtime", runtime));

    let models = match &qmd.models {
        QmdModelsFact::Present {
            path,
            count,
            total_bytes,
            names,
        } => {
            let preview = if names.len() <= 3 {
                names.join(", ")
            } else {
                format!(
                    "{}, … ({} files)",
                    names[..2].join(", "),
                    names.len()
                )
            };
            format!(
                "{count} file(s), {} ({preview}) ({})",
                format_bytes(*total_bytes),
                path.display()
            )
        }
        QmdModelsFact::Absent { path } => {
            format!(
                "absent ({}); finish with `iris qmd setup`",
                path.display()
            )
        }
        QmdModelsFact::HomeUnavailable => "home unavailable".to_owned(),
    };
    rows.push(("qmd models", models));

    let index = match &qmd.house_index {
        QmdHouseIndexFact::Present { path, house_id } => {
            format!("present for {house_id} ({})", path.display())
        }
        QmdHouseIndexFact::Absent { path, house_id } => {
            format!(
                "absent for {house_id} ({}); finish with `iris qmd setup`",
                path.display()
            )
        }
        QmdHouseIndexFact::HouseNotResolved => {
            "house not resolved from cwd (run doctor inside a house)".to_owned()
        }
        QmdHouseIndexFact::HomeUnavailable => "home unavailable".to_owned(),
    };
    rows.push(("qmd house index", index));

    let js = match &qmd.js_runtime {
        JsRuntimeFact::Available { kind, version } => format!("{kind} {version}"),
        JsRuntimeFact::Missing => {
            "missing (need Node.js >= 22 or Bun); see recommendation".to_owned()
        }
    };
    rows.push(("js runtime", js));

    rows
}

fn format_bytes(n: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    if n >= GB {
        format!("{:.1} GB", n as f64 / GB as f64)
    } else if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else if n >= KB {
        format!("{:.1} KB", n as f64 / KB as f64)
    } else {
        format!("{n} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn enablement_parse_defaults_missing_keys_to_false() {
        assert_eq!(parse_enablement_json("{}").unwrap(), (false, false));
        assert_eq!(
            parse_enablement_json(r#"{"dreamsEnabled":true}"#).unwrap(),
            (true, false)
        );
        assert_eq!(
            parse_enablement_json(r#"{"dreamsEnabled":true,"autoCommitLive":true}"#).unwrap(),
            (true, true)
        );
        // Non-boolean truthy values are not true (same as lucerna's strict check).
        assert_eq!(
            parse_enablement_json(r#"{"dreamsEnabled":"yes","autoCommitLive":1}"#).unwrap(),
            (false, false)
        );
        assert!(parse_enablement_json("not-json").is_err());
    }

    #[test]
    fn enablement_walk_finds_house_file() {
        let root = tempfile::tempdir().unwrap();
        let house = root.path().join("house");
        let nested = house.join("projects").join("x");
        std::fs::create_dir_all(&nested).unwrap();
        let runtime = house.join("instruments").join("lucerna");
        std::fs::create_dir_all(&runtime).unwrap();
        let enable = runtime.join("lucerna.enable.json");
        std::fs::write(
            &enable,
            r#"{"dreamsEnabled":true,"autoCommitLive":false}"#,
        )
        .unwrap();

        match probe_lucerna_enablement(Some(&nested)) {
            LucernaEnablementFact::Observed {
                dreams_enabled,
                auto_commit_live,
                error: None,
                path,
            } => {
                assert!(dreams_enabled);
                assert!(!auto_commit_live);
                assert_eq!(path, enable);
            }
            other => panic!("expected observed enablement, got {other:?}"),
        }
    }

    #[test]
    fn enablement_absent_is_not_observed() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            probe_lucerna_enablement(Some(root.path())),
            LucernaEnablementFact::NotObserved
        );
    }

    #[test]
    fn companion_not_installed_status_stable() {
        assert_eq!(
            CompanionInstall::NotInstalled.status_label(),
            "not_installed"
        );
        assert!(!CompanionInstall::NotInstalled.is_installed());
    }

    #[test]
    fn iris_missing_finding_is_recommendation_not_issue() {
        let finding = iris_missing_finding();
        assert_eq!(finding.id, IRIS_MISSING_ID);
        assert_eq!(finding.disposition, FindingDisposition::Recommendation);
        assert!(finding.automatic_remediation.is_none());
        assert!(finding.remediation.is_some());
        assert!(!finding.message.to_ascii_lowercase().contains("enable dream"));
    }

    #[test]
    fn qmd_js_missing_finding_is_recommendation() {
        let finding = qmd_js_runtime_missing_finding();
        assert_eq!(finding.id, QMD_JS_RUNTIME_MISSING_ID);
        assert_eq!(finding.disposition, FindingDisposition::Recommendation);
        assert!(finding.remediation.as_ref().unwrap().fix.contains("iris qmd setup"));
        assert!(finding.automatic_remediation.is_none());
    }

    #[test]
    fn apply_probe_never_issues_for_missing_opt_ins() {
        let mut report = DiagnosticReport {
            facts: super::super::DiagnosticFacts {
                terminal: crate::terminal::TerminalName::Unknown,
                xtversion: super::super::RuntimeFact::Unavailable,
                multiplexer: crate::terminal::MultiplexerKind::Undetected,
                byobu: None,
                ssh: false,
                tmux: super::super::TmuxFacts {
                    extended_keys: super::super::TmuxOptionFact::Unavailable,
                    set_clipboard: super::super::TmuxOptionFact::Unavailable,
                    allow_passthrough_support: super::super::TmuxSupportFact::Unavailable,
                    allow_passthrough: super::super::TmuxOptionFact::Unavailable,
                    color_passthrough: super::super::TmuxColorPassthrough::Unknown,
                },
                color: super::super::ColorFacts {
                    level: super::super::RuntimeFact::Unavailable,
                    available_themes: Vec::new(),
                    total_themes: 0,
                },
                keyboard: None,
                newline: None,
                clipboard: super::super::ClipboardFacts {
                    native_route: false,
                    native_tool: "none".into(),
                    native_preflight: crate::clipboard::NativeClipboardPreflight::Unavailable,
                    tmux_route: false,
                    osc52_route: false,
                    osc52_capability: crate::clipboard::Osc52Capability::Unknown,
                    wrap_sink: false,
                    display_server: crate::host::DisplayServer::Unknown,
                    container_no_display: false,
                    data_control: super::super::DataControlFact::NotApplicable,
                    delivery: crate::clipboard::ClipboardDelivery::Failed,
                    fix: None,
                },
                voice: None,
                instruments: InstrumentsFacts::default(),
            },
            findings: Vec::new(),
            probe_notes: Vec::new(),
        };
        apply_instruments_probe(&mut report);
        let opt_in_issues = report.findings.iter().filter(|f| {
            f.disposition == FindingDisposition::Issue
                && (f.id.item.contains("lucerna") || f.id.item.contains("speculum"))
        });
        assert_eq!(opt_in_issues.count(), 0);
        // qmd missing pieces must not be Issues either.
        let qmd_issues = report.findings.iter().filter(|f| {
            f.disposition == FindingDisposition::Issue && f.id.item.contains("qmd")
        });
        assert_eq!(qmd_issues.count(), 0);
    }

    #[test]
    fn version_timeout_constant_is_short() {
        assert!(VERSION_TIMEOUT <= Duration::from_secs(3));
    }

    #[test]
    fn format_install_not_installed() {
        assert_eq!(
            format_install_line(&CompanionInstall::NotInstalled),
            "not installed"
        );
    }

    #[test]
    fn format_install_unreported_version() {
        let line = format_install_line(&CompanionInstall::Installed {
            path: PathBuf::from("/bin/iris"),
            version: None,
        });
        assert!(line.contains("version unreported"), "{line}");
        assert!(line.contains("/bin/iris") || line.contains("iris"), "{line}");
    }

    #[test]
    fn companion_version_line_parseable_accepted() {
        let v = parse_companion_version_line("iris 0.2.120").unwrap();
        assert!(v.contains("iris"));
        assert!(v.contains("0.2.120"));
        // Optional v prefix and extra trailing text on the line still ok.
        assert!(parse_companion_version_line("lucerna v1.0.0 (release)").is_some());
        assert!(parse_companion_version_line("speculum 2.5.3-alpha.1").is_some());
    }

    #[test]
    fn companion_version_line_json_envelope_rejected() {
        assert_eq!(parse_companion_version_line("{"), None);
        assert_eq!(
            parse_companion_version_line(r#"{"error":"unknown command","ok":false}"#),
            None
        );
        assert_eq!(
            parse_companion_version_line(r#"{ "status": "error", "message": "no such flag" }"#),
            None
        );
    }

    #[test]
    fn companion_version_line_usage_description_rejected() {
        assert_eq!(
            parse_companion_version_line("speculum — mirror for the session corpus"),
            None
        );
        assert_eq!(
            parse_companion_version_line("speculum - mirror for the session corpus"),
            None
        );
        assert_eq!(
            parse_companion_version_line("Usage: iris [command] [options]"),
            None
        );
        // Bare dotted version without a name token is not a companion shape.
        assert_eq!(parse_companion_version_line("v1.2.3"), None);
        assert_eq!(parse_companion_version_line("1.2.3"), None);
    }

    #[test]
    fn companion_version_line_empty_rejected() {
        assert_eq!(parse_companion_version_line(""), None);
        assert_eq!(parse_companion_version_line("   \n\t  "), None);
    }

    #[test]
    fn write_temp_enablement_malformed_defaults_off() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("instruments").join("lucerna");
        std::fs::create_dir_all(&runtime).unwrap();
        let mut f = std::fs::File::create(runtime.join("lucerna.enable.json")).unwrap();
        write!(f, "{{not json").unwrap();
        match probe_lucerna_enablement(Some(dir.path())) {
            LucernaEnablementFact::Observed {
                dreams_enabled: false,
                auto_commit_live: false,
                error: Some(_),
                ..
            } => {}
            other => panic!("expected malformed observed defaults, got {other:?}"),
        }
    }

    #[test]
    fn iris_home_prefers_managed_over_legacy() {
        let home = tempfile::tempdir().unwrap();
        let managed = home
            .path()
            .join(".amore")
            .join("instruments")
            .join("iris");
        let legacy = home.path().join(".iris");
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        match probe_iris_daemon_home_at(home.path()) {
            IrisDaemonHome::Present {
                path,
                layout: IrisHomeLayout::Managed,
            } => assert_eq!(path, managed),
            other => panic!("expected managed home, got {other:?}"),
        }
    }

    #[test]
    fn iris_home_falls_back_to_legacy_with_moved_marker() {
        let home = tempfile::tempdir().unwrap();
        let legacy = home.path().join(".iris");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("MOVED.md"), "moved\n").unwrap();
        match probe_iris_daemon_home_at(home.path()) {
            IrisDaemonHome::Present {
                path,
                layout: IrisHomeLayout::Legacy {
                    moved_marker: true,
                },
            } => assert_eq!(path, legacy),
            other => panic!("expected legacy with marker, got {other:?}"),
        }
    }

    #[test]
    fn iris_home_absent_reports_both_paths() {
        let home = tempfile::tempdir().unwrap();
        match probe_iris_daemon_home_at(home.path()) {
            IrisDaemonHome::Absent {
                managed_path,
                legacy_path,
            } => {
                assert!(managed_path.ends_with(
                    Path::new(".amore")
                        .join("instruments")
                        .join("iris")
                ));
                assert!(legacy_path.ends_with(".iris"));
            }
            other => panic!("expected absent, got {other:?}"),
        }
    }

    #[test]
    fn qmd_probe_reads_runtime_version_and_models_without_spawn() {
        let home = tempfile::tempdir().unwrap();
        let qmd = home
            .path()
            .join(".amore")
            .join("instruments")
            .join("qmd");
        let runtime = qmd.join("runtime");
        let models = qmd.join("models");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(
            runtime.join("package.json"),
            r#"{"name":"@tobilu/qmd","version":"2.5.3"}"#,
        )
        .unwrap();
        std::fs::write(models.join("embed.gguf"), b"abc").unwrap();
        std::fs::write(models.join("rerank.gguf"), b"defg").unwrap();

        let house = home.path().join("myhouse");
        std::fs::create_dir_all(house.join(".amore")).unwrap();
        std::fs::write(house.join(HOUSE_MANIFEST_REL), "{}").unwrap();
        // Iris writes houses/<deriveHouseId(houseRoot)>/, not the bare basename.
        let expected_id = derive_house_id(&house, Some(&house));
        let index_dir = qmd.join("houses").join(&expected_id);
        std::fs::create_dir_all(&index_dir).unwrap();
        std::fs::write(index_dir.join("index.sqlite"), b"sqlite").unwrap();

        let facts = probe_qmd_search_at(home.path(), Some(&house));
        match facts.runtime {
            QmdRuntimeFact::Present {
                version: Some(v), ..
            } => assert_eq!(v, "2.5.3"),
            other => panic!("expected runtime present with version, got {other:?}"),
        }
        match facts.models {
            QmdModelsFact::Present {
                count,
                total_bytes,
                names,
                ..
            } => {
                assert_eq!(count, 2);
                assert_eq!(total_bytes, 7);
                assert_eq!(names, vec!["embed.gguf".to_owned(), "rerank.gguf".to_owned()]);
            }
            other => panic!("expected models present, got {other:?}"),
        }
        match facts.house_index {
            QmdHouseIndexFact::Present { house_id, path, .. } => {
                assert_eq!(house_id, expected_id);
                assert_eq!(path, index_dir);
            }
            other => panic!("expected house index present, got {other:?}"),
        }
    }

    /// Ground-truth vectors from iris `deriveHouseId` (live Node on Windows).
    /// sha256 via `xai_file_utils::sha256_hex` (existing workspace dep).
    #[test]
    fn derive_house_id_matches_iris_ground_truth_vectors() {
        // cwd supplies a Windows drive so root-absolute `/…` paths resolve
        // the way Node path.resolve does on Windows (campaign pin source).
        let win_cwd = r"C:\Users\example";
        assert_eq!(
            derive_house_id_str(r"C:\Houses\myhouse", win_cwd),
            "myhouse-11d59307423f"
        );
        assert_eq!(
            derive_house_id_str("/home/user/My House", win_cwd),
            "My_House-730fc801682b"
        );
        assert_eq!(
            derive_house_id_str(r"C:\Users\AlexMoyer\Documents\amore", win_cwd),
            "amore-95a9bb53dd38"
        );
    }

    #[test]
    fn derive_house_id_sanitizes_base_and_caps_length() {
        let id = derive_house_id_str(r"C:\Houses\!!!", r"C:\");
        assert!(id.starts_with("house-"), "empty sanitize falls back: {id}");
        let long = "a".repeat(50);
        let id = derive_house_id_str(&format!(r"C:\Houses\{long}"), r"C:\");
        let base = id.rsplit_once('-').unwrap().0;
        // hash is 12 hex; base capped at 40
        assert_eq!(base.len(), 40);
    }

    #[test]
    fn qmd_probe_absent_names_finish_command_in_format() {
        let home = tempfile::tempdir().unwrap();
        let facts = probe_qmd_search_at(home.path(), None);
        match facts.runtime {
            QmdRuntimeFact::Absent { .. } => {}
            other => panic!("expected absent runtime, got {other:?}"),
        }
        let lines = format_qmd_search_lines(&facts);
        assert!(
            lines
                .iter()
                .any(|(k, v)| *k == "qmd runtime" && v.contains("iris qmd setup"))
        );
        assert!(
            lines
                .iter()
                .any(|(k, v)| *k == "qmd house index" && v.contains("house not resolved"))
        );
    }

    #[test]
    fn format_iris_home_managed_wording() {
        let line = format_iris_daemon_home(&IrisDaemonHome::Present {
            path: PathBuf::from("/home/u/.amore/instruments/iris"),
            layout: IrisHomeLayout::Managed,
        });
        assert!(line.contains("managed"));
        assert!(line.contains("present"));
    }
}
