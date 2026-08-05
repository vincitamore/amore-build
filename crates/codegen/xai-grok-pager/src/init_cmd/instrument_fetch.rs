//! Shared fetch / verify / PATH-link path for house instruments.
//!
//! Release assets live on the same GitHub Release as the running `amore`
//! binary (`v{xai_grok_version::VERSION}`). Each instrument ships a single
//! multi-tool binary named `<name>-{os}-{arch}[.exe]`, packed as
//! `<name>-{suffix}.tar.gz` (unix) or `<name>-{suffix}.exe.zip` (windows).
//!
//! A failure here never fails the house: the tree is already complete when
//! this runs. Callers map outcomes into summary lines; opt-out is silent.

use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};

/// Where release assets live. The repo's own public URL.
pub const RELEASE_BASE: &str = "https://github.com/vincitamore/amore-build/releases/download";

const TIMEOUT: Duration = Duration::from_secs(120);

/// Identity of one instrument the shared installer can fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstrumentSpec {
    /// Short name used in asset filenames, PATH links, and summary lines.
    pub name: &'static str,
    /// Install directory relative to the house root (e.g. `instruments/iris`).
    pub install_rel: &'static str,
    /// When true, also link an archive member whose name starts with
    /// `{name}-dash` under the short name `{name}-dash` beside `amore`.
    pub link_dash: bool,
}

/// Iris companion: default-on at init, multi-tool + optional dash sibling.
pub const IRIS: InstrumentSpec = InstrumentSpec {
    name: "iris",
    install_rel: "instruments/iris",
    link_dash: true,
};

/// Lucerna house steward: opt-in at init, single binary.
pub const LUCERNA: InstrumentSpec = InstrumentSpec {
    name: "lucerna",
    install_rel: "instruments/lucerna",
    link_dash: false,
};

/// Speculum session mirror: opt-in at init, single binary.
pub const SPECULUM: InstrumentSpec = InstrumentSpec {
    name: "speculum",
    install_rel: "instruments/speculum",
    link_dash: false,
};

/// Release-asset suffix for the running host, or `None` when no asset is built
/// for it.
///
/// Only three targets are published (see `.github/workflows/release.yml`). An
/// Intel Mac or an ARM Linux box is a legitimate host with no asset, and it is
/// told that plainly rather than being handed a 404.
pub fn target_suffix() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("windows", "x86_64") => Some("windows-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        _ => None,
    }
}

/// Archive name published for `name` + `suffix`, and the primary binary inside.
pub fn asset_names(name: &str, suffix: &str) -> (String, String) {
    if suffix == "windows-x64" {
        // Packaged as `<bin>.zip` where `<bin>` already carries `.exe`.
        (
            format!("{name}-{suffix}.exe.zip"),
            format!("{name}-{suffix}.exe"),
        )
    } else {
        (
            format!("{name}-{suffix}.tar.gz"),
            format!("{name}-{suffix}"),
        )
    }
}

/// What happened, in terms the summary can print verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Installed {
        name: String,
        rel_path: String,
        version: String,
        /// Directory the binaries were also linked into (beside `amore`), when
        /// that succeeded.
        linked: Option<String>,
    },
    OptedOut,
    /// No published asset for this host.
    UnsupportedHost {
        name: String,
        host: String,
    },
    /// Reached for it and could not get it. Carries a human reason.
    Failed {
        name: String,
        reason: String,
    },
}

impl Outcome {
    /// One line for the init summary. `None` when there is nothing worth saying.
    pub fn summary_line(&self) -> Option<String> {
        match self {
            Self::Installed {
                name,
                rel_path,
                version,
                linked,
            } => {
                let label = summary_label(name);
                Some(match linked {
                    Some(dir) => format!(
                        "  {label} installed {rel_path} ({version}) — on PATH beside amore ({dir})"
                    ),
                    None => format!("  {label} installed {rel_path} ({version})"),
                })
            }
            Self::OptedOut => None,
            Self::UnsupportedHost { name, host } => {
                let label = summary_label(name);
                Some(format!(
                    "  {label} no published build for {host} — build it from source: \
                     https://github.com/vincitamore/amore-build/tree/main/instruments/{name}"
                ))
            }
            Self::Failed { name, reason } => {
                let label = summary_label(name);
                Some(format!(
                    "  {label} not installed ({reason})
             the house is complete without it — finish later with `amore init --refresh` here"
                ))
            }
        }
    }
}

/// Pad the instrument name so multi-instrument summaries stay aligned.
fn summary_label(name: &str) -> String {
    // Longest shipped name today is "speculum" (8). Colon + spaces to column 12.
    format!("{name}:          ")
        .chars()
        .take(12)
        .collect()
}

/// Install one instrument under `root`. Never returns `Err` — a failure to
/// fetch is an outcome to report, not an error that unwinds a successful house.
pub fn install(spec: &InstrumentSpec, root: &Path, version: &str, dry_run: bool) -> Outcome {
    let Some(suffix) = target_suffix() else {
        return Outcome::UnsupportedHost {
            name: spec.name.to_string(),
            host: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        };
    };
    if dry_run {
        let (archive, _) = asset_names(spec.name, suffix);
        return Outcome::Installed {
            name: spec.name.to_string(),
            rel_path: format!("{}/ (would fetch {archive})", spec.install_rel),
            version: version.to_string(),
            linked: None,
        };
    }
    match try_install(spec, root, version, suffix) {
        Ok((rel_path, linked)) => Outcome::Installed {
            name: spec.name.to_string(),
            rel_path,
            version: version.to_string(),
            linked,
        },
        Err(err) => Outcome::Failed {
            name: spec.name.to_string(),
            // `{err:#}` keeps the cause chain — the plain form tells the user
            // what we were attempting but never why it failed.
            reason: format!("{err:#}"),
        },
    }
}

fn try_install(
    spec: &InstrumentSpec,
    root: &Path,
    version: &str,
    suffix: &str,
) -> Result<(String, Option<String>)> {
    let (archive_name, binary_name) = asset_names(spec.name, suffix);
    let base = format!("{RELEASE_BASE}/v{version}");
    let archive_url = format!("{base}/{archive_name}");
    let sha_url = format!("{archive_url}.sha256");

    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("amore-init/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("build http client")?;

    let archive = get_bytes(&client, &archive_url)
        .with_context(|| format!("download {archive_name}"))?;
    let sha_doc = get_bytes(&client, &sha_url)
        .with_context(|| format!("download {archive_name}.sha256"))?;

    verify_sha256(&archive, &sha_doc)?;

    let dest = root.join(spec.install_rel);
    std::fs::create_dir_all(&dest)
        .with_context(|| format!("create {}", dest.display()))?;

    let installed = if archive_name.ends_with(".zip") {
        unpack_zip(&archive, &dest)?
    } else {
        unpack_tar_gz(&archive, &dest)?
    };
    if !installed.iter().any(|n| n == &binary_name) {
        bail!("archive did not contain {binary_name}");
    }

    // Give the multi-tool a stable name so docs can say `iris` / `lucerna` and mean it.
    let stable_name = if cfg!(windows) {
        format!("{}.exe", spec.name)
    } else {
        spec.name.to_string()
    };
    let stable = dest.join(&stable_name);
    let fetched = dest.join(&binary_name);
    if fetched.exists() {
        let _ = std::fs::remove_file(&stable);
        std::fs::rename(&fetched, &stable)
            .with_context(|| format!("name {} as {}", binary_name, stable.display()))?;
    }
    make_executable(&stable);
    for name in &installed {
        make_executable(&dest.join(name));
    }

    let linked = link_onto_path(spec, &dest, &installed);
    Ok((format!("{}/", spec.install_rel), linked))
}

/// Put the instrument on PATH the way `amore` already is: link the freshly
/// installed binaries into the directory the running `amore` executable lives
/// in. Hard link first (free, same volume), copy as fallback. A locked or
/// unwritable destination degrades silently.
fn link_onto_path(spec: &InstrumentSpec, dest: &Path, installed: &[String]) -> Option<String> {
    let bin_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    // Nothing to do if amore is somehow running out of the install dir.
    if bin_dir == *dest {
        return None;
    }
    let exe = |name: &str| {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    };
    let mut pairs: Vec<(std::path::PathBuf, std::path::PathBuf)> =
        vec![(dest.join(exe(spec.name)), bin_dir.join(exe(spec.name)))];
    if spec.link_dash {
        let dash_prefix = format!("{}-dash", spec.name);
        if let Some(dash) = installed.iter().find(|n| n.starts_with(&dash_prefix)) {
            pairs.push((dest.join(dash), bin_dir.join(exe(&dash_prefix))));
        }
    }
    let mut any = false;
    for (src, target) in pairs {
        if !src.exists() {
            continue;
        }
        // Move a previous copy aside rather than deleting it: on Windows a
        // running binary holds its file lock, but a locked file can still be
        // renamed — the same swap the installers use.
        if target.exists() {
            let prev = target.with_extension("prev");
            let _ = std::fs::remove_file(&prev);
            if std::fs::rename(&target, &prev).is_err() && target.exists() {
                continue;
            }
        }
        let ok = std::fs::hard_link(&src, &target).is_ok()
            || std::fs::copy(&src, &target).is_ok();
        if ok {
            make_executable(&target);
            any = true;
        }
    }
    any.then(|| bin_dir.display().to_string())
}

fn get_bytes(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>> {
    let res = client.get(url).send().context("request failed")?;
    if !res.status().is_success() {
        // 404 is the common, meaningful case: a dev build whose version has no
        // published release. Say the status; the caller prints it verbatim.
        bail!("HTTP {}", res.status().as_u16());
    }
    Ok(res.bytes().context("read response body")?.to_vec())
}

/// Checksum files are `<hex>  <filename>`; we only need the first field.
pub fn verify_sha256(payload: &[u8], sha_doc: &[u8]) -> Result<()> {
    let text = String::from_utf8_lossy(sha_doc);
    let expected = text
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if expected.len() != 64 {
        bail!("malformed checksum file");
    }
    let actual = xai_file_utils::sha256_hex(payload).to_ascii_lowercase();
    if actual != expected {
        bail!("checksum mismatch — refusing to install");
    }
    Ok(())
}

fn unpack_zip(bytes: &[u8], dest: &Path) -> Result<Vec<String>> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).context("open zip archive")?;
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).context("read zip entry")?;
        let Some(name) = entry.enclosed_name().and_then(|p| {
            p.file_name().map(|n| n.to_string_lossy().to_string())
        }) else {
            continue; // path traversal / unnamed entry: skip rather than trust
        };
        if entry.is_dir() {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).context("inflate zip entry")?;
        std::fs::write(dest.join(&name), &buf)
            .with_context(|| format!("write {name}"))?;
        names.push(name);
    }
    Ok(names)
}

fn unpack_tar_gz(bytes: &[u8], dest: &Path) -> Result<Vec<String>> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut tar = tar::Archive::new(gz);
    let mut names = Vec::new();
    for entry in tar.entries().context("read tar entries")? {
        let mut entry = entry.context("read tar entry")?;
        let path = entry.path().context("tar entry path")?.into_owned();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).context("read tar payload")?;
        std::fs::write(dest.join(&name), &buf)
            .with_context(|| format!("write {name}"))?;
        names.push(name);
    }
    Ok(names)
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o755);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_match_what_the_release_workflow_publishes() {
        // Windows packages `<bin>.exe` into `<bin>.exe.zip` — the doubled
        // extension is deliberate, not a typo.
        assert_eq!(
            asset_names("iris", "windows-x64"),
            ("iris-windows-x64.exe.zip".into(), "iris-windows-x64.exe".into())
        );
        assert_eq!(
            asset_names("iris", "linux-x64"),
            ("iris-linux-x64.tar.gz".into(), "iris-linux-x64".into())
        );
        assert_eq!(
            asset_names("iris", "darwin-arm64"),
            ("iris-darwin-arm64.tar.gz".into(), "iris-darwin-arm64".into())
        );
        assert_eq!(
            asset_names("lucerna", "linux-x64"),
            ("lucerna-linux-x64.tar.gz".into(), "lucerna-linux-x64".into())
        );
        assert_eq!(
            asset_names("speculum", "windows-x64"),
            (
                "speculum-windows-x64.exe.zip".into(),
                "speculum-windows-x64.exe".into()
            )
        );
    }

    #[test]
    fn only_published_targets_resolve() {
        // Whatever host runs the tests, the mapping must agree with itself.
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => assert_eq!(target_suffix(), Some("linux-x64")),
            ("windows", "x86_64") => assert_eq!(target_suffix(), Some("windows-x64")),
            ("macos", "aarch64") => assert_eq!(target_suffix(), Some("darwin-arm64")),
            _ => assert_eq!(target_suffix(), None),
        }
    }

    #[test]
    fn checksum_is_enforced() {
        let payload = b"hello";
        let good = xai_file_utils::sha256_hex(payload);
        assert!(verify_sha256(payload, format!("{good}  x.tar.gz").as_bytes()).is_ok());
        // Uppercase hex is still a match.
        assert!(verify_sha256(payload, good.to_ascii_uppercase().as_bytes()).is_ok());
        // A wrong digest must refuse, not warn.
        let bad = "0".repeat(64);
        assert!(verify_sha256(payload, bad.as_bytes()).is_err());
        // A truncated or empty checksum file is malformed, never "close enough".
        assert!(verify_sha256(payload, b"deadbeef  x.tar.gz").is_err());
        assert!(verify_sha256(payload, b"").is_err());
    }

    #[test]
    fn a_failed_fetch_is_reported_not_fatal() {
        let out = Outcome::Failed {
            name: "iris".into(),
            reason: "HTTP 404".into(),
        };
        let line = out.summary_line().expect("failure must be reported");
        assert!(line.contains("HTTP 404"));
        assert!(line.contains("the house is complete without it"));
        // Opting out is silent — nothing failed, so nothing is said.
        assert_eq!(Outcome::OptedOut.summary_line(), None);
    }

    #[test]
    fn unsupported_host_points_at_the_source_build() {
        let out = Outcome::UnsupportedHost {
            name: "iris".into(),
            host: "macos-x86_64".into(),
        };
        let line = out.summary_line().unwrap();
        assert!(line.contains("macos-x86_64"));
        assert!(line.contains("build it from source"));
        assert!(line.contains("instruments/iris"));
    }

    #[test]
    fn summary_label_aligns_longer_names() {
        let lucerna = Outcome::Installed {
            name: "lucerna".into(),
            rel_path: "instruments/lucerna/".into(),
            version: "0.1.0".into(),
            linked: None,
        }
        .summary_line()
        .unwrap();
        assert!(lucerna.starts_with("  lucerna:"));
        assert!(lucerna.contains("installed instruments/lucerna/"));

        let speculum = Outcome::Failed {
            name: "speculum".into(),
            reason: "offline".into(),
        }
        .summary_line()
        .unwrap();
        assert!(speculum.starts_with("  speculum:"));
        assert!(speculum.contains("not installed (offline)"));
    }
}
