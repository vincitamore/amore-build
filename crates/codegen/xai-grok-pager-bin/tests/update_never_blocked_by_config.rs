//! `amore update` is a recovery command: a config failure must not block it.
//!
//! After the fork apply-path re-point, plain `update` must not touch live
//! network from a test. Both runs set `AMORE_DISABLE_UPDATES=1` so the command
//! exits 2 by policy in both cases, proving a corrupt config.toml cannot
//! change the outcome or crash the policy path (option (a) from the seam brief).

use std::process::Command;

/// Resolve the pager binary like the PTY harness: `PAGER_BINARY` under
/// Bazel (runfiles-relative), else cargo's compile-time constant.
fn pager_binary() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("PAGER_BINARY") {
        return std::path::absolute(&p)
            .unwrap_or_else(|e| panic!("failed to absolutize PAGER_BINARY {p}: {e}"));
    }
    option_env!("CARGO_BIN_EXE_amore")
        .map(std::path::PathBuf::from)
        .expect("PAGER_BINARY is unset and this build is not `cargo test`")
}

/// Run `amore update` in an isolated home with the kill switch set.
fn run_update(config_toml: &str) -> std::process::Output {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("config.toml"), config_toml).unwrap();
    Command::new(pager_binary())
        .arg("update")
        .arg("--yes")
        .env_clear()
        .env("HOME", home.path())
        .env("GROK_HOME", home.path())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        // Policy path only: never reach discovery / fleet network.
        .env("AMORE_DISABLE_UPDATES", "1")
        .output()
        .expect("spawn amore update")
}

fn exit_code(out: &std::process::Output) -> i32 {
    out.status.code().unwrap_or(-1)
}

/// The valid run and the corrupt run must exit with the same policy code (2).
/// A config parse failure must not change that outcome or abort before policy.
#[test]
fn corrupt_config_never_changes_update_outcome() {
    let valid = run_update("[cli]\n");
    let corrupt = run_update("this is not toml {{{[[[");

    let valid_code = exit_code(&valid);
    let corrupt_code = exit_code(&corrupt);

    assert_eq!(
        valid_code, 2,
        "healthy config under AMORE_DISABLE_UPDATES=1 must exit 2 (policy)\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&valid.stdout),
        String::from_utf8_lossy(&valid.stderr)
    );
    assert_eq!(
        corrupt_code, valid_code,
        "a corrupt config.toml must not change the update outcome (both exit 2 by policy)\nvalid stderr:\n{}\ncorrupt stderr:\n{}",
        String::from_utf8_lossy(&valid.stderr),
        String::from_utf8_lossy(&corrupt.stderr)
    );
    // Policy notice should appear without a panic / config hard-fail.
    let valid_err = String::from_utf8_lossy(&valid.stderr);
    let corrupt_err = String::from_utf8_lossy(&corrupt.stderr);
    assert!(
        valid_err.contains("AMORE_DISABLE_UPDATES") || valid_err.contains("blocked by policy"),
        "expected policy notice on valid run, got: {valid_err}"
    );
    assert!(
        corrupt_err.contains("AMORE_DISABLE_UPDATES") || corrupt_err.contains("blocked by policy"),
        "expected policy notice on corrupt run, got: {corrupt_err}"
    );
}
