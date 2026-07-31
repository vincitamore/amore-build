//! Fork-local changelog, compiled in.
//!
//! Upstream fetched per-version changelogs from the x.ai CDN
//! (`x.ai/cli/changelogs/<version>.external.{md,json}`) with a disk cache
//! under `$GROK_HOME`. A permanent fork must not display upstream's release
//! notes as its own (nor phone the CDN at all), so both formats are baked
//! into the binary from `assets/arcus-changelog.{md,json}`.
//!
//! **Fork doctrine**: every user-visible fork change updates those two
//! assets in the same commit as the change itself — the welcome screen
//! shows the first three JSON entries, `/release-notes` renders the
//! markdown.

/// A single structured changelog entry.
///
/// All fields use `#[serde(default)]` so a single malformed entry doesn't
/// kill the entire array parse. Entries with an empty description are
/// filtered out by `bullets_from_entries`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ChangelogEntry {
    /// Category label (e.g. "features", "fixes", "breaking", "performance").
    #[serde(default)]
    pub category: String,
    /// Human-readable description (may contain `**bold**` or backticks).
    #[serde(default)]
    pub description: String,
    /// Whether this entry represents a breaking change.
    #[serde(default)]
    pub breaking_change: bool,
}

/// Both formats of the changelog.
pub struct Changelog {
    /// Rendered markdown (for `/release-notes` display).
    pub markdown: Option<String>,
    /// Structured entries (for welcome screen bullets).
    pub entries: Option<Vec<ChangelogEntry>>,
}

const CHANGELOG_MD: &str = include_str!("../../assets/arcus-changelog.md");
const CHANGELOG_JSON: &str = include_str!("../../assets/arcus-changelog.json");

/// Kept as a struct with the upstream construction shape
/// (`ChangelogManager::new().fetch()`) so call sites carry no fork diff.
pub struct ChangelogManager;

impl Default for ChangelogManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ChangelogManager {
    pub fn new() -> Self {
        Self
    }

    /// Return the compiled-in fork changelog (both formats, no I/O).
    pub fn fetch(&self) -> Changelog {
        let entries = match serde_json::from_str::<Vec<ChangelogEntry>>(CHANGELOG_JSON) {
            Ok(entries) => Some(entries),
            Err(e) => {
                tracing::warn!(error = %e, "baked changelog JSON failed to parse");
                None
            }
        };
        Changelog {
            markdown: Some(CHANGELOG_MD.to_string()),
            entries,
        }
    }
}

/// Strip `**bold**` markers and backticks from a description string.
fn strip_markdown_inline(s: &str) -> String {
    s.replace("**", "").replace('`', "")
}

/// Convert changelog entries to plain-text bullet strings.
///
/// Strips `**bold**` and backtick formatting from each description,
/// skips entries with empty descriptions (from tolerant deserialization),
/// and returns at most `max` entries.
pub fn bullets_from_entries(entries: &[ChangelogEntry], max: usize) -> Vec<String> {
    entries
        .iter()
        .filter(|e| !e.description.is_empty())
        .take(max)
        .map(|e| strip_markdown_inline(&e.description))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baked_changelog_parses_and_fills_welcome_bullets() {
        let changelog = ChangelogManager::new().fetch();
        assert!(
            changelog
                .markdown
                .as_deref()
                .is_some_and(|m| m.contains("Arcus")),
            "baked markdown must be present and ours"
        );
        let entries = changelog.entries.expect("baked JSON must parse");
        assert!(!entries.is_empty());
        assert!(
            entries.iter().all(|e| !e.description.is_empty()),
            "every baked entry needs a description — empty ones are dropped \
             from the welcome screen silently"
        );
        let bullets = bullets_from_entries(&entries, 3);
        assert!(!bullets.is_empty() && bullets.len() <= 3);
        assert!(
            bullets.iter().all(|b| !b.contains("**") && !b.contains('`')),
            "welcome bullets render plain text"
        );
    }

    #[test]
    fn bullets_strips_markdown_and_respects_max() {
        let entries = vec![
            ChangelogEntry {
                category: "features".into(),
                description: "Added **dark mode** support".into(),
                breaking_change: false,
            },
            ChangelogEntry {
                category: "fixes".into(),
                description: "Fixed `crash` on startup".into(),
                breaking_change: false,
            },
            ChangelogEntry {
                category: "performance".into(),
                description: "Faster **rendering** of `code` blocks".into(),
                breaking_change: false,
            },
        ];

        let bullets = bullets_from_entries(&entries, 2);
        assert_eq!(bullets.len(), 2);
        assert_eq!(bullets[0], "Added dark mode support");
        assert_eq!(bullets[1], "Fixed crash on startup");
    }

    #[test]
    fn bullets_skips_empty_descriptions() {
        let entries = vec![
            ChangelogEntry {
                category: "features".into(),
                description: "Good entry".into(),
                breaking_change: false,
            },
            ChangelogEntry {
                category: String::new(),
                description: String::new(), // bad entry from tolerant deser
                breaking_change: false,
            },
            ChangelogEntry {
                category: "fixes".into(),
                description: "Another good one".into(),
                breaking_change: false,
            },
        ];
        let bullets = bullets_from_entries(&entries, 10);
        assert_eq!(bullets, vec!["Good entry", "Another good one"]);
    }

    #[test]
    fn tolerant_deserialization_partial_entry() {
        // Missing description field → defaults to empty string, not a parse error
        let json = r#"[{"category":"features"},{"description":"ok"}]"#;
        let entries: Vec<ChangelogEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].description, "");
        assert_eq!(entries[1].category, "");
        assert_eq!(entries[1].description, "ok");
    }
}
