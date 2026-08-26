//! Release-tag ordering for the fleet updater.
//!
//! Delegates to [`xai_grok_version`] so the leader plane and the updater share
//! one `(major, minor, patch, hotfix)` key. A release tag is
//! `vMAJOR.MINOR.PATCH`, optionally followed by `-hotfix.N`:
//!
//! ```text
//! 1.0.8  <  1.0.8-hotfix.1  <  1.0.8-hotfix.2  <  1.0.9
//! ```
//!
//! Any other suffix (`-rc.1`, `+build`) is ignored for ordering, so a tag
//! without a hotfix counter compares as its bare triple. Every comparison the
//! updater makes (update check, `amore update`, the fleet transaction) goes
//! through this module so the three agree on what "newer" means.

pub(crate) use xai_grok_version::{is_newer, strip_v, version_cmp, version_key};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_numeric_triples() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.9.9", "1.0.0"));
        assert!(is_newer("v2.0.0", "1.9.9"));
        assert!(is_newer("1.10.0", "1.9.0"));
        assert_eq!(version_cmp("v1.0.6", "1.0.6"), 0);
    }

    #[test]
    fn hotfix_sorts_after_its_pin_and_before_the_next_patch() {
        assert!(is_newer("1.0.6-hotfix.1", "1.0.6"));
        assert!(is_newer("v1.0.6-hotfix.2", "v1.0.6-hotfix.1"));
        assert!(is_newer("1.0.7", "1.0.6-hotfix.9"));
        assert!(!is_newer("1.0.6", "1.0.6-hotfix.1"));
        assert!(!is_newer("1.0.6-hotfix.1", "1.0.6-hotfix.1"));
        assert_eq!(version_key("1.0.6-hotfix.3"), Some((1, 0, 6, 3)));
        assert_eq!(version_key("1.0.6-hotfix-3"), Some((1, 0, 6, 3)));
        assert_eq!(version_key("1.0.6-hotfix3+build.7"), Some((1, 0, 6, 3)));
    }

    #[test]
    fn one_oh_eight_hotfix_orders_between_pin_and_next_patch() {
        assert!(is_newer("1.0.8-hotfix.1", "1.0.8"));
        assert!(is_newer("1.0.9", "1.0.8-hotfix.1"));
        assert!(!is_newer("1.0.8", "1.0.8-hotfix.1"));
        assert_eq!(version_cmp("1.0.8", "1.0.8-hotfix.1"), -1);
        assert_eq!(version_cmp("1.0.8-hotfix.1", "1.0.9"), -1);
        assert_eq!(version_key("1.0.8-hotfix.1"), Some((1, 0, 8, 1)));
    }

    #[test]
    fn other_suffixes_do_not_order() {
        assert_eq!(version_key("1.0.6-rc.1"), Some((1, 0, 6, 0)));
        assert_eq!(version_key("1.0.6+build.5"), Some((1, 0, 6, 0)));
        assert_eq!(version_key("1.0.6-hotfix"), Some((1, 0, 6, 0)));
        assert_eq!(version_cmp("1.0.6-rc.1", "1.0.6"), 0);
    }

    #[test]
    fn short_and_unparseable_tokens() {
        assert_eq!(version_key("1.2"), Some((1, 2, 0, 0)));
        assert_eq!(version_key("7"), Some((7, 0, 0, 0)));
        assert_eq!(version_key("latest"), None);
        assert_eq!(version_cmp("latest", "latest"), 0);
        assert!(version_cmp("abc", "abd") < 0);
    }
}
