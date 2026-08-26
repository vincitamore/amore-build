//! Hotfix-aware release-tag ordering.
//!
//! A release tag is `vMAJOR.MINOR.PATCH`, optionally followed by `-hotfix.N`
//! for a fix cut between two pins. Ordering is by the numeric triple, then by
//! the hotfix counter:
//!
//! ```text
//! 1.0.8  <  1.0.8-hotfix.1  <  1.0.8-hotfix.2  <  1.0.9
//! ```
//!
//! Any other suffix (`-rc.1`, `+build`) is ignored for ordering, so a tag
//! without a hotfix counter compares as its bare triple. Raw `semver::Version`
//! treats `-hotfix.N` as a prerelease and orders it *below* the pin — the
//! opposite of this key.

use std::cmp::Ordering;

/// Ordering key: `(major, minor, patch, hotfix)`. `None` when the token does
/// not start with a numeric version.
pub fn version_key(s: &str) -> Option<(u64, u64, u64, u64)> {
    let s = strip_v(s.trim());
    let (core, suffix) = match s.find(['-', '+']) {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, ""),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch, hotfix_counter(suffix)))
}

/// `-hotfix.N` → `N` (also accepts `-hotfix-N` and `-hotfixN`); any other
/// suffix, or a bare `-hotfix` without a counter, is `0`.
fn hotfix_counter(suffix: &str) -> u64 {
    let Some(tail) = suffix.strip_prefix("-hotfix") else {
        return 0;
    };
    let digits: String = tail
        .trim_start_matches(['.', '-'])
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(0)
}

/// Compare two version tokens (optional leading `v`). Returns -1 / 0 / 1.
/// Tokens without a numeric version fall back to plain string order.
pub fn version_cmp(a: &str, b: &str) -> i32 {
    let ord = match (version_key(a), version_key(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => strip_v(a).cmp(strip_v(b)),
    };
    match ord {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

/// `candidate` sorts strictly after `current`. Unparseable pairs use string
/// order (see [`version_cmp`]).
pub fn is_newer(candidate: &str, current: &str) -> bool {
    version_cmp(candidate, current) > 0
}

/// `a` sorts strictly before `b` on the hotfix-aware key.
///
/// Returns `false` if either token has no numeric version — unparseable
/// versions are left alone. This is **not** `!is_newer(a, b)`: [`is_newer`]
/// falls back to string order for unparseable tokens.
pub fn is_older(a: &str, b: &str) -> bool {
    match (version_key(a), version_key(b)) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}

/// Drop a leading `v` (`v1.0.8` → `1.0.8`).
pub fn strip_v(s: &str) -> &str {
    s.strip_prefix('v').unwrap_or(s)
}

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
        assert!(is_older("1.0.8", "1.0.8-hotfix.1"));
        assert!(is_older("1.0.8-hotfix.1", "1.0.9"));
        assert!(!is_older("1.0.8-hotfix.1", "1.0.8"));
        assert!(!is_older("1.0.9", "1.0.8-hotfix.1"));
        assert!(is_newer("1.0.8-hotfix.1", "1.0.8"));
        assert!(is_newer("1.0.9", "1.0.8-hotfix.1"));
        assert_eq!(version_cmp("1.0.8", "1.0.8-hotfix.1"), -1);
        assert_eq!(version_cmp("1.0.8-hotfix.1", "1.0.9"), -1);
        assert_eq!(version_key("1.0.8"), Some((1, 0, 8, 0)));
        assert_eq!(version_key("1.0.8-hotfix.1"), Some((1, 0, 8, 1)));
        assert_eq!(version_key("v1.0.8-hotfix.1"), Some((1, 0, 8, 1)));
        assert_eq!(version_key("1.0.9"), Some((1, 0, 9, 0)));
    }

    #[test]
    fn other_suffixes_do_not_order() {
        assert_eq!(version_key("1.0.6-rc.1"), Some((1, 0, 6, 0)));
        assert_eq!(version_key("1.0.6+build.5"), Some((1, 0, 6, 0)));
        assert_eq!(version_key("1.0.6-hotfix"), Some((1, 0, 6, 0)));
        assert_eq!(version_cmp("1.0.6-rc.1", "1.0.6"), 0);
        assert!(!is_older("0.1.220-alpha.1", "0.1.220"));
        assert!(!is_newer("0.1.220", "0.1.220-alpha.1"));
    }

    #[test]
    fn short_and_unparseable_tokens() {
        assert_eq!(version_key("1.2"), Some((1, 2, 0, 0)));
        assert_eq!(version_key("7"), Some((7, 0, 0, 0)));
        assert_eq!(version_key("latest"), None);
        assert_eq!(version_cmp("latest", "latest"), 0);
        assert!(version_cmp("abc", "abd") < 0);
        assert!(!is_older("unknown", "0.2.0"));
        assert!(!is_older("0.1.0", "not-a-version"));
        assert!(is_newer("abd", "abc"));
    }
}
