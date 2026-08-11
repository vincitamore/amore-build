//! Self-update against this fork's GitHub Releases.
//!
//! Origin, discovery, fetch, and apply surfaces live here so the release
//! origin is named once and the updater never reaches an external host.

pub mod check;
pub mod cmd;
pub mod discover;
pub mod fetch;
pub mod fleet;
pub mod origin;
pub mod state;
pub mod swap;

pub use check::{
    CHECK_CADENCE, CheckConfig, CheckOutcome, DoctorUpdateFacts, INSTALLER_ID, UpdateAvailable,
    UpdateStatus, check_background, check_background_with, check_status, check_status_with,
    doctor_update_facts,
};
pub use cmd::{CheckCommand, channel_refusal_message, print_status, run_check};
