//! Integration apply-path matrix for self-update.
//!
//! Exercises real fetch / verify / activate / fleet paths against a local
//! HTTP artifact server with fault injection. Runs on every host OS; do not
//! gate this entire file with `#![cfg(unix)]` — per-assert unix cfg only.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serial_test::serial;
use tempfile::TempDir;

use xai_grok_pager::self_update::discover::{self, Component};
use xai_grok_pager::self_update::fetch::{self, StagedArtifact};
use xai_grok_pager::self_update::fleet::{
    self, FleetError, FleetSeams, Marker, STAGING_DIR_NAME, TransactionOpts,
};
use xai_grok_pager::self_update::state::{self, InstallState};
use xai_grok_pager::self_update::swap;

// ---------------------------------------------------------------------------
// Host / naming helpers
// ---------------------------------------------------------------------------

fn host_os_arch() -> (&'static str, &'static str) {
    discover::host_os_arch().expect("host OS/arch must be a published release target")
}

fn exe_name(base: &str, os: &str) -> String {
    if os == "windows" {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

// ---------------------------------------------------------------------------
// Smoke-passing real binaries (compiled once per version stamp)
// ---------------------------------------------------------------------------

/// Compile a tiny program that prints `version` on any invocation (including
/// `--version`). Cached by version string so the suite does not re-invoke
/// rustc for every case.
fn smoke_binary_bytes(version: &str) -> Vec<u8> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let guard = cache.lock().unwrap();
        if let Some(bytes) = guard.get(version) {
            return bytes.clone();
        }
    }

    let dir = tempfile::tempdir().expect("temp for rustc");
    let src = dir.path().join("smoke_bin.rs");
    // version is test-controlled; escape only for string literal safety.
    let escaped = version.replace('\\', "\\\\").replace('"', "\\\"");
    fs::write(
        &src,
        format!(
            r#"fn main() {{
    println!("{escaped}");
}}
"#
        ),
    )
    .unwrap();

    let out = if cfg!(windows) {
        dir.path().join("smoke_bin.exe")
    } else {
        dir.path().join("smoke_bin")
    };
    let status = std::process::Command::new("rustc")
        .arg("-C")
        .arg("opt-level=0")
        .arg("-o")
        .arg(&out)
        .arg(&src)
        .status()
        .expect("spawn rustc for smoke binary");
    assert!(
        status.success(),
        "rustc failed building smoke binary for {version:?}: {status}"
    );
    let bytes = fs::read(&out).expect("read compiled smoke binary");
    assert!(!bytes.is_empty(), "compiled smoke binary is empty");

    cache
        .lock()
        .unwrap()
        .insert(version.to_string(), bytes.clone());
    bytes
}

fn write_smoke_binary(path: &Path, version: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, smoke_binary_bytes(version)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).unwrap();
    }
}

// ---------------------------------------------------------------------------
// Archive builders (zip / tar.gz matching release layout)
// ---------------------------------------------------------------------------

fn build_zip(members: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in members {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(data).unwrap();
        }
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
        header.set_mode(0o755);
        header.set_cksum();
        builder.append_data(&mut header, *name, *data).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn pack_archive(os: &str, members: &[(&str, &[u8])]) -> Vec<u8> {
    if os == "windows" {
        build_zip(members)
    } else {
        build_tar_gz(members)
    }
}

fn component_archive(component: Component, os: &str, arch: &str, version: &str) -> (String, Vec<u8>) {
    let asset = fetch::archive_name(component, os, arch)
        .unwrap_or_else(|| panic!("no archive for {} on {os}-{arch}", component.name()));
    let member = fetch::binary_member_name(component, os, arch)
        .unwrap_or_else(|| panic!("no member for {} on {os}-{arch}", component.name()));
    let bin = smoke_binary_bytes(version);
    let archive = pack_archive(os, &[(member.as_str(), bin.as_slice())]);
    (asset, archive)
}

fn sha_doc_for(archive: &[u8], asset: &str) -> (String, Vec<u8>) {
    let hex = xai_file_utils::sha256_hex(archive).to_ascii_lowercase();
    let doc = format!("{hex}  {asset}\n");
    (hex, doc.into_bytes())
}

// ---------------------------------------------------------------------------
// Controllable local artifact server
// ---------------------------------------------------------------------------

/// How the server corrupts (or does not) archive body GETs.
///
/// Right-length garbage is served as a Full body whose bytes are garbage and
/// whose sidecar matches that body — not a separate server mode — so the
/// unpack layer (not the transfer layer) is what rejects it.
#[derive(Clone, Copy, Debug)]
enum Mode {
    /// Serve the configured body correctly (Range supported).
    Full,
    /// Advertise full Content-Length, send only `k` bytes, then close.
    Truncate(usize),
    /// Same as truncate after a short stall (client sees premature EOF).
    Hang(usize),
    /// Close the socket after response headers, before any body byte.
    EarlyClose,
}

struct AssetEntry {
    body: Arc<Vec<u8>>,
    /// When true, apply `mode` faults; sidecars never fault.
    is_archive: bool,
}

struct ServerState {
    /// Full request path (e.g. `/releases/download/v2.0.0/amore-….zip`) → body.
    assets: HashMap<String, AssetEntry>,
    mode: Mode,
}

struct ArtifactServer {
    addr: std::net::SocketAddr,
    state: Arc<Mutex<ServerState>>,
    shutdown: Arc<AtomicBool>,
    /// Body-serving archive GETs only (HEAD and sidecars excluded).
    archive_gets: Arc<AtomicUsize>,
    /// Number of archive GETs that carried a Range header.
    range_gets: Arc<AtomicUsize>,
}

impl ArtifactServer {
    fn start(assets: HashMap<String, AssetEntry>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            assets,
            mode: Mode::Full,
        }));
        let shutdown = Arc::new(AtomicBool::new(false));
        let archive_gets = Arc::new(AtomicUsize::new(0));
        let range_gets = Arc::new(AtomicUsize::new(0));

        let st = Arc::clone(&state);
        let sd = Arc::clone(&shutdown);
        let ag = Arc::clone(&archive_gets);
        let rg = Arc::clone(&range_gets);
        std::thread::spawn(move || {
            while !sd.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let st = Arc::clone(&st);
                        let sd = Arc::clone(&sd);
                        let ag = Arc::clone(&ag);
                        let rg = Arc::clone(&rg);
                        std::thread::spawn(move || handle_connection(stream, st, sd, ag, rg));
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            addr,
            state,
            shutdown,
            archive_gets,
            range_gets,
        }
    }

    /// `{scheme}://{addr}/releases/download` — pass as `download_root`.
    fn download_root(&self) -> String {
        format!("http://{}/releases/download", self.addr)
    }

    fn set_mode(&self, mode: Mode) {
        self.state.lock().unwrap().mode = mode;
    }

    fn archive_get_count(&self) -> usize {
        self.archive_gets.load(Ordering::Relaxed)
    }

    fn range_get_count(&self) -> usize {
        self.range_gets.load(Ordering::Relaxed)
    }
}

impl Drop for ArtifactServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

fn parse_range(request: &str) -> Option<(usize, usize)> {
    for line in request.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("range:") {
            let spec = rest.trim().strip_prefix("bytes=")?;
            let (a, b) = spec.split_once('-')?;
            let start: usize = a.trim().parse().ok()?;
            if b.trim().is_empty() {
                return Some((start, usize::MAX));
            }
            let end: usize = b.trim().parse().ok()?;
            return Some((start, end));
        }
    }
    None
}

fn handle_connection(
    mut stream: TcpStream,
    state: Arc<Mutex<ServerState>>,
    shutdown: Arc<AtomicBool>,
    archive_gets: Arc<AtomicUsize>,
    range_gets: Arc<AtomicUsize>,
) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let request = String::from_utf8_lossy(&buf).to_string();
    let first = request.lines().next().unwrap_or("");
    let is_head = first.starts_with("HEAD ");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let range = parse_range(&request);

    let (body, is_archive, mode) = {
        let st = state.lock().unwrap();
        match st.assets.get(path) {
            Some(entry) => (Arc::clone(&entry.body), entry.is_archive, st.mode),
            None => {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                return;
            }
        }
    };

    if is_archive && !is_head {
        archive_gets.fetch_add(1, Ordering::Relaxed);
        if range.is_some() {
            range_gets.fetch_add(1, Ordering::Relaxed);
        }
    }

    let total = body.len();
    let (slice_start, slice_end_excl) = match range {
        Some((a, b)) if b == usize::MAX => (a.min(total), total),
        Some((a, b)) => (a.min(total), (b + 1).min(total)),
        None => (0, total),
    };
    let claimed_len = slice_end_excl.saturating_sub(slice_start);

    // Fault injection applies only to archive bodies.
    let effective_mode = if is_archive { mode } else { Mode::Full };

    if matches!(effective_mode, Mode::EarlyClose) && !is_head {
        let mut head = String::new();
        head.push_str("HTTP/1.1 200 OK\r\n");
        head.push_str(&format!("Content-Length: {claimed_len}\r\n"));
        head.push_str("Accept-Ranges: bytes\r\n");
        head.push_str("Connection: close\r\n\r\n");
        let _ = stream.write_all(head.as_bytes());
        // No body — premature close with advertised length.
        return;
    }

    let send_end = match effective_mode {
        Mode::Truncate(k) | Mode::Hang(k) => slice_end_excl.min(k).max(slice_start),
        _ => slice_end_excl,
    };

    let payload: Vec<u8> = body[slice_start..send_end].to_vec();

    let mut head = String::new();
    if range.is_some() && !is_head {
        head.push_str("HTTP/1.1 206 Partial Content\r\n");
        head.push_str(&format!(
            "Content-Range: bytes {}-{}/{}\r\n",
            slice_start,
            slice_end_excl.saturating_sub(1),
            total
        ));
    } else {
        head.push_str("HTTP/1.1 200 OK\r\n");
        head.push_str("Accept-Ranges: bytes\r\n");
    }
    head.push_str(&format!("Content-Length: {claimed_len}\r\n"));
    head.push_str("Connection: close\r\n\r\n");

    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    if is_head {
        let _ = stream.flush();
        return;
    }

    match effective_mode {
        Mode::Hang(_) => {
            let _ = stream.write_all(&payload);
            let _ = stream.flush();
            // Short stall then drop — premature EOF without waiting on the
            // client's 120s request timeout.
            for _ in 0..15 {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        Mode::Full | Mode::Truncate(_) => {
            let _ = stream.write_all(&payload);
        }
        Mode::EarlyClose => unreachable!(),
    }
    let _ = stream.flush();
}

/// Build a server serving `tag` archives (+ matching sidecars) for each
/// component at the given version under Full-mode-ready bodies.
fn server_for_components(
    tag: &str,
    os: &str,
    arch: &str,
    components: &[Component],
    version: &str,
) -> (ArtifactServer, HashMap<String, String>) {
    let mut assets = HashMap::new();
    let mut digests = HashMap::new();
    for &component in components {
        let (asset, archive) = component_archive(component, os, arch, version);
        let (hex, sha_doc) = sha_doc_for(&archive, &asset);
        digests.insert(component.name().to_string(), hex);
        let archive_path = format!("/releases/download/{tag}/{asset}");
        let sha_path = format!("/releases/download/{tag}/{asset}.sha256");
        assets.insert(
            archive_path,
            AssetEntry {
                body: Arc::new(archive),
                is_archive: true,
            },
        );
        assets.insert(
            sha_path,
            AssetEntry {
                body: Arc::new(sha_doc),
                is_archive: false,
            },
        );
    }
    (ArtifactServer::start(assets), digests)
}

fn server_single_archive(
    tag: &str,
    asset: &str,
    archive: Vec<u8>,
    sha_doc: Vec<u8>,
) -> ArtifactServer {
    let mut assets = HashMap::new();
    assets.insert(
        format!("/releases/download/{tag}/{asset}"),
        AssetEntry {
            body: Arc::new(archive),
            is_archive: true,
        },
    );
    assets.insert(
        format!("/releases/download/{tag}/{asset}.sha256"),
        AssetEntry {
            body: Arc::new(sha_doc),
            is_archive: false,
        },
    );
    ArtifactServer::start(assets)
}

// ---------------------------------------------------------------------------
// Apply helpers + invariant
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expect {
    NewBinary,
    PreviousGood,
}

/// Compose fetch → stage-smoke → activate → post-swap smoke (with restore on
/// post-swap failure). This is the real apply path under test, not a mock.
fn attempt_apply(
    download_root: &str,
    tag: &str,
    os: &str,
    arch: &str,
    staging: &Path,
    dest: &Path,
) -> Result<StagedArtifact, String> {
    let _ = fs::remove_dir_all(staging);
    fs::create_dir_all(staging).map_err(|e| e.to_string())?;

    let artifact = fetch::fetch_and_stage_at(
        download_root,
        Component::Amore,
        tag,
        os,
        arch,
        staging,
    )
    .map_err(|e| format!("fetch: {e:#}"))?;

    swap::smoke(&artifact.binary_path).map_err(|e| format!("stage smoke: {e:#}"))?;

    let rollback = swap::activate(&artifact.binary_path, dest)
        .map_err(|e| format!("activate: {e:#}"))?;

    match swap::smoke(dest) {
        Ok(_) => Ok(artifact),
        Err(e) => {
            let _ = rollback.restore();
            Err(format!("post-swap smoke: {e:#}"))
        }
    }
}

/// Dest is a smoke-passing binary that is either the new or previous-good
/// content — never a partial, and no `.part`/tmp file sits at an active name.
fn assert_dest_invariant(dest: &Path, prev_bytes: &[u8], new_bytes: &[u8], expect: Expect) {
    assert!(
        dest.exists(),
        "dest must exist after apply attempt: {}",
        dest.display()
    );

    let name = dest.file_name().unwrap().to_string_lossy();
    assert!(
        !name.contains(".part") && !name.contains(".tmp") && !name.contains(".prev"),
        "active dest name must not be a temp/part/prev path: {name}"
    );

    // A `.part` / `.tmp` suffix must never be the live dest path (checked
    // above via `name`). Leftover partials belong under staging only.

    let live = fs::read(dest).expect("read dest");
    assert!(
        !live.is_empty(),
        "dest must not be empty/partial: {}",
        dest.display()
    );

    // Real smoke from disk — re-exec, never trust a harness-held flag.
    let smoke_out = swap::smoke(dest).unwrap_or_else(|e| {
        panic!(
            "active dest must pass smoke; {} failed: {e:#}",
            dest.display()
        )
    });
    assert!(
        !smoke_out.trim().is_empty(),
        "smoke stdout must be non-empty"
    );

    match expect {
        Expect::NewBinary => {
            assert_eq!(
                live, new_bytes,
                "expected newly activated binary bytes at dest"
            );
            assert!(
                smoke_out.contains("v2.0.0") || smoke_out.contains("2.0.0"),
                "new binary smoke should report new version, got {smoke_out:?}"
            );
        }
        Expect::PreviousGood => {
            assert_eq!(
                live, prev_bytes,
                "expected previous-good binary to remain at dest"
            );
        }
    }
}

fn assert_no_active_part_names(install_dir: &Path) {
    if !install_dir.exists() {
        return;
    }
    for entry in fs::read_dir(install_dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        // Staging leftovers are fine under .staging; active names at install
        // root must not end in .part.
        if name.ends_with(".part") {
            panic!("install dir has active-name .part file: {name}");
        }
    }
}

// ---------------------------------------------------------------------------
// 1. Corruption matrix
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn corruption_matrix_dest_is_new_or_previous_never_partial() {
    let (os, arch) = host_os_arch();
    let tag = "v2.0.0";
    let tmp = TempDir::new().unwrap();
    let install = tmp.path().join("install");
    let staging = tmp.path().join("staging");
    fs::create_dir_all(&install).unwrap();

    let dest = install.join(exe_name("amore", os));
    let prev_bytes = smoke_binary_bytes("v1.0.0");
    let new_bytes = smoke_binary_bytes("v2.0.0");
    write_smoke_binary(&dest, "v1.0.0");
    // Confirm previous-good really smokes before the matrix.
    swap::smoke(&dest).expect("seed previous-good must smoke");

    let (asset, good_archive) = component_archive(Component::Amore, os, arch, "v2.0.0");
    let (_good_hex, good_sha) = sha_doc_for(&good_archive, &asset);

    // Garbage body of the same length, with a matching (garbage) sidecar so
    // the transfer "succeeds" and the unpack/smoke layer must reject.
    let mut garbage = vec![0x5Au8; good_archive.len()];
    garbage[..4].copy_from_slice(b"GARB");
    let (_g_hex, garbage_sha) = sha_doc_for(&garbage, &asset);

    // Each case: (mode, expect, body, sidecar). Right-length garbage is
    // served under Full so the body matches its sidecar; unpack then fails.
    let cases: Vec<(Mode, Expect, Vec<u8>, Vec<u8>)> = vec![
        (
            Mode::Full,
            Expect::NewBinary,
            good_archive.clone(),
            good_sha.clone(),
        ),
        (
            Mode::Truncate(0),
            Expect::PreviousGood,
            good_archive.clone(),
            good_sha.clone(),
        ),
        (
            Mode::Truncate(good_archive.len() / 2),
            Expect::PreviousGood,
            good_archive.clone(),
            good_sha.clone(),
        ),
        (
            Mode::Truncate(good_archive.len().saturating_sub(1)),
            Expect::PreviousGood,
            good_archive.clone(),
            good_sha.clone(),
        ),
        (
            Mode::EarlyClose,
            Expect::PreviousGood,
            good_archive.clone(),
            good_sha.clone(),
        ),
        (
            Mode::Hang(good_archive.len() / 3),
            Expect::PreviousGood,
            good_archive.clone(),
            good_sha.clone(),
        ),
        (
            Mode::Full,
            Expect::PreviousGood,
            garbage.clone(),
            garbage_sha.clone(),
        ),
        // Clean serve after faults must still land the new binary.
        (
            Mode::Full,
            Expect::NewBinary,
            good_archive.clone(),
            good_sha.clone(),
        ),
    ];

    for (mode, expect, archive_body, sha_body) in cases {
        // Reset dest to previous-good so every case is independent.
        write_smoke_binary(&dest, "v1.0.0");

        let server = server_single_archive(tag, &asset, archive_body, sha_body);
        server.set_mode(mode);

        let result = attempt_apply(&server.download_root(), tag, os, arch, &staging, &dest);

        match expect {
            Expect::NewBinary => {
                assert!(
                    result.is_ok(),
                    "mode {mode:?} should install cleanly: {result:?}"
                );
            }
            Expect::PreviousGood => {
                assert!(
                    result.is_err(),
                    "mode {mode:?} must not install successfully: {result:?}"
                );
            }
        }

        assert_dest_invariant(&dest, &prev_bytes, &new_bytes, expect);
        assert_no_active_part_names(&install);
    }
}

// ---------------------------------------------------------------------------
// 2. Digest mismatch => refusal
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn digest_mismatch_refuses_clears_staged_leaves_dest() {
    let (os, arch) = host_os_arch();
    let tag = "v2.0.0";
    let tmp = TempDir::new().unwrap();
    let install = tmp.path().join("install");
    let staging = tmp.path().join("staging");
    fs::create_dir_all(&install).unwrap();
    fs::create_dir_all(&staging).unwrap();

    let dest = install.join(exe_name("amore", os));
    write_smoke_binary(&dest, "v1.0.0");
    let prev_bytes = fs::read(&dest).unwrap();

    let (asset, archive) = component_archive(Component::Amore, os, arch, "v2.0.0");
    let bad_sha = format!("{}\n", "0".repeat(64));
    let server = server_single_archive(tag, &asset, archive, bad_sha.into_bytes());

    let err = fetch::fetch_and_stage_at(
        &server.download_root(),
        Component::Amore,
        tag,
        os,
        arch,
        &staging,
    )
    .expect_err("digest mismatch must refuse");
    let msg = format!("{err:#}");
    assert!(
        msg.to_ascii_lowercase().contains("checksum")
            || msg.to_ascii_lowercase().contains("mismatch"),
        "expected checksum mismatch error, got: {msg}"
    );

    // Staged bytes gone.
    let part = staging.join(format!("{asset}.part"));
    let final_archive = staging.join(&asset);
    assert!(!part.exists(), "partial must be deleted on mismatch");
    assert!(
        !final_archive.exists(),
        "final archive must not remain after mismatch"
    );

    // Dest untouched.
    assert_eq!(fs::read(&dest).unwrap(), prev_bytes);
    swap::smoke(&dest).expect("previous-good still smokes");
    assert_no_active_part_names(&install);
}

// ---------------------------------------------------------------------------
// 3. Interrupted transaction resumes
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn interrupted_transaction_resumes_to_coherent_fleet() {
    let (os, arch) = host_os_arch();
    let tag = "v2.0.0";
    let tmp = TempDir::new().unwrap();
    let install = tmp.path();

    // Seed a multi-target fleet: companions first in activation order.
    for base in ["amore", "lucerna", "speculum"] {
        write_smoke_binary(&install.join(exe_name(base, os)), "v1.0.0");
    }
    let st = InstallState::new("v1.0.0", "stable", "t0");
    state::store_atomic(install, &st).unwrap();

    let components = [
        Component::Amore,
        Component::Companion("lucerna"),
        Component::Companion("speculum"),
    ];
    let (server, _digests) = server_for_components(tag, os, arch, &components, "v2.0.0");
    let root = server.download_root();

    let opts = TransactionOpts {
        os: os.into(),
        arch: arch.into(),
        channel: "stable".into(),
        allow_downgrade: true,
        pin_tag: Some(tag.into()),
    };

    let root_fetch = root.clone();
    let fail_after = Arc::new(AtomicUsize::new(0));
    let fail_after2 = Arc::clone(&fail_after);

    let seams = FleetSeams {
        discover: || Ok(tag.to_string()),
        fetch: move |c, t, o, a, staging| {
            fetch::fetch_and_stage_at(&root_fetch, c, t, o, a, staging)
                .map_err(|e| FleetError::Other(format!("fetch {}: {e:#}", c.name())))
        },
        sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
        smoke: move |path: &Path| {
            let out = swap::smoke(path).map_err(|e| {
                FleetError::Other(format!("smoke {}: {e:#}", path.display()))
            })?;
            let p = path.to_string_lossy();
            // Fail the first post-swap smoke after one unit has fully
            // activated (lucerna), so the marker records progress.
            if !p.contains(STAGING_DIR_NAME) {
                let n = fail_after2.fetch_add(1, Ordering::SeqCst);
                if n >= 1 {
                    return Err(FleetError::Other(format!(
                        "simulated post-swap failure at {}",
                        path.display()
                    )));
                }
            }
            Ok(out)
        },
        quiesce: |_id, _dir| Ok(()),
        restart: |_id, _bin| Ok(()),
    };

    let err = fleet::run_transaction_in(install, &opts, &seams).expect_err("must interrupt");
    match err {
        FleetError::ActivateFailed { activated, .. } => {
            assert!(
                !activated.is_empty(),
                "at least one target should have activated: {activated:?}"
            );
        }
        other => panic!("expected ActivateFailed, got {other}"),
    }

    let marker = Marker::load(install).unwrap().expect("marker remains for resume");
    assert!(
        !marker.completed.is_empty(),
        "marker must record completed targets for resume"
    );

    // Resume with always-ok smoke finishes the rest via real fetch again.
    let root_resume = root.clone();
    let seams_resume = FleetSeams {
        discover: || Ok(tag.to_string()),
        fetch: move |c, t, o, a, staging| {
            fetch::fetch_and_stage_at(&root_resume, c, t, o, a, staging)
                .map_err(|e| FleetError::Other(format!("fetch {}: {e:#}", c.name())))
        },
        sidecar_matches: |_c, _t, _o, _a, _h| Ok(false),
        smoke: |path: &Path| {
            swap::smoke(path)
                .map_err(|e| FleetError::Other(format!("smoke {}: {e:#}", path.display())))
        },
        quiesce: |_id, _dir| Ok(()),
        restart: |_id, _bin| Ok(()),
    };

    let out = fleet::run_transaction_in(install, &opts, &seams_resume).expect("resume completes");
    assert_eq!(out.tag, tag);
    assert!(
        Marker::load(install).unwrap().is_none(),
        "marker deleted after successful finalize"
    );

    let loaded = state::load(install).unwrap().expect("install state written");
    assert_eq!(loaded.tag, tag);

    for base in ["amore", "lucerna", "speculum"] {
        let path = install.join(exe_name(base, os));
        let ver = swap::smoke(&path).unwrap_or_else(|e| panic!("{base} smoke: {e:#}"));
        assert!(
            ver.contains("v2.0.0") || ver.contains("2.0.0"),
            "{base} must be on new version after resume, got {ver:?}"
        );
        assert!(
            loaded.files.contains_key(&exe_name(base, os)),
            "state files{{}} missing {}",
            exe_name(base, os)
        );
    }
    assert_no_active_part_names(install);
}

// ---------------------------------------------------------------------------
// 4. Range-resume completes with verified digest
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn range_resume_completes_with_verified_digest() {
    let (os, arch) = host_os_arch();
    let tag = "v2.0.0";
    let tmp = TempDir::new().unwrap();
    let staging = tmp.path().join("staging");
    fs::create_dir_all(&staging).unwrap();

    let (asset, archive) = component_archive(Component::Amore, os, arch, "v2.0.0");
    let (expected_hex, sha_doc) = sha_doc_for(&archive, &asset);
    assert!(
        archive.len() > 64,
        "archive must be large enough to partial-resume"
    );

    let server = server_single_archive(tag, &asset, archive.clone(), sha_doc);
    // Full mode answers Range with 206.
    server.set_mode(Mode::Full);

    // Pre-seed a partial first half so fetch issues Range: bytes=N-.
    let part_path = staging.join(format!("{asset}.part"));
    let half = archive.len() / 2;
    fs::write(&part_path, &archive[..half]).unwrap();
    assert_eq!(
        fetch::resume_offset(half as u64, archive.len() as u64),
        Some(half as u64)
    );

    let artifact = fetch::fetch_and_stage_at(
        &server.download_root(),
        Component::Amore,
        tag,
        os,
        arch,
        &staging,
    )
    .expect("range-resume fetch must succeed");

    assert_eq!(
        artifact.archive_sha256.to_ascii_lowercase(),
        expected_hex,
        "final digest must match sidecar after resume"
    );
    assert!(
        artifact.binary_path.exists(),
        "binary must unpack after resumed download"
    );
    swap::smoke(&artifact.binary_path).expect("resumed artifact must smoke in staging");

    // At least one Range GET should have been issued for the remainder.
    assert!(
        server.range_get_count() >= 1,
        "expected a Range request on resume; archive_gets={}, range_gets={}",
        server.archive_get_count(),
        server.range_get_count()
    );

    // No leftover .part after successful verify+rename.
    assert!(
        !part_path.exists(),
        "partial must be renamed away after verify"
    );
}

// ---------------------------------------------------------------------------
// 5. Unix-only: activated binary keeps executable bit
// ---------------------------------------------------------------------------

#[cfg(unix)]
#[test]
#[serial]
fn activated_binary_keeps_executable_bit() {
    use std::os::unix::fs::PermissionsExt as _;

    let (os, arch) = host_os_arch();
    let tag = "v2.0.0";
    let tmp = TempDir::new().unwrap();
    let install = tmp.path().join("install");
    let staging = tmp.path().join("staging");
    fs::create_dir_all(&install).unwrap();

    let dest = install.join(exe_name("amore", os));
    write_smoke_binary(&dest, "v1.0.0");

    let (asset, archive) = component_archive(Component::Amore, os, arch, "v2.0.0");
    let (_hex, sha_doc) = sha_doc_for(&archive, &asset);
    let server = server_single_archive(tag, &asset, archive, sha_doc);

    attempt_apply(&server.download_root(), tag, os, arch, &staging, &dest)
        .expect("clean apply should succeed");

    let mode = fs::metadata(&dest).unwrap().permissions().mode();
    assert_ne!(
        mode & 0o111,
        0,
        "activated binary must keep executable bits, mode={mode:#o}"
    );
    swap::smoke(&dest).expect("executable activated binary must smoke");
}

// ---------------------------------------------------------------------------
// Happy-path smoke that the local server + real bytes compose end-to-end
// (documents Full mode once without the matrix loop).
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn full_apply_path_swaps_smoke_passing_binary() {
    let (os, arch) = host_os_arch();
    let tag = "v2.0.0";
    let tmp = TempDir::new().unwrap();
    let install = tmp.path().join("install");
    let staging = tmp.path().join("staging");
    fs::create_dir_all(&install).unwrap();

    let dest = install.join(exe_name("amore", os));
    write_smoke_binary(&dest, "v1.0.0");
    let prev = fs::read(&dest).unwrap();
    let new_bytes = smoke_binary_bytes("v2.0.0");

    let (asset, archive) = component_archive(Component::Amore, os, arch, "v2.0.0");
    let (_hex, sha_doc) = sha_doc_for(&archive, &asset);
    let server = server_single_archive(tag, &asset, archive, sha_doc);

    attempt_apply(&server.download_root(), tag, os, arch, &staging, &dest)
        .expect("full apply");
    assert_dest_invariant(&dest, &prev, &new_bytes, Expect::NewBinary);
    assert_no_active_part_names(&install);
}
