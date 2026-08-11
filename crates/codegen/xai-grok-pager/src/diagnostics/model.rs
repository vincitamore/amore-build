//! Shared terminal diagnostic report types.

use crate::clipboard::{ClipboardDelivery, NativeClipboardPreflight, Osc52Capability};
use crate::host::{DisplayServer, HostOs};
use crate::terminal::{ByobuBackend, ModifierDelivery, MultiplexerKind, TerminalName};
use crate::theme::ThemeKind;
use crate::theme::color_support::ColorLevel;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeFact<T> {
    Available(T),
    NoReply,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct DiagnosticId {
    pub domain: &'static str,
    pub item: &'static str,
}

impl DiagnosticId {
    pub const fn new(domain: &'static str, item: &'static str) -> Self {
        Self { domain, item }
    }
}

impl std::fmt::Display for DiagnosticId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.domain, self.item)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticReport {
    pub facts: DiagnosticFacts,
    pub findings: Vec<DiagnosticFinding>,
    pub probe_notes: Vec<ProbeNote>,
}

pub(crate) const NOTIFICATION_PROTOCOL_FALLBACK_ID: DiagnosticId =
    DiagnosticId::new("notifications", "protocol-fallback");
pub(crate) const FOCUS_TRACKING_UNAVAILABLE_ID: DiagnosticId =
    DiagnosticId::new("notifications", "focus-tracking-unavailable");
pub(crate) const SANDBOX_PROFILE_CONFLICT_ID: DiagnosticId =
    DiagnosticId::new("sandbox", "profile-conflict");
pub(crate) const CLIPBOARD_DELIVERY_UNVERIFIED_ID: DiagnosticId =
    DiagnosticId::new("clipboard", "delivery-unverified");
pub(crate) const CLIPBOARD_DELIVERY_UNAVAILABLE_ID: DiagnosticId =
    DiagnosticId::new("clipboard", "delivery-unavailable");
pub(crate) const NEWLINE_FALLBACK_ID: DiagnosticId =
    DiagnosticId::new("terminal", "newline-fallback");
pub(crate) const ITERM2_CLIPBOARD_PERMISSION_ID: DiagnosticId =
    DiagnosticId::new("terminal", "iterm2-clipboard-permission");
pub(crate) const VSCODE_SSH_NON_ASCII_ID: DiagnosticId =
    DiagnosticId::new("clipboard", "vscode-ssh-non-ascii");
pub(crate) const VOICE_NO_INPUT_DEVICE_ID: DiagnosticId =
    DiagnosticId::new("voice", "no-input-device");

impl DiagnosticReport {
    pub fn issue_count(&self) -> usize {
        self.findings
            .iter()
            .filter(|finding| finding.disposition == FindingDisposition::Issue)
            .count()
            + usize::from(
                !self.facts.clipboard.delivery.is_confirmed()
                    && !self.findings.iter().any(|finding| {
                        matches!(
                            finding.id,
                            CLIPBOARD_DELIVERY_UNVERIFIED_ID | CLIPBOARD_DELIVERY_UNAVAILABLE_ID
                        )
                    }),
            )
    }

    pub fn recommendation_count(&self) -> usize {
        self.findings
            .iter()
            .filter(|finding| finding.disposition == FindingDisposition::Recommendation)
            .count()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticFacts {
    pub terminal: TerminalName,
    pub xtversion: RuntimeFact<String>,
    pub multiplexer: MultiplexerKind,
    pub byobu: Option<ByobuBackend>,
    pub ssh: bool,
    pub tmux: TmuxFacts,
    pub color: ColorFacts,
    pub keyboard: Option<KeyboardFact>,
    pub newline: Option<NewlineFact>,
    pub clipboard: ClipboardFacts,
    /// Passive mic enumeration when voice capture is available. `None` omits the
    /// Voice section (no-audio builds, or TUI when voice mode is off).
    pub voice: Option<VoiceFacts>,
    /// Companion instrument presence (iris / lucerna / speculum). Always filled
    /// by the instruments probe on standalone and TUI doctor paths.
    pub instruments: InstrumentsFacts,
    /// Cached self-update check state. Filled by the update probe; `None` when
    /// the probe has not run (for example pure terminal diagnostics).
    pub update: Option<crate::diagnostics::UpdateFacts>,
}

/// Result of a passive input-device lookup (does not open a capture stream).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoiceFacts {
    /// Device (or Linux recorder) capture would open.
    Device { name: String, detail: String },
    /// Audio is compiled in but no default input / recorder exists.
    Missing { error: String },
}

/// Companion binary presence for doctor facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompanionInstall {
    /// Binary found; version string when `--version` succeeded.
    Installed {
        path: std::path::PathBuf,
        version: Option<String>,
    },
    /// No binary beside `amore` and none on PATH.
    NotInstalled,
    /// Binary path known but the version probe failed.
    ProbeFailed {
        path: std::path::PathBuf,
        error: String,
    },
}

impl CompanionInstall {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Installed { .. } => "installed",
            Self::NotInstalled => "not_installed",
            Self::ProbeFailed { .. } => "probe_failed",
        }
    }

    pub fn path(&self) -> Option<&std::path::Path> {
        match self {
            Self::Installed { path, .. } | Self::ProbeFailed { path, .. } => Some(path.as_path()),
            Self::NotInstalled => None,
        }
    }

    pub fn version(&self) -> Option<&str> {
        match self {
            Self::Installed { version, .. } => version.as_deref(),
            Self::NotInstalled | Self::ProbeFailed { .. } => None,
        }
    }

    pub fn is_installed(&self) -> bool {
        matches!(self, Self::Installed { .. } | Self::ProbeFailed { .. })
    }
}

/// Which iris state home is live after the managed-home migration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IrisHomeLayout {
    /// `~/.amore/instruments/iris/` (preferred).
    Managed,
    /// Legacy `~/.iris`. `moved_marker` is true when `MOVED.md` is present
    /// (migration left a pointer in the old home).
    Legacy { moved_marker: bool },
}

impl IrisHomeLayout {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Legacy { .. } => "legacy",
        }
    }
}

/// Iris daemon state directory: managed home first, then legacy `~/.iris`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IrisDaemonHome {
    Present {
        path: std::path::PathBuf,
        layout: IrisHomeLayout,
    },
    Absent {
        managed_path: std::path::PathBuf,
        legacy_path: std::path::PathBuf,
    },
    HomeUnavailable,
}

impl IrisDaemonHome {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Present { .. } => "present",
            Self::Absent { .. } => "absent",
            Self::HomeUnavailable => "home_unavailable",
        }
    }
}

/// Managed `@tobilu/qmd` runtime under `~/.amore/instruments/qmd/runtime/`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QmdRuntimeFact {
    Present {
        path: std::path::PathBuf,
        /// Pinned package version when readable from disk (never by spawning).
        version: Option<String>,
    },
    Absent {
        path: std::path::PathBuf,
    },
    HomeUnavailable,
}

impl QmdRuntimeFact {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Present { .. } => "present",
            Self::Absent { .. } => "absent",
            Self::HomeUnavailable => "home_unavailable",
        }
    }
}

/// Search models under `~/.amore/instruments/qmd/models/` (filesystem only).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QmdModelsFact {
    Present {
        path: std::path::PathBuf,
        count: usize,
        total_bytes: u64,
        names: Vec<String>,
    },
    Absent {
        path: std::path::PathBuf,
    },
    HomeUnavailable,
}

impl QmdModelsFact {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Present { .. } => "present",
            Self::Absent { .. } => "absent",
            Self::HomeUnavailable => "home_unavailable",
        }
    }
}

/// House-scoped qmd index under `~/.amore/instruments/qmd/houses/<id>/`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QmdHouseIndexFact {
    Present {
        path: std::path::PathBuf,
        house_id: String,
    },
    Absent {
        path: std::path::PathBuf,
        house_id: String,
    },
    /// No house root found from the current directory ancestry.
    HouseNotResolved,
    HomeUnavailable,
}

impl QmdHouseIndexFact {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Present { .. } => "present",
            Self::Absent { .. } => "absent",
            Self::HouseNotResolved => "house_not_resolved",
            Self::HomeUnavailable => "home_unavailable",
        }
    }
}

/// Host JS runtime needed to run the managed qmd package (node >= 22 or bun).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JsRuntimeFact {
    Available {
        kind: String,
        version: String,
    },
    Missing,
}

impl JsRuntimeFact {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Available { .. } => "available",
            Self::Missing => "missing",
        }
    }
}

/// Semantic search (qmd) facts for doctor: filesystem + PATH only, never spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QmdSearchFacts {
    pub runtime: QmdRuntimeFact,
    pub models: QmdModelsFact,
    pub house_index: QmdHouseIndexFact,
    pub js_runtime: JsRuntimeFact,
}

impl Default for QmdSearchFacts {
    fn default() -> Self {
        Self {
            runtime: QmdRuntimeFact::HomeUnavailable,
            models: QmdModelsFact::HomeUnavailable,
            house_index: QmdHouseIndexFact::HomeUnavailable,
            js_runtime: JsRuntimeFact::Missing,
        }
    }
}

/// Lucerna durable enablement from `lucerna.enable.json` (house runtime).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LucernaEnablementFact {
    /// File found and parsed (malformed → both flags false, same as lucerna).
    Observed {
        path: std::path::PathBuf,
        dreams_enabled: bool,
        auto_commit_live: bool,
        /// Parse/read issue; flags still default off.
        error: Option<String>,
    },
    /// No house enablement file under the current directory ancestry.
    NotObserved,
}

impl LucernaEnablementFact {
    pub fn status_label(&self) -> &'static str {
        match self {
            Self::Observed { error: Some(_), .. } => "malformed",
            Self::Observed { .. } => "observed",
            Self::NotObserved => "not_observed",
        }
    }
}

/// Full instruments section for doctor facts (human + JSON).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstrumentsFacts {
    pub iris: CompanionInstall,
    pub iris_daemon_home: IrisDaemonHome,
    pub lucerna: CompanionInstall,
    pub lucerna_enablement: LucernaEnablementFact,
    pub speculum: CompanionInstall,
    /// Managed qmd semantic search (filesystem probes only).
    pub qmd: QmdSearchFacts,
}

impl Default for InstrumentsFacts {
    fn default() -> Self {
        Self {
            iris: CompanionInstall::NotInstalled,
            iris_daemon_home: IrisDaemonHome::HomeUnavailable,
            lucerna: CompanionInstall::NotInstalled,
            lucerna_enablement: LucernaEnablementFact::NotObserved,
            speculum: CompanionInstall::NotInstalled,
            qmd: QmdSearchFacts::default(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TmuxFacts {
    pub extended_keys: TmuxOptionFact,
    pub set_clipboard: TmuxOptionFact,
    pub allow_passthrough_support: TmuxSupportFact,
    pub allow_passthrough: TmuxOptionFact,
    pub color_passthrough: TmuxColorPassthrough,
}

/// Whether the attached tmux client forwards 24-bit color to the terminal.
///
/// tmux resolves a client's features once, at attach time, so this describes
/// the live client and not the config on disk: a config change applies only
/// after that client reattaches.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TmuxColorPassthrough {
    /// The client advertises `RGB`, so truecolor SGR reaches the terminal.
    Forwarded,
    /// tmux reduces 24-bit color to the client terminfo's palette, which is
    /// what makes themes look washed out even when Grok emits truecolor.
    Reduced,
    /// No usable evidence: tmux predates `terminal-features` (3.2), no client
    /// is attached, or the query failed. Never treated as a problem.
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TmuxOptionFact {
    Available(String),
    Unsupported,
    Unavailable,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TmuxSupportFact {
    Supported,
    Unsupported,
    Unavailable,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ColorFacts {
    pub level: RuntimeFact<ColorLevel>,
    pub available_themes: Vec<ThemeKind>,
    pub total_themes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyboardFact {
    pub modifier_delivery: ModifierDelivery,
    pub os: HostOs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NewlineFact {
    Vte { version: Option<String> },
    XtermJs { terminal: TerminalName },
    NoKittyKeyboardProtocol,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClipboardFacts {
    pub native_route: bool,
    pub native_tool: String,
    pub native_preflight: NativeClipboardPreflight,
    pub tmux_route: bool,
    pub osc52_route: bool,
    pub osc52_capability: Osc52Capability,
    pub wrap_sink: bool,
    pub display_server: DisplayServer,
    pub container_no_display: bool,
    pub data_control: DataControlFact,
    pub delivery: ClipboardDelivery,
    /// Compatibility projection for compact status/JSON consumers. Detailed
    /// policy and remediation live in named findings.
    pub fix: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DataControlFact {
    Available,
    Missing,
    Unavailable,
    Error,
    NotApplicable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiagnosticFinding {
    pub id: DiagnosticId,
    pub disposition: FindingDisposition,
    pub message: String,
    pub remediation: Option<ManualRemediation>,
    pub automatic_remediation: Option<crate::diagnostics::AutomaticRemediation>,
    pub note: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FindingDisposition {
    Issue,
    Recommendation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualRemediation {
    pub fix: String,
    pub config_path: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProbeNote {
    pub probe: &'static str,
    pub status: ProbeStatus,
    pub message: Option<String>,
}

pub(crate) fn probe_requires_live_tui(note: &ProbeNote) -> bool {
    note.status == ProbeStatus::Unavailable
        && matches!(
            note.probe,
            "runtime.fullscreen-active" | "runtime.kitty-flags-pushed" | "runtime.xtversion"
        )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeStatus {
    Unsupported,
    Unavailable,
    Error,
}
