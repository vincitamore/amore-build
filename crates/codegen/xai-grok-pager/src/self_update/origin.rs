//! Single source of truth for the fork's release origin.
//!
//! Release-asset download URLs and the self-update path are built from these
//! constants. Naming the origin only here means an xAI endpoint cannot be
//! reintroduced into the updater without an explicit edit to this file.

/// GitHub `owner/repo` that publishes the fork's release assets.
pub const UPDATE_ORIGIN_REPO: &str = "vincitamore/amore-build";

/// Host that serves those release assets.
pub const UPDATE_ORIGIN_HOST: &str = "github.com";

/// Base URL for versioned release downloads (`.../releases/download`).
///
/// Callers append `/v{version}` and the asset name. Matches the historical
/// `instrument_fetch::RELEASE_BASE` literal.
pub fn release_base() -> String {
    format!(
        "https://{host}/{repo}/releases/download",
        host = UPDATE_ORIGIN_HOST,
        repo = UPDATE_ORIGIN_REPO,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_repo_is_fork() {
        assert_eq!(UPDATE_ORIGIN_REPO, "vincitamore/amore-build");
    }

    #[test]
    fn origin_host_is_github() {
        assert_eq!(UPDATE_ORIGIN_HOST, "github.com");
    }

    #[test]
    fn release_base_matches_legacy_literal() {
        assert_eq!(
            release_base(),
            "https://github.com/vincitamore/amore-build/releases/download"
        );
    }
}
