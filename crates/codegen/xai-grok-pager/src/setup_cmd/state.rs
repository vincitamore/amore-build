//! Wizard state persistence under `~/.selene` (or `$SELENE_HOME` / `$GROK_HOME`).
//!
//! The state file ensures the auto-guided first-run screen fires once unless
//! the operator resets it (`selene setup --reset`).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Relative file name inside the grok/selene home directory.
pub const STATE_FILE_NAME: &str = "setup-wizard-state.json";

const STATE_VERSION: u32 = 1;

/// Lifecycle of the first-run wizard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WizardStatus {
    /// User completed at least one step (or finished the summary).
    Done,
    /// User dismissed / quit without finishing (still suppresses auto-fire).
    Skipped,
    /// Reserved for multi-session resume; treated as "not finished" for auto-fire.
    InProgress,
}

/// On-disk wizard bookkeeping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WizardState {
    pub version: u32,
    pub status: WizardStatus,
    /// RFC3339 timestamp of last status write (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl WizardState {
    pub fn new(status: WizardStatus) -> Self {
        Self {
            version: STATE_VERSION,
            status,
            updated_at: Some(now_rfc3339()),
        }
    }

    pub fn path_in(home: &Path) -> PathBuf {
        home.join(STATE_FILE_NAME)
    }

    pub fn load(home: &Path) -> Result<Option<Self>> {
        let path = Self::path_in(home);
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("read wizard state {}", path.display()))?;
        let state: Self = serde_json::from_str(&raw)
            .with_context(|| format!("parse wizard state {}", path.display()))?;
        Ok(Some(state))
    }

    pub fn save(&self, home: &Path) -> Result<()> {
        let path = Self::path_in(home);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let mut to_write = self.clone();
        to_write.updated_at = Some(now_rfc3339());
        let raw = serde_json::to_string_pretty(&to_write).context("serialize wizard state")?;
        std::fs::write(&path, format!("{raw}\n"))
            .with_context(|| format!("write wizard state {}", path.display()))?;
        Ok(())
    }

    pub fn clear(home: &Path) -> Result<bool> {
        let path = Self::path_in(home);
        if !path.exists() {
            return Ok(false);
        }
        std::fs::remove_file(&path)
            .with_context(|| format!("remove wizard state {}", path.display()))?;
        Ok(true)
    }

    #[must_use]
    pub fn suppresses_auto_fire(&self) -> bool {
        matches!(self.status, WizardStatus::Done | WizardStatus::Skipped)
    }
}

fn now_rfc3339() -> String {
    // chrono is already a pager dependency; keep timestamps human-readable.
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn round_trip_done() {
        let dir = tempdir().unwrap();
        let state = WizardState::new(WizardStatus::Done);
        state.save(dir.path()).unwrap();
        let loaded = WizardState::load(dir.path()).unwrap().expect("present");
        assert_eq!(loaded.status, WizardStatus::Done);
        assert_eq!(loaded.version, STATE_VERSION);
        assert!(loaded.suppresses_auto_fire());
    }

    #[test]
    fn clear_removes_file() {
        let dir = tempdir().unwrap();
        WizardState::new(WizardStatus::Skipped)
            .save(dir.path())
            .unwrap();
        assert!(WizardState::clear(dir.path()).unwrap());
        assert!(WizardState::load(dir.path()).unwrap().is_none());
        assert!(!WizardState::clear(dir.path()).unwrap());
    }

    #[test]
    fn missing_is_none() {
        let dir = tempdir().unwrap();
        assert!(WizardState::load(dir.path()).unwrap().is_none());
    }
}
