use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-env-changed=GROK_VERSION");

    // House cooperation-harness templates (embedded via include_dir in house_embed).
    // Walk once so any file change under templates/house invalidates the binary.
    let house = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../templates/house");
    println!("cargo:rerun-if-changed={}", house.display());
    if house.is_dir() {
        mark_rerun_recursive(&house);
    }

    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let version = std::env::var("GROK_VERSION")
        .or_else(|_| std::env::var("CARGO_PKG_VERSION"))
        .unwrap_or_else(|_| "0.0.0".to_string());

    println!(
        "cargo:rustc-env=VERSION_WITH_COMMIT={} ({})",
        version, commit
    );
}

fn mark_rerun_recursive(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_dir() {
            mark_rerun_recursive(&path);
        }
    }
}
