//! Self-update against this fork's GitHub Releases.
//!
//! Origin, discovery, fetch, and apply surfaces live here so the release
//! origin is named once and the updater never reaches an external host.

pub mod discover;
pub mod origin;
pub mod state;
