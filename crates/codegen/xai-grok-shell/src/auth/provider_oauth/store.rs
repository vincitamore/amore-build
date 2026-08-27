// Credential store for third-party OAuth providers.
//
// One JSON file under the harness home holds every provider's credentials:
//
//   { "version": 1, "providers": { "anthropic": { ... }, "cursor": { ... } } }
//
// Writes are atomic (tmp + rename) with owner-only permissions on unix, and
// refreshes use a compare-and-set on the stored refresh token so two processes
// sharing the file cannot clobber a sibling's rotated token (omp's
// `refreshCredentialById` CAS, reduced to the file store).

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ProviderKind;

const STORE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ProviderCredentials {
    pub access: String,
    pub refresh: String,
    /// Epoch ms the access token stops being accepted (5-minute clock skew
    /// already applied by the flows).
    pub expires_ms: i64,
    /// Epoch ms of the interactive login that minted this grant. Anthropic
    /// expires the whole refresh-token family ~30 days after authorization
    /// regardless of rotation; this anchors the re-login deadline warning.
    pub authorized_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_name: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CredentialsFile {
    version: u32,
    #[serde(default)]
    providers: std::collections::BTreeMap<String, ProviderCredentials>,
}

/// Default store location: `<harness home>/oauth-credentials.json`.
pub(crate) fn default_store_path() -> PathBuf {
    crate::util::grok_home::grok_home().join("oauth-credentials.json")
}

/// Epoch ms for "credential must be refreshed": expires at `now + REFRESH_MARGIN_MS`
/// or later counts as fresh. The flows bake a 5-minute clock skew into
/// `expires_ms`, so the margin on top is deliberately small.
pub(crate) const REFRESH_MARGIN_MS: i64 = 60_000;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ProviderCredentials {
    pub fn is_fresh(&self, now: i64) -> bool {
        now < self.expires_ms.saturating_sub(REFRESH_MARGIN_MS)
    }
}

fn read_file(path: &Path) -> CredentialsFile {
    let Ok(content) = std::fs::read_to_string(path) else {
        return CredentialsFile::default();
    };
    match serde_json::from_str(&content) {
        Ok(file) => file,
        Err(_) => {
            // A corrupt store is backed up and started over rather than
            // silently discarded (mirrors auth.json's recovery).
            backup_corrupt(path);
            CredentialsFile::default()
        }
    }
}

fn backup_corrupt(path: &Path) {
    let backup = path.with_extension(format!(
        "json.corrupt.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let _ = std::fs::rename(path, backup);
}

fn write_file(path: &Path, file: &CredentialsFile) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(file).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        set_owner_only(&f);
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(unix)]
fn set_owner_only(f: &std::fs::File) {
    use std::os::unix::fs::PermissionsExt;
    let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_owner_only(_f: &std::fs::File) {}

pub(crate) fn load(path: &Path, kind: ProviderKind) -> Option<ProviderCredentials> {
    read_file(path).providers.get(kind.as_str()).cloned()
}

pub(crate) fn store(
    path: &Path,
    kind: ProviderKind,
    creds: &ProviderCredentials,
) -> std::io::Result<()> {
    let mut file = read_file(path);
    file.version = STORE_VERSION;
    file.providers.insert(kind.as_str().to_owned(), creds.clone());
    write_file(path, &file)
}

pub(crate) fn clear(path: &Path, kind: ProviderKind) {
    let mut file = read_file(path);
    if file.providers.remove(kind.as_str()).is_some() {
        let _ = write_file(path, &file);
    }
}

/// Compare-and-set refresh: write `creds` only when the stored refresh token
/// still matches `expected_refresh` (i.e. no sibling process rotated it while
/// we were refreshing). Returns `false` when the store moved underneath us —
/// the caller should reload instead of retrying the refresh.
pub(crate) fn store_refresh_cas(
    path: &Path,
    kind: ProviderKind,
    expected_refresh: &str,
    creds: &ProviderCredentials,
) -> bool {
    let file = read_file(path);
    match file.providers.get(kind.as_str()) {
        Some(current) if current.refresh == expected_refresh => {
            let mut file = file;
            file.version = STORE_VERSION;
            file.providers.insert(kind.as_str().to_owned(), creds.clone());
            write_file(path, &file).is_ok()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(refresh: &str, expires_ms: i64) -> ProviderCredentials {
        ProviderCredentials {
            access: format!("access-for-{refresh}"),
            refresh: refresh.to_owned(),
            expires_ms,
            authorized_at: 1_000,
            account_id: Some("acct".to_owned()),
            email: Some("user@example.com".to_owned()),
            org_id: None,
            org_name: None,
        }
    }

    #[test]
    fn round_trip_and_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("oauth-credentials.json");

        assert!(load(&path, ProviderKind::Anthropic).is_none());

        store(&path, ProviderKind::Anthropic, &creds("r1", 5_000)).unwrap();
        assert_eq!(load(&path, ProviderKind::Anthropic), Some(creds("r1", 5_000)));
        assert!(load(&path, ProviderKind::Cursor).is_none());

        store(&path, ProviderKind::Cursor, &creds("r2", 6_000)).unwrap();
        clear(&path, ProviderKind::Anthropic);
        assert!(load(&path, ProviderKind::Anthropic).is_none());
        assert_eq!(load(&path, ProviderKind::Cursor), Some(creds("r2", 6_000)));
    }

    #[test]
    fn cas_fails_when_sibling_rotated() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("oauth-credentials.json");
        store(&path, ProviderKind::Anthropic, &creds("r1", 5_000)).unwrap();

        // Sibling rotated r1 -> r2 while we were refreshing from r1.
        store(&path, ProviderKind::Anthropic, &creds("r2", 7_000)).unwrap();
        assert!(!store_refresh_cas(&path, ProviderKind::Anthropic, "r1", &creds("r3", 9_000)));
        assert_eq!(load(&path, ProviderKind::Anthropic), Some(creds("r2", 7_000)));

        // Matching expectation writes through.
        assert!(store_refresh_cas(&path, ProviderKind::Anthropic, "r2", &creds("r3", 9_000)));
        assert_eq!(load(&path, ProviderKind::Anthropic), Some(creds("r3", 9_000)));
    }

    #[test]
    fn corrupt_file_is_backed_up_and_reset() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("oauth-credentials.json");
        std::fs::write(&path, "{not json").unwrap();

        assert!(load(&path, ProviderKind::Anthropic).is_none());
        store(&path, ProviderKind::Anthropic, &creds("r1", 5_000)).unwrap();
        assert_eq!(load(&path, ProviderKind::Anthropic), Some(creds("r1", 5_000)));

        let mut backups = 0;
        for entry in std::fs::read_dir(tmp.path()).unwrap().flatten() {
            if entry.file_name().to_string_lossy().contains(".corrupt.") {
                backups += 1;
            }
        }
        assert_eq!(backups, 1, "corrupt store should be backed up once");
    }

    #[test]
    fn freshness_respects_margin() {
        let now = 10_000_000;
        assert!(creds("r", now + REFRESH_MARGIN_MS + 1).is_fresh(now));
        assert!(!creds("r", now + REFRESH_MARGIN_MS).is_fresh(now));
    }
}
