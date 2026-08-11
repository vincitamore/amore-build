//! Fetch, verify, and unpack a release archive into a staging directory.
//!
//! This module stops at a verified, unpacked [`StagedArtifact`]. It never
//! executes a binary, never activates an install, and never writes outside the
//! caller-supplied staging directory. Downstream code hands
//! [`StagedArtifact::binary_path`] to a swap primitive that takes plain paths.
//!
//! Asset filenames come from [`super::discover::asset_name`]. Download URLs are
//! built only from [`super::origin::release_base`]. Digest checks always use the
//! `.sha256` sidecar on the same origin, never a REST API digest field.

use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};

use super::discover::{self, Component};
use super::origin;

const TIMEOUT: Duration = Duration::from_secs(120);

const USER_AGENT: &str = concat!("amore-self-update/", env!("CARGO_PKG_VERSION"));

/// A staged, verified, unpacked release artifact.
///
/// All paths live under the staging directory supplied to
/// [`fetch_and_stage`]. Extra (non-executable) archive members are routed into
/// a `docs/` subdirectory beside the binary so they never land in an install
/// directory on apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedArtifact {
    /// Component name ("amore", "iris", "lucerna", "speculum").
    pub component: String,
    /// The release tag the artifact came from.
    pub tag: String,
    /// The verified executable, staged under the staging dir.
    pub binary_path: PathBuf,
    /// Non-executable members (LICENSE, NOTICE, ...) staged beside the binary
    /// in a `docs/` subdirectory — never in the install dir.
    pub extra_files: Vec<PathBuf>,
    /// Hex sha256 of the downloaded archive (from the verified sidecar).
    pub archive_sha256: String,
}

/// Download, verify, and unpack `component` for `tag` on `os`/`arch` into
/// `staging_dir`.
///
/// `os` and `arch` use release-asset spelling (`windows`/`x64`, `linux`/`x64`,
/// `darwin`/`arm64`, …). `tag` is the published release tag (typically with a
/// leading `v`).
///
/// On digest mismatch the staged download is deleted and an error is returned.
/// Nothing is written outside `staging_dir`.
pub fn fetch_and_stage(
    component: Component,
    tag: &str,
    os: &str,
    arch: &str,
    staging_dir: &Path,
) -> Result<StagedArtifact> {
    let download_root = origin::release_base();
    fetch_and_stage_at(&download_root, component, tag, os, arch, staging_dir)
}

/// Testable seam: same as [`fetch_and_stage`] but downloads from
/// `download_root` instead of [`origin::release_base`].
///
/// Production callers must use [`fetch_and_stage`]. Tests may point
/// `download_root` at a loopback server.
pub fn fetch_and_stage_at(
    download_root: &str,
    component: Component,
    tag: &str,
    os: &str,
    arch: &str,
    staging_dir: &Path,
) -> Result<StagedArtifact> {
    if !discover::target_supported(component, os, arch) {
        bail!(
            "no published archive for {} on {}-{}",
            component.name(),
            os,
            arch
        );
    }
    let asset = discover::asset_name(component, os, arch).ok_or_else(|| {
        anyhow::anyhow!(
            "no asset name for {} on {}-{}",
            component.name(),
            os,
            arch
        )
    })?;
    let expected_binary = binary_member_name(component, os, arch).ok_or_else(|| {
        anyhow::anyhow!(
            "no binary member name for {} on {}-{}",
            component.name(),
            os,
            arch
        )
    })?;

    fs::create_dir_all(staging_dir)
        .with_context(|| format!("create staging dir {}", staging_dir.display()))?;

    let archive_url = asset_download_url(download_root, tag, &asset);
    let sha_url = format!("{archive_url}.sha256");
    let part_path = staging_dir.join(format!("{asset}.part"));
    let final_path = staging_dir.join(&asset);

    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .context("build http client")?;

    download_with_resume(&client, &archive_url, &part_path)
        .with_context(|| format!("download {asset}"))?;

    let sha_doc = get_bytes(&client, &sha_url)
        .with_context(|| format!("download {asset}.sha256"))?;

    let archive_sha256 = match verify_sha256_file(&part_path, &sha_doc) {
        Ok(hex) => hex,
        Err(err) => {
            // Digest mismatch (or malformed sidecar): delete the staged
            // download — never warn, never unpack.
            let _ = fs::remove_file(&part_path);
            let _ = fs::remove_file(&final_path);
            return Err(err);
        }
    };

    // Rename only after the digest verifies.
    if final_path.exists() {
        let _ = fs::remove_file(&final_path);
    }
    fs::rename(&part_path, &final_path)
        .with_context(|| format!("rename verified archive to {}", final_path.display()))?;

    let archive_bytes =
        fs::read(&final_path).with_context(|| format!("read {}", final_path.display()))?;

    let (binary_path, extra_files) =
        unpack_verified_archive(&archive_bytes, &asset, &expected_binary, staging_dir)?;

    make_executable(&binary_path);

    Ok(StagedArtifact {
        component: component.name().to_string(),
        tag: tag.to_string(),
        binary_path,
        extra_files,
        archive_sha256,
    })
}

/// Whether a release archive is published for this component on `os`/`arch`.
///
/// Per-component: amore ships five targets, companions three. Never answer
/// support globally.
pub fn component_target_supported(component: Component, os: &str, arch: &str) -> bool {
    discover::target_supported(component, os, arch)
}

/// Archive filename for `component` on `os`/`arch`, or `None` when unsupported.
///
/// Thin wrapper over [`discover::asset_name`] so fetch callers do not re-derive
/// the grammar.
pub fn archive_name(component: Component, os: &str, arch: &str) -> Option<String> {
    discover::asset_name(component, os, arch)
}

/// Primary executable member name inside the published archive.
///
/// - `amore` on Windows: `amore.exe` (archive is `amore-windows-x64.zip`)
/// - `amore` elsewhere: `amore`
/// - companions on Windows: `{name}-{os}-{arch}.exe`
/// - companions elsewhere: `{name}-{os}-{arch}`
pub fn binary_member_name(component: Component, os: &str, arch: &str) -> Option<String> {
    if !discover::target_supported(component, os, arch) {
        return None;
    }
    let name = component.name();
    let suffix = format!("{os}-{arch}");
    match (component, os) {
        (Component::Amore, "windows") => Some(format!("{name}.exe")),
        (Component::Amore, _) => Some(name.to_string()),
        (Component::Companion(_), "windows") => Some(format!("{name}-{suffix}.exe")),
        (Component::Companion(_), _) => Some(format!("{name}-{suffix}")),
    }
}

/// Build `{download_root}/{tag}/{asset}` without embedding host or repo strings.
pub fn asset_download_url(download_root: &str, tag: &str, asset: &str) -> String {
    let root = download_root.trim_end_matches('/');
    format!("{root}/{tag}/{asset}")
}

/// When a partial file of `existing_len` bytes is shorter than the known
/// `content_length`, return the HTTP Range start. Otherwise `None` (caller
/// starts fresh, or the download is already complete).
pub fn resume_offset(existing_len: u64, content_length: u64) -> Option<u64> {
    if existing_len > 0 && existing_len < content_length {
        Some(existing_len)
    } else {
        None
    }
}

/// True when the on-disk partial already has exactly `content_length` bytes.
pub fn download_complete(existing_len: u64, content_length: u64) -> bool {
    content_length > 0 && existing_len == content_length
}

/// Parse the first field of a `<hex>  <filename>` sidecar and verify `payload`.
///
/// Returns the lowercase hex digest on match. Digest mismatch is a hard `Err`.
pub fn verify_sha256(payload: &[u8], sha_doc: &[u8]) -> Result<String> {
    let expected = parse_expected_sha256(sha_doc)?;
    let actual = xai_file_utils::sha256_hex(payload).to_ascii_lowercase();
    if actual != expected {
        bail!("checksum mismatch — refusing to install");
    }
    Ok(actual)
}

/// Stream-hash `path` and compare against the sidecar document.
pub fn verify_sha256_file(path: &Path, sha_doc: &[u8]) -> Result<String> {
    let expected = parse_expected_sha256(sha_doc)?;
    let actual = xai_file_utils::sha256_hex_from_file(path, None)
        .with_context(|| format!("hash {}", path.display()))?
        .to_ascii_lowercase();
    if actual != expected {
        bail!("checksum mismatch — refusing to install");
    }
    Ok(actual)
}

/// Extract the expected lowercase hex digest from a `.sha256` sidecar body.
pub fn parse_expected_sha256(sha_doc: &[u8]) -> Result<String> {
    let text = String::from_utf8_lossy(sha_doc);
    let expected = text
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("malformed checksum file");
    }
    Ok(expected)
}

/// Unpack an already-verified archive: primary binary at the staging root,
/// every other member under `staging_dir/docs/`.
///
/// Path traversal (`..`, absolute paths) fails the unpack. Nothing is written
/// outside `staging_dir`.
pub fn unpack_verified_archive(
    archive_bytes: &[u8],
    archive_name: &str,
    expected_binary: &str,
    staging_dir: &Path,
) -> Result<(PathBuf, Vec<PathBuf>)> {
    fs::create_dir_all(staging_dir)
        .with_context(|| format!("create staging dir {}", staging_dir.display()))?;
    if archive_name.ends_with(".zip") {
        unpack_zip_selective(archive_bytes, staging_dir, expected_binary)
    } else {
        unpack_tar_gz_selective(archive_bytes, staging_dir, expected_binary)
    }
}

/// Reject archive entry paths that escape the staging root.
pub fn reject_traversal(path: &Path) -> Result<()> {
    use std::path::Component;
    if path.is_absolute() {
        bail!("archive entry path traversal rejected");
    }
    for c in path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!("archive entry path traversal rejected"),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP transfer (thin)
// ---------------------------------------------------------------------------

fn get_bytes(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>> {
    let res = client.get(url).send().context("request failed")?;
    if !res.status().is_success() {
        bail!("HTTP {}", res.status().as_u16());
    }
    Ok(res.bytes().context("read response body")?.to_vec())
}

/// Download `url` into `part_path`, resuming with `Range` when a shorter partial
/// is present and the server advertises a total length.
fn download_with_resume(
    client: &reqwest::blocking::Client,
    url: &str,
    part_path: &Path,
) -> Result<()> {
    let existing_len = if part_path.exists() {
        fs::metadata(part_path)
            .with_context(|| format!("stat {}", part_path.display()))?
            .len()
    } else {
        0
    };

    // Prefer HEAD for Content-Length so we can decide resume vs restart
    // without discarding a partial on a full GET.
    let content_length = match client.head(url).send() {
        Ok(res) if res.status().is_success() => res
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok()),
        _ => None,
    };

    if let Some(total) = content_length {
        if download_complete(existing_len, total) {
            return Ok(());
        }
        // Longer-than-total partial is corrupt; start over.
        if existing_len > total {
            let _ = fs::remove_file(part_path);
        }
    }

    let offset = match content_length {
        Some(total) => resume_offset(
            if part_path.exists() {
                fs::metadata(part_path).map(|m| m.len()).unwrap_or(0)
            } else {
                0
            },
            total,
        ),
        None if existing_len > 0 => Some(existing_len),
        None => None,
    };

    let mut request = client.get(url);
    if let Some(off) = offset {
        request = request.header(reqwest::header::RANGE, format!("bytes={off}-"));
    }

    let response = request.send().context("download request failed")?;
    let status = response.status();

    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        // Append the remainder onto the existing partial.
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(part_path)
            .with_context(|| format!("open partial {}", part_path.display()))?;
        stream_body_to_file(response, &mut file)?;
        return Ok(());
    }

    if status.is_success() {
        // Full body (no range, or server ignored Range). Rewrite the partial.
        let mut file = File::create(part_path)
            .with_context(|| format!("create partial {}", part_path.display()))?;
        stream_body_to_file(response, &mut file)?;
        return Ok(());
    }

    bail!("HTTP {}", status.as_u16());
}

fn stream_body_to_file(
    response: reqwest::blocking::Response,
    file: &mut File,
) -> Result<()> {
    let mut reader = response;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).context("read download body")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).context("write download body")?;
    }
    file.flush().context("flush download body")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unpack (member selection + traversal rejection)
// ---------------------------------------------------------------------------

fn unpack_zip_selective(
    bytes: &[u8],
    staging_dir: &Path,
    expected_binary: &str,
) -> Result<(PathBuf, Vec<PathBuf>)> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).context("open zip archive")?;
    let mut binary_path: Option<PathBuf> = None;
    let mut extra_files = Vec::new();
    let docs_dir = staging_dir.join("docs");

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).context("read zip entry")?;
        // enclosed_name() is None for absolute paths and `..` components —
        // treat that as a hard failure, not a silent skip.
        let Some(enclosed) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            bail!("archive entry path traversal rejected");
        };
        reject_traversal(&enclosed)?;
        if entry.is_dir() {
            continue;
        }
        let name = file_name_only(&enclosed)?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).context("inflate zip entry")?;
        stage_member(
            staging_dir,
            &docs_dir,
            expected_binary,
            &name,
            &buf,
            &mut binary_path,
            &mut extra_files,
        )?;
    }

    let binary_path = binary_path
        .ok_or_else(|| anyhow::anyhow!("archive did not contain {expected_binary}"))?;
    Ok((binary_path, extra_files))
}

fn unpack_tar_gz_selective(
    bytes: &[u8],
    staging_dir: &Path,
    expected_binary: &str,
) -> Result<(PathBuf, Vec<PathBuf>)> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut tar = tar::Archive::new(gz);
    let mut binary_path: Option<PathBuf> = None;
    let mut extra_files = Vec::new();
    let docs_dir = staging_dir.join("docs");

    for entry in tar.entries().context("read tar entries")? {
        let mut entry = entry.context("read tar entry")?;
        let path = entry.path().context("tar entry path")?.into_owned();
        reject_traversal(&path)?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let name = file_name_only(&path)?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).context("read tar payload")?;
        stage_member(
            staging_dir,
            &docs_dir,
            expected_binary,
            &name,
            &buf,
            &mut binary_path,
            &mut extra_files,
        )?;
    }

    let binary_path = binary_path
        .ok_or_else(|| anyhow::anyhow!("archive did not contain {expected_binary}"))?;
    Ok((binary_path, extra_files))
}

fn file_name_only(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("unnamed archive entry"))?
        .to_string_lossy()
        .into_owned();
    if name.is_empty() || name == "." || name == ".." {
        bail!("archive entry path traversal rejected");
    }
    Ok(name)
}

fn stage_member(
    staging_dir: &Path,
    docs_dir: &Path,
    expected_binary: &str,
    name: &str,
    buf: &[u8],
    binary_path: &mut Option<PathBuf>,
    extra_files: &mut Vec<PathBuf>,
) -> Result<()> {
    // Belt-and-suspenders: every write target must stay under staging_dir.
    if name == expected_binary {
        let dest = staging_dir.join(name);
        ensure_under(staging_dir, &dest)?;
        fs::write(&dest, buf).with_context(|| format!("write {}", dest.display()))?;
        *binary_path = Some(dest);
    } else {
        fs::create_dir_all(docs_dir)
            .with_context(|| format!("create {}", docs_dir.display()))?;
        let dest = docs_dir.join(name);
        ensure_under(staging_dir, &dest)?;
        fs::write(&dest, buf).with_context(|| format!("write {}", dest.display()))?;
        extra_files.push(dest);
    }
    Ok(())
}

fn ensure_under(root: &Path, candidate: &Path) -> Result<()> {
    let root_abs = fs::canonicalize(root)
        .with_context(|| format!("canonicalize {}", root.display()))?;
    // Parent of the candidate must exist for canonicalize of a not-yet-written
    // file; use parent + file_name join against the canonical root instead.
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow::anyhow!("candidate has no parent"))?;
    if !parent.exists() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    let parent_abs = fs::canonicalize(parent)
        .with_context(|| format!("canonicalize {}", parent.display()))?;
    if !parent_abs.starts_with(&root_abs) {
        bail!("refusing to write outside staging dir");
    }
    let file_name = candidate
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("candidate has no file name"))?;
    let dest_abs = parent_abs.join(file_name);
    if !dest_abs.starts_with(&root_abs) {
        bail!("refusing to write outside staging dir");
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o755);
        let _ = fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    // -- asset grammar (via discover, all targets + .exe.zip asymmetry) ------

    #[test]
    fn amore_asset_grammar_all_five_targets() {
        let cases = [
            ("linux", "x64", "amore-linux-x64.tar.gz", "amore"),
            ("linux", "arm64", "amore-linux-arm64.tar.gz", "amore"),
            ("windows", "x64", "amore-windows-x64.zip", "amore.exe"),
            ("darwin", "arm64", "amore-darwin-arm64.tar.gz", "amore"),
            ("darwin", "x64", "amore-darwin-x64.tar.gz", "amore"),
        ];
        for (os, arch, archive, member) in cases {
            assert_eq!(
                archive_name(Component::Amore, os, arch).as_deref(),
                Some(archive),
                "archive {os}-{arch}"
            );
            assert_eq!(
                binary_member_name(Component::Amore, os, arch).as_deref(),
                Some(member),
                "member {os}-{arch}"
            );
            assert!(component_target_supported(Component::Amore, os, arch));
            // Round-trip: discover::asset_name is the single source.
            assert_eq!(
                archive_name(Component::Amore, os, arch),
                discover::asset_name(Component::Amore, os, arch)
            );
        }
    }

    #[test]
    fn companion_asset_grammar_three_targets_and_exe_zip_asymmetry() {
        for name in ["iris", "lucerna", "speculum"] {
            let c = Component::Companion(name);
            assert_eq!(
                archive_name(c, "linux", "x64").as_deref(),
                Some(format!("{name}-linux-x64.tar.gz").as_str())
            );
            assert_eq!(
                archive_name(c, "windows", "x64").as_deref(),
                Some(format!("{name}-windows-x64.exe.zip").as_str()),
                "companions use .exe.zip; amore does not"
            );
            assert_eq!(
                archive_name(c, "darwin", "arm64").as_deref(),
                Some(format!("{name}-darwin-arm64.tar.gz").as_str())
            );
            assert_eq!(
                binary_member_name(c, "windows", "x64").as_deref(),
                Some(format!("{name}-windows-x64.exe").as_str())
            );
            assert_eq!(
                binary_member_name(c, "linux", "x64").as_deref(),
                Some(format!("{name}-linux-x64").as_str())
            );
            assert!(component_target_supported(c, "linux", "x64"));
            assert!(component_target_supported(c, "windows", "x64"));
            assert!(component_target_supported(c, "darwin", "arm64"));
            // Companions do not ship amore's extra targets.
            assert!(!component_target_supported(c, "linux", "arm64"));
            assert!(!component_target_supported(c, "darwin", "x64"));
            assert_eq!(archive_name(c, "linux", "arm64"), None);
        }

        // The asymmetry itself, side by side.
        assert_eq!(
            archive_name(Component::Amore, "windows", "x64").as_deref(),
            Some("amore-windows-x64.zip")
        );
        assert_eq!(
            archive_name(Component::Companion("iris"), "windows", "x64").as_deref(),
            Some("iris-windows-x64.exe.zip")
        );
    }

    // -- resume offset -------------------------------------------------------

    #[test]
    fn resume_offset_partial_file_yields_range_start() {
        assert_eq!(resume_offset(0, 100), None);
        assert_eq!(resume_offset(40, 100), Some(40));
        assert_eq!(resume_offset(99, 100), Some(99));
        assert_eq!(resume_offset(100, 100), None); // complete
        assert_eq!(resume_offset(120, 100), None); // corrupt / oversize
        assert!(!download_complete(40, 100));
        assert!(download_complete(100, 100));
        assert!(!download_complete(0, 0));
    }

    // -- digest --------------------------------------------------------------

    #[test]
    fn checksum_is_enforced_and_mismatch_deletes_partial() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("asset.zip.part");
        let payload = b"hello-release-archive";
        fs::write(&part, payload).unwrap();

        let good = xai_file_utils::sha256_hex(payload);
        assert_eq!(
            verify_sha256(payload, format!("{good}  asset.zip").as_bytes()).unwrap(),
            good.to_ascii_lowercase()
        );
        assert_eq!(
            verify_sha256_file(&part, format!("{good}  asset.zip").as_bytes()).unwrap(),
            good.to_ascii_lowercase()
        );

        let bad = "0".repeat(64);
        assert!(verify_sha256(payload, bad.as_bytes()).is_err());
        assert!(verify_sha256(payload, b"deadbeef").is_err());
        assert!(verify_sha256(payload, b"").is_err());

        // Mismatch path used by fetch_and_stage_at: delete staged bytes.
        let err = verify_sha256_file(&part, bad.as_bytes()).unwrap_err();
        assert!(
            err.to_string().contains("checksum mismatch"),
            "got: {err}"
        );
        let _ = fs::remove_file(&part);
        assert!(
            !part.exists(),
            "staged partial must be removed after mismatch handling"
        );
    }

    #[test]
    fn digest_mismatch_in_stage_flow_removes_download() {
        // Build a tiny zip, serve it with a wrong sidecar, assert Err + cleanup.
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("stage");
        fs::create_dir_all(&staging).unwrap();

        let archive = build_zip(&[("amore.exe", b"fake-bin")]);
        let bad_sha = "1".repeat(64);
        let bad_doc = format!("{bad_sha}  amore-windows-x64.zip");
        let (listener, root) = spawn_asset_server(
            "v1.0.0",
            "amore-windows-x64.zip",
            archive,
            bad_doc.into_bytes(),
        );

        let err = fetch_and_stage_at(
            &root,
            Component::Amore,
            "v1.0.0",
            "windows",
            "x64",
            &staging,
        )
        .expect_err("digest mismatch must refuse");
        assert!(
            err.to_string().contains("checksum mismatch"),
            "got: {err:#}"
        );

        let part = staging.join("amore-windows-x64.zip.part");
        let final_archive = staging.join("amore-windows-x64.zip");
        assert!(!part.exists(), "partial must be deleted on mismatch");
        assert!(
            !final_archive.exists(),
            "final archive must not remain after mismatch"
        );
        // No unpacked binary either.
        assert!(!staging.join("amore.exe").exists());

        drop(listener);
    }

    // -- member selection + staging bounds -----------------------------------

    #[test]
    fn multi_member_amore_zip_stages_binary_and_docs() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("stage");
        // Outside path that must stay empty / untouched.
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"untouched").unwrap();

        let members = [
            ("amore.exe", b"binary-bytes".as_slice()),
            ("LICENSE", b"license-text".as_slice()),
            ("NOTICE", b"notice-text".as_slice()),
            ("README.md", b"readme-text".as_slice()),
            ("UPSTREAM.md", b"upstream-text".as_slice()),
        ];
        let archive = build_zip(&members);

        let (binary, extras) =
            unpack_verified_archive(&archive, "amore-windows-x64.zip", "amore.exe", &staging)
                .unwrap();

        assert_eq!(binary, staging.join("amore.exe"));
        assert_eq!(fs::read(&binary).unwrap(), b"binary-bytes");
        assert!(binary.starts_with(&staging));

        let mut extra_names: Vec<_> = extras
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        extra_names.sort();
        assert_eq!(
            extra_names,
            vec!["LICENSE", "NOTICE", "README.md", "UPSTREAM.md"]
        );
        for p in &extras {
            assert!(
                p.starts_with(&staging.join("docs")),
                "extra must live under docs/: {}",
                p.display()
            );
            assert!(p.starts_with(&staging));
        }

        // Nothing written outside staging.
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"untouched");
        let outside_entries: Vec<_> = fs::read_dir(&outside)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(outside_entries, vec!["keep.txt"]);
    }

    #[test]
    fn multi_member_amore_tar_gz_stages_binary_and_docs() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("stage");
        let members = [
            ("amore", b"unix-bin".as_slice()),
            ("LICENSE", b"L".as_slice()),
            ("NOTICE", b"N".as_slice()),
            ("README.md", b"R".as_slice()),
            ("UPSTREAM.md", b"U".as_slice()),
        ];
        let archive = build_tar_gz(&members);
        let (binary, extras) =
            unpack_verified_archive(&archive, "amore-linux-x64.tar.gz", "amore", &staging)
                .unwrap();
        assert_eq!(binary, staging.join("amore"));
        assert_eq!(fs::read(&binary).unwrap(), b"unix-bin");
        assert_eq!(extras.len(), 4);
        for p in extras {
            assert!(p.starts_with(&staging.join("docs")));
        }
    }

    #[test]
    fn companion_single_member_zip_stages_only_binary() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("stage");
        let name = "iris-windows-x64.exe";
        let archive = build_zip(&[(name, b"iris-bin")]);
        let (binary, extras) =
            unpack_verified_archive(&archive, "iris-windows-x64.exe.zip", name, &staging)
                .unwrap();
        assert_eq!(binary, staging.join(name));
        assert!(extras.is_empty());
        assert!(!staging.join("docs").exists());
    }

    // -- traversal rejection -------------------------------------------------

    #[test]
    fn unpack_rejects_tar_traversal_entry() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("stage");
        fs::create_dir_all(&staging).unwrap();

        // Craft a tar.gz whose member path is `../evil`. The high-level
        // append_data API refuses `..`, so write the header name bytes raw.
        let archive = build_tar_gz_with_raw_name(b"../evil", b"pwned", &[("amore", b"ok")]);
        let err =
            unpack_verified_archive(&archive, "amore-linux-x64.tar.gz", "amore", &staging)
                .expect_err("traversal must fail the unpack");
        assert!(
            err.to_string().contains("traversal"),
            "got: {err:#}"
        );
        assert!(
            !dir.path().join("evil").exists(),
            "must not write ../evil outside staging"
        );
        assert!(!staging.join("evil").exists());
    }

    #[test]
    fn unpack_rejects_zip_traversal_entry() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("stage");
        fs::create_dir_all(&staging).unwrap();

        // zip's enclosed_name() returns None for `../evil` → hard fail.
        let archive = build_zip_raw_name("../evil", b"pwned");
        let err =
            unpack_verified_archive(&archive, "amore-windows-x64.zip", "amore.exe", &staging)
                .expect_err("traversal must fail the unpack");
        assert!(
            err.to_string().contains("traversal"),
            "got: {err:#}"
        );
    }

    #[test]
    fn reject_traversal_pure() {
        assert!(reject_traversal(Path::new("amore.exe")).is_ok());
        assert!(reject_traversal(Path::new("docs/LICENSE")).is_ok());
        assert!(reject_traversal(Path::new("../evil")).is_err());
        assert!(reject_traversal(Path::new("foo/../../evil")).is_err());
    }

    // -- range-resume over loopback ------------------------------------------

    #[test]
    fn download_resumes_partial_over_loopback() {
        let payload: Vec<u8> = (0u8..200).collect();
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("blob.part");

        // Pre-seed a partial first half; resume_offset must report Range start 80.
        fs::write(&part, &payload[..80]).unwrap();
        assert_eq!(resume_offset(80, payload.len() as u64), Some(80));

        let (listener, url) = spawn_range_server(payload.clone());
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        download_with_resume(&client, &url, &part).unwrap();
        let got = fs::read(&part).unwrap();
        assert_eq!(got, payload, "resumed download must equal full payload");
        drop(listener);
    }

    // -- URL construction (origin-derived, no host literals in logic) --------

    #[test]
    fn asset_url_joins_download_root_tag_and_name() {
        let url = asset_download_url(
            "http://127.0.0.1:9/releases/download",
            "v1.2.3",
            "amore-linux-x64.tar.gz",
        );
        assert_eq!(
            url,
            "http://127.0.0.1:9/releases/download/v1.2.3/amore-linux-x64.tar.gz"
        );
        // Production root comes only from origin (no host/repo literals here).
        let prod = asset_download_url(&origin::release_base(), "v0.1.0", "amore-windows-x64.zip");
        assert!(prod.starts_with(&origin::release_base()));
        assert!(prod.ends_with("/v0.1.0/amore-windows-x64.zip"));
        assert_eq!(prod, format!("{}/v0.1.0/amore-windows-x64.zip", origin::release_base()));
    }

    // -- archive builders ----------------------------------------------------

    fn build_zip(members: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Cursor;
        use zip::write::SimpleFileOptions;
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, data) in members {
                writer.start_file(*name, opts).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    /// Build a zip whose entry name is exactly `name` (may include `..`).
    fn build_zip_raw_name(name: &str, data: &[u8]) -> Vec<u8> {
        use std::io::Cursor;
        use zip::write::SimpleFileOptions;
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            // ZipWriter may accept `../evil` as a name; enclosed_name rejects it.
            writer.start_file(name, opts).unwrap();
            writer.write_all(data).unwrap();
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn build_tar_gz(members: &[(&str, &[u8])]) -> Vec<u8> {
        use flate2::Compression;
        use flate2::write::GzEncoder;
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (name, data) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, *name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    /// Build a tar.gz with a first entry whose header name is raw bytes
    /// (used to inject `../evil` past tar::Builder path validation).
    fn build_tar_gz_with_raw_name(
        raw_name: &[u8],
        raw_data: &[u8],
        rest: &[(&str, &[u8])],
    ) -> Vec<u8> {
        use flate2::Compression;
        use flate2::write::GzEncoder;
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        {
            let name_field = &mut header.as_old_mut().name;
            assert!(raw_name.len() < name_field.len());
            name_field[..raw_name.len()].copy_from_slice(raw_name);
        }
        header.set_size(raw_data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, raw_data).unwrap();
        for (name, data) in rest {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, *name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn parse_range_start(req: &str) -> Option<u64> {
        for line in req.lines() {
            let lower = line.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("range:") {
                let rest = rest.trim();
                if let Some(spec) = rest.strip_prefix("bytes=") {
                    let start = spec.split('-').next()?;
                    return start.parse().ok();
                }
            }
        }
        None
    }

    /// Serve HEAD (Content-Length) and GET with optional Range.
    fn spawn_range_server(body: Vec<u8>) -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/blob");
        let serving = listener.try_clone().unwrap();
        let body = Arc::new(body);
        std::thread::spawn(move || {
            for stream in serving.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = [0u8; 4096];
                let n = match stream.read(&mut buf) {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let is_head = req.starts_with("HEAD ");
                let range = parse_range_start(&req);
                let data = body.as_ref();
                let total = data.len();
                if is_head {
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    );
                    continue;
                }
                if let Some(start) = range {
                    let start = start as usize;
                    if start > total {
                        let _ = stream.write_all(b"HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\n\r\n");
                        continue;
                    }
                    let slice = &data[start..];
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            slice.len(),
                            start,
                            total - 1,
                            total
                        )
                        .as_bytes(),
                    );
                    let _ = stream.write_all(slice);
                } else {
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    );
                    let _ = stream.write_all(data);
                }
            }
        });
        (listener, url)
    }

    /// Minimal release-layout server: `/{tag}/{asset}` and `/{tag}/{asset}.sha256`.
    fn spawn_asset_server(
        tag: &str,
        asset: &str,
        archive: Vec<u8>,
        sha_doc: Vec<u8>,
    ) -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        // Mimic origin::release_base shape: .../releases/download
        let root = format!("http://{addr}/releases/download");
        let archive_path = format!("/{tag}/{asset}");
        let sha_path = format!("/{tag}/{asset}.sha256");
        let serving = listener.try_clone().unwrap();
        let archive = Arc::new(archive);
        let sha_doc = Arc::new(sha_doc);
        let archive_path = Arc::new(archive_path);
        let sha_path = Arc::new(sha_path);
        std::thread::spawn(move || {
            for stream in serving.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut buf = [0u8; 4096];
                let n = match stream.read(&mut buf) {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let path = first.split_whitespace().nth(1).unwrap_or("");
                let is_head = first.starts_with("HEAD ");
                let (status, body): (&str, &[u8]) = if path == archive_path.as_str()
                    || path.ends_with(archive_path.as_str())
                {
                    ("200 OK", archive.as_ref())
                } else if path == sha_path.as_str() || path.ends_with(sha_path.as_str()) {
                    ("200 OK", sha_doc.as_ref())
                } else {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                    continue;
                };
                if is_head {
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    );
                } else {
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    );
                    let _ = stream.write_all(body);
                }
            }
        });
        (listener, root)
    }
}
