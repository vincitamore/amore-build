// Google Antigravity (Cloud Code Assist) wire adapter for `ApiBackend::Messages`.
//
// Ported from `@oh-my-pi/pi-ai` (`src/providers/google-gemini-cli.ts`,
// `src/providers/google-shared.ts`) and `@oh-my-pi/pi-catalog`
// (`src/wire/gemini-headers.ts`, `src/compat/rules/taxonomy/_collapse.kdl`).
//
// When a model entry authenticates with `api_key = "oauth:google-antigravity"`
// (or points at `daily-cloudcode-pa.googleapis.com` /
// `daily-cloudcode-pa.sandbox.googleapis.com`), requests target
// `/v1internal:streamGenerateContent?alt=sse` with the Cloud Code Assist
// request envelope (`project`, `model`, `requestId`, `userAgent: "antigravity"`,
// `requestType: "agent"`, `request.{contents, systemInstruction, generationConfig,
// tools, toolConfig, labels, sessionId}`) and translate the streamed
// `CloudCodeAssistResponseChunk` SSE events into `MessageStreamEvent` items for
// the existing `stream_messages` Layer-2 consumer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use serde::Deserialize;
use xai_grok_sampling_types::{
    ContentPart, ConversationItem, ConversationRequest, ConversationToolChoice, ReasoningEffort,
    messages::{
        ContentBlock, MessageDeltaBody, MessageDeltaUsage, MessageStreamEvent, MessagesResponse,
        MessagesUsage, StopReason, StreamDelta, StreamError,
    },
};

pub const ANTIGRAVITY_DAILY_ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";
pub const ANTIGRAVITY_SANDBOX_ENDPOINT: &str = "https://daily-cloudcode-pa.sandbox.googleapis.com";
pub const DEFAULT_ANTIGRAVITY_VERSION: &str = "2.19.1";
pub const DEFAULT_ANTIGRAVITY_CL: &str = "963137146";
pub const DEFAULT_ANTIGRAVITY_OS: &str = "darwin";
pub const DEFAULT_ANTIGRAVITY_ARCH: &str = "arm64";
pub const CLAUDE_THINKING_BETA_HEADER: &str = "interleaved-thinking-2025-05-14";
pub const SKIP_THOUGHT_SIGNATURE: &str = "skip_thought_signature_validator";

const FORCED_TOOL_DIRECTIVE: &str =
    "TOOL-ONLY TURN. This turn accepts a tool call and nothing else; a text reply here is discarded unread and you will be re-prompted. Emit the tool call now.";

static TOOL_CALL_COUNTER: AtomicU64 = AtomicU64::new(0);
static STEP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// True when `base_url` points at a Google Antigravity / Cloud Code Assist endpoint.
pub fn is_antigravity_backend_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_ascii_lowercase();
    lower.contains("daily-cloudcode-pa.googleapis.com")
        || lower.contains("daily-cloudcode-pa.sandbox.googleapis.com")
        || lower.contains("cloudcode-pa.googleapis.com")
}

/// Resolve the Cloud Code Assist streaming endpoint URL
/// (`.../v1internal:streamGenerateContent?alt=sse`).
pub fn resolve_antigravity_stream_url(base_url: &str) -> String {
    let raw = base_url.trim();
    let base = if raw.is_empty() {
        ANTIGRAVITY_DAILY_ENDPOINT
    } else {
        raw
    };
    let normalized = base.trim_end_matches('/');
    if normalized.contains("v1internal:streamGenerateContent") {
        if normalized.contains("alt=sse") {
            normalized.to_owned()
        } else if normalized.contains('?') {
            format!("{normalized}&alt=sse")
        } else {
            format!("{normalized}?alt=sse")
        }
    } else if normalized.ends_with("/v1internal") {
        format!("{normalized}:streamGenerateContent?alt=sse")
    } else {
        format!("{normalized}/v1internal:streamGenerateContent?alt=sse")
    }
}

/// Build the Antigravity `User-Agent` header value, honoring env overrides:
/// `AMORE_ANTIGRAVITY_VERSION` / `PI_AI_ANTIGRAVITY_VERSION`, `_CL`, `_OS`, `_ARCH`.
pub fn antigravity_user_agent() -> String {
    let version = std::env::var("AMORE_ANTIGRAVITY_VERSION")
        .or_else(|_| std::env::var("PI_AI_ANTIGRAVITY_VERSION"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ANTIGRAVITY_VERSION.to_owned());
    let cl = std::env::var("AMORE_ANTIGRAVITY_CL")
        .or_else(|_| std::env::var("PI_AI_ANTIGRAVITY_CL"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ANTIGRAVITY_CL.to_owned());
    let os = std::env::var("AMORE_ANTIGRAVITY_OS")
        .or_else(|_| std::env::var("PI_AI_ANTIGRAVITY_OS"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ANTIGRAVITY_OS.to_owned());
    let arch = std::env::var("AMORE_ANTIGRAVITY_ARCH")
        .or_else(|_| std::env::var("PI_AI_ANTIGRAVITY_ARCH"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ANTIGRAVITY_ARCH.to_owned());
    format!("antigravity/hub/{version} (aidev_client; os_type={os}; arch={arch}; cl={cl})")
}

/// Decoded structured Antigravity credential (`{"token":"...","projectId":"...","email":"..."}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityCredential {
    pub access_token: String,
    pub project_id: String,
    pub email: Option<String>,
}

/// Parse either a JSON-structured credential (`{"token":"...","projectId":"..."}`)
/// or a `"<token>|<projectId>"` pair.
pub fn parse_antigravity_credential(raw: &str) -> Option<AntigravityCredential> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('{') {
        let val: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        let token = val
            .get("token")
            .or_else(|| val.get("access"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_owned();
        let project_id = val
            .get("projectId")
            .or_else(|| val.get("project_id"))
            .or_else(|| val.get("account_id"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())?
            .to_owned();
        let email = val
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        return Some(AntigravityCredential {
            access_token: token,
            project_id,
            email,
        });
    }
    if let Some((tok, proj)) = trimmed.split_once('|') {
        let tok = tok.trim();
        let proj = proj.trim();
        if !tok.is_empty() && !proj.is_empty() {
            return Some(AntigravityCredential {
                access_token: tok.to_owned(),
                project_id: proj.to_owned(),
                email: None,
            });
        }
    }
    None
}

/// Per-wire-id request profile on `daily-cloudcode-pa`.
#[derive(Debug, Clone, Copy)]
pub struct AntigravityWireProfile {
    pub model_enum: Option<&'static str>,
    pub max_output_tokens: u32,
}

pub fn wire_profile(wire_model_id: &str) -> Option<AntigravityWireProfile> {
    match wire_model_id {
        "gemini-3.5-flash-extra-low" => Some(AntigravityWireProfile {
            model_enum: Some("MODEL_PLACEHOLDER_M187"),
            max_output_tokens: 65_536,
        }),
        "gemini-3.5-flash-low" => Some(AntigravityWireProfile {
            model_enum: Some("MODEL_PLACEHOLDER_M20"),
            max_output_tokens: 65_536,
        }),
        "gemini-3-flash-agent" => Some(AntigravityWireProfile {
            model_enum: Some("MODEL_PLACEHOLDER_M132"),
            max_output_tokens: 65_536,
        }),
        "gemini-3.1-pro-low" => Some(AntigravityWireProfile {
            model_enum: Some("MODEL_PLACEHOLDER_M36"),
            max_output_tokens: 65_535,
        }),
        "gemini-pro-agent" => Some(AntigravityWireProfile {
            model_enum: Some("MODEL_PLACEHOLDER_M16"),
            max_output_tokens: 65_535,
        }),
        "claude-sonnet-4-6" | "claude-opus-4-6-thinking" => Some(AntigravityWireProfile {
            model_enum: None,
            max_output_tokens: 64_000,
        }),
        _ => None,
    }
}

pub fn is_claude_model(model_id: &str) -> bool {
    model_id.trim().to_ascii_lowercase().contains("claude")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThinkingTransport {
    None,
    Level(&'static str),
    Budget(u32),
    SuppressLevel(&'static str),
    SuppressBudget(u32),
}

/// Resolve the upstream Cloud Code Assist wire model ID and thinking transport
/// from a logical or explicit wire model ID and optional `ReasoningEffort`.
pub fn resolve_wire_model_and_thinking(
    model_id: &str,
    effort: Option<ReasoningEffort>,
) -> (String, ThinkingTransport) {
    let trimmed = model_id.trim();
    let lower = trimmed.to_ascii_lowercase();

    let is_off = matches!(effort, Some(ReasoningEffort::None));
    let eff = effort.filter(|e| !matches!(e, ReasoningEffort::None));

    match lower.as_str() {
        "gemini-3.5-flash" | "gemini-3-flash" => {
            if is_off {
                return (
                    "gemini-3.5-flash-extra-low".to_owned(),
                    ThinkingTransport::SuppressBudget(0),
                );
            }
            let e = eff.unwrap_or(ReasoningEffort::Medium);
            match e {
                ReasoningEffort::Minimal | ReasoningEffort::Low => (
                    "gemini-3.5-flash-extra-low".to_owned(),
                    ThinkingTransport::Budget(1_000),
                ),
                ReasoningEffort::Medium => (
                    "gemini-3.5-flash-low".to_owned(),
                    ThinkingTransport::Budget(4_000),
                ),
                ReasoningEffort::High | ReasoningEffort::Xhigh | ReasoningEffort::Max => (
                    "gemini-3-flash-agent".to_owned(),
                    ThinkingTransport::Budget(10_000),
                ),
                ReasoningEffort::None => unreachable!(),
            }
        }
        "gemini-3.1-pro" => {
            if is_off {
                return (
                    "gemini-3.1-pro-low".to_owned(),
                    ThinkingTransport::SuppressBudget(0),
                );
            }
            let e = eff.unwrap_or(ReasoningEffort::High);
            match e {
                ReasoningEffort::Minimal | ReasoningEffort::Low => (
                    "gemini-3.1-pro-low".to_owned(),
                    ThinkingTransport::Budget(1_001),
                ),
                _ => (
                    "gemini-pro-agent".to_owned(),
                    ThinkingTransport::Budget(10_001),
                ),
            }
        }
        "gemini-3-pro" => {
            if is_off {
                return (
                    "gemini-3-pro-low".to_owned(),
                    ThinkingTransport::SuppressLevel("MINIMAL"),
                );
            }
            let e = eff.unwrap_or(ReasoningEffort::High);
            match e {
                ReasoningEffort::Minimal | ReasoningEffort::Low => (
                    "gemini-3-pro-low".to_owned(),
                    ThinkingTransport::Level("LOW"),
                ),
                _ => (
                    "gemini-3-pro-high".to_owned(),
                    ThinkingTransport::Level("HIGH"),
                ),
            }
        }
        "gemini-4-argon" => {
            let e = eff.unwrap_or(ReasoningEffort::High);
            match e {
                ReasoningEffort::Minimal | ReasoningEffort::Low => (
                    "gemini-4-argon-low".to_owned(),
                    ThinkingTransport::Level("LOW"),
                ),
                ReasoningEffort::Medium => (
                    "gemini-4-argon-medium".to_owned(),
                    ThinkingTransport::Level("MEDIUM"),
                ),
                _ => (
                    "gemini-4-argon-high".to_owned(),
                    ThinkingTransport::Level("HIGH"),
                ),
            }
        }
        "claude-opus-4-6" | "claude-opus-4-6-thinking" => {
            let budget = effort_budget_for_claude(eff);
            (
                "claude-opus-4-6-thinking".to_owned(),
                budget.map_or(ThinkingTransport::None, ThinkingTransport::Budget),
            )
        }
        "claude-sonnet-4-6" | "claude-sonnet-4-6-thinking" => {
            let budget = effort_budget_for_claude(eff);
            (
                "claude-sonnet-4-6".to_owned(),
                budget.map_or(ThinkingTransport::None, ThinkingTransport::Budget),
            )
        }
        "claude-opus-4-5" => {
            if is_off || eff.is_none() {
                ("claude-opus-4-5".to_owned(), ThinkingTransport::None)
            } else {
                let budget = effort_budget_for_claude(eff);
                (
                    "claude-opus-4-5-thinking".to_owned(),
                    budget.map_or(ThinkingTransport::None, ThinkingTransport::Budget),
                )
            }
        }
        "claude-sonnet-4-5" => {
            if is_off || eff.is_none() {
                ("claude-sonnet-4-5".to_owned(), ThinkingTransport::None)
            } else {
                let budget = effort_budget_for_claude(eff);
                (
                    "claude-sonnet-4-5-thinking".to_owned(),
                    budget.map_or(ThinkingTransport::None, ThinkingTransport::Budget),
                )
            }
        }
        "claude-opus-5-5" => {
            let e = eff.unwrap_or(ReasoningEffort::High);
            let suffix = match e {
                ReasoningEffort::Minimal | ReasoningEffort::Low => "low",
                ReasoningEffort::Medium => "medium",
                _ => "high",
            };
            let budget = effort_budget_for_claude(Some(e)).unwrap_or(16_384);
            (
                format!("claude-opus-5-5-{suffix}"),
                ThinkingTransport::Budget(budget),
            )
        }
        "claude-sonnet-5-5" => {
            let e = eff.unwrap_or(ReasoningEffort::High);
            let suffix = match e {
                ReasoningEffort::Minimal | ReasoningEffort::Low => "low",
                ReasoningEffort::Medium => "medium",
                _ => "high",
            };
            let budget = effort_budget_for_claude(Some(e)).unwrap_or(16_384);
            (
                format!("claude-sonnet-5-5-{suffix}"),
                ThinkingTransport::Budget(budget),
            )
        }
        "gemini-2.5-flash" => {
            if is_off || eff.is_none() {
                ("gemini-2.5-flash".to_owned(), ThinkingTransport::None)
            } else {
                let budget = match eff.unwrap_or(ReasoningEffort::Medium) {
                    ReasoningEffort::Minimal => 1_024,
                    ReasoningEffort::Low => 2_048,
                    ReasoningEffort::Medium => 8_192,
                    _ => 24_576,
                };
                (
                    "gemini-2.5-flash-thinking".to_owned(),
                    ThinkingTransport::Budget(budget),
                )
            }
        }
        _ => {
            // Check gemini-{rev}-flash pattern (e.g. gemini-3.6-flash, gemini-3.7-flash)
            if let Some(rev) = lower
                .strip_prefix("gemini-")
                .and_then(|s| s.strip_suffix("-flash"))
                && rev
                    .parse::<f32>()
                    .is_ok_and(|v| v >= 3.6)
            {
                let e = eff.unwrap_or(ReasoningEffort::Medium);
                return match e {
                    ReasoningEffort::Minimal | ReasoningEffort::Low => (
                        format!("gemini-{rev}-flash-low"),
                        ThinkingTransport::Level("LOW"),
                    ),
                    ReasoningEffort::Medium => (
                        format!("gemini-{rev}-flash-medium"),
                        ThinkingTransport::Level("MEDIUM"),
                    ),
                    _ => (
                        format!("gemini-{rev}-flash-high"),
                        ThinkingTransport::Level("HIGH"),
                    ),
                };
            }

            // Explicit wire ID passed directly
            if is_claude_model(&lower) {
                let budget = effort_budget_for_claude(eff);
                (
                    trimmed.to_owned(),
                    budget.map_or(ThinkingTransport::None, ThinkingTransport::Budget),
                )
            } else if let Some(e) = eff {
                let level = match e {
                    ReasoningEffort::Minimal => "MINIMAL",
                    ReasoningEffort::Low => "LOW",
                    ReasoningEffort::Medium => "MEDIUM",
                    ReasoningEffort::High | ReasoningEffort::Xhigh | ReasoningEffort::Max => "HIGH",
                    ReasoningEffort::None => "MINIMAL",
                };
                (trimmed.to_owned(), ThinkingTransport::Level(level))
            } else {
                (trimmed.to_owned(), ThinkingTransport::None)
            }
        }
    }
}

fn effort_budget_for_claude(effort: Option<ReasoningEffort>) -> Option<u32> {
    match effort? {
        ReasoningEffort::None => None,
        ReasoningEffort::Minimal => Some(1_024),
        ReasoningEffort::Low => Some(4_096),
        ReasoningEffort::Medium => Some(10_240),
        ReasoningEffort::High => Some(16_384),
        ReasoningEffort::Xhigh | ReasoningEffort::Max => Some(31_999),
    }
}

/// Apply the Google Antigravity header set onto `headers`, replacing any
/// structured JSON credential in `Authorization` with `Bearer <access_token>`
/// and stripping `x-grok-*` and `x-api-key` headers.
pub fn apply_antigravity_headers(
    headers: &mut HeaderMap,
    access_token: &str,
    wire_model_id: &str,
    has_thinking: bool,
) {
    let strip: Vec<HeaderName> = headers
        .keys()
        .filter(|k| {
            let name = k.as_str();
            name.starts_with("x-grok")
                || name.eq_ignore_ascii_case("x-api-key")
                || name.eq_ignore_ascii_case("x-session-id")
        })
        .cloned()
        .collect();
    for name in strip {
        headers.remove(&name);
    }

    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {access_token}")) {
        headers.insert(AUTHORIZATION, v);
    }
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    if let Ok(ua) = HeaderValue::from_str(&antigravity_user_agent()) {
        headers.insert(USER_AGENT, ua);
    }
    if is_claude_model(wire_model_id) && has_thinking {
        headers.insert(
            HeaderName::from_static("anthropic-beta"),
            HeaderValue::from_static(CLAUDE_THINKING_BETA_HEADER),
        );
    }
}

fn derive_signed_decimal_session_id(seed: &str) -> String {
    let digest = blake3::hash(seed.as_bytes());
    let mut prefix = [0u8; 8];
    if let Some(first8) = digest.as_bytes().get(..8) {
        prefix.copy_from_slice(first8);
    }
    let mut val = u64::from_be_bytes(prefix);
    val &= (1u64 << 63) - 1;
    if val == 0 {
        val = 1;
    }
    format!("-{val}")
}

fn sanitize_tool_call_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        format!("call_{}", TOOL_CALL_COUNTER.fetch_add(1, Ordering::Relaxed) + 1)
    } else {
        cleaned
    }
}

fn is_valid_base64_signature(sig: &str) -> bool {
    !sig.is_empty()
        && sig.len().is_multiple_of(4)
        && sig
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Sanitize a JSON Schema for Cloud Code Assist (`parameters` / `parametersJsonSchema`).
/// Strips unsupported meta/validation keywords (`$schema`, `$id`, `$ref`, `$defs`,
/// `additionalProperties`, etc.) and converts scalar `["T", "null"]` type arrays.
pub fn sanitize_schema_for_cca(schema: &serde_json::Value, is_claude: bool) -> serde_json::Value {
    sanitize_schema_node(schema, is_claude, false)
}

fn is_unsupported_cca_field(key: &str) -> bool {
    matches!(
        key,
        "$schema"
            | "$id"
            | "$anchor"
            | "$ref"
            | "$defs"
            | "definitions"
            | "$dynamicRef"
            | "$dynamicAnchor"
            | "examples"
            | "prefixItems"
            | "unevaluatedProperties"
            | "unevaluatedItems"
            | "patternProperties"
            | "additionalProperties"
            | "propertyNames"
            | "minItems"
            | "maxItems"
            | "uniqueItems"
            | "contains"
            | "minContains"
            | "maxContains"
            | "additionalItems"
            | "minLength"
            | "maxLength"
            | "minimum"
            | "maximum"
            | "exclusiveMinimum"
            | "exclusiveMaximum"
            | "multipleOf"
            | "pattern"
            | "format"
            | "contentEncoding"
            | "contentMediaType"
            | "contentSchema"
            | "dependencies"
            | "dependentSchemas"
            | "dependentRequired"
            | "x-mcp-header"
            | "deprecated"
            | "readOnly"
            | "writeOnly"
            | "$comment"
    )
}

fn sanitize_schema_node(
    value: &serde_json::Value,
    is_claude: bool,
    inside_properties_map: bool,
) -> serde_json::Value {
    match value {
        serde_json::Value::Array(arr) => serde_json::Value::Array(
            arr.iter()
                .map(|v| sanitize_schema_node(v, is_claude, false))
                .collect(),
        ),
        serde_json::Value::Bool(b) => {
            if !inside_properties_map {
                serde_json::json!({})
            } else {
                serde_json::Value::Bool(*b)
            }
        }
        serde_json::Value::Object(map) => {
            if inside_properties_map {
                let mut out = serde_json::Map::new();
                for (k, v) in map {
                    out.insert(k.clone(), sanitize_schema_node(v, is_claude, false));
                }
                return serde_json::Value::Object(out);
            }

            let mut out = serde_json::Map::new();
            let mut nullable = false;

            for (raw_key, val) in map {
                let key = match raw_key.as_str() {
                    "additional_properties" => "additionalProperties",
                    "any_of" => "anyOf",
                    "prefix_items" => "prefixItems",
                    "property_ordering" => "propertyOrdering",
                    other => other,
                };
                if is_unsupported_cca_field(key) {
                    continue;
                }
                if is_claude && key == "nullable" {
                    continue;
                }
                if key == "const" {
                    out.insert("enum".to_owned(), serde_json::json!([val]));
                    continue;
                }
                if key == "type"
                    && let Some(arr) = val.as_array()
                {
                    let types: Vec<&str> = arr.iter().filter_map(|t| t.as_str()).collect();
                    if types.contains(&"null") {
                        nullable = true;
                    }
                    let chosen = types
                        .iter()
                        .copied()
                        .find(|t| *t != "null")
                        .or_else(|| types.first().copied())
                        .unwrap_or("string");
                    out.insert("type".to_owned(), serde_json::Value::String(chosen.to_owned()));
                    continue;
                }
                let is_props = key == "properties";
                out.insert(
                    key.to_owned(),
                    sanitize_schema_node(val, is_claude, is_props),
                );
            }

            if nullable && !is_claude {
                out.insert("nullable".to_owned(), serde_json::Value::Bool(true));
            }
            if out.get("type").and_then(|v| v.as_str()) == Some("object")
                && !out.contains_key("properties")
            {
                out.insert("properties".to_owned(), serde_json::json!({}));
            }

            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

fn content_part_to_gemini_part(part: &ContentPart) -> Option<serde_json::Value> {
    match part {
        ContentPart::Text { text } => {
            if text.trim().is_empty() {
                None
            } else {
                Some(serde_json::json!({ "text": text.as_ref() }))
            }
        }
        ContentPart::Image { url } => {
            if let Some(rest) = url.strip_prefix("data:")
                && let Some((media_type, data)) = rest.split_once(";base64,")
            {
                return Some(serde_json::json!({
                    "inlineData": {
                        "mimeType": if media_type.is_empty() { "image/png" } else { media_type },
                        "data": data,
                    }
                }));
            }
            Some(serde_json::json!({
                "fileData": {
                    "fileUri": url.as_ref(),
                    "mimeType": "image/png",
                }
            }))
        }
    }
}

/// Build the Cloud Code Assist JSON request body from a [`ConversationRequest`].
/// Returns `(body, wire_model_id, has_thinking)`.
pub fn build_antigravity_request_body(
    req: &ConversationRequest,
    project_id: &str,
    default_model: &str,
    default_max_tokens: Option<u32>,
    default_temperature: Option<f32>,
    default_top_p: Option<f32>,
    default_effort: Option<ReasoningEffort>,
) -> (serde_json::Value, String, bool) {
    let raw_model = req
        .model
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(default_model);
    let effort = req.reasoning_effort.or(default_effort);
    let (wire_model_id, thinking_transport) = resolve_wire_model_and_thinking(raw_model, effort);
    let is_claude = is_claude_model(&wire_model_id);

    let mut system_parts: Vec<serde_json::Value> = Vec::new();
    let mut contents: Vec<serde_json::Value> = Vec::new();
    let mut pending_model_parts: Vec<serde_json::Value> = Vec::new();
    let mut pending_tool_response_parts: Vec<serde_json::Value> = Vec::new();
    let mut pending_reasoning: Vec<(String, Option<String>)> = Vec::new();
    let mut emitted_tool_names: HashMap<String, String> = HashMap::new();
    let mut first_user_text: Option<String> = None;

    let flush_model =
        |pending: &mut Vec<serde_json::Value>, out: &mut Vec<serde_json::Value>| {
            if !pending.is_empty() {
                out.push(serde_json::json!({
                    "role": "model",
                    "parts": std::mem::take(pending),
                }));
            }
        };

    let flush_tool_responses =
        |pending: &mut Vec<serde_json::Value>, out: &mut Vec<serde_json::Value>| {
            if !pending.is_empty() {
                out.push(serde_json::json!({
                    "role": "user",
                    "parts": std::mem::take(pending),
                }));
            }
        };

    for item in &req.items {
        match item {
            ConversationItem::System(s) => {
                flush_model(&mut pending_model_parts, &mut contents);
                flush_tool_responses(&mut pending_tool_response_parts, &mut contents);
                pending_reasoning.clear();
                if !s.content.trim().is_empty() {
                    system_parts.push(serde_json::json!({ "text": s.content.as_ref() }));
                }
            }
            ConversationItem::User(u) => {
                flush_model(&mut pending_model_parts, &mut contents);
                flush_tool_responses(&mut pending_tool_response_parts, &mut contents);
                pending_reasoning.clear();
                let mut parts = Vec::new();
                for part in &u.content {
                    if first_user_text.is_none()
                        && let ContentPart::Text { text } = part
                        && !text.trim().is_empty()
                    {
                        first_user_text = Some(text.as_ref().to_owned());
                    }
                    if let Some(p) = content_part_to_gemini_part(part) {
                        parts.push(p);
                    }
                }
                if !parts.is_empty() {
                    contents.push(serde_json::json!({
                        "role": "user",
                        "parts": parts,
                    }));
                }
            }
            ConversationItem::Reasoning(r) => {
                flush_tool_responses(&mut pending_tool_response_parts, &mut contents);
                let text = xai_grok_sampling_types::reasoning_item_text(r);
                let sig = r
                    .encrypted_content
                    .as_deref()
                    .filter(|s| is_valid_base64_signature(s))
                    .map(str::to_owned);
                if !text.trim().is_empty() || sig.is_some() {
                    pending_reasoning.push((text, sig));
                }
            }
            ConversationItem::Assistant(a) => {
                flush_tool_responses(&mut pending_tool_response_parts, &mut contents);

                let mut trailing_sig: Option<String> = None;
                for (thought_text, sig) in pending_reasoning.drain(..) {
                    if is_claude && sig.is_none() {
                        // Cloud Code Assist Claude drops unsigned thinking blocks (`drop-unsigned-thinking`).
                        continue;
                    }
                    if thought_text.trim().is_empty() {
                        if let Some(s) = sig {
                            trailing_sig = Some(s);
                        }
                        continue;
                    }
                    let mut part = serde_json::Map::new();
                    part.insert("thought".to_owned(), serde_json::Value::Bool(true));
                    part.insert("text".to_owned(), serde_json::Value::String(thought_text));
                    if let Some(s) = sig {
                        part.insert("thoughtSignature".to_owned(), serde_json::Value::String(s));
                    }
                    pending_model_parts.push(serde_json::Value::Object(part));
                }

                if !a.content.trim().is_empty() {
                    let mut part = serde_json::Map::new();
                    part.insert(
                        "text".to_owned(),
                        serde_json::Value::String(a.content.as_ref().to_owned()),
                    );
                    if a.tool_calls.is_empty()
                        && let Some(sig) = trailing_sig.take()
                    {
                        part.insert(
                            "thoughtSignature".to_owned(),
                            serde_json::Value::String(sig),
                        );
                    }
                    pending_model_parts.push(serde_json::Value::Object(part));
                }

                let mut is_first_tool = true;
                for tc in &a.tool_calls {
                    let clean_id = sanitize_tool_call_id(&tc.id);
                    emitted_tool_names.insert(clean_id.clone(), tc.name.clone());
                    let args: serde_json::Value =
                        serde_json::from_str::<serde_json::Value>(&tc.arguments)
                            .ok()
                            .filter(serde_json::Value::is_object)
                            .unwrap_or_else(|| serde_json::json!({}));

                    let mut fc = serde_json::Map::new();
                    fc.insert(
                        "name".to_owned(),
                        serde_json::Value::String(tc.name.clone()),
                    );
                    fc.insert("args".to_owned(), args);
                    if is_claude {
                        fc.insert("id".to_owned(), serde_json::Value::String(clean_id));
                    }

                    let mut part = serde_json::Map::new();
                    part.insert("functionCall".to_owned(), serde_json::Value::Object(fc));
                    if let Some(sig) = trailing_sig.take() {
                        part.insert(
                            "thoughtSignature".to_owned(),
                            serde_json::Value::String(sig),
                        );
                    } else if is_first_tool && !is_claude {
                        part.insert(
                            "thoughtSignature".to_owned(),
                            serde_json::Value::String(SKIP_THOUGHT_SIGNATURE.to_owned()),
                        );
                    }
                    is_first_tool = false;
                    pending_model_parts.push(serde_json::Value::Object(part));
                }

                flush_model(&mut pending_model_parts, &mut contents);
            }
            ConversationItem::ToolResult(t) => {
                flush_model(&mut pending_model_parts, &mut contents);
                pending_reasoning.clear();
                let clean_id = sanitize_tool_call_id(&t.tool_call_id);
                let tool_name = emitted_tool_names
                    .get(&clean_id)
                    .cloned()
                    .unwrap_or_else(|| "tool".to_owned());
                let mut fr = serde_json::Map::new();
                fr.insert("name".to_owned(), serde_json::Value::String(tool_name));
                fr.insert(
                    "response".to_owned(),
                    serde_json::json!({ "output": t.content.as_ref() }),
                );
                if is_claude {
                    fr.insert("id".to_owned(), serde_json::Value::String(clean_id));
                }
                if !t.images.is_empty() {
                    let img_parts: Vec<serde_json::Value> = t
                        .images
                        .iter()
                        .filter_map(content_part_to_gemini_part)
                        .collect();
                    if !img_parts.is_empty() {
                        fr.insert("parts".to_owned(), serde_json::Value::Array(img_parts));
                    }
                }
                pending_tool_response_parts.push(serde_json::json!({
                    "functionResponse": serde_json::Value::Object(fr),
                }));
            }
            ConversationItem::BackendToolCall(b) => {
                flush_tool_responses(&mut pending_tool_response_parts, &mut contents);
                pending_model_parts.push(serde_json::json!({
                    "text": b.text_summary(),
                }));
            }
        }
    }

    flush_model(&mut pending_model_parts, &mut contents);
    flush_tool_responses(&mut pending_tool_response_parts, &mut contents);

    let mut request_obj = serde_json::Map::new();

    if !system_parts.is_empty() {
        request_obj.insert(
            "systemInstruction".to_owned(),
            serde_json::json!({
                "role": "user",
                "parts": system_parts,
            }),
        );
    }

    // Tool declarations and toolConfig
    let mut forced_any_tool = false;
    if !req.tools.is_empty() {
        let declarations: Vec<serde_json::Value> = req
            .tools
            .iter()
            .map(|t| {
                let sanitized = sanitize_schema_for_cca(&t.parameters, is_claude);
                serde_json::json!({
                    "name": t.name,
                    "description": t.description.as_deref().unwrap_or(""),
                    "parameters": sanitized,
                })
            })
            .collect();
        request_obj.insert(
            "tools".to_owned(),
            serde_json::json!([{ "functionDeclarations": declarations }]),
        );

        let tool_config = match &req.tool_choice {
            Some(ConversationToolChoice::None) => Some(serde_json::json!({
                "functionCallingConfig": { "mode": "NONE" }
            })),
            Some(ConversationToolChoice::Required) => {
                forced_any_tool = true;
                Some(serde_json::json!({
                    "functionCallingConfig": { "mode": "ANY" }
                }))
            }
            Some(ConversationToolChoice::Function(name)) => {
                forced_any_tool = true;
                Some(serde_json::json!({
                    "functionCallingConfig": {
                        "mode": "ANY",
                        "allowedFunctionNames": [name],
                    }
                }))
            }
            Some(ConversationToolChoice::Auto) | None => Some(serde_json::json!({
                "functionCallingConfig": { "mode": "VALIDATED" }
            })),
        };
        if let Some(tc) = tool_config {
            request_obj.insert("toolConfig".to_owned(), tc);
        }
    } else if is_claude {
        // Claude on Antigravity always forces VALIDATED even with no tools declared.
        request_obj.insert(
            "toolConfig".to_owned(),
            serde_json::json!({
                "functionCallingConfig": { "mode": "VALIDATED" }
            }),
        );
    }

    if forced_any_tool && !is_claude {
        contents.push(serde_json::json!({
            "role": "user",
            "parts": [{ "text": FORCED_TOOL_DIRECTIVE }],
        }));
    }

    request_obj.insert("contents".to_owned(), serde_json::Value::Array(contents));

    // Generation config
    let mut gen_config = serde_json::Map::new();
    if let Some(temp) = req.temperature.or(default_temperature) {
        gen_config.insert("temperature".to_owned(), serde_json::json!(temp));
    }
    if let Some(top_p) = req.top_p.or(default_top_p) {
        gen_config.insert("topP".to_owned(), serde_json::json!(top_p));
    }

    let profile = wire_profile(&wire_model_id);
    let max_out = profile
        .map(|p| p.max_output_tokens)
        .or(req.max_output_tokens)
        .or(default_max_tokens)
        .unwrap_or(if is_claude { 64_000 } else { 65_535 });
    let clamped_max_out = if is_claude {
        max_out.min(64_000)
    } else {
        max_out
    };
    gen_config.insert(
        "maxOutputTokens".to_owned(),
        serde_json::json!(clamped_max_out),
    );

    let has_thinking = match thinking_transport {
        ThinkingTransport::None => false,
        ThinkingTransport::Level(level) => {
            gen_config.insert(
                "thinkingConfig".to_owned(),
                serde_json::json!({
                    "includeThoughts": true,
                    "thinkingLevel": level,
                }),
            );
            true
        }
        ThinkingTransport::Budget(budget) => {
            let safe_budget = if clamped_max_out > 1_024 {
                budget.min(clamped_max_out.saturating_sub(1_024))
            } else {
                budget
            };
            gen_config.insert(
                "thinkingConfig".to_owned(),
                serde_json::json!({
                    "includeThoughts": true,
                    "thinkingBudget": safe_budget,
                }),
            );
            true
        }
        ThinkingTransport::SuppressLevel(level) => {
            gen_config.insert(
                "thinkingConfig".to_owned(),
                serde_json::json!({
                    "includeThoughts": false,
                    "thinkingLevel": level,
                }),
            );
            false
        }
        ThinkingTransport::SuppressBudget(budget) => {
            gen_config.insert(
                "thinkingConfig".to_owned(),
                serde_json::json!({
                    "includeThoughts": false,
                    "thinkingBudget": budget,
                }),
            );
            false
        }
    };

    request_obj.insert(
        "generationConfig".to_owned(),
        serde_json::Value::Object(gen_config),
    );

    // Session & envelope metadata (`sessionId`, `requestId`, `labels`)
    let session_seed = req
        .x_grok_session_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| req.x_grok_conv_id.as_deref().filter(|s| !s.is_empty()))
        .or(first_user_text.as_deref())
        .unwrap_or("antigravity-session");
    let session_id = derive_signed_decimal_session_id(session_seed);
    let step = STEP_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let agent_id = uuid::Uuid::new_v4().to_string();
    let trajectory_id = uuid::Uuid::new_v4().to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let request_id = format!("agent/{agent_id}/{now_ms}/{trajectory_id}/{step}");

    let mut labels = serde_json::Map::new();
    labels.insert(
        "last_step_index".to_owned(),
        serde_json::Value::String((step - 1).to_string()),
    );
    if let Some(model_enum) = profile.and_then(|p| p.model_enum) {
        labels.insert(
            "model_enum".to_owned(),
            serde_json::Value::String(model_enum.to_owned()),
        );
    }
    labels.insert(
        "trajectory_id".to_owned(),
        serde_json::Value::String(trajectory_id),
    );
    let used_claude = if is_claude { "true" } else { "false" };
    labels.insert(
        "used_claude".to_owned(),
        serde_json::Value::String(used_claude.to_owned()),
    );
    labels.insert(
        "used_claude_conservative".to_owned(),
        serde_json::Value::String(used_claude.to_owned()),
    );

    request_obj.insert("labels".to_owned(), serde_json::Value::Object(labels));
    request_obj.insert(
        "sessionId".to_owned(),
        serde_json::Value::String(session_id),
    );

    let outer = serde_json::json!({
        "project": project_id,
        "requestId": request_id,
        "request": serde_json::Value::Object(request_obj),
        "model": wire_model_id,
        "userAgent": "antigravity",
        "requestType": "agent",
    });

    (outer, wire_model_id, has_thinking)
}

// ============================================================================
// Cloud Code Assist SSE -> MessageStreamEvent translator
// ============================================================================

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaChunk {
    #[serde(default)]
    response: Option<CcaResponse>,
    #[serde(default)]
    error: Option<CcaError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaResponse {
    #[serde(default)]
    candidates: Option<Vec<CcaCandidate>>,
    #[serde(default)]
    usage_metadata: Option<CcaUsageMetadata>,
    #[serde(default)]
    model_version: Option<String>,
    #[serde(default)]
    response_id: Option<String>,
    #[serde(default)]
    prompt_feedback: Option<CcaPromptFeedback>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaCandidate {
    #[serde(default)]
    content: Option<CcaContent>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaContent {
    #[serde(default)]
    parts: Option<Vec<CcaPart>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaPart {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    thought: Option<bool>,
    #[serde(default)]
    thought_signature: Option<String>,
    #[serde(default)]
    function_call: Option<CcaFunctionCall>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaFunctionCall {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    args: Option<serde_json::Value>,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaUsageMetadata {
    #[serde(default)]
    prompt_token_count: Option<u32>,
    #[serde(default)]
    candidates_token_count: Option<u32>,
    #[serde(default)]
    thoughts_token_count: Option<u32>,
    #[serde(default)]
    total_token_count: Option<u32>,
    #[serde(default)]
    cached_content_token_count: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CcaPromptFeedback {
    #[serde(default)]
    block_reason: Option<String>,
    #[serde(default)]
    block_reason_message: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CcaError {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveBlockKind {
    Thinking,
    Text,
}

/// Stateful per-stream translator converting Cloud Code Assist SSE JSON frames
/// into Anthropic [`MessageStreamEvent`]s so `stream_messages` can consume them
/// directly.
#[derive(Debug)]
pub struct AntigravitySseTranslator {
    model_id: String,
    started: bool,
    finished: bool,
    next_block_index: u32,
    active_block: Option<(u32, ActiveBlockKind)>,
    seen_tool_ids: Vec<String>,
    unattributed_signature: Option<String>,
    input_tokens: u32,
    output_tokens: u32,
    cache_read_tokens: u32,
    stop_reason: Option<StopReason>,
}

impl AntigravitySseTranslator {
    pub fn new(model_id: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
            started: false,
            finished: false,
            next_block_index: 0,
            active_block: None,
            seen_tool_ids: Vec::new(),
            unattributed_signature: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            stop_reason: None,
        }
    }

    fn ensure_message_start(
        &mut self,
        response: &CcaResponse,
        out: &mut Vec<MessageStreamEvent>,
    ) {
        if self.started {
            return;
        }
        self.started = true;
        let id = response
            .response_id
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4()));
        let model = response
            .model_version
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.model_id.clone());
        out.push(MessageStreamEvent::MessageStart {
            message: MessagesResponse {
                id,
                r#type: "message".to_owned(),
                role: "assistant".to_owned(),
                content: Vec::new(),
                model,
                stop_reason: None,
                usage: MessagesUsage {
                    input_tokens: self.input_tokens,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: self.cache_read_tokens,
                },
            },
        });
    }

    fn close_active_block(&mut self, out: &mut Vec<MessageStreamEvent>) {
        if let Some((idx, _)) = self.active_block.take() {
            out.push(MessageStreamEvent::ContentBlockStop { index: idx });
        }
    }

    fn ensure_open_block(
        &mut self,
        kind: ActiveBlockKind,
        out: &mut Vec<MessageStreamEvent>,
    ) -> u32 {
        if let Some((idx, current_kind)) = self.active_block {
            if current_kind == kind {
                return idx;
            }
            self.close_active_block(out);
        }
        let idx = self.next_block_index;
        self.next_block_index += 1;
        let content_block = match kind {
            ActiveBlockKind::Thinking => ContentBlock::Thinking {
                thinking: String::new(),
                signature: String::new(),
            },
            ActiveBlockKind::Text => ContentBlock::Text {
                text: String::new(),
                cache_control: None,
            },
        };
        out.push(MessageStreamEvent::ContentBlockStart {
            index: idx,
            content_block,
        });
        self.active_block = Some((idx, kind));
        idx
    }

    fn update_usage(&mut self, meta: &CcaUsageMetadata) {
        let candidates = meta.candidates_token_count.unwrap_or(0);
        let thoughts = meta.thoughts_token_count.unwrap_or(0);
        let total = meta.total_token_count.unwrap_or(0);
        let prompt = meta
            .prompt_token_count
            .unwrap_or_else(|| total.saturating_sub(candidates.saturating_add(thoughts)));
        let cache_read = meta.cached_content_token_count.unwrap_or(0).min(prompt);
        self.input_tokens = prompt.saturating_sub(cache_read);
        self.cache_read_tokens = cache_read;
        self.output_tokens = candidates.saturating_add(thoughts);
    }

    /// Translate one SSE `data` frame into zero or more [`MessageStreamEvent`]s.
    pub fn push_chunk(
        &mut self,
        data: &str,
    ) -> std::result::Result<Vec<MessageStreamEvent>, serde_json::Error> {
        let chunk: CcaChunk = serde_json::from_str(data)?;
        let mut out = Vec::new();

        if let Some(err) = chunk.error {
            let detail = err
                .message
                .or(err.status)
                .unwrap_or_else(|| "unknown error".to_owned());
            let code_prefix = err.code.map(|c| format!("{c}: ")).unwrap_or_default();
            out.push(MessageStreamEvent::Error {
                error: StreamError {
                    r#type: "api_error".to_owned(),
                    message: format!("Cloud Code Assist stream error: {code_prefix}{detail}"),
                },
            });
            self.finished = true;
            return Ok(out);
        }

        let Some(resp) = chunk.response else {
            return Ok(out);
        };

        if let Some(meta) = resp.usage_metadata.as_ref() {
            self.update_usage(meta);
        }

        let has_candidates = resp
            .candidates
            .as_ref()
            .is_some_and(|c| !c.is_empty());
        if !has_candidates
            && let Some(feedback) = resp.prompt_feedback.as_ref()
            && let Some(reason) = feedback.block_reason.as_deref()
        {
            let detail = feedback
                .block_reason_message
                .as_deref()
                .map(|m| format!(": {m}"))
                .unwrap_or_default();
            out.push(MessageStreamEvent::Error {
                error: StreamError {
                    r#type: "content_blocked".to_owned(),
                    message: format!("Request blocked by Google ({reason}){detail}"),
                },
            });
            self.finished = true;
            return Ok(out);
        }

        self.ensure_message_start(&resp, &mut out);

        if let Some(candidate) = resp.candidates.as_ref().and_then(|c| c.first()) {
            if let Some(parts) = candidate.content.as_ref().and_then(|c| c.parts.as_ref()) {
                for part in parts {
                    let sig = part
                        .thought_signature
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);

                    if let Some(text) = part.text.as_deref() {
                        if !text.is_empty() {
                            if part.thought == Some(true) {
                                let idx = self.ensure_open_block(ActiveBlockKind::Thinking, &mut out);
                                out.push(MessageStreamEvent::ContentBlockDelta {
                                    index: idx,
                                    delta: StreamDelta::ThinkingDelta {
                                        thinking: text.to_owned(),
                                    },
                                });
                                if let Some(s) = sig {
                                    out.push(MessageStreamEvent::ContentBlockDelta {
                                        index: idx,
                                        delta: StreamDelta::SignatureDelta { signature: s },
                                    });
                                }
                            } else {
                                let idx = self.ensure_open_block(ActiveBlockKind::Text, &mut out);
                                out.push(MessageStreamEvent::ContentBlockDelta {
                                    index: idx,
                                    delta: StreamDelta::TextDelta {
                                        text: text.to_owned(),
                                    },
                                });
                                if let Some(s) = sig {
                                    self.unattributed_signature = Some(s);
                                }
                            }
                        } else if let Some(s) = sig
                            && part.function_call.is_none()
                        {
                            if let Some((idx, ActiveBlockKind::Thinking)) = self.active_block {
                                out.push(MessageStreamEvent::ContentBlockDelta {
                                    index: idx,
                                    delta: StreamDelta::SignatureDelta { signature: s },
                                });
                            } else {
                                self.unattributed_signature = Some(s);
                            }
                        }
                    }

                    if let Some(fc) = part.function_call.as_ref() {
                        // Attach any thought signature to a synthetic empty Thinking block
                        // so multi-turn conversation replay preserves Gemini 3's required signature.
                        if let Some(s) = part
                            .thought_signature
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .or_else(|| self.unattributed_signature.take())
                        {
                            let think_idx =
                                self.ensure_open_block(ActiveBlockKind::Thinking, &mut out);
                            out.push(MessageStreamEvent::ContentBlockDelta {
                                index: think_idx,
                                delta: StreamDelta::SignatureDelta { signature: s },
                            });
                            self.close_active_block(&mut out);
                        } else {
                            self.close_active_block(&mut out);
                        }

                        let name = fc.name.clone().unwrap_or_else(|| "tool".to_owned());
                        let raw_id = fc.id.clone().unwrap_or_default();
                        let tool_id = if raw_id.is_empty() || self.seen_tool_ids.contains(&raw_id) {
                            let n = TOOL_CALL_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
                            format!("{name}_{n}")
                        } else {
                            raw_id
                        };
                        self.seen_tool_ids.push(tool_id.clone());

                        let args_json = fc
                            .args
                            .as_ref()
                            .and_then(|v| serde_json::to_string(v).ok())
                            .unwrap_or_else(|| "{}".to_owned());

                        let idx = self.next_block_index;
                        self.next_block_index += 1;
                        out.push(MessageStreamEvent::ContentBlockStart {
                            index: idx,
                            content_block: ContentBlock::ToolUse {
                                id: tool_id,
                                name,
                                input: serde_json::json!({}),
                                cache_control: None,
                            },
                        });
                        out.push(MessageStreamEvent::ContentBlockDelta {
                            index: idx,
                            delta: StreamDelta::InputJsonDelta {
                                partial_json: args_json,
                            },
                        });
                        out.push(MessageStreamEvent::ContentBlockStop { index: idx });
                        self.stop_reason = Some(StopReason::ToolUse);
                    }
                }
            }

            if let Some(finish) = candidate.finish_reason.as_deref() {
                let mapped = map_finish_reason(finish, !self.seen_tool_ids.is_empty());
                self.stop_reason = Some(mapped);
            }
        }

        Ok(out)
    }

    /// Emit closing `ContentBlockStop`, `MessageDelta`, and `MessageStop` events
    /// when the SSE stream ends.
    pub fn finish(&mut self) -> Vec<MessageStreamEvent> {
        let mut out = Vec::new();
        if self.finished || !self.started {
            return out;
        }
        self.finished = true;

        if let Some(sig) = self.unattributed_signature.take() {
            let idx = self.ensure_open_block(ActiveBlockKind::Thinking, &mut out);
            out.push(MessageStreamEvent::ContentBlockDelta {
                index: idx,
                delta: StreamDelta::SignatureDelta { signature: sig },
            });
        }

        self.close_active_block(&mut out);

        let default_stop = if !self.seen_tool_ids.is_empty() {
            StopReason::ToolUse
        } else {
            StopReason::EndTurn
        };
        let stop_reason = self.stop_reason.clone().unwrap_or(default_stop);

        out.push(MessageStreamEvent::MessageDelta {
            delta: MessageDeltaBody {
                stop_reason: Some(stop_reason),
                stop_sequence: None,
                stop_details: None,
            },
            usage: MessageDeltaUsage {
                output_tokens: self.output_tokens,
                input_tokens: Some(self.input_tokens),
                cache_read_input_tokens: Some(self.cache_read_tokens),
                cache_creation_input_tokens: Some(0),
            },
        });
        out.push(MessageStreamEvent::MessageStop);
        out
    }
}

fn map_finish_reason(reason: &str, has_tool_calls: bool) -> StopReason {
    match reason {
        "STOP" => {
            if has_tool_calls {
                StopReason::ToolUse
            } else {
                StopReason::EndTurn
            }
        }
        "MAX_TOKENS" => {
            if has_tool_calls {
                StopReason::ToolUse
            } else {
                StopReason::MaxTokens
            }
        }
        "SAFETY"
        | "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "SPII"
        | "IMAGE_SAFETY"
        | "IMAGE_PROHIBITED_CONTENT"
        | "RECITATION" => StopReason::Refusal,
        other => StopReason::Unknown(other.to_owned()),
    }
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn resolves_antigravity_urls_and_detects_backend() {
        assert!(is_antigravity_backend_url(ANTIGRAVITY_DAILY_ENDPOINT));
        assert!(is_antigravity_backend_url(ANTIGRAVITY_SANDBOX_ENDPOINT));
        assert!(!is_antigravity_backend_url("https://api.openai.com/v1"));

        assert_eq!(
            resolve_antigravity_stream_url(ANTIGRAVITY_DAILY_ENDPOINT),
            "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            resolve_antigravity_stream_url("https://daily-cloudcode-pa.googleapis.com/v1internal"),
            "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn parses_structured_and_pipe_credentials() {
        let json = r#"{"token":"ya29.tok","projectId":"proj-123","email":"u@example.com"}"#;
        let cred = parse_antigravity_credential(json).unwrap();
        assert_eq!(cred.access_token, "ya29.tok");
        assert_eq!(cred.project_id, "proj-123");
        assert_eq!(cred.email.as_deref(), Some("u@example.com"));

        let pipe = parse_antigravity_credential("ya29.abc|proj-999").unwrap();
        assert_eq!(pipe.access_token, "ya29.abc");
        assert_eq!(pipe.project_id, "proj-999");
    }

    #[test]
    fn resolves_wire_models_and_thinking_transports() {
        let (wire, transport) =
            resolve_wire_model_and_thinking("gemini-3.1-pro", Some(ReasoningEffort::High));
        assert_eq!(wire, "gemini-pro-agent");
        assert_eq!(transport, ThinkingTransport::Budget(10_001));

        let (wire, transport) =
            resolve_wire_model_and_thinking("gemini-3.5-flash", Some(ReasoningEffort::Medium));
        assert_eq!(wire, "gemini-3.5-flash-low");
        assert_eq!(transport, ThinkingTransport::Budget(4_000));

        let (wire, transport) =
            resolve_wire_model_and_thinking("gemini-3.7-flash", Some(ReasoningEffort::High));
        assert_eq!(wire, "gemini-3.7-flash-high");
        assert_eq!(transport, ThinkingTransport::Level("HIGH"));

        let (wire, transport) =
            resolve_wire_model_and_thinking("claude-opus-4-6", Some(ReasoningEffort::High));
        assert_eq!(wire, "claude-opus-4-6-thinking");
        assert_eq!(transport, ThinkingTransport::Budget(16_384));
    }

    #[test]
    fn builds_request_envelope_and_translates_sse_stream() {
        let req = ConversationRequest {
            model: Some("gemini-3.1-pro".to_owned()),
            reasoning_effort: Some(ReasoningEffort::High),
            items: vec![
                ConversationItem::system("You are Amore Build."),
                ConversationItem::user("Hello Antigravity"),
            ],
            ..Default::default()
        };

        let (body, wire_model, has_thinking) = build_antigravity_request_body(
            &req,
            "cca-project-1",
            "gemini-3.1-pro",
            None,
            None,
            None,
            None,
        );
        assert_eq!(wire_model, "gemini-pro-agent");
        assert!(has_thinking);
        assert_eq!(body["project"], "cca-project-1");
        assert_eq!(body["model"], "gemini-pro-agent");
        assert_eq!(body["userAgent"], "antigravity");
        assert_eq!(body["requestType"], "agent");
        assert_eq!(
            body["request"]["labels"]["model_enum"],
            "MODEL_PLACEHOLDER_M16"
        );
        assert_eq!(
            body["request"]["generationConfig"]["maxOutputTokens"],
            65_535
        );
        assert_eq!(
            body["request"]["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            10_001
        );

        let mut translator = AntigravitySseTranslator::new(&wire_model);
        let chunk_1 = r#"{"response":{"responseId":"resp_1","modelVersion":"gemini-pro-agent","candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"Thinking step..."},{"text":"Hello world!","thoughtSignature":"YWJjZGVm"}]}}]}}"#;
        let events_1 = translator.push_chunk(chunk_1).unwrap();
        assert!(events_1.iter().any(|e| matches!(e, MessageStreamEvent::MessageStart { .. })));
        assert!(events_1.iter().any(|e| matches!(
            e,
            MessageStreamEvent::ContentBlockDelta {
                delta: StreamDelta::ThinkingDelta { thinking },
                ..
            } if thinking == "Thinking step..."
        )));
        assert!(events_1.iter().any(|e| matches!(
            e,
            MessageStreamEvent::ContentBlockDelta {
                delta: StreamDelta::TextDelta { text },
                ..
            } if text == "Hello world!"
        )));

        let chunk_2 = r#"{"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{"target_file":"README.md"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":30,"thoughtsTokenCount":15,"totalTokenCount":165,"cachedContentTokenCount":20}}}"#;
        let events_2 = translator.push_chunk(chunk_2).unwrap();
        assert!(events_2.iter().any(|e| matches!(
            e,
            MessageStreamEvent::ContentBlockStart {
                content_block: ContentBlock::ToolUse { name, .. },
                ..
            } if name == "read_file"
        )));

        let tail = translator.finish();
        assert!(tail.iter().any(|e| matches!(
            e,
            MessageStreamEvent::MessageDelta {
                delta: MessageDeltaBody {
                    stop_reason: Some(StopReason::ToolUse),
                    ..
                },
                usage: MessageDeltaUsage {
                    output_tokens: 45,
                    input_tokens: Some(100),
                    cache_read_input_tokens: Some(20),
                    ..
                },
            }
        )));
        assert!(tail.iter().any(|e| matches!(e, MessageStreamEvent::MessageStop)));
    }
}
