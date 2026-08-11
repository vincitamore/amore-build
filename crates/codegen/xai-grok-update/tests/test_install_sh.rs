//! Blitz harness for the bash installer (`scripts/install.sh`), the second
//! client that can brick a machine. Runs the REAL shipped repo-root installer
//! against a fake `curl` that serves a release archive plus its `.sha256`
//! sidecar (good, truncated, or right-length garbage), and asserts:
//!
//! > After any install attempt, `$AMORE_INSTALL_DIR/amore` resolves to a
//! > binary that runs and prints a version, OR is still the previous-good
//! > binary — never a partial/garbage binary left active.
//!
//! Contract under test (repo-root `scripts/install.sh`):
//! - downloads `amore-{os}-{arch}.tar.gz` then the `.sha256` sidecar
//! - hard-exits on digest mismatch (before touching the install dir)
//! - extracts the archive, installs `amore` (not a bare executable download)
//! - moves any prior binary to `amore.prev` and restores it if smoke fails
//! - smoke requires run-and-print (`--version` exits 0 with non-empty stdout)
//!
//! The installer path must resolve under cargo from this crate; a missing
//! script is a hard failure (not a skip).

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolve the shipped installer. `CARGO_MANIFEST_DIR` is
/// `crates/codegen/xai-grok-update`; three parents reach the repo root.
fn install_sh_path() -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/install.sh");
    let path = dunce::canonicalize(&path).unwrap_or_else(|e| {
        panic!(
            "scripts/install.sh must resolve relative to the crate (looked for {}): {e}",
            path.display()
        );
    });
    assert!(
        path.is_file(),
        "scripts/install.sh must exist at {}",
        path.display()
    );
    path
}

/// Host triple as named by `scripts/install.sh` (`linux`/`darwin` + `x64`/`arm64`).
fn host_artifact() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "arm64"
    };
    format!("amore-{os}-{arch}")
}

/// New good binary: must print a version line (installer's smoke gate).
const GOOD_SCRIPT: &str = "#!/bin/sh\necho 'amore 0.2.0-test'\n";
/// Previous-good binary left in place before a corrupt attempt.
const PREV_SCRIPT: &str = "#!/bin/sh\necho 'amore 0.1.0-prev'\n";

fn hash_file(path: &Path) -> String {
    for (bin, extra) in [("sha256sum", &[][..]), ("shasum", &["-a", "256"][..])] {
        let mut cmd = Command::new(bin);
        for a in extra {
            cmd.arg(a);
        }
        if let Ok(out) = cmd.arg(path).output() {
            if out.status.success() {
                let line = String::from_utf8_lossy(&out.stdout);
                return line
                    .split_whitespace()
                    .next()
                    .expect("hash output")
                    .to_string();
            }
        }
    }
    panic!("neither sha256sum nor shasum produced a digest for {}", path.display());
}

fn write_tar_gz_with_amore(archive: &Path, script_body: &str) {
    let parent = archive.parent().unwrap();
    let staging = parent.join(format!(
        "staging-{}",
        archive.file_stem().unwrap().to_string_lossy()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).unwrap();
    let bin_path = staging.join("amore");
    std::fs::write(&bin_path, script_body).unwrap();
    std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let status = Command::new("tar")
        .arg("-czf")
        .arg(archive)
        .arg("-C")
        .arg(&staging)
        .arg("amore")
        .status()
        .expect("spawn tar");
    assert!(status.success(), "tar -czf {} failed", archive.display());
    let _ = std::fs::remove_dir_all(&staging);
}

/// Write a fake `curl` plus pre-built good archive/sidecar under `dir`.
/// `$FAKE_MODE` (full|truncate|garbage) selects the corruption on the archive
/// body; the sidecar always carries the good archive's digest so corrupt
/// bodies fail the installer's hard sha256 check before the install dir is
/// touched.
fn write_fake_curl(dir: &Path, artifact: &str) {
    let artifacts = dir.join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();

    let archive = artifacts.join(format!("{artifact}.tar.gz"));
    write_tar_gz_with_amore(&archive, GOOD_SCRIPT);
    let hash = hash_file(&archive);
    let sidecar = artifacts.join(format!("{artifact}.tar.gz.sha256"));
    std::fs::write(&sidecar, format!("{hash}  {artifact}.tar.gz\n")).unwrap();
    let fullsize = std::fs::metadata(&archive).unwrap().len();

    let body = format!(
        r#"#!/bin/bash
set -e
mode="${{FAKE_MODE:-full}}"
artifacts="{artifacts}"
artifact="{artifact}"
fullsize={fullsize}
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -fsSL|-f|-s|-S|-L) ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
if [ -z "$out" ]; then
  echo "fake curl: expected -o <path>" >&2
  exit 1
fi
case "$url" in
  *.sha256)
    cat "$artifacts/${{artifact}}.tar.gz.sha256" > "$out"
    ;;
  *.tar.gz|*.zip)
    case "$mode" in
      full)
        cp "$artifacts/${{artifact}}.tar.gz" "$out"
        ;;
      truncate)
        printf '\0\0\0\0' > "$out"
        ;;
      garbage)
        head -c "$fullsize" /dev/zero | tr '\0' 'X' > "$out"
        ;;
      *)
        echo "fake curl: unknown FAKE_MODE=$mode" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "fake curl: unexpected url=$url" >&2
    exit 1
    ;;
esac
exit 0
"#,
        artifacts = artifacts.display(),
        artifact = artifact,
        fullsize = fullsize,
    );
    let path = dir.join("curl");
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Seed a valid previous-good `amore` in the isolated install dir.
fn seed_previous_good(install_dir: &Path) {
    std::fs::create_dir_all(install_dir).unwrap();
    let bin = install_dir.join("amore");
    std::fs::write(&bin, PREV_SCRIPT).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Re-resolve `$AMORE_INSTALL_DIR/amore` from disk and re-run it: the active
/// binary must always execute and print a version (installer's own smoke gate).
fn assert_active_amore_runs(install_dir: &Path) {
    let bin = install_dir.join("amore");
    assert!(
        bin.is_file(),
        "amore must exist as a file at {}",
        bin.display()
    );
    let name = bin.file_name().unwrap().to_string_lossy();
    assert!(
        !name.contains(".tmp"),
        "active amore must not be a temp file: {name}"
    );
    let output = Command::new(&bin)
        .arg("--version")
        .output()
        .unwrap_or_else(|e| panic!("spawn active amore: {e}"));
    assert!(
        output.status.success(),
        "active amore must exit 0: {}",
        bin.display()
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.trim().is_empty(),
        "active amore must print a version: {}",
        bin.display()
    );
}

fn active_version(install_dir: &Path) -> String {
    let output = Command::new(install_dir.join("amore"))
        .arg("--version")
        .output()
        .expect("spawn amore --version");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn run_installer(
    install_sh: &Path,
    home: &Path,
    install_dir: &Path,
    fakebin: &Path,
    mode: &str,
) -> bool {
    let path_env = format!("{}:/usr/bin:/bin", fakebin.display());
    let status = Command::new("/bin/bash")
        .arg(install_sh)
        .env_clear()
        .env("HOME", home)
        .env("PATH", path_env)
        .env("AMORE_INSTALL_DIR", install_dir)
        // Pin version so the download URL is deterministic for the fake curl.
        .env("AMORE_VERSION", "v0.0.0-test")
        .env("FAKE_MODE", mode)
        .status()
        .expect("spawn bash install.sh");
    status.success()
}

#[test]
fn install_sh_blitz_keeps_amore_runnable_under_corruption() {
    let install_sh = install_sh_path();
    let artifact = host_artifact();
    let fakedir = tempfile::tempdir().unwrap();
    write_fake_curl(fakedir.path(), &artifact);

    // Each entry: (mode, should the installer succeed?). Loop a few rounds so a
    // re-install over an existing good install is also exercised.
    let cases = [
        ("full", true),
        ("truncate", false),
        ("garbage", false),
        ("full", true),
        ("truncate", false),
        ("garbage", false),
        ("full", true),
    ];

    for (mode, expect_ok) in cases {
        let home = tempfile::tempdir().unwrap();
        let install_dir = home.path().join(".local").join("bin");
        seed_previous_good(&install_dir);

        let ok = run_installer(
            &install_sh,
            home.path(),
            &install_dir,
            fakedir.path(),
            mode,
        );
        assert_eq!(
            ok, expect_ok,
            "install.sh mode={mode} exit success mismatch"
        );

        // The invariant holds regardless of which path was taken: the active
        // amore always runs (new good binary on success, previous-good on
        // rejection at the digest check).
        assert_active_amore_runs(&install_dir);

        let ver = active_version(&install_dir);
        if expect_ok {
            assert!(
                ver.contains("0.2.0-test"),
                "successful install should leave the new binary, got {ver:?}"
            );
        } else {
            assert!(
                ver.contains("0.1.0-prev"),
                "failed install must preserve previous-good, got {ver:?}"
            );
        }
    }
}

/// Digest passes but the extracted binary fails the run-and-print smoke gate.
/// Installer must restore `amore.prev`.
#[test]
fn install_sh_restores_prev_when_smoke_fails() {
    let install_sh = install_sh_path();
    let artifact = host_artifact();
    let fakedir = tempfile::tempdir().unwrap();
    let artifacts = fakedir.path().join("artifacts");
    std::fs::create_dir_all(&artifacts).unwrap();

    // Silent-exit binary: extract succeeds, `--version` prints nothing → smoke fails.
    let archive = artifacts.join(format!("{artifact}.tar.gz"));
    write_tar_gz_with_amore(&archive, "#!/bin/sh\nexit 0\n");
    let hash = hash_file(&archive);
    std::fs::write(
        artifacts.join(format!("{artifact}.tar.gz.sha256")),
        format!("{hash}  {artifact}.tar.gz\n"),
    )
    .unwrap();

    let body = format!(
        r#"#!/bin/bash
set -e
artifacts="{artifacts}"
artifact="{artifact}"
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -fsSL|-f|-s|-S|-L) ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
case "$url" in
  *.sha256) cat "$artifacts/${{artifact}}.tar.gz.sha256" > "$out" ;;
  *.tar.gz|*.zip) cp "$artifacts/${{artifact}}.tar.gz" "$out" ;;
  *) echo "fake curl: unexpected url=$url" >&2; exit 1 ;;
esac
exit 0
"#,
        artifacts = artifacts.display(),
        artifact = artifact,
    );
    let curl = fakedir.path().join("curl");
    std::fs::write(&curl, body).unwrap();
    std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).unwrap();

    let home = tempfile::tempdir().unwrap();
    let install_dir = home.path().join(".local").join("bin");
    seed_previous_good(&install_dir);

    let ok = run_installer(
        &install_sh,
        home.path(),
        &install_dir,
        fakedir.path(),
        "full",
    );
    assert!(!ok, "silent binary must fail the run-and-print smoke gate");
    assert_active_amore_runs(&install_dir);
    let ver = active_version(&install_dir);
    assert!(
        ver.contains("0.1.0-prev"),
        "smoke failure must restore amore.prev, got {ver:?}"
    );
}
