//! Atomic binary activation: rename-never-delete, `dest` never left missing.
//!
//! Mechanical primitive only. No version policy, config, network, or install-state
//! writes. The caller supplies plain paths; composition with fetch/staging lives
//! elsewhere.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

/// Handle to the displaced previous binary; restoring it is the rollback.
#[derive(Debug)]
pub struct Rollback {
    /// Where the previous binary now sits (`<dest>.prev` or a unique sibling).
    pub prev_path: PathBuf,
    /// The active destination it can be restored to.
    pub dest: PathBuf,
}

/// Atomically activate `staged` at `dest`, displacing any existing binary
/// to a sibling `.prev`. Either `dest` is the staged binary and a Rollback
/// is returned, or `dest` is untouched and an Err is returned. `dest` is
/// NEVER left missing or partial.
pub fn activate(staged: &Path, dest: &Path) -> Result<Rollback> {
    activate_with(staged, dest, place_staged)
}

/// Core activation with an injectable placement step (tests inject mid-flight
/// failures after displacement without needing OS-level locks).
fn activate_with(
    staged: &Path,
    dest: &Path,
    place: impl FnOnce(&Path, &Path) -> Result<()>,
) -> Result<Rollback> {
    if !path_exists(staged) {
        bail!("staged binary does not exist: {}", staged.display());
    }
    if dest.file_name().is_none() {
        bail!("destination has no filename: {}", dest.display());
    }

    // Rename survives a lock everywhere we ship: Windows permits renaming an
    // executing file (directory entry moves, file object stays); Linux refuses
    // open(O_WRONLY) on a running binary but permits rename(2) over it.
    // MOVEFILE_DELAY_UNTIL_REBOOT must not be used.
    let displaced = if path_exists(dest) {
        Some(displace_dest(dest).with_context(|| {
            format!("displacing existing binary at {}", dest.display())
        })?)
    } else {
        None
    };

    match place(staged, dest) {
        Ok(()) => {
            // Unix: staged files from an unpack may lack the executable bit.
            #[cfg(unix)]
            ensure_executable(dest).with_context(|| {
                format!("setting executable bit on {}", dest.display())
            })?;

            let prev_path = displaced.unwrap_or_else(|| prev_path_for(dest));
            Ok(Rollback {
                prev_path,
                dest: dest.to_path_buf(),
            })
        }
        Err(e) => {
            // On ANY failure after dest was displaced, restore dest before
            // returning the error — the invariant is dest never missing.
            if let Some(ref prev) = displaced {
                if let Err(restore_err) = fs::rename(prev, dest) {
                    return Err(e).context(format!(
                        "activation failed; also failed to restore {} from {}: {restore_err}",
                        dest.display(),
                        prev.display()
                    ));
                }
            }
            Err(e).context(format!(
                "failed to place staged binary at {}",
                dest.display()
            ))
        }
    }
}

impl Rollback {
    /// Restore the previous binary to `dest` (used when a post-swap smoke
    /// fails, and by a later unit's `--rollback`).
    pub fn restore(self) -> Result<()> {
        let Rollback { prev_path, dest } = self;

        if !path_exists(&prev_path) {
            // Fresh activation had no previous binary: restore means absence.
            if path_exists(&dest) {
                // Safe to remove here: dest is the just-activated (failed) binary,
                // not a still-mapped previous image. macOS risk applies to the
                // displaced previous file, which does not exist in this branch.
                fs::remove_file(&dest).with_context(|| {
                    format!("removing activated binary at {} during restore", dest.display())
                })?;
            }
            return Ok(());
        }

        // Never leave dest missing: displace the current dest aside first, then
        // rename prev into place; on failure, put dest back from the aside.
        let aside = if path_exists(&dest) {
            let aside = unique_sibling(&dest, "restore-aside");
            fs::rename(&dest, &aside).with_context(|| {
                format!(
                    "moving current {} aside before restore",
                    dest.display()
                )
            })?;
            Some(aside)
        } else {
            None
        };

        match fs::rename(&prev_path, &dest) {
            Ok(()) => {
                // macOS: never delete the old backing file. The kernel re-verifies
                // code signatures of mmap'd executable pages; deleting a running
                // binary's backing file can SIGKILL the process. Leave the aside
                // on disk; cleanup is a later launch's problem, never activation's.
                let _ = aside;
                Ok(())
            }
            Err(e) => {
                if let Some(ref a) = aside {
                    if let Err(restore_err) = fs::rename(a, &dest) {
                        return Err(e).context(format!(
                            "restore of {} from {} failed; also failed to put dest back from {}: {restore_err}",
                            dest.display(),
                            prev_path.display(),
                            a.display()
                        ));
                    }
                }
                Err(e).context(format!(
                    "restoring previous binary from {} to {}",
                    prev_path.display(),
                    dest.display()
                ))
            }
        }
    }
}

/// Run-and-print smoke: spawn `binary --version`, require exit 0 AND
/// non-empty stdout, return the trimmed stdout. A binary that exits 0
/// printing nothing FAILS (a loader error can print to stderr and exit 0).
pub fn smoke(binary: &Path) -> Result<String> {
    let mut cmd = Command::new(binary);
    cmd.arg("--version");
    smoke_with(&mut cmd)
}

/// Injectable smoke entry point so tests can fake exit codes and I/O shapes
/// without a real per-platform binary.
fn smoke_with(cmd: &mut Command) -> Result<String> {
    let output = cmd
        .output()
        .with_context(|| "failed to spawn smoke command")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "smoke check failed with status {}{}",
            output.status,
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr.trim())
            }
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        bail!("smoke check produced empty stdout (exit 0 is not enough)");
    }
    Ok(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// `<dest>.prev` — e.g. `foo.exe` -> `foo.exe.prev`.
fn prev_path_for(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".prev");
    PathBuf::from(name)
}

/// Unique sibling `dest.prev-<n>` for Windows locked-aside diversion.
fn prev_path_numbered(dest: &Path, n: u32) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(format!(".prev-{n}"));
    PathBuf::from(name)
}

/// Unique temp sibling next to `base` for same-directory atomic rename.
fn unique_sibling(base: &Path, tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut name = base
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(format!(
        ".{}-{}-{tag}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    base.with_file_name(name)
}

/// ERROR_NOT_SAME_DEVICE (17) on Windows; EXDEV (18) on Unix.
fn is_cross_device(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(17) | Some(18))
}

/// ERROR_ACCESS_DENIED (5) / ERROR_SHARING_VIOLATION (32) on Windows.
#[cfg(windows)]
fn is_sharing_or_access(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(5) | Some(32))
}

/// Displace `dest` to `<dest>.prev` (or a unique sibling when the preferred
/// name cannot be used). Returns the path the previous binary now occupies.
fn displace_dest(dest: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        displace_dest_windows(dest)
    }
    #[cfg(unix)]
    {
        // Unix activate: dest -> dest.prev via rename (replacing any stale
        // .prev). rename(2) over an existing file unlinks the old inode; that
        // is intentional replacement of a stale previous, not deletion of the
        // binary currently mapped at dest (which moves to .prev and stays).
        let prev = prev_path_for(dest);
        fs::rename(dest, &prev).with_context(|| {
            format!(
                "renaming {} -> {} (displace)",
                dest.display(),
                prev.display()
            )
        })?;
        Ok(prev)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let prev = prev_path_for(dest);
        fs::rename(dest, &prev)?;
        Ok(prev)
    }
}

/// Windows activate: rename dest -> dest.prev; on ERROR_SHARING_VIOLATION /
/// ERROR_ACCESS_DENIED fall back to dest.prev-<n>, 3 attempts with short
/// backoff. Stale .prev that cannot be replaced forces a unique sibling.
#[cfg(windows)]
fn displace_dest_windows(dest: &Path) -> Result<PathBuf> {
    use std::thread;
    use std::time::Duration;

    let preferred = prev_path_for(dest);

    // Prefer the stable .prev name. If a stale .prev exists, try to remove it
    // so rename can land there; if remove fails (still locked by an older
    // session), fall through to unique siblings. Never use
    // MOVEFILE_DELAY_UNTIL_REBOOT.
    if path_exists(&preferred) {
        let _ = fs::remove_file(&preferred);
    }

    match fs::rename(dest, &preferred) {
        Ok(()) => return Ok(preferred),
        Err(e) if is_sharing_or_access(&e) || path_exists(&preferred) => {
            // Fall through to numbered siblings with backoff.
            let first_err = e;
            for n in 1..=3u32 {
                let candidate = prev_path_numbered(dest, n);
                if path_exists(&candidate) {
                    let _ = fs::remove_file(&candidate);
                }
                match fs::rename(dest, &candidate) {
                    Ok(()) => return Ok(candidate),
                    Err(e2) if is_sharing_or_access(&e2) || path_exists(&candidate) => {
                        if n < 3 {
                            thread::sleep(Duration::from_millis(40 * u64::from(n)));
                            continue;
                        }
                        return Err(e2).context(format!(
                            "cannot displace locked executable {} after 3 attempts (first error: {first_err})",
                            dest.display()
                        ));
                    }
                    Err(e2) => {
                        return Err(e2).context(format!(
                            "renaming {} -> {}",
                            dest.display(),
                            candidate.display()
                        ));
                    }
                }
            }
            Err(first_err).context(format!(
                "cannot displace locked executable {}",
                dest.display()
            ))
        }
        Err(e) => Err(e).context(format!(
            "renaming {} -> {}",
            dest.display(),
            preferred.display()
        )),
    }
}

/// Move `staged` onto `dest`. Final activation is always an atomic
/// same-directory rename; if staged and dest are on different volumes
/// (rename fails EXDEV / ERROR_NOT_SAME_DEVICE), copy to a temp sibling of
/// dest then rename into place.
fn place_staged(staged: &Path, dest: &Path) -> Result<()> {
    match fs::rename(staged, dest) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => place_staged_cross_device(staged, dest),
        // Windows: rename also fails when dest somehow still exists, or when
        // staged is locked. Surface clearly.
        Err(e) => Err(e).context(format!(
            "renaming staged {} -> {}",
            staged.display(),
            dest.display()
        )),
    }
}

fn place_staged_cross_device(staged: &Path, dest: &Path) -> Result<()> {
    let tmp = unique_sibling(dest, "activate-tmp");
    fs::copy(staged, &tmp).with_context(|| {
        format!(
            "copying staged {} -> {} (cross-device)",
            staged.display(),
            tmp.display()
        )
    })?;
    #[cfg(unix)]
    ensure_executable(&tmp)?;
    match fs::rename(&tmp, dest) {
        Ok(()) => {
            // Best-effort cleanup of the original staged file on the other volume.
            let _ = fs::remove_file(staged);
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e).context(format!(
                "renaming cross-device temp {} -> {}",
                tmp.display(),
                dest.display()
            ))
        }
    }
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let meta = fs::metadata(path)?;
    let mut perms = meta.permissions();
    // Preserve existing mode bits; ensure owner/group/other execute so a
    // staged unpack (often 0644) becomes runnable after activation.
    perms.set_mode(perms.mode() | 0o111);
    fs::set_permissions(path, perms)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
    }

    fn read_file(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn activate_fresh_dest() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tool");
        let staged = dir.path().join("staged");
        write_file(&staged, "new-binary");

        let rb = activate(&staged, &dest).unwrap();
        assert_eq!(read_file(&dest), "new-binary");
        assert!(!path_exists(&staged), "staged should be consumed by rename");
        assert_eq!(rb.dest, dest);
        // No previous binary; .prev path is reserved but absent.
        assert!(!path_exists(&rb.prev_path));
    }

    #[test]
    fn activate_over_existing() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tool");
        let staged = dir.path().join("staged");
        write_file(&dest, "old-binary");
        write_file(&staged, "new-binary");

        let rb = activate(&staged, &dest).unwrap();
        assert_eq!(read_file(&dest), "new-binary");
        assert_eq!(read_file(&rb.prev_path), "old-binary");
        assert!(
            rb.prev_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".prev"),
            "prev_path should be a .prev sibling: {}",
            rb.prev_path.display()
        );
    }

    #[test]
    fn activate_failure_midway_leaves_dest_present() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tool");
        let staged = dir.path().join("staged");
        write_file(&dest, "original");
        write_file(&staged, "new-binary");

        // Simulate: staged path missing after displacement.
        let result = activate_with(&staged, &dest, |staged, _dest| {
            let _ = fs::remove_file(staged);
            if !path_exists(staged) {
                bail!("staged binary does not exist: {}", staged.display());
            }
            Ok(())
        });

        assert!(result.is_err(), "activation must fail: {result:?}");
        assert!(
            path_exists(&dest),
            "dest must be present after failed activation"
        );
        assert_eq!(
            read_file(&dest),
            "original",
            "dest must be restored to original bytes"
        );
    }

    #[test]
    fn restore_brings_previous_bytes_back() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tool");
        let staged = dir.path().join("staged");
        write_file(&dest, "version-one");
        write_file(&staged, "version-two");

        let rb = activate(&staged, &dest).unwrap();
        assert_eq!(read_file(&dest), "version-two");

        rb.restore().unwrap();
        assert_eq!(read_file(&dest), "version-one");
    }

    #[test]
    fn stale_prev_is_replaced_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tool");
        let staged = dir.path().join("staged");
        let stale_prev = prev_path_for(&dest);

        write_file(&dest, "current");
        write_file(&stale_prev, "ancient-stale");
        write_file(&staged, "fresh");

        let rb = activate(&staged, &dest).unwrap();
        assert_eq!(read_file(&dest), "fresh");
        // Previous current binary is now at prev_path; stale content is gone
        // from the stable .prev name (replaced) or left only if divert forced.
        assert_eq!(read_file(&rb.prev_path), "current");
        if rb.prev_path == stale_prev {
            assert_ne!(
                read_file(&stale_prev),
                "ancient-stale",
                "stale .prev content must be replaced when landing on the stable name"
            );
        }
    }

    #[test]
    fn smoke_exit_zero_with_stdout_ok() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "echo", "1.2.3"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "echo 1.2.3"]);
            c
        };
        let out = smoke_with(&mut cmd).unwrap();
        assert_eq!(out, "1.2.3");
    }

    #[test]
    fn smoke_exit_zero_empty_stdout_err() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        let err = smoke_with(&mut cmd).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("empty stdout"),
            "expected empty-stdout error, got: {msg}"
        );
    }

    #[test]
    fn smoke_nonzero_exit_err() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit", "1"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "exit 1"]);
            c
        };
        let err = smoke_with(&mut cmd).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("smoke check failed"),
            "expected nonzero-exit error, got: {msg}"
        );
    }

    #[test]
    fn smoke_spawn_failure_err() {
        let mut cmd = Command::new("definitely-not-a-real-binary-xyzzy-u17-swap");
        cmd.arg("--version");
        let err = smoke_with(&mut cmd).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("failed to spawn") || msg.contains("os error"),
            "expected spawn failure, got: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_executable_bit_preserved_on_activated_binary() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tool");
        let staged = dir.path().join("staged");
        write_file(&staged, "#!/bin/sh\necho hi\n");
        // Unpack-like mode: readable but not executable.
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o644)).unwrap();

        activate(&staged, &dest).unwrap();

        let mode = fs::metadata(&dest).unwrap().permissions().mode();
        assert_ne!(mode & 0o111, 0, "activated binary must be executable, mode={mode:#o}");
    }

    #[test]
    fn restore_fresh_activation_removes_dest() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tool");
        let staged = dir.path().join("staged");
        write_file(&staged, "only");

        let rb = activate(&staged, &dest).unwrap();
        assert!(path_exists(&dest));
        rb.restore().unwrap();
        assert!(
            !path_exists(&dest),
            "restore of a fresh activation should remove dest"
        );
    }
}
