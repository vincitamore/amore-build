//! Upstream pins FEATURES against `docs/internal/{25-enterprise,
//! 22-environment-variables}.md`. Those files live in the monorepo and
//! are not in the public bundle, so the original `include_str!` compile-
//! fails here. Restore the include_str pin when either file ships.

use std::path::Path;

#[test]
fn internal_feature_docs_are_absent_from_the_public_tree() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/internal");
    for name in ["25-enterprise.md", "22-environment-variables.md"] {
        assert!(
            !root.join(name).exists(),
            "{name} shipped under docs/internal; restore the include_str FEATURES pin",
        );
    }
}
