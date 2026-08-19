pub mod command;
pub mod http;

use std::time::Duration;

use crate::config::HookSpec;
use crate::event::HookEventEnvelope;
use serde::Deserialize;

use crate::result::{HookDecision, HttpInfo, StopHookOutcome};

/// How a hook's output is interpreted, per the event's [`GateKind`]: `Observe`
/// ignores output, `Tool` parses the allow/deny vocabulary, `Stop` the stop
/// vocabulary.
pub use crate::event::GateKind;

pub struct RunContext<'a> {
    pub session_id: &'a str,
    pub workspace_root: &'a str,
    pub process_scope: Option<xai_grok_tools::util::ProcessScope>,
}

/// Result of running a single hook (any handler type).
#[derive(Debug)]
pub enum HookRunnerResult {
    Allow {
        updated_input: Option<serde_json::Value>,
    },
    Deny {
        reason: String,
        hook_name: String,
    },
    Stop(StopHookOutcome),
    /// Non-blocking success. `additional_context` is set when an Observe-mode
    /// hook (notably `SessionStart`) emits
    /// `hookSpecificOutput.additionalContext`.
    Success {
        additional_context: Option<String>,
    },
    /// Failed: the caller fails open.
    Failed(String),
}

impl HookRunnerResult {
    /// Observe/tool success with no context payload.
    pub fn success() -> Self {
        Self::Success {
            additional_context: None,
        }
    }

    /// Observe success carrying SessionStart-style additional context.
    pub fn success_with_context(context: Option<String>) -> Self {
        Self::Success {
            additional_context: context.filter(|c| !c.trim().is_empty()),
        }
    }
}

/// JSON emitted by a `PreToolUse` gate hook. Every field is optional: `decision`
/// carries the allow/deny verdict, `reason` its message, and
/// `hookSpecificOutput.updatedInput` an optional rewrite of the tool input.
#[derive(Debug, Deserialize)]
pub(crate) struct GateHookJson {
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default, rename = "hookSpecificOutput")]
    pub hook_specific_output: Option<GateHookSpecificOutputJson>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GateHookSpecificOutputJson {
    #[serde(default, rename = "updatedInput")]
    pub updated_input: Option<serde_json::Value>,
}

impl GateHookJson {
    /// True only when the payload carries a `decision` or `hookSpecificOutput`;
    /// a stray JSON log line is not a gate document and must not read as allow.
    fn is_gate_document(&self) -> bool {
        self.decision.is_some() || self.hook_specific_output.is_some()
    }

    fn updated_input(&self, hook_name: &str) -> Option<serde_json::Value> {
        let value = self.hook_specific_output.as_ref()?.updated_input.as_ref()?;
        if value.is_object() {
            return Some(value.clone());
        }
        tracing::warn!(hook_name, "ignoring non-object `updatedInput` from hook");
        None
    }
}

/// Interpret a [`GateHookJson`] as a [`HookDecision`]. An unknown decision value
/// is an error so typos surface instead of failing open.
///
/// `fallback_reason` supplies the deny message when the JSON carries none
/// (command hooks pass the first stderr line — the hook's feedback channel;
/// HTTP hooks have no stderr and pass `None`).
pub(crate) fn gate_json_to_decision(
    json: &GateHookJson,
    hook_name: &str,
    fallback_reason: Option<&str>,
) -> Result<HookDecision, String> {
    match json.decision.as_deref() {
        Some("deny") => Ok(HookDecision::Deny {
            reason: json
                .reason
                .clone()
                .filter(|r| !r.trim().is_empty())
                .or_else(|| fallback_reason.map(str::to_string))
                .unwrap_or_else(|| format!("denied by hook '{hook_name}'")),
            hook_name: hook_name.to_string(),
        }),
        Some("allow") | None => Ok(HookDecision::Allow),
        Some(other) => Err(format!(
            "unknown decision value '{other}' from hook '{hook_name}'"
        )),
    }
}

/// JSON from `Stop`/`SubagentStop` gate hooks. All fields optional; one output
/// can combine several signals.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct StopHookJson {
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default, rename = "continue")]
    pub continue_: Option<bool>,
    #[serde(default, rename = "stopReason")]
    pub stop_reason: Option<String>,
    #[serde(default, rename = "hookSpecificOutput")]
    pub hook_specific_output: Option<StopHookSpecificOutputJson>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct StopHookSpecificOutputJson {
    /// Optional event name (SessionStart/Stop/…); accepted so house scripts
    /// can emit the documented wire shape. additionalContext is load-bearing.
    #[serde(default, rename = "hookEventName")]
    #[allow(dead_code)]
    pub hook_event_name: Option<String>,
    #[serde(default, rename = "additionalContext")]
    pub additional_context: Option<String>,
}

/// Thin observe-stdout JSON: `{"hookSpecificOutput":{"additionalContext":"…"}}`.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ObserveHookJson {
    #[serde(default, rename = "hookSpecificOutput")]
    pub hook_specific_output: Option<StopHookSpecificOutputJson>,
}

/// Extract non-empty `hookSpecificOutput.additionalContext` from observe stdout.
pub(crate) fn parse_observe_additional_context(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    let json: ObserveHookJson = serde_json::from_str(trimmed).ok()?;
    json.hook_specific_output
        .and_then(|o| o.additional_context)
        .filter(|c| !c.trim().is_empty())
}

/// Interpret a [`StopHookJson`] as a [`StopHookOutcome`].
///
/// `decision: "block"` requires a reason (a missing one falls back to a generic
/// message). `decision: "approve"` is a no-op; any other value is an error so
/// typos surface.
pub(crate) fn stop_json_to_outcome(
    json: StopHookJson,
    hook_name: &str,
) -> Result<StopHookOutcome, String> {
    let block_reason = match json.decision.as_deref() {
        Some("block") => Some(
            json.reason
                .filter(|reason| !reason.trim().is_empty())
                .unwrap_or_else(|| format!("Blocked by stop hook '{hook_name}'")),
        ),
        Some("approve") | None => None,
        Some(other) => {
            return Err(format!(
                "unknown decision value '{other}' from hook '{hook_name}'"
            ));
        }
    };
    Ok(StopHookOutcome {
        block_reason,
        additional_context: json
            .hook_specific_output
            .and_then(|output| output.additional_context)
            .filter(|context| !context.trim().is_empty()),
        force_stop: (json.continue_ == Some(false)).then_some(crate::result::StopOverride {
            reason: json.stop_reason,
        }),
    })
}

/// Each runner returns the result, wall-clock duration, and optional HTTP
/// metadata for enriched scrollback logging.
pub type HookRunOutput = (HookRunnerResult, Duration, Option<HttpInfo>);

pub async fn run_hook(
    spec: &HookSpec,
    envelope: &HookEventEnvelope,
    ctx: &RunContext<'_>,
    mode: GateKind,
) -> HookRunOutput {
    match spec.handler_type {
        crate::config::HandlerType::Command => {
            let (result, elapsed) = command::run_command_hook(spec, envelope, ctx, mode).await;
            (result, elapsed, None)
        }
        crate::config::HandlerType::Http => http::run_http_hook(spec, envelope, ctx, mode).await,
    }
}

#[cfg(test)]
mod observe_context_tests {
    use super::*;

    #[test]
    fn parse_session_start_additional_context() {
        let raw = r#"{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[HOUSE SESSION INIT]\nDue reminders: none"}}"#;
        assert_eq!(
            parse_observe_additional_context(raw).as_deref(),
            Some("[HOUSE SESSION INIT]\nDue reminders: none")
        );
    }

    #[test]
    fn parse_observe_empty_and_plain_stdout_ignored() {
        assert_eq!(parse_observe_additional_context(""), None);
        assert_eq!(parse_observe_additional_context("hello world"), None);
        assert_eq!(
            parse_observe_additional_context(
                r#"{"hookSpecificOutput":{"additionalContext":"   "}}"#
            ),
            None
        );
    }
}
