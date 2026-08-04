//! Install the iris companion into a new house's `instruments/iris/`.
//!
//! Iris is part of the house, not an optional extra, so `init` installs it by
//! default and `--no-iris` opts out. That means `init` reaches the network,
//! and the docs say so — the alternative was keeping a "no network required"
//! sentence true by shipping a house without its instrument.
//!
//! **A failure here never fails the house.** The whole tree is already written
//! by the time this runs; a download that 404s, times out, or lands on a
//! platform with no published asset produces a clear note and one command to
//! finish later. Nothing is half-installed: the archive is verified against its
//! published checksum before anything is unpacked.

use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};

/// Where release assets live. The repo's own public URL.
const RELEASE_BASE: &str = "https://github.com/vincitamore/amore-build/releases/download";

/// Directory, relative to the house root, that the companion is installed into.
pub const IRIS_REL: &str = "instruments/iris";

const TIMEOUT: Duration = Duration::from_secs(120);

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

/// Archive name published for `suffix`, and the multi-tool binary inside it.
fn asset_names(suffix: &str) -> (String, String) {
    if suffix == "windows-x64" {
        // Packaged as `<bin>.zip` where `<bin>` already carries `.exe`.
        (
            format!("iris-{suffix}.exe.zip"),
            format!("iris-{suffix}.exe"),
        )
    } else {
        (
            format!("iris-{suffix}.tar.gz"),
            format!("iris-{suffix}"),
        )
    }
}

/// What happened, in terms the summary can print verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IrisOutcome {
    Installed {
        rel_path: String,
        version: String,
        /// Directory the binaries were also linked into (beside `amore`), when
        /// that succeeded — i.e. `iris` is now on PATH wherever `amore` is.
        linked: Option<String>,
    },
    OptedOut,
    /// No published asset for this host.
    UnsupportedHost { host: String },
    /// Reached for it and could not get it. Carries a human reason.
    Failed { reason: String },
}

impl IrisOutcome {
    /// One line for the init summary. `None` when there is nothing worth saying.
    pub fn summary_line(&self) -> Option<String> {
        match self {
            Self::Installed { rel_path, version, linked } => Some(match linked {
                Some(dir) => format!(
                    "  iris:      installed {rel_path} ({version}) — on PATH beside amore ({dir})"
                ),
                None => format!("  iris:      installed {rel_path} ({version})"),
            }),
            Self::OptedOut => None,
            Self::UnsupportedHost { host } => Some(format!(
                "  iris:      no published build for {host} — build it from source: \
                 https://github.com/vincitamore/amore-build/tree/main/instruments/iris"
            )),
            Self::Failed { reason } => Some(format!(
                "  iris:      not installed ({reason})
             the house is complete without it — finish later with `amore init --refresh` here"
            )),
        }
    }
}

/// Install iris under `root`. Never returns `Err` — a failure to fetch is an
/// outcome to report, not an error that unwinds a successful house install.
pub fn install(root: &Path, version: &str, dry_run: bool) -> IrisOutcome {
    let Some(suffix) = target_suffix() else {
        return IrisOutcome::UnsupportedHost {
            host: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        };
    };
    if dry_run {
        let (archive, _) = asset_names(suffix);
        return IrisOutcome::Installed {
            rel_path: format!("{IRIS_REL}/ (would fetch {archive})"),
            version: version.to_string(),
            linked: None,
        };
    }
    match try_install(root, version, suffix) {
        Ok((rel_path, linked)) => IrisOutcome::Installed {
            rel_path,
            version: version.to_string(),
            linked,
        },
        Err(err) => IrisOutcome::Failed {
            // `{err:#}` keeps the cause chain — the plain form tells the user
            // what we were attempting but never why it failed.
            reason: format!("{err:#}"),
        },
    }
}

fn try_install(root: &Path, version: &str, suffix: &str) -> Result<(String, Option<String>)> {
    let (archive_name, binary_name) = asset_names(suffix);
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

    let dest = root.join(IRIS_REL);
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

    // Give the multi-tool a stable name so docs can say `iris` and mean it.
    let stable = dest.join(if cfg!(windows) { "iris.exe" } else { "iris" });
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

    let linked = link_onto_path(&dest, &installed);
    Ok((format!("{IRIS_REL}/"), linked))
}

/// Put `iris` on PATH the way `amore` already is: link the freshly installed
/// binaries into the directory the running `amore` executable lives in. If
/// `amore` resolves on PATH, `iris` now does too — no rc-file or registry
/// surgery, and it works identically on every platform. Hard link first
/// (free, same volume), copy as fallback (different volume). A locked or
/// unwritable destination degrades silently: the install itself already
/// succeeded, and the manual hint in the docs still applies.
///
/// The dash sibling is linked under its short name (`iris-dash[.exe]`),
/// which the multi-tool's sibling resolution accepts, so `iris dash` works
/// from PATH as well.
fn link_onto_path(dest: &Path, installed: &[String]) -> Option<String> {
    let bin_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    // Nothing to do if amore is somehow running out of the install dir.
    if bin_dir == *dest {
        return None;
    }
    let exe = |name: &str| {
        if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
    };
    let mut pairs: Vec<(std::path::PathBuf, std::path::PathBuf)> =
        vec![(dest.join(exe("iris")), bin_dir.join(exe("iris")))];
    if let Some(dash) = installed.iter().find(|n| n.starts_with("iris-dash")) {
        pairs.push((dest.join(dash), bin_dir.join(exe("iris-dash"))));
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
fn verify_sha256(payload: &[u8], sha_doc: &[u8]) -> Result<()> {
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
            asset_names("windows-x64"),
            ("iris-windows-x64.exe.zip".into(), "iris-windows-x64.exe".into())
        );
        assert_eq!(
            asset_names("linux-x64"),
            ("iris-linux-x64.tar.gz".into(), "iris-linux-x64".into())
        );
        assert_eq!(
            asset_names("darwin-arm64"),
            ("iris-darwin-arm64.tar.gz".into(), "iris-darwin-arm64".into())
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
        assert!(
            verify_sha256(payload, good.to_ascii_uppercase().as_bytes()).is_ok()
        );
        // A wrong digest must refuse, not warn.
        let bad = "0".repeat(64);
        assert!(verify_sha256(payload, bad.as_bytes()).is_err());
        // A truncated or empty checksum file is malformed, never "close enough".
        assert!(verify_sha256(payload, b"deadbeef  x.tar.gz").is_err());
        assert!(verify_sha256(payload, b"").is_err());
    }

    #[test]
    fn a_failed_fetch_is_reported_not_fatal() {
        let out = IrisOutcome::Failed { reason: "HTTP 404".into() };
        let line = out.summary_line().expect("failure must be reported");
        assert!(line.contains("HTTP 404"));
        assert!(line.contains("the house is complete without it"));
        // Opting out is silent — nothing failed, so nothing is said.
        assert_eq!(IrisOutcome::OptedOut.summary_line(), None);
    }

    #[test]
    fn unsupported_host_points_at_the_source_build() {
        let out = IrisOutcome::UnsupportedHost { host: "macos-x86_64".into() };
        let line = out.summary_line().unwrap();
        assert!(line.contains("macos-x86_64"));
        assert!(line.contains("build it from source"));
    }
}
