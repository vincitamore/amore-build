//! Update-check facts for `amore doctor` (cached state only; no network).

use super::{DiagnosticReport};
use crate::self_update::{DoctorUpdateFacts, doctor_update_facts};

/// Attach cached self-update facts to a doctor report.
///
/// Never contacts the release origin. Surfaces last check time, last seen
/// tag, whether checks are permitted, and typed install-dir writability.
pub fn apply_update_probe(report: &mut DiagnosticReport) {
    report.facts.update = Some(probe_update_facts());
}

/// Live read of cached state + policy (no network).
pub fn probe_update_facts() -> UpdateFacts {
    UpdateFacts::from(doctor_update_facts())
}

/// Doctor-facing update section.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateFacts {
    pub last_check_at: Option<String>,
    pub last_seen_tag: Option<String>,
    pub checks_permitted: bool,
    pub block_reason: Option<String>,
    pub install_dir: Option<String>,
}

impl From<DoctorUpdateFacts> for UpdateFacts {
    fn from(f: DoctorUpdateFacts) -> Self {
        Self {
            last_check_at: f.last_check_at,
            last_seen_tag: f.last_seen_tag,
            checks_permitted: f.checks_permitted,
            block_reason: f.block_reason.or(f.state_error),
            install_dir: f.install_dir,
        }
    }
}

/// Format the Update section for human doctor output.
pub fn format_update_section(facts: &UpdateFacts, out: &mut String) {
    out.push_str("\nUpdate\n");
    let mut row = |label: &str, value: &str| {
        out.push_str(&format!("  {label:<16} {value}\n"));
    };
    row(
        "checks",
        if facts.checks_permitted {
            "permitted"
        } else {
            "blocked"
        },
    );
    if let Some(ref reason) = facts.block_reason {
        row("reason", reason);
    }
    row(
        "last check",
        facts.last_check_at.as_deref().unwrap_or("never"),
    );
    row(
        "last seen",
        facts.last_seen_tag.as_deref().unwrap_or("none"),
    );
    if let Some(ref dir) = facts.install_dir {
        row("install dir", dir);
    }
}
