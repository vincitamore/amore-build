//! Tag discovery and release-asset naming for self-update.
//!
//! Background checks resolve the current tag via the GitHub web redirect on
//! `/releases/latest` (zero API quota). User-initiated paths may call the
//! REST API for full release metadata. Asset filenames are always built from
//! a per-component template; they are never reverse-parsed from a URL.

use std::time::Duration;

use serde::Deserialize;
use tracing::debug;

use super::origin::{UPDATE_ORIGIN_HOST, UPDATE_ORIGIN_REPO};

/// REST API host for user-initiated release metadata.
///
/// Derived as `api.{UPDATE_ORIGIN_HOST}` so the origin host stays
/// single-sourced in [`super::origin`]. The REST API is a different service
/// from the asset host, with its own per-IP rate-limit bucket (60/hr
/// unauthenticated), and must not be reached from the background check path.
pub fn update_api_host() -> String {
    format!("api.{}", UPDATE_ORIGIN_HOST)
}

const TIMEOUT: Duration = Duration::from_secs(30);

const USER_AGENT: &str = concat!("amore-self-update/", env!("CARGO_PKG_VERSION"));

/// A release tag resolved from discovery.
///
/// Resolving a tag is **not** an asset-existence check. The `latest` alias
/// redirects to a tag URL regardless of whether any particular platform
/// archive is published under that tag; only the final asset URL 404s when
/// the archive is missing. Callers that need the archive must probe the
/// asset URL (or consult [`ReleaseMeta`] assets) separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTag {
    pub tag: String,
}

/// Published component whose archive name grammar we know how to build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Component {
    /// The main `amore` binary (five published targets).
    Amore,
    /// A companion instrument (`iris`, `lucerna`, `speculum`; three targets).
    Companion(&'static str),
}

impl Component {
    /// Short name used in archive filenames (`amore`, `iris`, …).
    pub fn name(self) -> &'static str {
        match self {
            Self::Amore => "amore",
            Self::Companion(name) => name,
        }
    }
}

/// One asset listed under a release metadata response.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub digest: Option<String>,
    pub browser_download_url: String,
}

/// Full release metadata from the GitHub REST API (user-initiated only).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReleaseMeta {
    pub tag_name: String,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

/// Failure modes for discovery. Callers must treat every variant as "no
/// answer" — never as evidence that the installation is current.
#[derive(Debug)]
pub enum DiscoverError {
    /// HTTP client could not be built or the request failed to complete.
    Transport(String),
    /// Response status was not a success or redirect we know how to handle.
    UnexpectedStatus(u16),
    /// `Location` header missing, empty, or not a `/releases/tag/...` URL.
    UnparseableLocation,
    /// REST body was not usable release JSON.
    UnparseableBody(String),
    /// Wall-clock budget exceeded (mapped from the client timeout).
    Timeout,
}

impl std::fmt::Display for DiscoverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(msg) => write!(f, "transport error: {msg}"),
            Self::UnexpectedStatus(code) => write!(f, "unexpected HTTP status {code}"),
            Self::UnparseableLocation => write!(f, "could not parse tag from Location header"),
            Self::UnparseableBody(msg) => write!(f, "could not parse release body: {msg}"),
            Self::Timeout => write!(f, "request timed out"),
        }
    }
}

impl std::error::Error for DiscoverError {}

/// Build the archive filename for `component` on `os`/`arch`, or `None` when
/// that component is not published for the target.
///
/// `os` and `arch` use release-asset spelling: `linux`/`x64`, `windows`/`x64`,
/// `darwin`/`arm64`, etc. — not `std::env::consts` values.
///
/// Templates (never reverse-parsed):
/// - `amore` on Windows: `amore-windows-x64.zip` (no `.exe` segment)
/// - `amore` elsewhere: `amore-{os}-{arch}.tar.gz`
/// - companions on Windows: `{name}-windows-x64.exe.zip`
/// - companions elsewhere: `{name}-{os}-{arch}.tar.gz`
pub fn asset_name(component: Component, os: &str, arch: &str) -> Option<String> {
    if !target_supported(component, os, arch) {
        return None;
    }
    let name = component.name();
    let suffix = format!("{os}-{arch}");
    match (component, os) {
        (Component::Amore, "windows") => Some(format!("{name}-{suffix}.zip")),
        (Component::Amore, _) => Some(format!("{name}-{suffix}.tar.gz")),
        (Component::Companion(_), "windows") => Some(format!("{name}-{suffix}.exe.zip")),
        (Component::Companion(_), _) => Some(format!("{name}-{suffix}.tar.gz")),
    }
}

/// Whether a release archive is published for this component on `os`/`arch`.
pub fn target_supported(component: Component, os: &str, arch: &str) -> bool {
    match component {
        Component::Amore => matches!(
            (os, arch),
            ("linux", "x64")
                | ("linux", "arm64")
                | ("windows", "x64")
                | ("darwin", "arm64")
                | ("darwin", "x64")
        ),
        Component::Companion(_) => {
            matches!((os, arch), ("linux", "x64") | ("windows", "x64") | ("darwin", "arm64"))
        }
    }
}

/// Map `std::env::consts::{OS, ARCH}` onto release-asset `(os, arch)` spelling.
pub fn host_os_arch() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some(("linux", "x64")),
        ("linux", "aarch64") => Some(("linux", "arm64")),
        ("windows", "x86_64") => Some(("windows", "x64")),
        ("macos", "aarch64") => Some(("darwin", "arm64")),
        ("macos", "x86_64") => Some(("darwin", "x64")),
        _ => None,
    }
}

/// Resolve the latest non-prerelease tag via the web `/releases/latest` redirect.
///
/// Uses `HEAD` with redirects disabled so the 302 `Location` is observable.
/// Does not touch the REST API host and costs no REST quota.
///
/// On any failure the error is logged at debug and returned; the caller must
/// record the attempt time and stay silent toward the user.
pub fn latest_tag_via_redirect() -> Result<ResolvedTag, DiscoverError> {
    let url = format!(
        "https://{host}/{repo}/releases/latest",
        host = UPDATE_ORIGIN_HOST,
        repo = UPDATE_ORIGIN_REPO,
    );
    match latest_tag_via_redirect_at(&url) {
        Ok(tag) => Ok(tag),
        Err(err) => {
            debug!(error = %err, url = %url, "self_update discover: latest tag probe failed");
            Err(err)
        }
    }
}

/// Probe a concrete latest-release URL (testable seam; production uses
/// [`latest_tag_via_redirect`]).
pub fn latest_tag_via_redirect_at(url: &str) -> Result<ResolvedTag, DiscoverError> {
    let client = redirect_sniff_client()?;
    let response = client.head(url).send().map_err(map_transport)?;
    let status = response.status();
    // GitHub returns 302 Found; accept any 3xx with a Location we can parse.
    if !(status.is_redirection() || status.is_success()) {
        return Err(DiscoverError::UnexpectedStatus(status.as_u16()));
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(DiscoverError::UnparseableLocation)?;
    let tag = parse_tag_from_location(location).ok_or(DiscoverError::UnparseableLocation)?;
    Ok(ResolvedTag { tag })
}

/// Fetch release metadata for a specific tag via the REST API.
///
/// **User-initiated calls only.** Each call spends 1 of 60 unauthenticated
/// requests/hour keyed per source IP. Never invoke from the background check
/// path.
pub fn release_metadata(tag: &str) -> Result<ReleaseMeta, DiscoverError> {
    let url = format!(
        "https://{api}/repos/{repo}/releases/tags/{tag}",
        api = update_api_host(),
        repo = UPDATE_ORIGIN_REPO,
    );
    match release_metadata_at(&url) {
        Ok(meta) => Ok(meta),
        Err(err) => {
            debug!(error = %err, tag = %tag, "self_update discover: release metadata failed");
            Err(err)
        }
    }
}

/// Fetch release metadata from a concrete URL (testable seam).
pub fn release_metadata_at(url: &str) -> Result<ReleaseMeta, DiscoverError> {
    let client = api_client()?;
    let response = client.get(url).send().map_err(map_transport)?;
    let status = response.status();
    if !status.is_success() {
        return Err(DiscoverError::UnexpectedStatus(status.as_u16()));
    }
    let body = response.text().map_err(|e| DiscoverError::Transport(e.to_string()))?;
    serde_json::from_str(&body).map_err(|e| DiscoverError::UnparseableBody(e.to_string()))
}

/// Extract the tag segment from a `Location` header value such as
/// `https://{host}/{repo}/releases/tag/v1.0.0` (absolute or relative).
pub fn parse_tag_from_location(location: &str) -> Option<String> {
    // Accept absolute URLs and relative paths. Look for `/releases/tag/<tag>`.
    let marker = "/releases/tag/";
    let idx = location.find(marker)?;
    let rest = &location[idx + marker.len()..];
    let tag = rest.split(&['?', '#', '/'][..]).next().unwrap_or("");
    if tag.is_empty() {
        return None;
    }
    // Captive portals and odd redirects sometimes hand back HTML paths; require
    // a plausible tag token (starts with a letter or digit, no whitespace).
    if !tag.chars().next()?.is_ascii_alphanumeric() {
        return None;
    }
    if tag.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    Some(tag.to_string())
}

fn redirect_sniff_client() -> Result<reqwest::blocking::Client, DiscoverError> {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| DiscoverError::Transport(e.to_string()))
}

fn api_client() -> Result<reqwest::blocking::Client, DiscoverError> {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| DiscoverError::Transport(e.to_string()))
}

fn map_transport(err: reqwest::Error) -> DiscoverError {
    if err.is_timeout() {
        DiscoverError::Timeout
    } else {
        DiscoverError::Transport(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amore_all_five_targets() {
        let cases = [
            ("linux", "x64", "amore-linux-x64.tar.gz"),
            ("linux", "arm64", "amore-linux-arm64.tar.gz"),
            ("windows", "x64", "amore-windows-x64.zip"),
            ("darwin", "arm64", "amore-darwin-arm64.tar.gz"),
            ("darwin", "x64", "amore-darwin-x64.tar.gz"),
        ];
        for (os, arch, expected) in cases {
            assert_eq!(
                asset_name(Component::Amore, os, arch).as_deref(),
                Some(expected),
                "amore {os}-{arch}"
            );
            assert!(target_supported(Component::Amore, os, arch));
        }
    }

    #[test]
    fn companion_all_three_targets_and_exe_zip_asymmetry() {
        for name in ["iris", "lucerna", "speculum"] {
            let c = Component::Companion(name);
            let linux = format!("{name}-linux-x64.tar.gz");
            let windows = format!("{name}-windows-x64.exe.zip");
            let darwin = format!("{name}-darwin-arm64.tar.gz");
            assert_eq!(asset_name(c, "linux", "x64").as_deref(), Some(linux.as_str()));
            assert_eq!(
                asset_name(c, "windows", "x64").as_deref(),
                Some(windows.as_str()),
                "companions use .exe.zip; amore does not"
            );
            assert_eq!(
                asset_name(c, "darwin", "arm64").as_deref(),
                Some(darwin.as_str())
            );
            assert!(target_supported(c, "linux", "x64"));
            assert!(target_supported(c, "windows", "x64"));
            assert!(target_supported(c, "darwin", "arm64"));
        }
    }

    #[test]
    fn companion_unsupported_targets_are_none() {
        let c = Component::Companion("iris");
        // amore ships these; companions do not
        assert_eq!(asset_name(c, "linux", "arm64"), None);
        assert_eq!(asset_name(c, "darwin", "x64"), None);
        assert!(!target_supported(c, "linux", "arm64"));
        assert!(!target_supported(c, "darwin", "x64"));
    }

    #[test]
    fn amore_unsupported_target_is_none() {
        assert_eq!(asset_name(Component::Amore, "windows", "arm64"), None);
        assert!(!target_supported(Component::Amore, "freebsd", "x64"));
    }

    #[test]
    fn windows_asset_name_asymmetry_amore_vs_companion() {
        assert_eq!(
            asset_name(Component::Amore, "windows", "x64").as_deref(),
            Some("amore-windows-x64.zip")
        );
        assert_eq!(
            asset_name(Component::Companion("iris"), "windows", "x64").as_deref(),
            Some("iris-windows-x64.exe.zip")
        );
    }

    #[test]
    fn parse_tag_from_absolute_location() {
        let loc = format!(
            "https://{host}/{repo}/releases/tag/v1.2.3",
            host = UPDATE_ORIGIN_HOST,
            repo = UPDATE_ORIGIN_REPO,
        );
        assert_eq!(parse_tag_from_location(&loc).as_deref(), Some("v1.2.3"));
    }

    #[test]
    fn parse_tag_from_relative_location() {
        let loc = format!("/{repo}/releases/tag/v0.3.1", repo = UPDATE_ORIGIN_REPO);
        assert_eq!(parse_tag_from_location(&loc).as_deref(), Some("v0.3.1"));
    }

    #[test]
    fn api_host_derives_from_origin_host() {
        assert_eq!(update_api_host(), format!("api.{}", UPDATE_ORIGIN_HOST));
    }

    #[test]
    fn parse_tag_strips_query_and_fragment() {
        assert_eq!(
            parse_tag_from_location("/owner/repo/releases/tag/v9.9.9?foo=1#bar").as_deref(),
            Some("v9.9.9")
        );
    }

    #[test]
    fn parse_tag_rejects_garbage() {
        assert_eq!(parse_tag_from_location("https://example.com/login"), None);
        assert_eq!(parse_tag_from_location("/releases/tag/"), None);
        assert_eq!(parse_tag_from_location("/releases/tag/ has space"), None);
    }

    #[test]
    fn release_meta_deserializes_minimal_json() {
        let json = r#"{
            "tag_name": "v1.0.0",
            "assets": [
                {
                    "name": "amore-windows-x64.zip",
                    "size": 100,
                    "digest": "sha256:abc",
                    "browser_download_url": "https://example.invalid/a.zip"
                }
            ]
        }"#;
        let meta: ReleaseMeta = serde_json::from_str(json).unwrap();
        assert_eq!(meta.tag_name, "v1.0.0");
        assert_eq!(meta.assets.len(), 1);
        assert_eq!(meta.assets[0].name, "amore-windows-x64.zip");
        assert_eq!(meta.assets[0].digest.as_deref(), Some("sha256:abc"));
    }

    #[test]
    fn resolved_tag_is_not_asset_proof_documented_in_type() {
        // Type-level distinction: ResolvedTag carries only the tag string.
        // Asset presence is a separate concern (ReleaseMeta assets / fetch 404).
        let tag = ResolvedTag {
            tag: "v1.0.0".into(),
        };
        assert_eq!(tag.tag, "v1.0.0");
        // A tag can exist while a platform asset does not:
        assert_eq!(
            asset_name(Component::Companion("iris"), "darwin", "x64"),
            None
        );
    }

    /// Live network probes are gated and default-off. Enable with
    /// `AMORE_SELF_UPDATE_LIVE_PROBE=1` for manual E2E (U15 covers the lane).
    #[test]
    fn live_probe_gated_default_off() {
        if std::env::var_os("AMORE_SELF_UPDATE_LIVE_PROBE").as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            return;
        }
        let tag = latest_tag_via_redirect().expect("live latest tag");
        assert!(tag.tag.starts_with('v') || tag.tag.chars().next().unwrap().is_ascii_digit());
        let meta = release_metadata(&tag.tag).expect("live metadata");
        assert_eq!(meta.tag_name, tag.tag);
    }
}
