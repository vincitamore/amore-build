use serde::Serialize;

use crate::clipboard::{ClipboardDelivery, NativeClipboardPreflight, Osc52Capability};
use crate::diagnostics::{
    CompanionInstall, DataControlFact, DiagnosticFinding, DiagnosticReport, FindingDisposition,
    InstrumentsFacts, IrisDaemonHome, IrisHomeLayout, JsRuntimeFact, LucernaEnablementFact,
    NewlineFact, ProbeNote, ProbeStatus, QmdHouseIndexFact, QmdModelsFact, QmdRuntimeFact,
    QmdSearchFacts, RuntimeFact, VoiceFacts,
};
use crate::host::HostOs;
use crate::terminal::{ByobuBackend, ModifierFate, MultiplexerKind, TerminalName};
use crate::theme::color_support::ColorLevel;

use super::SCHEMA_VERSION;

pub(super) fn write(
    report: &DiagnosticReport,
    writer: &mut impl std::io::Write,
) -> anyhow::Result<()> {
    serde_json::to_writer_pretty(&mut *writer, &JsonReport::from(report))?;
    writeln!(writer)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonReport<'a> {
    schema_version: &'static str,
    facts: JsonFacts<'a>,
    findings: Vec<JsonFinding<'a>>,
    probe_notes: Vec<JsonProbeNote<'a>>,
    counts: JsonCounts,
    /// Always-present PATH-collision check for the public `amore` binary
    /// (crates.io Lua-linter mitigation).
    path_collision: JsonPathCollision,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonPathCollision {
    binary: &'static str,
    status: &'static str,
    shadowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    message: String,
}

impl JsonPathCollision {
    fn from_live_check() -> Self {
        let result = super::path_collision::check_amore_path_collision();
        Self {
            binary: "amore",
            status: result.status_label(),
            shadowed: result.is_shadowed(),
            path: result.path().map(|p| p.display().to_string()),
            message: result.message(),
        }
    }
}

impl<'a> From<&'a DiagnosticReport> for JsonReport<'a> {
    fn from(report: &'a DiagnosticReport) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            facts: JsonFacts::from(report),
            findings: report.findings.iter().map(JsonFinding::from).collect(),
            probe_notes: report.probe_notes.iter().map(JsonProbeNote::from).collect(),
            counts: JsonCounts {
                issues: report.issue_count(),
                recommendations: report.recommendation_count(),
                probe_notes: report.probe_notes.len(),
            },
            path_collision: JsonPathCollision::from_live_check(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonFacts<'a> {
    terminal: JsonTerminalFact<'a>,
    multiplexer: JsonMultiplexerFact,
    ssh: bool,
    color: JsonColorFacts,
    keyboard: Option<JsonKeyboardFact>,
    newline: Option<JsonNewlineFact<'a>>,
    clipboard: JsonClipboardFacts<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    voice: Option<JsonVoiceFacts<'a>>,
    instruments: JsonInstrumentsFacts<'a>,
}

impl<'a> From<&'a DiagnosticReport> for JsonFacts<'a> {
    fn from(report: &'a DiagnosticReport) -> Self {
        let facts = &report.facts;
        Self {
            terminal: JsonTerminalFact {
                name: terminal_name(facts.terminal),
                xtversion: JsonRuntimeFact::from(&facts.xtversion),
            },
            multiplexer: JsonMultiplexerFact {
                kind: multiplexer(facts.multiplexer),
                byobu: facts.byobu.map(byobu_backend),
            },
            ssh: facts.ssh,
            color: JsonColorFacts {
                level: JsonColorLevel::from(&facts.color.level),
                available_themes: facts
                    .color
                    .available_themes
                    .iter()
                    .map(|theme| theme.display_name())
                    .collect(),
                total_themes: facts.color.total_themes,
            },
            keyboard: facts.keyboard.as_ref().map(|keyboard| JsonKeyboardFact {
                cmd: modifier_fate(keyboard.modifier_delivery.cmd),
                opt: modifier_fate(keyboard.modifier_delivery.opt),
                os: host_os(keyboard.os),
            }),
            newline: facts.newline.as_ref().map(JsonNewlineFact::from),
            clipboard: JsonClipboardFacts::from(&facts.clipboard),
            voice: facts.voice.as_ref().map(JsonVoiceFacts::from),
            instruments: JsonInstrumentsFacts::from(&facts.instruments),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonInstrumentsFacts<'a> {
    iris: JsonCompanionInstall<'a>,
    iris_daemon_home: JsonIrisDaemonHome<'a>,
    lucerna: JsonCompanionInstall<'a>,
    lucerna_enablement: JsonLucernaEnablement<'a>,
    speculum: JsonCompanionInstall<'a>,
    qmd: JsonQmdSearchFacts<'a>,
}

impl<'a> From<&'a InstrumentsFacts> for JsonInstrumentsFacts<'a> {
    fn from(facts: &'a InstrumentsFacts) -> Self {
        Self {
            iris: JsonCompanionInstall::from(&facts.iris),
            iris_daemon_home: JsonIrisDaemonHome::from(&facts.iris_daemon_home),
            lucerna: JsonCompanionInstall::from(&facts.lucerna),
            lucerna_enablement: JsonLucernaEnablement::from(&facts.lucerna_enablement),
            speculum: JsonCompanionInstall::from(&facts.speculum),
            qmd: JsonQmdSearchFacts::from(&facts.qmd),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonCompanionInstall<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

impl<'a> From<&'a CompanionInstall> for JsonCompanionInstall<'a> {
    fn from(install: &'a CompanionInstall) -> Self {
        match install {
            CompanionInstall::Installed { path, version } => Self {
                status: "installed",
                path: path.to_str(),
                version: version.as_deref(),
                error: None,
            },
            CompanionInstall::NotInstalled => Self {
                status: "not_installed",
                path: None,
                version: None,
                error: None,
            },
            CompanionInstall::ProbeFailed { path, error } => Self {
                status: "probe_failed",
                path: path.to_str(),
                version: None,
                error: Some(error.as_str()),
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonIrisDaemonHome<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    /// `managed` or `legacy` when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    layout: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    moved_marker: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    managed_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_path: Option<&'a str>,
}

impl<'a> From<&'a IrisDaemonHome> for JsonIrisDaemonHome<'a> {
    fn from(home: &'a IrisDaemonHome) -> Self {
        match home {
            IrisDaemonHome::Present { path, layout } => match layout {
                IrisHomeLayout::Managed => Self {
                    status: "present",
                    path: path.to_str(),
                    layout: Some("managed"),
                    moved_marker: None,
                    managed_path: None,
                    legacy_path: None,
                },
                IrisHomeLayout::Legacy { moved_marker } => Self {
                    status: "present",
                    path: path.to_str(),
                    layout: Some("legacy"),
                    moved_marker: Some(*moved_marker),
                    managed_path: None,
                    legacy_path: None,
                },
            },
            IrisDaemonHome::Absent {
                managed_path,
                legacy_path,
            } => Self {
                status: "absent",
                path: None,
                layout: None,
                moved_marker: None,
                managed_path: managed_path.to_str(),
                legacy_path: legacy_path.to_str(),
            },
            IrisDaemonHome::HomeUnavailable => Self {
                status: "home_unavailable",
                path: None,
                layout: None,
                moved_marker: None,
                managed_path: None,
                legacy_path: None,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonQmdSearchFacts<'a> {
    runtime: JsonQmdRuntime<'a>,
    models: JsonQmdModels<'a>,
    house_index: JsonQmdHouseIndex<'a>,
    js_runtime: JsonJsRuntime<'a>,
}

impl<'a> From<&'a QmdSearchFacts> for JsonQmdSearchFacts<'a> {
    fn from(facts: &'a QmdSearchFacts) -> Self {
        Self {
            runtime: JsonQmdRuntime::from(&facts.runtime),
            models: JsonQmdModels::from(&facts.models),
            house_index: JsonQmdHouseIndex::from(&facts.house_index),
            js_runtime: JsonJsRuntime::from(&facts.js_runtime),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonQmdRuntime<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
}

impl<'a> From<&'a QmdRuntimeFact> for JsonQmdRuntime<'a> {
    fn from(fact: &'a QmdRuntimeFact) -> Self {
        match fact {
            QmdRuntimeFact::Present { path, version } => Self {
                status: "present",
                path: path.to_str(),
                version: version.as_deref(),
            },
            QmdRuntimeFact::Absent { path } => Self {
                status: "absent",
                path: path.to_str(),
                version: None,
            },
            QmdRuntimeFact::HomeUnavailable => Self {
                status: "home_unavailable",
                path: None,
                version: None,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonQmdModels<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    names: Option<&'a [String]>,
}

impl<'a> From<&'a QmdModelsFact> for JsonQmdModels<'a> {
    fn from(fact: &'a QmdModelsFact) -> Self {
        match fact {
            QmdModelsFact::Present {
                path,
                count,
                total_bytes,
                names,
            } => Self {
                status: "present",
                path: path.to_str(),
                count: Some(*count),
                total_bytes: Some(*total_bytes),
                names: Some(names.as_slice()),
            },
            QmdModelsFact::Absent { path } => Self {
                status: "absent",
                path: path.to_str(),
                count: None,
                total_bytes: None,
                names: None,
            },
            QmdModelsFact::HomeUnavailable => Self {
                status: "home_unavailable",
                path: None,
                count: None,
                total_bytes: None,
                names: None,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonQmdHouseIndex<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    house_id: Option<&'a str>,
}

impl<'a> From<&'a QmdHouseIndexFact> for JsonQmdHouseIndex<'a> {
    fn from(fact: &'a QmdHouseIndexFact) -> Self {
        match fact {
            QmdHouseIndexFact::Present { path, house_id } => Self {
                status: "present",
                path: path.to_str(),
                house_id: Some(house_id.as_str()),
            },
            QmdHouseIndexFact::Absent { path, house_id } => Self {
                status: "absent",
                path: path.to_str(),
                house_id: Some(house_id.as_str()),
            },
            QmdHouseIndexFact::HouseNotResolved => Self {
                status: "house_not_resolved",
                path: None,
                house_id: None,
            },
            QmdHouseIndexFact::HomeUnavailable => Self {
                status: "home_unavailable",
                path: None,
                house_id: None,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonJsRuntime<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
}

impl<'a> From<&'a JsRuntimeFact> for JsonJsRuntime<'a> {
    fn from(fact: &'a JsRuntimeFact) -> Self {
        match fact {
            JsRuntimeFact::Available { kind, version } => Self {
                status: "available",
                kind: Some(kind.as_str()),
                version: Some(version.as_str()),
            },
            JsRuntimeFact::Missing => Self {
                status: "missing",
                kind: None,
                version: None,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonLucernaEnablement<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dreams_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_commit_live: Option<bool>,
    /// When live, auto-commit mode is "live"; otherwise "dry-run" or absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_commit_mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

impl<'a> From<&'a LucernaEnablementFact> for JsonLucernaEnablement<'a> {
    fn from(fact: &'a LucernaEnablementFact) -> Self {
        match fact {
            LucernaEnablementFact::NotObserved => Self {
                status: "not_observed",
                path: None,
                dreams_enabled: None,
                auto_commit_live: None,
                auto_commit_mode: None,
                error: None,
            },
            LucernaEnablementFact::Observed {
                path,
                dreams_enabled,
                auto_commit_live,
                error,
            } => Self {
                status: if error.is_some() {
                    "malformed"
                } else {
                    "observed"
                },
                path: path.to_str(),
                dreams_enabled: Some(*dreams_enabled),
                auto_commit_live: Some(*auto_commit_live),
                auto_commit_mode: Some(if *auto_commit_live { "live" } else { "dry-run" }),
                error: error.as_deref(),
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonVoiceFacts<'a> {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

impl<'a> From<&'a VoiceFacts> for JsonVoiceFacts<'a> {
    fn from(facts: &'a VoiceFacts) -> Self {
        match facts {
            VoiceFacts::Device { name, detail } => Self {
                status: "available",
                name: Some(name),
                detail: Some(detail),
                error: None,
            },
            VoiceFacts::Missing { error } => Self {
                status: "missing",
                name: None,
                detail: None,
                error: Some(error),
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonTerminalFact<'a> {
    name: &'static str,
    xtversion: JsonRuntimeFact<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonMultiplexerFact {
    kind: &'static str,
    byobu: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonRuntimeFact<'a> {
    status: &'static str,
    value: Option<&'a str>,
}

impl<'a> From<&'a RuntimeFact<String>> for JsonRuntimeFact<'a> {
    fn from(fact: &'a RuntimeFact<String>) -> Self {
        match fact {
            RuntimeFact::Available(value) => Self {
                status: "available",
                value: Some(value),
            },
            RuntimeFact::NoReply => Self {
                status: "no_reply",
                value: None,
            },
            RuntimeFact::Unavailable => Self {
                status: "unavailable",
                value: None,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonColorFacts {
    level: JsonColorLevel,
    available_themes: Vec<&'static str>,
    total_themes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonColorLevel {
    status: &'static str,
    value: Option<&'static str>,
}

impl From<&RuntimeFact<ColorLevel>> for JsonColorLevel {
    fn from(fact: &RuntimeFact<ColorLevel>) -> Self {
        match fact {
            RuntimeFact::Available(level) => Self {
                status: "available",
                value: Some(level.as_str()),
            },
            RuntimeFact::NoReply => Self {
                status: "no_reply",
                value: None,
            },
            RuntimeFact::Unavailable => Self {
                status: "unavailable",
                value: None,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonKeyboardFact {
    cmd: &'static str,
    opt: &'static str,
    os: &'static str,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum JsonNewlineFact<'a> {
    Vte { version: Option<&'a str> },
    XtermJs { terminal_name: &'static str },
    NoKittyKeyboardProtocol,
}

impl<'a> From<&'a NewlineFact> for JsonNewlineFact<'a> {
    fn from(newline: &'a NewlineFact) -> Self {
        match newline {
            NewlineFact::Vte { version } => Self::Vte {
                version: version.as_deref(),
            },
            NewlineFact::XtermJs { terminal } => Self::XtermJs {
                terminal_name: terminal_name(*terminal),
            },
            NewlineFact::NoKittyKeyboardProtocol => Self::NoKittyKeyboardProtocol,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonClipboardFacts<'a> {
    native_route: bool,
    native_tool: &'a str,
    native_preflight: &'static str,
    tmux_route: bool,
    osc52_route: bool,
    osc52_capability: &'static str,
    wrap_sink: bool,
    display_server: &'static str,
    container_no_display: bool,
    data_control: &'static str,
    delivery: &'static str,
    fix: Option<&'a str>,
}

impl<'a> From<&'a crate::diagnostics::ClipboardFacts> for JsonClipboardFacts<'a> {
    fn from(facts: &'a crate::diagnostics::ClipboardFacts) -> Self {
        Self {
            native_route: facts.native_route,
            native_tool: &facts.native_tool,
            native_preflight: native_preflight(facts.native_preflight),
            tmux_route: facts.tmux_route,
            osc52_route: facts.osc52_route,
            osc52_capability: osc52_capability(facts.osc52_capability),
            wrap_sink: facts.wrap_sink,
            display_server: display_server(facts.display_server),
            container_no_display: facts.container_no_display,
            data_control: data_control(facts.data_control),
            delivery: clipboard_delivery(facts.delivery),
            fix: facts.fix.as_deref(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonFinding<'a> {
    id: String,
    disposition: &'static str,
    message: &'a str,
    remediation: Option<JsonRemediation<'a>>,
    automatic_remediation: Option<JsonAutomaticRemediation>,
    note: Option<&'a str>,
}

impl<'a> From<&'a DiagnosticFinding> for JsonFinding<'a> {
    fn from(finding: &'a DiagnosticFinding) -> Self {
        Self {
            id: finding.id.to_string(),
            disposition: match finding.disposition {
                FindingDisposition::Issue => "issue",
                FindingDisposition::Recommendation => "recommendation",
            },
            message: &finding.message,
            remediation: finding
                .remediation
                .as_ref()
                .map(|remediation| JsonRemediation {
                    fix: &remediation.fix,
                    config_path: remediation.config_path.as_deref(),
                }),
            automatic_remediation: finding.automatic_remediation.map(|automatic| {
                JsonAutomaticRemediation {
                    fix_id: automatic.fix_id.to_string(),
                    command: automatic.command,
                }
            }),
            note: finding.note.as_deref(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonRemediation<'a> {
    fix: &'a str,
    config_path: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonAutomaticRemediation {
    fix_id: String,
    command: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonProbeNote<'a> {
    probe: &'static str,
    status: &'static str,
    message: Option<&'a str>,
}

impl<'a> From<&'a ProbeNote> for JsonProbeNote<'a> {
    fn from(note: &'a ProbeNote) -> Self {
        Self {
            probe: note.probe,
            status: probe_status(note.status),
            message: note.message.as_deref(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonCounts {
    issues: usize,
    recommendations: usize,
    probe_notes: usize,
}

pub(super) fn terminal_name(name: TerminalName) -> &'static str {
    match name {
        TerminalName::AppleTerminal => "apple_terminal",
        TerminalName::Ghostty => "ghostty",
        TerminalName::Iterm2 => "iterm2",
        TerminalName::WarpTerminal => "warp",
        TerminalName::VsCode => "vs_code",
        TerminalName::Cursor => "cursor",
        TerminalName::Windsurf => "windsurf",
        TerminalName::Zed => "zed",
        TerminalName::WezTerm => "wezterm",
        TerminalName::Kitty => "kitty",
        TerminalName::Alacritty => "alacritty",
        TerminalName::Rio => "rio",
        TerminalName::Foot => "foot",
        TerminalName::JetBrains => "jetbrains",
        TerminalName::GrokDesktop => "grok_desktop",
        TerminalName::Vte => "vte",
        TerminalName::Terminator => "terminator",
        TerminalName::WindowsTerminal => "windows_terminal",
        TerminalName::Otty => "otty",
        TerminalName::Unknown => "unknown",
    }
}

pub(super) fn multiplexer(kind: MultiplexerKind) -> &'static str {
    match kind {
        MultiplexerKind::Tmux => "tmux",
        MultiplexerKind::Screen => "screen",
        MultiplexerKind::Zellij => "zellij",
        MultiplexerKind::Cmux => "cmux",
        MultiplexerKind::Herdr => "herdr",
        MultiplexerKind::Undetected => "undetected",
    }
}

pub(super) fn byobu_backend(backend: ByobuBackend) -> &'static str {
    match backend {
        ByobuBackend::Unknown => "unknown",
        ByobuBackend::Tmux => "tmux",
        ByobuBackend::Screen => "screen",
    }
}

pub(super) fn modifier_fate(fate: ModifierFate) -> &'static str {
    match fate {
        ModifierFate::Native => "native",
        ModifierFate::Dropped => "dropped",
        ModifierFate::Unrecoverable => "unrecoverable",
        ModifierFate::Unknown => "unknown",
        _ => "unknown",
    }
}

pub(super) fn host_os(os: HostOs) -> &'static str {
    match os {
        HostOs::Macos => "macos",
        HostOs::Linux => "linux",
        HostOs::Windows => "windows",
        HostOs::Other => "other",
        _ => "other",
    }
}

pub(super) fn native_preflight(fact: NativeClipboardPreflight) -> &'static str {
    match fact {
        NativeClipboardPreflight::Disabled => "disabled",
        NativeClipboardPreflight::LocalAvailable => "local_available",
        NativeClipboardPreflight::RemoteOnly => "remote_only",
        NativeClipboardPreflight::Unavailable => "unavailable",
    }
}

pub(super) fn osc52_capability(capability: Osc52Capability) -> &'static str {
    match capability {
        Osc52Capability::Supported => "supported",
        Osc52Capability::Unsupported => "unsupported",
        Osc52Capability::Unknown => "unknown",
    }
}

pub(super) fn display_server(server: crate::host::DisplayServer) -> &'static str {
    match server {
        crate::host::DisplayServer::Quartz => "quartz",
        crate::host::DisplayServer::Wayland => "wayland",
        crate::host::DisplayServer::X11 => "x11",
        crate::host::DisplayServer::Win32 => "win32",
        crate::host::DisplayServer::Unknown => "unknown",
        _ => "unknown",
    }
}

pub(super) fn clipboard_delivery(delivery: ClipboardDelivery) -> &'static str {
    match delivery {
        ClipboardDelivery::Confirmed => "confirmed",
        ClipboardDelivery::Unverified => "unverified",
        ClipboardDelivery::Failed => "failed",
    }
}

pub(super) fn data_control(fact: DataControlFact) -> &'static str {
    match fact {
        DataControlFact::Available => "available",
        DataControlFact::Missing => "missing",
        DataControlFact::Unavailable => "unavailable",
        DataControlFact::Error => "error",
        DataControlFact::NotApplicable => "not_applicable",
    }
}

pub(super) fn probe_status(status: ProbeStatus) -> &'static str {
    match status {
        ProbeStatus::Unsupported => "unsupported",
        ProbeStatus::Unavailable => "unavailable",
        ProbeStatus::Error => "error",
    }
}
