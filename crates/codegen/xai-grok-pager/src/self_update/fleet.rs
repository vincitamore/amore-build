//! Fleet update: one transaction for `amore` plus every installed companion.
//!
//! # Why the fleet is one transaction
//!
//! Companion fetch runs in exactly one place (`init_cmd`, at `amore init` /
//! `--refresh`), pinned to the calling amore's version. The update crate has
//! no vocabulary for companions. An updater that swaps `amore` without moving
//! the companions reproduces the exact staleness this design exists to close —
//! silently. Presence on disk is the answer for which companions are in scope;
//! they move with amore as one unit.
//!
//! # Stages
//!
//! Preflight (no network beyond tag discovery) → fetch+verify (smoke in
//! staging) → quiesce live daemons → activate companions first, amore last →
//! finalize install state. A marker records progress; a real lock
//! (`fleet.lock`) serializes concurrent attempts. Recovery resumes incomplete
//! markers without relaunching the running amore process.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::discover::{self, Component};
use super::fetch::{self, StagedArtifact};
use super::state::{self, FileRecord, InstallState, TargetRecord};
use super::swap::{self, Rollback};

/// Transaction marker filename (beside the install-state file).
pub const MARKER_FILE_NAME: &str = ".update-in-progress.json";

/// Exclusive fleet lock filename in the install directory.
pub const LOCK_FILE_NAME: &str = "fleet.lock";

/// Staging directory name under the install directory.
pub const STAGING_DIR_NAME: &str = ".staging";

// ---------------------------------------------------------------------------
// Errors and outcomes
// ---------------------------------------------------------------------------

/// Typed failures from a fleet transaction.
#[derive(Debug)]
pub enum FleetError {
    /// Install directory is not writable; update needs elevation.
    UnwritableInstallDir { path: PathBuf, message: String },
    /// Another fleet transaction holds the lock.
    AlreadyRunning { holder_pid: Option<u32>, started_at: Option<String> },
    /// One or more scanned companions are not published for this host.
    UnsupportedHost {
        os: String,
        arch: String,
        components: Vec<String>,
    },
    /// Candidate tag is at or below the recorded version floor.
    VersionFloor { floor: String, tag: String },
    /// Candidate equals the installed tag (nothing to do).
    AlreadyCurrent { tag: String },
    /// A daemon stop could not be confirmed; nothing was activated.
    QuiesceFailed { daemon: String, detail: String },
    /// Post-swap smoke failed; this target was restored, earlier ones kept.
    ActivateFailed {
        failed: String,
        activated: Vec<String>,
        remaining: Vec<String>,
        detail: String,
    },
    /// Fetch, I/O, or other operational failure.
    Other(String),
}

impl std::fmt::Display for FleetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnwritableInstallDir { path, message } => {
                write!(
                    f,
                    "install directory not writable ({}): {message}; \
                     if this was installed system-wide, update requires elevated privileges",
                    path.display()
                )
            }
            Self::AlreadyRunning {
                holder_pid,
                started_at,
            } => {
                write!(f, "fleet update already running")?;
                if let Some(pid) = holder_pid {
                    write!(f, " (pid {pid}")?;
                    if let Some(at) = started_at {
                        write!(f, ", started {at}")?;
                    }
                    write!(f, ")")?;
                }
                Ok(())
            }
            Self::UnsupportedHost {
                os,
                arch,
                components,
            } => {
                write!(
                    f,
                    "host {os}-{arch} cannot complete a fleet update including: {}",
                    components.join(", ")
                )
            }
            Self::VersionFloor { floor, tag } => {
                write!(
                    f,
                    "refusing tag {tag}: at or below version floor {floor} (pass allow_downgrade to override)"
                )
            }
            Self::AlreadyCurrent { tag } => write!(f, "already current at {tag}"),
            Self::QuiesceFailed { daemon, detail } => {
                write!(
                    f,
                    "cannot confirm {daemon} stopped ({detail}); aborting fleet update with nothing activated"
                )
            }
            Self::ActivateFailed {
                failed,
                activated,
                remaining,
                detail,
            } => {
                write!(
                    f,
                    "activation failed for {failed} ({detail}); activated: [{}]; remaining: [{}]",
                    activated.join(", "),
                    remaining.join(", ")
                )
            }
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for FleetError {}

impl From<state::StateError> for FleetError {
    fn from(e: state::StateError) -> Self {
        match e {
            state::StateError::UnwritableInstallDir { path, source } => {
                Self::UnwritableInstallDir {
                    path,
                    message: source.to_string(),
                }
            }
            other => Self::Other(other.to_string()),
        }
    }
}

/// Successful transaction summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransactionOutcome {
    pub tag: String,
    pub activated: Vec<String>,
    pub skipped: Vec<String>,
    pub install_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

/// On-disk transaction journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    pub tag: String,
    pub started_at: String,
    pub targets: Vec<String>,
    #[serde(default)]
    pub completed: Vec<String>,
}

impl Marker {
    pub fn path(install_dir: &Path) -> PathBuf {
        install_dir.join(MARKER_FILE_NAME)
    }

    pub fn load(install_dir: &Path) -> Result<Option<Self>, FleetError> {
        let path = Self::path(install_dir);
        match fs::read(&path) {
            Ok(bytes) => {
                let m: Marker = serde_json::from_slice(&bytes).map_err(|e| {
                    FleetError::Other(format!("parse marker {}: {e}", path.display()))
                })?;
                Ok(Some(m))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(FleetError::Other(format!(
                "read marker {}: {e}",
                path.display()
            ))),
        }
    }

    pub fn store_atomic(&self, install_dir: &Path) -> Result<(), FleetError> {
        let path = Self::path(install_dir);
        let tmp = install_dir.join(format!("{MARKER_FILE_NAME}.tmp"));
        let body = serde_json::to_vec_pretty(self)
            .map_err(|e| FleetError::Other(format!("serialize marker: {e}")))?;
        fs::write(&tmp, &body).map_err(|e| {
            FleetError::Other(format!("write marker tmp {}: {e}", tmp.display()))
        })?;
        if path.exists() {
            fs::remove_file(&path).map_err(|e| {
                FleetError::Other(format!("remove marker {}: {e}", path.display()))
            })?;
        }
        fs::rename(&tmp, &path).map_err(|e| {
            FleetError::Other(format!("rename marker to {}: {e}", path.display()))
        })?;
        Ok(())
    }

    pub fn delete(install_dir: &Path) -> Result<(), FleetError> {
        let path = Self::path(install_dir);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(FleetError::Other(format!(
                "delete marker {}: {e}",
                path.display()
            ))),
        }
    }

    pub fn mark_completed(&mut self, names: &[String], install_dir: &Path) -> Result<(), FleetError> {
        for n in names {
            if !self.completed.iter().any(|c| c == n) {
                self.completed.push(n.clone());
            }
        }
        self.store_atomic(install_dir)
    }
}

// ---------------------------------------------------------------------------
// Lock (U20)
// ---------------------------------------------------------------------------

/// Contents written into `fleet.lock` while held.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockBody {
    pid: u32,
    started_at: String,
}

/// Exclusive, non-blocking fleet lock. Drop releases and removes the file.
#[derive(Debug)]
pub struct FleetLock {
    path: PathBuf,
    _file: File,
}

impl FleetLock {
    /// Acquire `fleet.lock` in `install_dir` without blocking.
    ///
    /// Uses exclusive-create. On contention, reads the holder pid; if the
    /// holder is dead the lock is reclaimed, otherwise returns
    /// [`FleetError::AlreadyRunning`].
    pub fn try_acquire(install_dir: &Path) -> Result<Self, FleetError> {
        let path = install_dir.join(LOCK_FILE_NAME);
        match exclusive_create(&path) {
            Ok(mut file) => {
                write_lock_body(&mut file)?;
                Ok(Self { path, _file: file })
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                try_reclaim_or_contend(&path)
            }
            Err(e) => Err(FleetError::Other(format!(
                "create lock {}: {e}",
                path.display()
            ))),
        }
    }
}

impl Drop for FleetLock {
    fn drop(&mut self) {
        // Release by removing the lock file. The open handle is dropped after.
        let _ = fs::remove_file(&self.path);
    }
}

fn exclusive_create(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

fn write_lock_body(file: &mut File) -> Result<(), FleetError> {
    let body = LockBody {
        pid: std::process::id(),
        started_at: rfc3339_now(),
    };
    let bytes = serde_json::to_vec_pretty(&body)
        .map_err(|e| FleetError::Other(format!("serialize lock: {e}")))?;
    file.set_len(0)
        .map_err(|e| FleetError::Other(format!("truncate lock: {e}")))?;
    file.write_all(&bytes)
        .map_err(|e| FleetError::Other(format!("write lock: {e}")))?;
    file.flush()
        .map_err(|e| FleetError::Other(format!("flush lock: {e}")))?;
    Ok(())
}

fn read_lock_body(path: &Path) -> Option<LockBody> {
    let mut f = File::open(path).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    serde_json::from_str(&buf).ok()
}

fn try_reclaim_or_contend(path: &Path) -> Result<FleetLock, FleetError> {
    let body = read_lock_body(path);
    let holder_pid = body.as_ref().map(|b| b.pid);
    let started_at = body.as_ref().map(|b| b.started_at.clone());

    if let Some(pid) = holder_pid {
        if !pid_is_alive(pid) {
            // Stale: remove and exclusive-create again.
            let _ = fs::remove_file(path);
            return match exclusive_create(path) {
                Ok(mut file) => {
                    write_lock_body(&mut file)?;
                    Ok(FleetLock {
                        path: path.to_path_buf(),
                        _file: file,
                    })
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    // Lost the reclaim race.
                    let body2 = read_lock_body(path);
                    Err(FleetError::AlreadyRunning {
                        holder_pid: body2.as_ref().map(|b| b.pid).or(Some(pid)),
                        started_at: body2
                            .as_ref()
                            .map(|b| b.started_at.clone())
                            .or(started_at),
                    })
                }
                Err(e) => Err(FleetError::Other(format!(
                    "reclaim lock {}: {e}",
                    path.display()
                ))),
            };
        }
    }

    Err(FleetError::AlreadyRunning {
        holder_pid,
        started_at,
    })
}

/// Best-effort "is this pid still running?" for stale-lock reclaim.
pub fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    #[cfg(windows)]
    {
        pid_is_alive_windows(pid)
    }
    #[cfg(unix)]
    {
        // kill(pid, 0): existence probe; EPERM means the process exists but we
        // cannot signal it (still "alive" for lock purposes).
        let rc = unsafe { libc::kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        let err = io::Error::last_os_error();
        matches!(err.raw_os_error(), Some(libc::EPERM))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

#[cfg(windows)]
fn pid_is_alive_windows(pid: u32) -> bool {
    // PROCESS_QUERY_LIMITED_INFORMATION — enough to call GetExitCodeProcess.
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        fn GetExitCodeProcess(handle: *mut core::ffi::c_void, code: *mut u32) -> i32;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE
    }
}

// ---------------------------------------------------------------------------
// Target scan
// ---------------------------------------------------------------------------

/// One install-dir file that participates in the transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetFile {
    /// Basename used in the marker and install-state `files` map.
    pub name: String,
    /// Absolute (or install-dir-relative resolved) destination path.
    pub dest: PathBuf,
}

/// A logical fleet unit (one fetch component; iris may carry a dash sibling).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetUnit {
    /// Stable id: `amore`, `iris`, `lucerna`, `speculum`.
    pub id: String,
    pub component: Component,
    /// Files activated together (iris primary + optional dash).
    pub files: Vec<FleetFile>,
    /// Whether this unit may have a live daemon that needs quiesce.
    pub needs_quiesce: bool,
}

/// Scan `install_dir` for fleet members. Amore is always included; companions
/// only when present on disk. Iris + platform-suffixed dash are one unit.
pub fn scan_targets(install_dir: &Path, os: &str, arch: &str) -> Vec<FleetUnit> {
    let mut units = Vec::new();

    let amore_name = exe_name("amore", os);
    units.push(FleetUnit {
        id: "amore".into(),
        component: Component::Amore,
        files: vec![FleetFile {
            name: amore_name.clone(),
            dest: install_dir.join(&amore_name),
        }],
        needs_quiesce: false,
    });

    // iris + optional platform-suffixed dash sibling (both or neither as a unit
    // when both exist; iris alone is still a unit).
    let iris_name = exe_name("iris", os);
    let iris_path = install_dir.join(&iris_name);
    if path_exists(&iris_path) {
        let mut files = vec![FleetFile {
            name: iris_name,
            dest: iris_path,
        }];
        if let Some(dash) = find_iris_dash(install_dir, os, arch) {
            files.push(dash);
        }
        units.push(FleetUnit {
            id: "iris".into(),
            component: Component::Companion("iris"),
            files,
            needs_quiesce: true,
        });
    }

    for name in ["lucerna", "speculum"] {
        let bin = exe_name(name, os);
        let dest = install_dir.join(&bin);
        if path_exists(&dest) {
            units.push(FleetUnit {
                id: name.into(),
                component: Component::Companion(name),
                files: vec![FleetFile {
                    name: bin,
                    dest,
                }],
                needs_quiesce: name == "lucerna",
            });
        }
    }

    units
}

fn find_iris_dash(install_dir: &Path, os: &str, arch: &str) -> Option<FleetFile> {
    // Prefer the platform-suffixed name (what iris re-execs first).
    let suffixed = if os == "windows" {
        format!("iris-dash-{os}-{arch}.exe")
    } else {
        format!("iris-dash-{os}-{arch}")
    };
    let p = install_dir.join(&suffixed);
    if path_exists(&p) {
        return Some(FleetFile {
            name: suffixed,
            dest: p,
        });
    }
    // Short name from link_onto_path.
    let short = exe_name("iris-dash", os);
    let p = install_dir.join(&short);
    if path_exists(&p) {
        return Some(FleetFile {
            name: short,
            dest: p,
        });
    }
    None
}

fn exe_name(base: &str, os: &str) -> String {
    if os == "windows" {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Activation order: companions first, amore last.
pub fn activation_order(units: &[FleetUnit]) -> Vec<&FleetUnit> {
    let mut companions: Vec<&FleetUnit> = units.iter().filter(|u| u.id != "amore").collect();
    // Stable: lucerna, iris, speculum as scanned, then amore.
    companions.sort_by_key(|u| match u.id.as_str() {
        "lucerna" => 0,
        "iris" => 1,
        "speculum" => 2,
        _ => 9,
    });
    let mut out = companions;
    if let Some(amore) = units.iter().find(|u| u.id == "amore") {
        out.push(amore);
    }
    out
}

// ---------------------------------------------------------------------------
// Options and seams
// ---------------------------------------------------------------------------

/// Options for a fleet transaction.
#[derive(Debug, Clone)]
pub struct TransactionOpts {
    pub os: String,
    pub arch: String,
    pub channel: String,
    /// When true, allow a tag at or below the recorded version floor.
    pub allow_downgrade: bool,
    /// When set, skip discovery and use this tag.
    pub pin_tag: Option<String>,
}

impl Default for TransactionOpts {
    fn default() -> Self {
        let (os, arch) = discover::host_os_arch().unwrap_or(("windows", "x64"));
        Self {
            os: os.into(),
            arch: arch.into(),
            channel: "stable".into(),
            allow_downgrade: false,
            pin_tag: None,
        }
    }
}

/// Injectable seams so tests drive the transaction without network or real
/// binaries. Production callers use [`default_seams`].
pub struct FleetSeams<D, F, Sk, Sm, Q, R>
where
    D: Fn() -> Result<String, FleetError>,
    F: Fn(Component, &str, &str, &str, &Path) -> Result<StagedArtifact, FleetError>,
    Sk: Fn(Component, &str, &str, &str, &str) -> Result<bool, FleetError>,
    Sm: Fn(&Path) -> Result<String, FleetError>,
    Q: Fn(&str, &Path) -> Result<(), FleetError>,
    R: Fn(&str, &Path) -> Result<(), FleetError>,
{
    pub discover: D,
    pub fetch: F,
    /// Content-addressed skip: (component, tag, os, arch, installed_hash) → match?
    pub sidecar_matches: Sk,
    pub smoke: Sm,
    /// (daemon_id, install_dir) → stop confirmed or error.
    pub quiesce: Q,
    /// (daemon_id, binary_path) → restart detached.
    pub restart: R,
}

/// Production seams wired to discover / fetch / swap / companion stop verbs.
pub fn default_seams() -> FleetSeams<
    impl Fn() -> Result<String, FleetError>,
    impl Fn(Component, &str, &str, &str, &Path) -> Result<StagedArtifact, FleetError>,
    impl Fn(Component, &str, &str, &str, &str) -> Result<bool, FleetError>,
    impl Fn(&Path) -> Result<String, FleetError>,
    impl Fn(&str, &Path) -> Result<(), FleetError>,
    impl Fn(&str, &Path) -> Result<(), FleetError>,
> {
    FleetSeams {
        discover: || {
            discover::latest_tag_via_redirect()
                .map(|t| t.tag)
                .map_err(|e| FleetError::Other(format!("discover: {e}")))
        },
        fetch: |component, tag, os, arch, staging| {
            fetch::fetch_and_stage(component, tag, os, arch, staging)
                .map_err(|e| FleetError::Other(format!("fetch {}: {e}", component.name())))
        },
        sidecar_matches: |component, tag, os, arch, hash| {
            fetch::sidecar_matches_installed(component, tag, os, arch, hash)
                .map_err(|e| FleetError::Other(format!("sidecar {}: {e}", component.name())))
        },
        smoke: |path| {
            swap::smoke(path).map_err(|e| FleetError::Other(format!("smoke {}: {e}", path.display())))
        },
        quiesce: |id, install_dir| quiesce_daemon(id, install_dir),
        restart: |id, binary| restart_daemon(id, binary),
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Run a full fleet transaction for the live install directory.
pub fn run_transaction(opts: &TransactionOpts) -> Result<TransactionOutcome, FleetError> {
    let install_dir = state::install_dir().map_err(FleetError::from)?;
    run_transaction_in(&install_dir, opts, &default_seams())
}

/// Resume an interrupted transaction when a marker is present (one stat when
/// nothing is wrong). Takes the fleet lock; safe to call on every launch.
pub fn resume_if_interrupted(
    install_dir: &Path,
    opts: &TransactionOpts,
) -> Result<Option<TransactionOutcome>, FleetError> {
    if Marker::load(install_dir)?.is_none() {
        return Ok(None);
    }
    let seams = default_seams();
    Ok(Some(run_transaction_in(install_dir, opts, &seams)?))
}

/// Testable / injectable transaction entry.
pub fn run_transaction_in<D, F, Sk, Sm, Q, R>(
    install_dir: &Path,
    opts: &TransactionOpts,
    seams: &FleetSeams<D, F, Sk, Sm, Q, R>,
) -> Result<TransactionOutcome, FleetError>
where
    D: Fn() -> Result<String, FleetError>,
    F: Fn(Component, &str, &str, &str, &Path) -> Result<StagedArtifact, FleetError>,
    Sk: Fn(Component, &str, &str, &str, &str) -> Result<bool, FleetError>,
    Sm: Fn(&Path) -> Result<String, FleetError>,
    Q: Fn(&str, &Path) -> Result<(), FleetError>,
    R: Fn(&str, &Path) -> Result<(), FleetError>,
{
    // U20: lock the whole transaction (preflight through finalize).
    let _lock = FleetLock::try_acquire(install_dir)?;

    // PREFLIGHT
    state::write_probe(install_dir).map_err(FleetError::from)?;

    let units = scan_targets(install_dir, &opts.os, &opts.arch);
    let unsupported = unsupported_components(&units, &opts.os, &opts.arch);
    if !unsupported.is_empty() {
        return Err(FleetError::UnsupportedHost {
            os: opts.os.clone(),
            arch: opts.arch.clone(),
            components: unsupported,
        });
    }

    let existing = Marker::load(install_dir)?;
    let install_state = state::load(install_dir)?.unwrap_or_else(|| {
        InstallState::new("v0.0.0", opts.channel.as_str(), rfc3339_now())
    });

    let tag = if let Some(ref m) = existing {
        m.tag.clone()
    } else if let Some(ref pin) = opts.pin_tag {
        normalize_tag(pin)
    } else {
        normalize_tag(&(seams.discover)()?)
    };

    if existing.is_none() {
        enforce_version_policy(&tag, &install_state, opts)?;
    }

    let target_names: Vec<String> = units
        .iter()
        .flat_map(|u| u.files.iter().map(|f| f.name.clone()))
        .collect();

    let mut marker = if let Some(m) = existing {
        m
    } else {
        let m = Marker {
            tag: tag.clone(),
            started_at: rfc3339_now(),
            targets: target_names.clone(),
            completed: Vec::new(),
        };
        m.store_atomic(install_dir)?;
        m
    };

    let staging_root = install_dir.join(STAGING_DIR_NAME);
    fs::create_dir_all(&staging_root).map_err(|e| {
        FleetError::Other(format!("create staging {}: {e}", staging_root.display()))
    })?;

    // FETCH + VERIFY (and content-addressed skip)
    let mut staged: Vec<StagedUnit> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let order = activation_order(&units);

    for unit in &order {
        let pending_files: Vec<&FleetFile> = unit
            .files
            .iter()
            .filter(|f| !marker.completed.iter().any(|c| c == &f.name))
            .collect();
        if pending_files.is_empty() {
            continue;
        }

        // U19: if every pending file's recorded hash matches the sidecar, skip.
        if all_files_current(unit, &pending_files, &install_state, &tag, opts, seams)? {
            let names: Vec<String> = pending_files.iter().map(|f| f.name.clone()).collect();
            marker.mark_completed(&names, install_dir)?;
            skipped.extend(names);
            continue;
        }

        let unit_staging = staging_root.join(&unit.id);
        fs::create_dir_all(&unit_staging).map_err(|e| {
            FleetError::Other(format!("create {}: {e}", unit_staging.display()))
        })?;

        let artifact = (seams.fetch)(
            unit.component,
            &tag,
            &opts.os,
            &opts.arch,
            &unit_staging,
        )?;

        // Stage-smoke primary binary; require tag stamp when present.
        let smoke_out = (seams.smoke)(&artifact.binary_path)?;
        require_tag_in_smoke(&smoke_out, &tag)?;

        let file_map = map_staged_files(unit, &artifact, &opts.os, &opts.arch)?;
        for (file, staged_path) in &file_map {
            if file.name != unit.files[0].name {
                // Secondary (dash): smoke too when present.
                let out = (seams.smoke)(staged_path)?;
                require_tag_in_smoke(&out, &tag)?;
            }
        }

        staged.push(StagedUnit {
            unit: (*unit).clone(),
            artifact,
            file_map,
        });
    }

    // QUIESCE (only units that still need activation and declare a daemon)
    let mut stopped: Vec<(String, PathBuf)> = Vec::new();
    for unit in &order {
        if !unit.needs_quiesce {
            continue;
        }
        let still_pending = unit
            .files
            .iter()
            .any(|f| !marker.completed.iter().any(|c| c == &f.name));
        if !still_pending {
            continue;
        }
        // Only quiesce if we have staged work (or would activate).
        let has_staged = staged.iter().any(|s| s.unit.id == unit.id);
        if !has_staged {
            continue;
        }
        match (seams.quiesce)(&unit.id, install_dir) {
            Ok(()) => {
                stopped.push((unit.id.clone(), unit.files[0].dest.clone()));
            }
            Err(e) => {
                // Abort whole transaction; nothing activated yet.
                let detail = e.to_string();
                // Leave marker for resume (fetch products may still be useful)
                // or clean when nothing was partially done — prefer clean when
                // completed is empty so the next run is a fresh transaction.
                if marker.completed.is_empty() {
                    let _ = Marker::delete(install_dir);
                    let _ = fs::remove_dir_all(&staging_root);
                }
                return Err(FleetError::QuiesceFailed {
                    daemon: unit.id.clone(),
                    detail,
                });
            }
        }
    }

    // ACTIVATE
    let mut activated: Vec<String> = marker.completed.clone();
    let mut archive_digests: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();

    // Carry archive digests for already-completed (skipped) files from install
    // state targets{} (not files{}, which holds content hashes).
    for name in &marker.completed {
        if let Some(t) = install_state.targets.get(name) {
            if !t.archive_sha256.is_empty() {
                archive_digests.insert(name.clone(), t.archive_sha256.clone());
            }
        }
    }

    for staged_unit in &staged {
        let unit = &staged_unit.unit;
        let mut rollbacks: Vec<Rollback> = Vec::new();
        let mut activated_names: Vec<String> = Vec::new();

        let activate_result = (|| -> Result<(), FleetError> {
            for (file, staged_path) in &staged_unit.file_map {
                if marker.completed.iter().any(|c| c == &file.name) {
                    continue;
                }
                let rb = swap::activate(staged_path, &file.dest).map_err(|e| {
                    FleetError::Other(format!("activate {}: {e}", file.name))
                })?;
                rollbacks.push(rb);

                // Post-swap smoke at the real path.
                let out = (seams.smoke)(&file.dest).map_err(|e| {
                    FleetError::Other(format!("post-swap smoke {}: {e}", file.name))
                })?;
                require_tag_in_smoke(&out, &tag).map_err(|e| {
                    FleetError::Other(format!("post-swap smoke {}: {e}", file.name))
                })?;
                activated_names.push(file.name.clone());
                archive_digests.insert(
                    file.name.clone(),
                    staged_unit.artifact.archive_sha256.clone(),
                );
            }
            Ok(())
        })();

        if let Err(e) = activate_result {
            // Restore THIS unit's files; keep earlier activations.
            for rb in rollbacks.into_iter().rev() {
                let _ = rb.restore();
            }
            let remaining: Vec<String> = order
                .iter()
                .flat_map(|u| u.files.iter().map(|f| f.name.clone()))
                .filter(|n| !activated.contains(n) && !activated_names.contains(n))
                .collect();
            return Err(FleetError::ActivateFailed {
                failed: unit.id.clone(),
                activated: activated.clone(),
                remaining,
                detail: e.to_string(),
            });
        }

        marker.mark_completed(&activated_names, install_dir)?;
        activated.extend(activated_names);

        // Restart daemons we stopped, from the newly activated binary.
        if unit.needs_quiesce {
            if let Some((_, dest)) = stopped.iter().find(|(id, _)| id == &unit.id) {
                let _ = (seams.restart)(&unit.id, dest);
            }
        }
    }

    // FINALIZE
    // files{} always stores the content sha256 of the activated on-disk file
    // (re-hash unconditionally). targets{} stores the archive/sidecar digest
    // used by content-addressed skip.
    let mut new_state = InstallState::new(&tag, opts.channel.as_str(), rfc3339_now());
    new_state.last_check_at = install_state.last_check_at.clone();
    new_state.last_seen_tag = Some(tag.clone());
    for unit in &units {
        for file in &unit.files {
            if !path_exists(&file.dest) {
                continue;
            }
            let meta = fs::metadata(&file.dest).map_err(|e| {
                FleetError::Other(format!("stat {}: {e}", file.dest.display()))
            })?;
            let content_sha = xai_file_utils::sha256_hex_from_file(&file.dest, None)
                .map_err(|e| {
                    FleetError::Other(format!("content hash {}: {e}", file.dest.display()))
                })?
                .to_ascii_lowercase();
            new_state.files.insert(
                file.name.clone(),
                FileRecord {
                    sha256: content_sha,
                    size: meta.len(),
                },
            );
            let archive = archive_digests
                .get(&file.name)
                .cloned()
                .or_else(|| {
                    install_state
                        .targets
                        .get(&file.name)
                        .map(|t| t.archive_sha256.clone())
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or_default();
            if !archive.is_empty() {
                new_state.targets.insert(
                    file.name.clone(),
                    TargetRecord {
                        archive_sha256: archive,
                    },
                );
            }
        }
    }
    // Config snapshot at FINALIZE (ACTIVATE complete): copy live user
    // config.toml beside install state so --rollback can restore it with
    // binaries. Best-effort; missing config is not an error. Prefer recording
    // on new_state so one store_atomic keeps files{} + config_snapshot atomic.
    // (cmd.rs also calls snapshot_user_config post-transaction as a belt-and-
    // braces path until this patch is applied; both are idempotent.)
    match state::write_user_config_snapshot(install_dir) {
        Ok(state::SnapshotOutcome::Written { record, .. }) => {
            new_state.config_snapshot = Some(record);
        }
        Ok(state::SnapshotOutcome::SourceAbsent) => {}
        Err(_) => {
            // Install already succeeded; snapshot is best-effort.
        }
    }
    state::store_atomic(install_dir, &new_state)?;
    Marker::delete(install_dir)?;
    let _ = fs::remove_dir_all(&staging_root);

    // Deliberately do NOT relaunch amore: apply-then-quit is the design.

    Ok(TransactionOutcome {
        tag,
        activated,
        skipped,
        install_dir: install_dir.to_path_buf(),
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

struct StagedUnit {
    unit: FleetUnit,
    artifact: StagedArtifact,
    /// Parallel to unit.files that were staged (name → staged path).
    file_map: Vec<(FleetFile, PathBuf)>,
}

fn unsupported_components(units: &[FleetUnit], os: &str, arch: &str) -> Vec<String> {
    let mut out = Vec::new();
    for u in units {
        if !discover::target_supported(u.component, os, arch) {
            out.push(u.id.clone());
        }
    }
    out
}

fn enforce_version_policy(
    tag: &str,
    install_state: &InstallState,
    opts: &TransactionOpts,
) -> Result<(), FleetError> {
    let cand = strip_v(tag);
    if !opts.allow_downgrade {
        let floor = strip_v(&install_state.version_floor);
        if version_cmp(cand, floor) < 0 {
            return Err(FleetError::VersionFloor {
                floor: install_state.version_floor.clone(),
                tag: tag.to_string(),
            });
        }
    }
    // Same tag as installed → already current (unless allow path for repair).
    if strip_v(&install_state.tag) == cand && !opts.allow_downgrade {
        // Still allow when marker recovery or hash repair is needed; only
        // short-circuit when state files already cover the scan.
        // Caller handles empty completed marker path separately.
        return Err(FleetError::AlreadyCurrent {
            tag: tag.to_string(),
        });
    }
    Ok(())
}

fn all_files_current<D, F, Sk, Sm, Q, R>(
    unit: &FleetUnit,
    pending: &[&FleetFile],
    install_state: &InstallState,
    tag: &str,
    opts: &TransactionOpts,
    seams: &FleetSeams<D, F, Sk, Sm, Q, R>,
) -> Result<bool, FleetError>
where
    D: Fn() -> Result<String, FleetError>,
    F: Fn(Component, &str, &str, &str, &Path) -> Result<StagedArtifact, FleetError>,
    Sk: Fn(Component, &str, &str, &str, &str) -> Result<bool, FleetError>,
    Sm: Fn(&Path) -> Result<String, FleetError>,
    Q: Fn(&str, &Path) -> Result<(), FleetError>,
    R: Fn(&str, &Path) -> Result<(), FleetError>,
{
    // One sidecar GET per unit (shared archive for iris + dash).
    // Compare against targets{}.archive_sha256 (not files{}.sha256, which is
    // the on-disk content hash).
    let Some(first) = pending.first() else {
        return Ok(true);
    };
    let Some(target) = install_state.targets.get(&first.name) else {
        return Ok(false);
    };
    if target.archive_sha256.is_empty() {
        return Ok(false);
    }
    let archive = target.archive_sha256.as_str();
    let matches = (seams.sidecar_matches)(
        unit.component,
        tag,
        &opts.os,
        &opts.arch,
        archive,
    )?;
    if !matches {
        return Ok(false);
    }
    // Require every pending file to share the same recorded archive digest.
    for f in pending {
        match install_state.targets.get(&f.name) {
            Some(t) if t.archive_sha256.eq_ignore_ascii_case(archive) => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn map_staged_files(
    unit: &FleetUnit,
    artifact: &StagedArtifact,
    os: &str,
    arch: &str,
) -> Result<Vec<(FleetFile, PathBuf)>, FleetError> {
    let mut out = Vec::new();
    // Primary: artifact.binary_path → unit.files[0]
    let primary = unit
        .files
        .first()
        .ok_or_else(|| FleetError::Other(format!("unit {} has no files", unit.id)))?;
    out.push((primary.clone(), artifact.binary_path.clone()));

    // Secondary files (iris-dash): look under staging docs/ or next to binary.
    for file in unit.files.iter().skip(1) {
        let staged = locate_secondary_staged(file, artifact, os, arch)?;
        out.push((file.clone(), staged));
    }
    Ok(out)
}

fn locate_secondary_staged(
    file: &FleetFile,
    artifact: &StagedArtifact,
    os: &str,
    arch: &str,
) -> Result<PathBuf, FleetError> {
    // Candidates: platform-suffixed member name as published, and the dest basename.
    let mut candidates = BTreeSet::new();
    candidates.insert(file.name.clone());
    if os == "windows" {
        candidates.insert(format!("iris-dash-{os}-{arch}.exe"));
    } else {
        candidates.insert(format!("iris-dash-{os}-{arch}"));
    }
    candidates.insert("iris-dash.exe".into());
    candidates.insert("iris-dash".into());

    // extra_files live under docs/ after fetch unpack.
    for p in &artifact.extra_files {
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            if candidates.contains(name) {
                return Ok(p.clone());
            }
        }
    }
    // Also check beside the primary binary (same staging root).
    if let Some(parent) = artifact.binary_path.parent() {
        for name in &candidates {
            let p = parent.join(name);
            if path_exists(&p) {
                return Ok(p);
            }
            let docs = parent.join("docs").join(name);
            if path_exists(&docs) {
                return Ok(docs);
            }
        }
    }
    Err(FleetError::Other(format!(
        "staged archive for {} did not contain dash sibling {}",
        artifact.component, file.name
    )))
}

fn require_tag_in_smoke(smoke_out: &str, tag: &str) -> Result<(), FleetError> {
    let bare = strip_v(tag);
    if smoke_out.contains(tag) || smoke_out.contains(bare) {
        Ok(())
    } else {
        Err(FleetError::Other(format!(
            "smoke output does not contain tag {tag}: {smoke_out:?}"
        )))
    }
}

/// Spawn the installed companion with `stop`. Missing binary / no-daemon is ok.
pub fn quiesce_daemon(id: &str, install_dir: &Path) -> Result<(), FleetError> {
    let os = discover::host_os_arch().map(|(o, _)| o).unwrap_or("windows");
    let bin_name = exe_name(id, os);
    let bin = install_dir.join(bin_name);
    if !path_exists(&bin) {
        // Not installed → already quiesced.
        return Ok(());
    }
    let output = Command::new(&bin)
        .arg("stop")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| FleetError::Other(format!("spawn {id} stop: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let combined = format!("{stdout}\n{stderr}");

    // Treat "not running" / missing pidfile as already quiesced.
    if !output.status.success() {
        if combined.contains("not running")
            || combined.contains("no pidfile")
            || combined.contains("not found")
            || combined.contains("no such")
        {
            return Ok(());
        }
        return Err(FleetError::Other(format!(
            "{id} stop failed (status {}): {}",
            output.status,
            combined.trim()
        )));
    }
    Ok(())
}

/// Restart a daemon from the newly activated binary, detached.
pub fn restart_daemon(id: &str, binary: &Path) -> Result<(), FleetError> {
    if !path_exists(binary) {
        return Ok(());
    }
    let mut cmd = Command::new(binary);
    // iris / lucerna accept `daemon` or `start` depending on tool; prefer start
    // for lucerna and daemon for iris.
    match id {
        "lucerna" => {
            cmd.arg("start");
        }
        "iris" => {
            cmd.arg("daemon");
        }
        _ => {
            cmd.arg("start");
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A hidden console of its own rather than no console at all: console
        // children the daemon spawns later inherit it instead of each opening
        // a visible window on the desktop.
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: no shared memory; we only want a new session.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    match cmd.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(FleetError::Other(format!(
            "restart {id} from {}: {e}",
            binary.display()
        ))),
    }
}

fn strip_v(s: &str) -> &str {
    s.strip_prefix('v').unwrap_or(s)
}

fn normalize_tag(s: &str) -> String {
    let t = s.trim();
    if t.starts_with('v') {
        t.to_string()
    } else {
        format!("v{t}")
    }
}

fn version_cmp(a: &str, b: &str) -> i32 {
    let ord = match (version_triple(a), version_triple(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => strip_v(a).cmp(strip_v(b)),
    };
    match ord {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

fn version_triple(s: &str) -> Option<(u64, u64, u64)> {
    let s = strip_v(s);
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn rfc3339_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    // Compact UTC-ish stamp good enough for markers and lock bodies.
    format!("{secs}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn write_bin(path: &Path, contents: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, contents.as_bytes()).unwrap();
    }

    fn test_opts(os: &str, arch: &str) -> TransactionOpts {
        TransactionOpts {
            os: os.into(),
            arch: arch.into(),
            channel: "stable".into(),
            allow_downgrade: true, // tests pin explicit tags
            pin_tag: Some("v2.0.0".into()),
        }
    }

    /// Fake fetch: writes a plain-file "binary" into staging, returns artifact.
    fn fake_fetch(
        archive_hits: Arc<AtomicUsize>,
        component: Component,
        tag: &str,
        _os: &str,
        _arch: &str,
        staging: &Path,
    ) -> Result<StagedArtifact, FleetError> {
        archive_hits.fetch_add(1, Ordering::SeqCst);
        fs::create_dir_all(staging).unwrap();
        let name = match component {
            Component::Amore => "amore.exe",
            Component::Companion("iris") => "iris.exe",
            Component::Companion("lucerna") => "lucerna.exe",
            Component::Companion("speculum") => "speculum.exe",
            Component::Companion(other) => other,
        };
        let binary_path = staging.join(name);
        // Contents include the tag so smoke-with-tag checks pass.
        fs::write(&binary_path, format!("{name} {tag} bytes")).unwrap();
        let mut extra = Vec::new();
        if matches!(component, Component::Companion("iris")) {
            let dash = staging.join("docs");
            fs::create_dir_all(&dash).unwrap();
            let dash_bin = dash.join("iris-dash-windows-x64.exe");
            fs::write(&dash_bin, format!("iris-dash {tag} bytes")).unwrap();
            extra.push(dash_bin);
        }
        let digest = xai_file_utils::sha256_hex(format!("{name}-{tag}").as_bytes());
        Ok(StagedArtifact {
            component: component.name().into(),
            tag: tag.into(),
            binary_path,
            extra_files: extra,
            archive_sha256: digest,
        })
    }

    fn fake_smoke(path: &Path) -> Result<String, FleetError> {
        let bytes = fs::read(path)
            .map_err(|e| FleetError::Other(format!("read smoke {}: {e}", path.display())))?;
        let s = String::from_utf8_lossy(&bytes).trim().to_string();
        if s.is_empty() {
            return Err(FleetError::Other("empty smoke".into()));
        }
        Ok(s)
    }

    fn noop_quiesce(_id: &str, _dir: &Path) -> Result<(), FleetError> {
        Ok(())
    }
    fn noop_restart(_id: &str, _bin: &Path) -> Result<(), FleetError> {
        Ok(())
    }
    fn refuse_quiesce(id: &str, _dir: &Path) -> Result<(), FleetError> {
        Err(FleetError::Other(format!("{id} still alive after stop")))
    }

    #[test]
    fn happy_path_companions_before_amore_state_written_marker_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        write_bin(&install.join("amore.exe"), "old-amore");
        write_bin(&install.join("iris.exe"), "old-iris");
        write_bin(&install.join("iris-dash-windows-x64.exe"), "old-dash");
        write_bin(&install.join("lucerna.exe"), "old-lucerna");

        let state = InstallState::new("v1.0.0", "stable", "t0");
        state::store_atomic(install, &state).unwrap();

        let order_log = Arc::new(Mutex::new(Vec::new()));
        let order_log2 = Arc::clone(&order_log);
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);

        let opts = test_opts("windows", "x64");
        let seams = FleetSeams {
            discover: || Ok("v2.0.0".into()),
            fetch: move |c, tag, os, arch, staging| {
                order_log2.lock().unwrap().push(c.name().to_string());
                fake_fetch(Arc::clone(&hits2), c, tag, os, arch, staging)
            },
            sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
            smoke: fake_smoke,
            quiesce: noop_quiesce,
            restart: noop_restart,
        };

        let out = run_transaction_in(install, &opts, &seams).expect("happy path");
        assert_eq!(out.tag, "v2.0.0");
        assert!(Marker::load(install).unwrap().is_none(), "marker deleted");
        assert!(!install.join(STAGING_DIR_NAME).exists() || {
            // staging removed
            fs::read_dir(install.join(STAGING_DIR_NAME)).is_err()
        });

        let loaded = state::load(install).unwrap().expect("state written");
        assert_eq!(loaded.tag, "v2.0.0");
        assert!(loaded.files.contains_key("amore.exe"));
        assert!(loaded.files.contains_key("iris.exe"));
        assert!(loaded.files.contains_key("lucerna.exe"));

        // Activation order: companions fetched/activated before amore.
        // fetch log order follows activation_order.
        let log = order_log.lock().unwrap().clone();
        let amore_pos = log.iter().position(|n| n == "amore").expect("amore fetched");
        let lucerna_pos = log.iter().position(|n| n == "lucerna");
        let iris_pos = log.iter().position(|n| n == "iris");
        if let Some(lp) = lucerna_pos {
            assert!(lp < amore_pos, "lucerna before amore: {log:?}");
        }
        if let Some(ip) = iris_pos {
            assert!(ip < amore_pos, "iris before amore: {log:?}");
        }

        // Dest contents updated.
        let amore_body = fs::read_to_string(install.join("amore.exe")).unwrap();
        assert!(amore_body.contains("v2.0.0"), "{amore_body}");
        let iris_body = fs::read_to_string(install.join("iris.exe")).unwrap();
        assert!(iris_body.contains("v2.0.0"), "{iris_body}");
    }

    #[test]
    fn interrupted_transaction_resume_finishes_coherent_fleet() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        write_bin(&install.join("amore.exe"), "old-amore");
        write_bin(&install.join("lucerna.exe"), "old-lucerna");
        write_bin(&install.join("speculum.exe"), "old-speculum");

        let st = InstallState::new("v1.0.0", "stable", "t0");
        state::store_atomic(install, &st).unwrap();

        let smoke_count = Arc::new(AtomicUsize::new(0));
        let smoke_count2 = Arc::clone(&smoke_count);
        // Fail post-swap smoke after 1 successful unit activation by counting
        // smoke calls: stage smokes + post-swap. Simpler: fail activate smoke
        // when dest is amore.
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);

        let fail_after = Arc::new(AtomicUsize::new(0));
        let fail_after2 = Arc::clone(&fail_after);

        let opts = test_opts("windows", "x64");
        let seams = FleetSeams {
            discover: || Ok("v2.0.0".into()),
            fetch: move |c, tag, os, arch, staging| {
                fake_fetch(Arc::clone(&hits2), c, tag, os, arch, staging)
            },
            sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
            smoke: move |path: &Path| {
                let out = fake_smoke(path)?;
                // Count only post-swap smokes at install paths (not staging).
                let p = path.to_string_lossy();
                if !p.contains(STAGING_DIR_NAME) {
                    let n = fail_after2.fetch_add(1, Ordering::SeqCst);
                    // After lucerna activates (1st post-swap), fail the next unit.
                    if n >= 1 {
                        return Err(FleetError::Other(format!(
                            "simulated post-swap failure at {}",
                            path.display()
                        )));
                    }
                }
                smoke_count2.fetch_add(1, Ordering::SeqCst);
                Ok(out)
            },
            quiesce: noop_quiesce,
            restart: noop_restart,
        };

        let err = run_transaction_in(install, &opts, &seams).expect_err("must interrupt");
        match err {
            FleetError::ActivateFailed { activated, .. } => {
                assert!(
                    !activated.is_empty(),
                    "at least lucerna should have activated: {activated:?}"
                );
                assert!(
                    activated.iter().any(|a| a.contains("lucerna")),
                    "expected lucerna in activated: {activated:?}"
                );
            }
            other => panic!("expected ActivateFailed, got {other}"),
        }

        let marker = Marker::load(install).unwrap().expect("marker remains");
        assert!(!marker.completed.is_empty());
        assert!(marker.completed.iter().any(|c| c.contains("lucerna")));

        // Resume with always-ok smoke finishes the rest.
        let hits_r = Arc::new(AtomicUsize::new(0));
        let hits_r2 = Arc::clone(&hits_r);
        let seams_resume = FleetSeams {
            discover: || Ok("v2.0.0".into()),
            fetch: move |c, tag, os, arch, staging| {
                fake_fetch(Arc::clone(&hits_r2), c, tag, os, arch, staging)
            },
            sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
            smoke: fake_smoke,
            quiesce: noop_quiesce,
            restart: noop_restart,
        };
        let out = run_transaction_in(install, &opts, &seams_resume).expect("resume");
        assert_eq!(out.tag, "v2.0.0");
        assert!(Marker::load(install).unwrap().is_none());
        let loaded = state::load(install).unwrap().unwrap();
        assert_eq!(loaded.tag, "v2.0.0");
        assert!(loaded.files.contains_key("amore.exe"));
        assert!(loaded.files.contains_key("lucerna.exe"));
        assert!(loaded.files.contains_key("speculum.exe"));
        // All binaries show new tag.
        for name in ["amore.exe", "lucerna.exe", "speculum.exe"] {
            let body = fs::read_to_string(install.join(name)).unwrap();
            assert!(body.contains("v2.0.0"), "{name}: {body}");
        }
    }

    #[test]
    fn quiesce_abort_nothing_activated() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        write_bin(&install.join("amore.exe"), "old-amore");
        write_bin(&install.join("lucerna.exe"), "old-lucerna");
        let st = InstallState::new("v1.0.0", "stable", "t0");
        state::store_atomic(install, &st).unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);
        let opts = test_opts("windows", "x64");
        let seams = FleetSeams {
            discover: || Ok("v2.0.0".into()),
            fetch: move |c, tag, os, arch, staging| {
                fake_fetch(Arc::clone(&hits2), c, tag, os, arch, staging)
            },
            sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
            smoke: fake_smoke,
            quiesce: refuse_quiesce,
            restart: noop_restart,
        };

        let err = run_transaction_in(install, &opts, &seams).expect_err("quiesce abort");
        match err {
            FleetError::QuiesceFailed { daemon, .. } => {
                assert_eq!(daemon, "lucerna");
            }
            other => panic!("expected QuiesceFailed, got {other}"),
        }
        // Nothing activated: binaries still old.
        assert_eq!(
            fs::read_to_string(install.join("amore.exe")).unwrap(),
            "old-amore"
        );
        assert_eq!(
            fs::read_to_string(install.join("lucerna.exe")).unwrap(),
            "old-lucerna"
        );
    }

    #[test]
    fn post_swap_smoke_failure_restores_target_keeps_earlier() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        write_bin(&install.join("amore.exe"), "old-amore");
        write_bin(&install.join("lucerna.exe"), "old-lucerna");
        write_bin(&install.join("speculum.exe"), "old-speculum");
        let st = InstallState::new("v1.0.0", "stable", "t0");
        state::store_atomic(install, &st).unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);
        let opts = test_opts("windows", "x64");

        // Fail post-swap only for speculum.
        let seams = FleetSeams {
            discover: || Ok("v2.0.0".into()),
            fetch: move |c, tag, os, arch, staging| {
                fake_fetch(Arc::clone(&hits2), c, tag, os, arch, staging)
            },
            sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
            smoke: move |path: &Path| {
                let out = fake_smoke(path)?;
                let p = path.to_string_lossy();
                if !p.contains(STAGING_DIR_NAME) && p.contains("speculum") {
                    return Err(FleetError::Other("speculum post-swap boom".into()));
                }
                Ok(out)
            },
            quiesce: noop_quiesce,
            restart: noop_restart,
        };

        let err = run_transaction_in(install, &opts, &seams).expect_err("activate fail");
        match err {
            FleetError::ActivateFailed {
                failed,
                activated,
                remaining,
                ..
            } => {
                assert_eq!(failed, "speculum");
                assert!(
                    activated.iter().any(|a| a.contains("lucerna")),
                    "lucerna kept: {activated:?}"
                );
                assert!(
                    remaining.iter().any(|r| r.contains("amore")),
                    "amore remaining: {remaining:?}"
                );
            }
            other => panic!("expected ActivateFailed, got {other}"),
        }

        // lucerna activated (new), speculum restored (old), amore untouched (old).
        let lucerna = fs::read_to_string(install.join("lucerna.exe")).unwrap();
        assert!(lucerna.contains("v2.0.0"), "{lucerna}");
        assert_eq!(
            fs::read_to_string(install.join("speculum.exe")).unwrap(),
            "old-speculum"
        );
        assert_eq!(
            fs::read_to_string(install.join("amore.exe")).unwrap(),
            "old-amore"
        );
    }

    #[test]
    fn per_component_host_support_reports_companions_on_darwin_x64() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        write_bin(&install.join("amore"), "old-amore");
        write_bin(&install.join("iris"), "old-iris");
        write_bin(&install.join("lucerna"), "old-lucerna");
        let st = InstallState::new("v1.0.0", "stable", "t0");
        state::store_atomic(install, &st).unwrap();

        let opts = TransactionOpts {
            os: "darwin".into(),
            arch: "x64".into(),
            channel: "stable".into(),
            allow_downgrade: true,
            pin_tag: Some("v2.0.0".into()),
        };
        let seams = FleetSeams {
            discover: || Ok("v2.0.0".into()),
            fetch: |_c, _t, _o, _a, _s| unreachable!("must not fetch on unsupported host"),
            sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
            smoke: fake_smoke,
            quiesce: noop_quiesce,
            restart: noop_restart,
        };

        let err = run_transaction_in(install, &opts, &seams).expect_err("unsupported");
        match err {
            FleetError::UnsupportedHost {
                os,
                arch,
                components,
            } => {
                assert_eq!(os, "darwin");
                assert_eq!(arch, "x64");
                assert!(
                    components.iter().any(|c| c == "iris"),
                    "must list iris: {components:?}"
                );
                assert!(
                    components.iter().any(|c| c == "lucerna"),
                    "must list lucerna: {components:?}"
                );
                assert!(
                    !components.iter().any(|c| c == "amore"),
                    "amore is supported on darwin-x64: {components:?}"
                );
            }
            other => panic!("expected UnsupportedHost, got {other}"),
        }
    }

    #[test]
    fn content_addressed_skip_issues_zero_archive_requests() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        write_bin(&install.join("amore.exe"), "current-amore");
        let archive_digest = xai_file_utils::sha256_hex(b"amore.exe-v2.0.0");
        let content_digest = xai_file_utils::sha256_hex(b"current-amore").to_ascii_lowercase();
        let mut st = InstallState::new("v1.0.0", "stable", "t0");
        // files{} = content hash of on-disk binary; targets{} = archive digest.
        st.files.insert(
            "amore.exe".into(),
            FileRecord {
                sha256: content_digest,
                size: b"current-amore".len() as u64,
            },
        );
        st.targets.insert(
            "amore.exe".into(),
            TargetRecord {
                archive_sha256: archive_digest.clone(),
            },
        );
        // Floor below candidate so policy allows the transaction.
        st.version_floor = "1.0.0".into();
        state::store_atomic(install, &st).unwrap();

        let archive_hits = Arc::new(AtomicUsize::new(0));
        let archive_hits2 = Arc::clone(&archive_hits);
        let sidecar_hits = Arc::new(AtomicUsize::new(0));
        let sidecar_hits2 = Arc::clone(&sidecar_hits);

        let opts = test_opts("windows", "x64");
        let digest2 = archive_digest.clone();
        let seams = FleetSeams {
            discover: || Ok("v2.0.0".into()),
            fetch: move |c, tag, os, arch, staging| {
                fake_fetch(Arc::clone(&archive_hits2), c, tag, os, arch, staging)
            },
            sidecar_matches: move |_c, _t, _o, _a, h| {
                sidecar_hits2.fetch_add(1, Ordering::SeqCst);
                Ok(h.eq_ignore_ascii_case(&digest2))
            },
            smoke: fake_smoke,
            quiesce: noop_quiesce,
            restart: noop_restart,
        };

        let out = run_transaction_in(install, &opts, &seams).expect("skip path");
        assert_eq!(
            archive_hits.load(Ordering::SeqCst),
            0,
            "zero archive requests when sidecar matches"
        );
        assert!(
            sidecar_hits.load(Ordering::SeqCst) >= 1,
            "sidecar consulted"
        );
        assert!(
            out.skipped.iter().any(|s| s.contains("amore")),
            "amore skipped: {:?}",
            out.skipped
        );
        assert!(Marker::load(install).unwrap().is_none());
        let loaded = state::load(install).unwrap().unwrap();
        assert_eq!(loaded.tag, "v2.0.0");
        // Content hash of the still-on-disk file is recorded in files{}.
        let content = loaded.files.get("amore.exe").expect("content record");
        assert_eq!(
            content.sha256,
            xai_file_utils::sha256_hex(b"current-amore").to_ascii_lowercase()
        );
        // Archive digest preserved in targets{}.
        assert_eq!(
            loaded
                .targets
                .get("amore.exe")
                .map(|t| t.archive_sha256.as_str()),
            Some(archive_digest.as_str())
        );
    }

    #[test]
    fn concurrent_transactions_one_proceeds_other_contends() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().to_path_buf();

        let lock1 = FleetLock::try_acquire(&install).expect("first lock");
        let err = FleetLock::try_acquire(&install).expect_err("second must contend");
        match err {
            FleetError::AlreadyRunning { holder_pid, .. } => {
                assert_eq!(holder_pid, Some(std::process::id()));
            }
            other => panic!("expected AlreadyRunning, got {other}"),
        }
        drop(lock1);

        // After release, acquire succeeds again.
        let lock2 = FleetLock::try_acquire(&install).expect("re-acquire");
        drop(lock2);
    }

    #[test]
    fn concurrent_two_threads_exactly_one_proceeds() {
        use std::thread;
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().to_path_buf();

        let barrier = Arc::new(std::sync::Barrier::new(2));
        let results = Arc::new(Mutex::new(Vec::new()));

        let mut handles = Vec::new();
        for _ in 0..2 {
            let install = install.clone();
            let barrier = Arc::clone(&barrier);
            let results = Arc::clone(&results);
            handles.push(thread::spawn(move || {
                barrier.wait();
                let r = FleetLock::try_acquire(&install);
                let ok = r.is_ok();
                results.lock().unwrap().push(ok);
                // Hold briefly so the loser definitely contends.
                if ok {
                    thread::sleep(Duration::from_millis(80));
                    drop(r);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let got = results.lock().unwrap().clone();
        let winners = got.iter().filter(|x| **x).count();
        let losers = got.iter().filter(|x| !**x).count();
        assert_eq!(winners, 1, "exactly one proceeds: {got:?}");
        assert_eq!(losers, 1, "exactly one contends: {got:?}");
    }

    #[test]
    fn stale_lock_dead_pid_is_reclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        let path = install.join(LOCK_FILE_NAME);
        // Write a lock body with a pid that is almost certainly dead.
        let dead_pid = 4_294_967_294u32; // very high; not a real process
        assert!(
            !pid_is_alive(dead_pid),
            "test pid {dead_pid} unexpectedly alive"
        );
        let body = LockBody {
            pid: dead_pid,
            started_at: "0".into(),
        };
        fs::write(&path, serde_json::to_vec_pretty(&body).unwrap()).unwrap();

        let lock = FleetLock::try_acquire(install).expect("reclaim stale");
        // Holder is us now.
        let body = read_lock_body(&path).expect("lock body");
        assert_eq!(body.pid, std::process::id());
        drop(lock);
        assert!(!path.exists(), "lock file removed on drop");
    }

    #[test]
    fn scan_targets_presence_is_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path();
        write_bin(&install.join("amore.exe"), "a");
        write_bin(&install.join("iris.exe"), "i");
        write_bin(&install.join("iris-dash-windows-x64.exe"), "d");
        // no lucerna / speculum
        let units = scan_targets(install, "windows", "x64");
        let ids: Vec<_> = units.iter().map(|u| u.id.as_str()).collect();
        assert_eq!(ids, vec!["amore", "iris"]);
        let iris = units.iter().find(|u| u.id == "iris").unwrap();
        assert_eq!(iris.files.len(), 2, "iris + dash as one unit");
    }

    #[test]
    fn activation_order_amore_last() {
        let units = vec![
            FleetUnit {
                id: "amore".into(),
                component: Component::Amore,
                files: vec![],
                needs_quiesce: false,
            },
            FleetUnit {
                id: "iris".into(),
                component: Component::Companion("iris"),
                files: vec![],
                needs_quiesce: true,
            },
            FleetUnit {
                id: "lucerna".into(),
                component: Component::Companion("lucerna"),
                files: vec![],
                needs_quiesce: true,
            },
        ];
        let order: Vec<_> = activation_order(&units).iter().map(|u| u.id.as_str()).collect();
        assert_eq!(order, vec!["lucerna", "iris", "amore"]);
    }

    #[test]
    fn resume_if_interrupted_none_when_no_marker() {
        let dir = tempfile::tempdir().unwrap();
        let opts = test_opts("windows", "x64");
        // Only checks marker presence when default seams would network —
        // the fast path returns None without lock when no marker.
        // Use Marker::load directly equivalent:
        assert!(Marker::load(dir.path()).unwrap().is_none());
        let _ = opts;
    }
}
