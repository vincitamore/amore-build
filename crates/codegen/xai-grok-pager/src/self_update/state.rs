//! Install identity and the `.amore-install.json` state file.
//!
//! # Identity model (Model B)
//!
//! The install directory is `canonicalize(current_exe())?.parent()` — **not**
//! `~/.amore/bin`. This is load-bearing:
//!
//! 1. **Every existing install is already correct under it**, including installs
//!    that place `amore` on PATH in an arbitrary directory.
//! 2. **`instrument_fetch::link_onto_path` already resolves the same way**
//!    (`current_exe()?.parent()`), so companions land beside the binary the
//!    updater will later swap.
//! 3. **A `~/.amore/bin` identity would flip `is_managed_install` true**, which
//!    gates the stdio agent's background-update path and would silently arm
//!    that path for ordinary PATH installs. Model B keeps managed-install
//!    detection structurally false for a normal user install.
//!
//! One state file lives in that directory, so two side-by-side installs keep
//! independent version floors and check caches.
//!
//! # Writability
//!
//! If the install directory is not writable the check cannot cache. Callers
//! skip the check and surface the typed [`StateError::UnwritableInstallDir`]
//! (e.g. via `amore doctor`). Never degrade to checking every launch.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::debug;

/// Filename of the install state document, always under the install directory.
pub const STATE_FILE_NAME: &str = ".amore-install.json";

/// Config snapshot filename under the install directory (beside binary `.prev`
/// siblings and [STATE_FILE_NAME]).
///
/// Chosen over a slot under `$AMORE_HOME`: install identity is Model B (parent
/// of the running binary), side-by-side installs keep independent rollback
/// artifacts, and the snapshot travels with the binaries it pairs with.
pub const CONFIG_SNAPSHOT_FILE_NAME: &str = "config.toml.prev";

/// Spec version written by this crate. A mismatched `spec` on disk is treated
/// as absent state (forward-incompatible), never a crash.
///
/// Stays at 1 while new fields remain optional with serde defaults (same rule
/// as `targets` and `config_snapshot`).
pub const SPEC_VERSION: u32 = 1;

/// Per-file record of an activated install member.
///
/// `sha256` is always the **content** digest of the on-disk file (not the
/// release archive). Archive / sidecar digests live in [`TargetRecord`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    pub sha256: String,
    pub size: u64,
}

/// Per-target metadata that is not the on-disk content hash.
///
/// `archive_sha256` is the release-asset / sidecar digest used for
/// content-addressed skip (compare remote `.sha256` without re-fetching the
/// archive when it still matches).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TargetRecord {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub archive_sha256: String,
}

/// Record that a user `config.toml` was snapshotted for rollback.
///
/// The bytes live at [`CONFIG_SNAPSHOT_FILE_NAME`] under the install directory;
/// this field only records that the snapshot was taken (and when).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigSnapshotRecord {
    /// Basename under the install directory (today always
    /// [`CONFIG_SNAPSHOT_FILE_NAME`]).
    pub path: String,
    /// When the snapshot was written (same clock style as `installed_at`).
    pub taken_at: String,
}

/// Contents of `.amore-install.json`.
///
/// Unknown fields are tolerated on read (serde default) so a newer writer can
/// extend the document without breaking older readers. A `spec` other than
/// [`SPEC_VERSION`] is treated as absent state by [`load`].
///
/// `files` holds content hashes; `targets` holds archive digests;
/// `config_snapshot` records a pre-activate copy of the user config. Adding
/// optional maps/fields is forward-compatible (default empty / none on old
/// documents), so [`SPEC_VERSION`] stays at 1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallState {
    pub spec: u32,
    pub tag: String,
    pub channel: String,
    pub installed_at: String,
    pub version_floor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_tag: Option<String>,
    #[serde(default)]
    pub files: BTreeMap<String, FileRecord>,
    /// Archive/sidecar digests keyed by the same basenames as [`Self::files`].
    #[serde(default)]
    pub targets: BTreeMap<String, TargetRecord>,
    /// Present when a config.toml snapshot was written for this install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_snapshot: Option<ConfigSnapshotRecord>,
}

impl InstallState {
    /// Build a fresh state document for a successful install of `tag`.
    pub fn new(tag: impl Into<String>, channel: impl Into<String>, installed_at: impl Into<String>) -> Self {
        let tag = tag.into();
        let version_floor = tag_to_version_floor(&tag);
        Self {
            spec: SPEC_VERSION,
            tag: tag.clone(),
            channel: channel.into(),
            installed_at: installed_at.into(),
            version_floor,
            last_check_at: None,
            last_seen_tag: None,
            files: BTreeMap::new(),
            targets: BTreeMap::new(),
            config_snapshot: None,
        }
    }
}

/// Errors from install-directory identity and state I/O.
#[derive(Debug)]
pub enum StateError {
    /// Could not resolve the running executable or its parent directory.
    InstallDir(String),
    /// Install directory exists but is not writable; check cache is impossible.
    UnwritableInstallDir {
        path: PathBuf,
        source: io::Error,
    },
    /// Filesystem or serialization failure while reading or writing state.
    Io {
        path: PathBuf,
        source: io::Error,
    },
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InstallDir(msg) => write!(f, "install directory: {msg}"),
            Self::UnwritableInstallDir { path, source } => {
                write!(
                    f,
                    "install directory not writable ({}): {source}",
                    path.display()
                )
            }
            Self::Io { path, source } => {
                write!(f, "state I/O ({}): {source}", path.display())
            }
        }
    }
}

impl std::error::Error for StateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::UnwritableInstallDir { source, .. } | Self::Io { source, .. } => Some(source),
            Self::InstallDir(_) => None,
        }
    }
}

/// Resolve the install directory: parent of the canonicalized current executable.
pub fn install_dir() -> Result<PathBuf, StateError> {
    let exe = std::env::current_exe().map_err(|e| {
        StateError::InstallDir(format!("current_exe: {e}"))
    })?;
    let canon = dunce::canonicalize(&exe).map_err(|e| {
        StateError::InstallDir(format!("canonicalize({}): {e}", exe.display()))
    })?;
    let parent = canon.parent().ok_or_else(|| {
        StateError::InstallDir(format!(
            "executable has no parent directory: {}",
            canon.display()
        ))
    })?;
    Ok(parent.to_path_buf())
}

/// Path of the state file under `dir`.
pub fn state_path(dir: &Path) -> PathBuf {
    dir.join(STATE_FILE_NAME)
}

/// Probe whether `dir` accepts creates. On failure returns
/// [`StateError::UnwritableInstallDir`] so doctor can report the why.
pub fn write_probe(dir: &Path) -> Result<(), StateError> {
    let probe = dir.join(".amore-write-probe.tmp");
    match fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(source) => Err(StateError::UnwritableInstallDir {
            path: dir.to_path_buf(),
            source,
        }),
    }
}

/// Load install state from `dir`.
///
/// - Missing file → `Ok(None)`
/// - `spec` mismatch → `Ok(None)` (absent state; never a crash)
/// - Unparseable JSON → `Ok(None)` after a debug log (corrupt treated as absent)
/// - I/O errors other than NotFound → `Err`
pub fn load(dir: &Path) -> Result<Option<InstallState>, StateError> {
    let path = state_path(dir);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(StateError::Io {
                path,
                source,
            });
        }
    };
    let state: InstallState = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            debug!(
                path = %path.display(),
                error = %e,
                "self_update state: unparseable install state; treating as absent"
            );
            return Ok(None);
        }
    };
    if state.spec != SPEC_VERSION {
        debug!(
            path = %path.display(),
            spec = state.spec,
            expected = SPEC_VERSION,
            "self_update state: spec mismatch; treating as absent"
        );
        return Ok(None);
    }
    Ok(Some(state))
}

/// Write `state` atomically under `dir` (temp file + rename).
///
/// The install directory must pass [`write_probe`]; callers that skip the
/// probe still get a typed I/O error if the rename fails.
pub fn store_atomic(dir: &Path, state: &InstallState) -> Result<(), StateError> {
    write_probe(dir)?;
    let path = state_path(dir);
    let tmp = dir.join(format!("{STATE_FILE_NAME}.tmp"));
    let body = serde_json::to_vec_pretty(state).map_err(|e| StateError::Io {
        path: path.clone(),
        source: io::Error::new(io::ErrorKind::InvalidData, e),
    })?;
    fs::write(&tmp, &body).map_err(|source| StateError::Io {
        path: tmp.clone(),
        source,
    })?;
    // On Windows, rename does not replace an existing destination.
    if path.exists() {
        fs::remove_file(&path).map_err(|source| StateError::Io {
            path: path.clone(),
            source,
        })?;
    }
    fs::rename(&tmp, &path).map_err(|source| StateError::Io {
        path: path.clone(),
        source,
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Config snapshot (rollback completeness)
// ---------------------------------------------------------------------------

/// Outcome of taking a config snapshot under the install directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotOutcome {
    /// Bytes copied to `path` (install-dir [`CONFIG_SNAPSHOT_FILE_NAME`]).
    Written {
        path: PathBuf,
        record: ConfigSnapshotRecord,
    },
    /// Live user config was missing or unresolvable; nothing written.
    SourceAbsent,
}

/// Outcome of restoring a config snapshot over the live user config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreOutcome {
    /// Snapshot bytes written to `dest`.
    Restored { dest: PathBuf },
    /// No snapshot file under the install directory.
    SnapshotAbsent,
}

/// Absolute path of the live user `config.toml` (`$AMORE_HOME` / `$GROK_HOME`).
pub fn live_user_config_path() -> Option<PathBuf> {
    xai_grok_config::user_grok_home().map(|h| h.join(xai_grok_config::USER_CONFIG_FILENAME))
}

/// Path of the config snapshot under `install_dir`.
pub fn config_snapshot_path(install_dir: &Path) -> PathBuf {
    install_dir.join(CONFIG_SNAPSHOT_FILE_NAME)
}

/// Copy `source_config` to `install_dir/config.toml.prev` without mutating
/// install state. Use this from FINALIZE when the caller will set
/// [`InstallState::config_snapshot`] and `store_atomic` in one write.
///
/// Missing source is not an error ([`SnapshotOutcome::SourceAbsent`]).
pub fn write_config_snapshot_bytes(
    install_dir: &Path,
    source_config: &Path,
) -> Result<SnapshotOutcome, StateError> {
    if !source_config.is_file() {
        return Ok(SnapshotOutcome::SourceAbsent);
    }
    write_probe(install_dir)?;
    let dest = config_snapshot_path(install_dir);
    let tmp = install_dir.join(format!("{CONFIG_SNAPSHOT_FILE_NAME}.tmp"));
    fs::copy(source_config, &tmp).map_err(|source| StateError::Io {
        path: tmp.clone(),
        source,
    })?;
    if dest.exists() {
        fs::remove_file(&dest).map_err(|source| StateError::Io {
            path: dest.clone(),
            source,
        })?;
    }
    fs::rename(&tmp, &dest).map_err(|source| StateError::Io {
        path: dest.clone(),
        source,
    })?;

    let record = ConfigSnapshotRecord {
        path: CONFIG_SNAPSHOT_FILE_NAME.to_string(),
        taken_at: unix_now_string(),
    };
    Ok(SnapshotOutcome::Written {
        path: dest,
        record,
    })
}

/// Copy live user `config.toml` into the install dir (bytes only).
pub fn write_user_config_snapshot(install_dir: &Path) -> Result<SnapshotOutcome, StateError> {
    let Some(src) = live_user_config_path() else {
        return Ok(SnapshotOutcome::SourceAbsent);
    };
    write_config_snapshot_bytes(install_dir, &src)
}

/// Copy `source_config` to `install_dir/config.toml.prev` and record the
/// snapshot on install state when a state document is present.
///
/// Missing source is not an error ([`SnapshotOutcome::SourceAbsent`]). Callers
/// at ACTIVATE / post-transaction use this so a later rollback can restore
/// both binaries and config.
pub fn snapshot_config_file(
    install_dir: &Path,
    source_config: &Path,
) -> Result<SnapshotOutcome, StateError> {
    let outcome = write_config_snapshot_bytes(install_dir, source_config)?;
    // Best-effort state annotation: a missing state file still leaves the
    // snapshot bytes for restore (restore keys off the file, not the field).
    if let SnapshotOutcome::Written { record, .. } = &outcome {
        if let Some(mut state) = load(install_dir)? {
            state.config_snapshot = Some(record.clone());
            store_atomic(install_dir, &state)?;
        }
    }
    Ok(outcome)
}

/// Snapshot the live user `config.toml` when it exists (bytes + state field).
pub fn snapshot_user_config(install_dir: &Path) -> Result<SnapshotOutcome, StateError> {
    let Some(src) = live_user_config_path() else {
        return Ok(SnapshotOutcome::SourceAbsent);
    };
    snapshot_config_file(install_dir, &src)
}

/// Restore `install_dir/config.toml.prev` over `dest` when the snapshot exists.
///
/// Absent snapshot → [`RestoreOutcome::SnapshotAbsent`] (never an error). Used
/// by `amore update --rollback` so binary restore still succeeds without one.
pub fn restore_config_snapshot_to(
    install_dir: &Path,
    dest: &Path,
) -> Result<RestoreOutcome, StateError> {
    let src = config_snapshot_path(install_dir);
    if !src.is_file() {
        return Ok(RestoreOutcome::SnapshotAbsent);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|source| StateError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let tmp = dest.with_extension("toml.restore-tmp");
    fs::copy(&src, &tmp).map_err(|source| StateError::Io {
        path: tmp.clone(),
        source,
    })?;
    if dest.exists() {
        fs::remove_file(dest).map_err(|source| StateError::Io {
            path: dest.to_path_buf(),
            source,
        })?;
    }
    fs::rename(&tmp, dest).map_err(|source| StateError::Io {
        path: dest.to_path_buf(),
        source,
    })?;
    Ok(RestoreOutcome::Restored {
        dest: dest.to_path_buf(),
    })
}

/// Restore the config snapshot over the live user `config.toml` when present.
pub fn restore_config_snapshot(install_dir: &Path) -> Result<RestoreOutcome, StateError> {
    let Some(dest) = live_user_config_path() else {
        return Ok(RestoreOutcome::SnapshotAbsent);
    };
    restore_config_snapshot_to(install_dir, &dest)
}

/// Strip a leading `v` from a tag for the version-floor field.
fn tag_to_version_floor(tag: &str) -> String {
    tag.strip_prefix('v').unwrap_or(tag).to_string()
}

fn unix_now_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_state() -> InstallState {
        let mut state = InstallState::new("v1.0.0", "stable", "2026-08-11T00:00:00Z");
        state.last_check_at = Some("2026-08-11T01:00:00Z".into());
        state.last_seen_tag = Some("v1.0.0".into());
        state.files.insert(
            "amore.exe".into(),
            FileRecord {
                sha256: "abc".into(),
                size: 41943040,
            },
        );
        state.targets.insert(
            "amore.exe".into(),
            TargetRecord {
                archive_sha256: "archive-abc".into(),
            },
        );
        state
    }

    #[test]
    fn targets_archive_digest_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let state = sample_state();
        store_atomic(dir.path(), &state).unwrap();
        let loaded = load(dir.path()).unwrap().expect("state present");
        assert_eq!(
            loaded.targets.get("amore.exe").map(|t| t.archive_sha256.as_str()),
            Some("archive-abc")
        );
        // files{} is the content hash, not the archive digest.
        assert_eq!(
            loaded.files.get("amore.exe").map(|f| f.sha256.as_str()),
            Some("abc")
        );
    }

    #[test]
    fn missing_targets_map_defaults_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        let json = r#"{
            "spec": 1,
            "tag": "v1.0.0",
            "channel": "stable",
            "installed_at": "2026-08-11T00:00:00Z",
            "version_floor": "1.0.0",
            "files": {}
        }"#;
        fs::write(&path, json).unwrap();
        let loaded = load(dir.path()).unwrap().expect("legacy shape");
        assert!(loaded.targets.is_empty());
        assert_eq!(loaded.spec, SPEC_VERSION);
    }

    #[test]
    fn atomic_write_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let state = sample_state();
        store_atomic(dir.path(), &state).unwrap();
        let loaded = load(dir.path()).unwrap().expect("state present");
        assert_eq!(loaded, state);
        assert_eq!(loaded.spec, SPEC_VERSION);
        assert_eq!(loaded.version_floor, "1.0.0");
        assert!(state_path(dir.path()).is_file());
        assert!(!dir.path().join(format!("{STATE_FILE_NAME}.tmp")).exists());
    }

    #[test]
    fn load_missing_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_none());
    }

    #[test]
    fn spec_mismatch_reads_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        let mut bad = sample_state();
        bad.spec = 99;
        fs::write(&path, serde_json::to_vec_pretty(&bad).unwrap()).unwrap();
        assert!(load(dir.path()).unwrap().is_none());
    }

    #[test]
    fn unknown_fields_tolerated_on_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        let json = r#"{
            "spec": 1,
            "tag": "v1.0.0",
            "channel": "stable",
            "installed_at": "2026-08-11T00:00:00Z",
            "version_floor": "1.0.0",
            "last_check_at": "2026-08-11T01:00:00Z",
            "last_seen_tag": "v1.0.0",
            "files": {},
            "future_extension": { "nested": true },
            "another_new_field": 42
        }"#;
        fs::write(&path, json).unwrap();
        let loaded = load(dir.path()).unwrap().expect("forward-compatible read");
        assert_eq!(loaded.tag, "v1.0.0");
        assert_eq!(loaded.version_floor, "1.0.0");
        assert_eq!(loaded.last_seen_tag.as_deref(), Some("v1.0.0"));
    }

    #[test]
    fn unwritable_dir_is_typed_error() {
        let dir = tempfile::tempdir().unwrap();
        // A file is not a writable install directory; creating a child fails.
        let not_dir = dir.path().join("not-a-directory");
        fs::write(&not_dir, b"x").unwrap();
        let err = write_probe(&not_dir).unwrap_err();
        match err {
            StateError::UnwritableInstallDir { path, .. } => {
                assert_eq!(path, not_dir);
            }
            other => panic!("expected UnwritableInstallDir, got {other}"),
        }
        // store_atomic must surface the same typed failure, not check forever.
        let err = store_atomic(&not_dir, &sample_state()).unwrap_err();
        assert!(
            matches!(err, StateError::UnwritableInstallDir { .. }),
            "got {err}"
        );
    }

    #[test]
    fn write_probe_ok_on_temp_dir() {
        let dir = tempfile::tempdir().unwrap();
        write_probe(dir.path()).unwrap();
    }

    #[test]
    fn corrupt_json_reads_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(state_path(dir.path()), b"not-json{{{").unwrap();
        assert!(load(dir.path()).unwrap().is_none());
    }

    #[test]
    fn version_floor_strips_v_prefix() {
        let s = InstallState::new("v2.1.0", "stable", "t");
        assert_eq!(s.version_floor, "2.1.0");
        let s = InstallState::new("3.0.0", "stable", "t");
        assert_eq!(s.version_floor, "3.0.0");
    }

    #[test]
    fn config_snapshot_field_defaults_none_on_legacy_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        let json = r#"{
            "spec": 1,
            "tag": "v1.0.0",
            "channel": "stable",
            "installed_at": "2026-08-11T00:00:00Z",
            "version_floor": "1.0.0",
            "files": {}
        }"#;
        fs::write(&path, json).unwrap();
        let loaded = load(dir.path()).unwrap().expect("legacy shape");
        assert!(loaded.config_snapshot.is_none());
    }

    #[test]
    fn snapshot_config_file_writes_prev_and_records_state() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("install");
        fs::create_dir_all(&install).unwrap();
        store_atomic(&install, &sample_state()).unwrap();

        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let source = home.join("config.toml");
        fs::write(&source, b"[cli]\nauto_update = true\nmarker = \"pre-activate\"\n").unwrap();

        let outcome = snapshot_config_file(&install, &source).unwrap();
        match outcome {
            SnapshotOutcome::Written { path, record } => {
                assert_eq!(path, config_snapshot_path(&install));
                assert_eq!(record.path, CONFIG_SNAPSHOT_FILE_NAME);
                assert!(!record.taken_at.is_empty());
            }
            other => panic!("expected Written, got {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(config_snapshot_path(&install)).unwrap(),
            "[cli]\nauto_update = true\nmarker = \"pre-activate\"\n"
        );
        let loaded = load(&install).unwrap().expect("state");
        assert_eq!(
            loaded
                .config_snapshot
                .as_ref()
                .map(|c| c.path.as_str()),
            Some(CONFIG_SNAPSHOT_FILE_NAME)
        );
    }

    #[test]
    fn snapshot_source_absent_is_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-config.toml");
        let outcome = snapshot_config_file(dir.path(), &missing).unwrap();
        assert_eq!(outcome, SnapshotOutcome::SourceAbsent);
        assert!(!config_snapshot_path(dir.path()).exists());
    }

    #[test]
    fn restore_config_snapshot_to_overwrites_dest() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("install");
        fs::create_dir_all(&install).unwrap();
        fs::write(
            config_snapshot_path(&install),
            b"[cli]\nauto_update = false\nmarker = \"snap\"\n",
        )
        .unwrap();

        let dest = dir.path().join("home").join("config.toml");
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, b"[cli]\nmarker = \"live-new\"\n").unwrap();

        let outcome = restore_config_snapshot_to(&install, &dest).unwrap();
        assert!(matches!(outcome, RestoreOutcome::Restored { .. }));
        assert_eq!(
            fs::read_to_string(&dest).unwrap(),
            "[cli]\nauto_update = false\nmarker = \"snap\"\n"
        );
    }

    #[test]
    fn restore_absent_snapshot_notices_not_fails() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("config.toml");
        fs::write(&dest, b"keep-me\n").unwrap();
        let outcome = restore_config_snapshot_to(dir.path(), &dest).unwrap();
        assert_eq!(outcome, RestoreOutcome::SnapshotAbsent);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "keep-me\n");
    }
}
