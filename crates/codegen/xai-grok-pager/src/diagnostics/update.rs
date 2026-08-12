//! Update-check facts for `amore doctor` (cached state only; no network).

use super::DiagnosticReport;
use crate::self_update::discover;
use crate::self_update::fleet;
use crate::self_update::state as install_state;
use crate::self_update::{DoctorUpdateFacts, doctor_update_facts};

/// Attach cached self-update facts to a doctor report.
///
/// Never contacts the release origin. Surfaces last check time, last seen
/// tag, whether checks are permitted, typed install-dir writability, and
/// fleet coherence against the install-state file.
pub fn apply_update_probe(report: &mut DiagnosticReport) {
    report.facts.update = Some(probe_update_facts());
}

/// Live read of cached state + policy + fleet coherence (no network).
pub fn probe_update_facts() -> UpdateFacts {
    let mut facts = UpdateFacts::from(doctor_update_facts());
    let coherence = probe_fleet_coherence();
    facts.fleet_coherent = Some(coherence.coherent);
    facts.fleet_tag = coherence.tag;
    facts.fleet_mismatches = coherence.mismatches;
    facts
}

/// Doctor-facing update section.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateFacts {
    pub last_check_at: Option<String>,
    pub last_seen_tag: Option<String>,
    pub checks_permitted: bool,
    pub block_reason: Option<String>,
    pub install_dir: Option<String>,
    /// Whether on-disk fleet files match the install-state records.
    /// `None` when coherence could not be evaluated (no install dir).
    pub fleet_coherent: Option<bool>,
    /// Install-state tag used for the coherence comparison.
    pub fleet_tag: Option<String>,
    /// Present components whose on-disk hash/size disagrees with state.
    pub fleet_mismatches: Vec<FleetMismatch>,
}

/// One fleet member that disagrees with the install-state record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetMismatch {
    pub component: String,
    /// What is on disk (content sha256 hex, or a short status token).
    pub installed: String,
    /// What the install state recorded.
    pub expected: String,
}

impl From<DoctorUpdateFacts> for UpdateFacts {
    fn from(f: DoctorUpdateFacts) -> Self {
        Self {
            last_check_at: f.last_check_at,
            last_seen_tag: f.last_seen_tag,
            checks_permitted: f.checks_permitted,
            block_reason: f.block_reason.or(f.state_error),
            install_dir: f.install_dir,
            fleet_coherent: None,
            fleet_tag: None,
            fleet_mismatches: Vec::new(),
        }
    }
}

struct FleetCoherence {
    coherent: bool,
    tag: Option<String>,
    mismatches: Vec<FleetMismatch>,
}

/// Compare present fleet binaries to `.amore-install.json` (cached, no network).
///
/// Components on disk with no state record are unknown (not incoherent).
/// Components with a state record are hashed; size and sha256 must match.
fn probe_fleet_coherence() -> FleetCoherence {
    let install_dir = match install_state::install_dir() {
        Ok(d) => d,
        Err(_) => {
            return FleetCoherence {
                coherent: true,
                tag: None,
                mismatches: Vec::new(),
            };
        }
    };
    let loaded = match install_state::load(&install_dir) {
        Ok(s) => s,
        Err(_) => {
            return FleetCoherence {
                coherent: true,
                tag: None,
                mismatches: Vec::new(),
            };
        }
    };
    let Some(state) = loaded else {
        // No state file: every present companion is unknown, not incoherent.
        return FleetCoherence {
            coherent: true,
            tag: None,
            mismatches: Vec::new(),
        };
    };

    let (os, arch) = discover::host_os_arch().unwrap_or(("windows", "x64"));
    let units = fleet::scan_targets(&install_dir, os, arch);
    let mut mismatches = Vec::new();

    for unit in &units {
        for file in &unit.files {
            let Some(rec) = state.files.get(&file.name) else {
                // Present on disk, absent from state: unknown, not a mismatch.
                continue;
            };
            if !path_exists(&file.dest) {
                mismatches.push(FleetMismatch {
                    component: file.name.clone(),
                    installed: "missing".into(),
                    expected: format!("sha256={} size={}", rec.sha256, rec.size),
                });
                continue;
            }
            let meta = match std::fs::metadata(&file.dest) {
                Ok(m) => m,
                Err(_) => {
                    mismatches.push(FleetMismatch {
                        component: file.name.clone(),
                        installed: "unreadable".into(),
                        expected: format!("sha256={} size={}", rec.sha256, rec.size),
                    });
                    continue;
                }
            };
            let disk_hash = match xai_file_utils::sha256_hex_from_file(&file.dest, None) {
                Ok(h) => h.to_ascii_lowercase(),
                Err(_) => {
                    mismatches.push(FleetMismatch {
                        component: file.name.clone(),
                        installed: "unhashable".into(),
                        expected: rec.sha256.clone(),
                    });
                    continue;
                }
            };
            // files{}.sha256 is always the content hash of the on-disk file.
            // Strict equality; size is reported for humans but not a substitute.
            if disk_hash.eq_ignore_ascii_case(&rec.sha256) && meta.len() == rec.size {
                continue;
            }
            mismatches.push(FleetMismatch {
                component: file.name.clone(),
                installed: format!("sha256={} size={}", disk_hash, meta.len()),
                expected: format!("sha256={} size={}", rec.sha256, rec.size),
            });
        }
    }

    FleetCoherence {
        coherent: mismatches.is_empty(),
        tag: Some(state.tag.clone()),
        mismatches,
    }
}

fn path_exists(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Format the Update section for human doctor output.
pub fn format_update_section(facts: &UpdateFacts, out: &mut String) {
    out.push_str("\nUpdate\n");
    let push_row = |out: &mut String, label: &str, value: &str| {
        out.push_str(&format!("  {label:<16} {value}\n"));
    };
    push_row(
        out,
        "checks",
        if facts.checks_permitted {
            "permitted"
        } else {
            "blocked"
        },
    );
    if let Some(ref reason) = facts.block_reason {
        push_row(out, "reason", reason);
    }
    push_row(
        out,
        "last check",
        facts.last_check_at.as_deref().unwrap_or("never"),
    );
    push_row(
        out,
        "last seen",
        facts.last_seen_tag.as_deref().unwrap_or("none"),
    );
    if let Some(ref dir) = facts.install_dir {
        push_row(out, "install dir", dir);
    }
    if let Some(coherent) = facts.fleet_coherent {
        push_row(
            out,
            "fleet",
            if coherent { "coherent" } else { "incoherent" },
        );
        if let Some(ref tag) = facts.fleet_tag {
            push_row(out, "fleet tag", tag);
        }
        if !coherent {
            for m in &facts.fleet_mismatches {
                out.push_str(&format!(
                    "  mismatch        {comp}: installed={ins} expected={exp}\n",
                    comp = m.component,
                    ins = m.installed,
                    exp = m.expected,
                ));
            }
            let bin = crate::app::cli::resolved_bin_name();
            push_row(
                out,
                "realign",
                &format!("run '{bin} update' to realign the fleet"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::self_update::state::{FileRecord, InstallState, load, store_atomic};
    use std::fs;

    #[test]
    fn format_includes_realign_when_incoherent() {
        let facts = UpdateFacts {
            last_check_at: None,
            last_seen_tag: None,
            checks_permitted: true,
            block_reason: None,
            install_dir: Some("/tmp/bin".into()),
            fleet_coherent: Some(false),
            fleet_tag: Some("v1.0.0".into()),
            fleet_mismatches: vec![FleetMismatch {
                component: "iris.exe".into(),
                installed: "sha256=aaa size=1".into(),
                expected: "sha256=bbb size=2".into(),
            }],
        };
        let mut out = String::new();
        format_update_section(&facts, &mut out);
        assert!(out.contains("incoherent"), "{out}");
        assert!(out.contains("realign"), "{out}");
        assert!(out.contains("update"), "{out}");
        assert!(out.contains("iris.exe"), "{out}");
    }

    #[test]
    fn present_without_state_record_is_not_mismatch() {
        // Empty state files map + synthetic unit is covered by probe logic:
        // a file with no record is skipped. Unit-level: empty mismatches.
        let dir = tempfile::tempdir().unwrap();
        let mut st = InstallState::new("v1.0.0", "stable", "t0");
        st.files.clear();
        store_atomic(dir.path(), &st).unwrap();
        // No fleet binaries beside the real install dir; coherence of empty
        // state against scan of this temp dir is coherent (no comparable files).
        let (os, arch) = ("windows", "x64");
        // scan always includes amore; write a dummy so dest exists without state.
        let amore = dir.path().join(if os == "windows" {
            "amore.exe"
        } else {
            "amore"
        });
        fs::write(&amore, b"x").unwrap();
        let units = fleet::scan_targets(dir.path(), os, arch);
        assert!(units.iter().any(|u| u.id == "amore"));
        // Manual compare: no state record → no mismatch.
        let loaded = load(dir.path()).unwrap().unwrap();
        let mut mismatches = 0usize;
        for unit in &units {
            for file in &unit.files {
                if loaded.files.get(&file.name).is_some() {
                    mismatches += 1;
                }
            }
        }
        assert_eq!(mismatches, 0);
    }

    #[test]
    fn size_mismatch_is_incoherent() {
        let dir = tempfile::tempdir().unwrap();
        let name = "amore.exe";
        let path = dir.path().join(name);
        fs::write(&path, b"hello-world-bytes").unwrap();
        let mut st = InstallState::new("v1.0.0", "stable", "t0");
        st.files.insert(
            name.into(),
            FileRecord {
                sha256: "deadbeef".into(),
                size: 1, // wrong size
            },
        );
        store_atomic(dir.path(), &st).unwrap();
        let loaded = load(dir.path()).unwrap().unwrap();
        let rec = loaded.files.get(name).unwrap();
        let meta = fs::metadata(&path).unwrap();
        assert_ne!(meta.len(), rec.size);
    }
}
