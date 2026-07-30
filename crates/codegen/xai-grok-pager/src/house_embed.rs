//! Build-time embed of `templates/house/**` for offline `init`.
//!
//! Source of truth remains the in-repo tree under `templates/house/`. Sibling
//! content units own that tree; this module only ships whatever is present at
//! compile time. Empty directories are not embedded (include_dir only carries
//! files); `init` creates parent dirs as needed when writing.

use include_dir::{Dir, DirEntry, include_dir};

/// Compiled-in cooperation-harness template tree (`templates/house/**`).
pub static HOUSE_TEMPLATE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../../templates/house");

/// One file from the embedded house pack (or a test fixture pack).
#[derive(Debug, Clone)]
pub struct HouseEntry {
    /// Path relative to the install root, forward-slash normalized.
    pub rel_path: String,
    /// File bytes.
    pub contents: Vec<u8>,
}

/// Flatten an `include_dir::Dir` into path/content pairs.
pub fn dir_to_entries(dir: &Dir<'_>) -> Vec<HouseEntry> {
    let mut out = Vec::new();
    collect_dir(dir, &mut out);
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

/// Entries from the compiled-in `templates/house` pack.
pub fn embedded_house_entries() -> Vec<HouseEntry> {
    dir_to_entries(&HOUSE_TEMPLATE)
}

fn collect_dir(dir: &Dir<'_>, out: &mut Vec<HouseEntry>) {
    for entry in dir.entries() {
        match entry {
            DirEntry::Dir(sub) => collect_dir(sub, out),
            DirEntry::File(file) => {
                let rel = normalize_rel(file.path());
                if rel.is_empty() {
                    continue;
                }
                out.push(HouseEntry {
                    rel_path: rel,
                    contents: file.contents().to_vec(),
                });
            }
        }
    }
}

fn normalize_rel(path: &std::path::Path) -> String {
    path.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_house_is_non_empty() {
        let entries = embedded_house_entries();
        assert!(
            !entries.is_empty(),
            "templates/house must embed at least one file"
        );
        assert!(
            entries.iter().any(|e| e.rel_path == "AGENTS.md"),
            "AGENTS.md must be present in the house pack"
        );
    }

    #[test]
    fn paths_are_forward_slash_normalized() {
        for e in embedded_house_entries() {
            assert!(
                !e.rel_path.contains('\\'),
                "path must not use backslash: {}",
                e.rel_path
            );
            assert!(
                !e.rel_path.starts_with('/'),
                "path must be relative: {}",
                e.rel_path
            );
        }
    }
}
