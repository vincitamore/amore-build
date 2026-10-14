// OpenAI Codex (ChatGPT OAuth) wire adapter for the Responses API backend.
//
// When a model entry authenticates with an OpenAI Codex OAuth JWT (minted by
// `amore login --provider openai`), requests target the ChatGPT Codex Responses
// endpoint (`https://chatgpt.com/backend-api/codex/responses`) and carry the
// Codex header and body shape:
//
// - `Authorization: Bearer <jwt>` (strips `x-grok-*` and `x-api-key`)
// - `chatgpt-account-id` and `x-openai-internal-codex-residency` decoded from
//   the token's `https://api.openai.com/auth` claim
// - `OpenAI-Beta: responses=experimental`, `originator: omp`,
//   `version: 0.159.0`, `x-codex-routing-hint: model=<model>`
// - `session_id`, `conversation_id`, `session-id`, `x-client-request-id`
// - Body shaping: system messages lifted to `instructions` (first) and
//   `developer` role items (remainder), `store: false`, `stream: true`,
//   `include: ["reasoning.encrypted_content"]`, and unsupported sampling caps
//   (`max_output_tokens`, `max_completion_tokens`, `temperature`, `top_p`)
//   omitted.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};

pub const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
pub const CODEX_CLIENT_VERSION: &str = "0.159.0";
pub const CODEX_ORIGINATOR: &str = "omp";
pub const CODEX_BETA_RESPONSES: &str = "responses=experimental";

const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _sig = parts.next()?;
    if parts.next().is_some() || payload.is_empty() {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| URL_SAFE.decode(payload))
        .or_else(|_| STANDARD_NO_PAD.decode(payload))
        .or_else(|_| STANDARD.decode(payload))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

/// True when `token` is an OpenAI Codex OAuth JWT carrying the
/// `https://api.openai.com/auth` claim object.
pub fn is_openai_codex_oauth_token(token: &str) -> bool {
    decode_jwt_payload(token)
        .and_then(|v| v.get(JWT_CLAIM_PATH).and_then(|c| c.as_object()).cloned())
        .is_some()
}

/// True when `base_url` points at the ChatGPT Codex backend (`chatgpt.com/backend-api`).
pub fn is_codex_backend_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_ascii_lowercase();
    lower.contains("chatgpt.com/backend-api") || lower.ends_with("/codex") || lower.ends_with("/codex/responses")
}

/// Extract the `chatgpt_account_id` claim from an OpenAI Codex JWT.
pub fn extract_codex_account_id(token: &str) -> Option<String> {
    let payload = decode_jwt_payload(token)?;
    let id = payload
        .get(JWT_CLAIM_PATH)?
        .get("chatgpt_account_id")?
        .as_str()?
        .trim();
    (!id.is_empty()).then(|| id.to_owned())
}

/// Extract data or compute residency (`chatgpt_data_residency` or
/// `chatgpt_compute_residency`) from an OpenAI Codex JWT.
pub fn extract_codex_residency(token: &str) -> Option<String> {
    let payload = decode_jwt_payload(token)?;
    let auth = payload.get(JWT_CLAIM_PATH)?;
    for key in ["chatgpt_data_residency", "chatgpt_compute_residency"] {
        if let Some(val) = auth.get(key).and_then(|v| v.as_str()).map(str::trim)
            && !val.is_empty()
        {
            return Some(val.to_owned());
        }
    }
    None
}

/// Read the active credential out of a built `HeaderMap`.
pub fn credential_from_headers(
    headers: &HeaderMap,
    scheme: crate::config::AuthScheme,
) -> Option<String> {
    match scheme {
        crate::config::AuthScheme::Bearer => headers
            .get(AUTHORIZATION)?
            .to_str()
            .ok()?
            .strip_prefix("Bearer ")
            .map(str::to_owned),
        crate::config::AuthScheme::XApiKey => headers
            .get(HeaderName::from_static("x-api-key"))?
            .to_str()
            .ok()
            .map(str::to_owned),
    }
    .filter(|k| !k.is_empty())
}

/// Resolve the Codex Responses endpoint URL (`.../codex/responses`).
pub fn resolve_codex_responses_url(base_url: &str) -> String {
    let raw = base_url.trim();
    let base = if raw.is_empty() { CODEX_BASE_URL } else { raw };
    let normalized = base.trim_end_matches('/');
    if normalized.ends_with("/codex/responses") {
        normalized.to_owned()
    } else if normalized.ends_with("/codex") {
        format!("{normalized}/responses")
    } else if normalized.ends_with("/backend-api/v1") {
        let prefix = normalized.trim_end_matches("/v1");
        format!("{prefix}/codex/responses")
    } else {
        format!("{normalized}/codex/responses")
    }
}

/// Apply the OpenAI Codex header set onto a built `reqwest::Request`, stripping
/// `x-grok-*` and `x-api-key` headers.
pub fn apply_codex_request_headers(
    request: &mut reqwest::Request,
    access_token: &str,
    model_id: &str,
    session_id: Option<&str>,
) {
    apply_codex_headers(request.headers_mut(), access_token, model_id, session_id);
}

/// Apply the OpenAI Codex header set onto `headers`, stripping `x-grok-*` and
/// `x-api-key` headers.
pub fn apply_codex_headers(
    headers: &mut HeaderMap,
    access_token: &str,
    model_id: &str,
    session_id: Option<&str>,
) {
    let strip: Vec<HeaderName> = headers
        .keys()
        .filter(|k| {
            let name = k.as_str();
            name.starts_with("x-grok")
                || name.eq_ignore_ascii_case("x-api-key")
                || name.eq_ignore_ascii_case("openai-beta")
        })
        .cloned()
        .collect();
    for name in strip {
        headers.remove(&name);
    }

    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {access_token}")) {
        headers.insert(AUTHORIZATION, v);
    }
    if let Some(account_id) = extract_codex_account_id(access_token)
        && let Ok(v) = HeaderValue::from_str(&account_id)
    {
        headers.insert(HeaderName::from_static("chatgpt-account-id"), v);
    }
    if !headers.contains_key("x-openai-internal-codex-residency")
        && let Some(residency) = extract_codex_residency(access_token)
        && let Ok(v) = HeaderValue::from_str(&residency)
    {
        headers.insert(
            HeaderName::from_static("x-openai-internal-codex-residency"),
            v,
        );
    }
    if !model_id.is_empty()
        && let Ok(v) = HeaderValue::from_str(&format!("model={model_id}"))
    {
        headers.insert(HeaderName::from_static("x-codex-routing-hint"), v);
    }
    headers.insert(
        HeaderName::from_static("openai-beta"),
        HeaderValue::from_static(CODEX_BETA_RESPONSES),
    );
    headers.insert(
        HeaderName::from_static("originator"),
        HeaderValue::from_static(CODEX_ORIGINATOR),
    );
    headers.insert(
        HeaderName::from_static("version"),
        HeaderValue::from_static(CODEX_CLIENT_VERSION),
    );

    if let Some(sid) = session_id.filter(|s| !s.is_empty())
        && let Ok(v) = HeaderValue::from_str(sid)
    {
        headers.insert(HeaderName::from_static("conversation_id"), v.clone());
        headers.insert(HeaderName::from_static("session_id"), v.clone());
        headers.insert(HeaderName::from_static("session-id"), v.clone());
        headers.insert(HeaderName::from_static("x-client-request-id"), v);
    }
}

fn extract_message_text(item: &serde_json::Value) -> Option<String> {
    match item.get("content")? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(parts) => {
            let mut texts = Vec::new();
            for part in parts {
                if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    texts.push(t);
                }
            }
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

/// Transform a serialized Responses API JSON body to match the OpenAI Codex
/// backend's contract (`transformRequestBody` in omp):
///
/// 1. `store = false`, `stream = true`.
/// 2. System messages in `input` are lifted: the first becomes top-level
///    `instructions` (when not already set), and any additional system messages
///    become `developer` role input messages.
/// 3. Item `id` fields on non-`computer_call` input items are stripped.
/// 4. Sampling controls and output caps (`max_output_tokens`,
///    `max_completion_tokens`, `temperature`, `top_p`, `stream_tool_calls`) are
///    removed because the Codex backend rejects them with HTTP 400.
/// 5. `include` contains `"reasoning.encrypted_content"`.
pub fn apply_codex_request_body(body: &mut serde_json::Value, session_id: Option<&str>) {
    let Some(obj) = body.as_object_mut() else {
        return;
    };

    obj.insert("store".to_owned(), serde_json::Value::Bool(false));
    obj.insert("stream".to_owned(), serde_json::Value::Bool(true));

    // Strip parameters the Codex backend rejects with 400 Unsupported parameter.
    for unsupported in [
        "max_output_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "stream_tool_calls",
    ] {
        obj.remove(unsupported);
    }

    if let Some(sid) = session_id.filter(|s| !s.is_empty())
        && !obj.contains_key("prompt_cache_key")
    {
        obj.insert(
            "prompt_cache_key".to_owned(),
            serde_json::Value::String(sid.to_owned()),
        );
    }

    let mut existing_instructions = obj
        .get("instructions")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    if let Some(input_arr) = obj.get_mut("input").and_then(|v| v.as_array_mut()) {
        let mut system_texts: Vec<String> = Vec::new();
        let mut retained: Vec<serde_json::Value> = Vec::with_capacity(input_arr.len());

        for mut item in input_arr.drain(..) {
            let is_system = item.get("role").and_then(|r| r.as_str()) == Some("system");
            if is_system {
                if let Some(text) = extract_message_text(&item)
                    && !text.trim().is_empty()
                {
                    system_texts.push(text);
                }
                continue;
            }
            if item.get("type").and_then(|t| t.as_str()) == Some("item_reference") {
                continue;
            }
            if item.get("type").and_then(|t| t.as_str()) != Some("computer_call")
                && let Some(item_obj) = item.as_object_mut()
            {
                item_obj.remove("id");
            }
            retained.push(item);
        }

        let mut dev_items: Vec<serde_json::Value> = Vec::new();
        for text in system_texts {
            if existing_instructions.is_none() {
                existing_instructions = Some(text);
            } else {
                dev_items.push(serde_json::json!({
                    "type": "message",
                    "role": "developer",
                    "content": [{ "type": "input_text", "text": text }],
                }));
            }
        }

        dev_items.extend(retained);

        // Ensure at least one non-developer input item exists when instructions are present.
        let has_visible = dev_items
            .iter()
            .any(|item| item.get("role").and_then(|r| r.as_str()) != Some("developer"));
        if !has_visible
            && let Some(ref instr) = existing_instructions
        {
            dev_items.push(serde_json::json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": instr }],
            }));
        }

        *input_arr = dev_items;
    }

    if let Some(instr) = existing_instructions {
        obj.insert("instructions".to_owned(), serde_json::Value::String(instr));
    }

    // Ensure `include` contains `reasoning.encrypted_content`.
    let include = obj
        .entry("include")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if !include.is_array() {
        *include = serde_json::Value::Array(Vec::new());
    }
    if let Some(arr) = include.as_array_mut() {
        let needle = "reasoning.encrypted_content";
        if !arr.iter().any(|v| v.as_str() == Some(needle)) {
            arr.push(serde_json::Value::String(needle.to_owned()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_codex_jwt(account_id: &str, residency: Option<&str>) -> String {
        let mut auth = serde_json::json!({
            "chatgpt_account_id": account_id,
        });
        if let Some(r) = residency {
            auth.as_object_mut()
                .unwrap()
                .insert("chatgpt_data_residency".to_owned(), serde_json::json!(r));
        }
        let claims = serde_json::json!({
            "https://api.openai.com/auth": auth,
        });
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        format!("{header}.{payload}.sig")
    }

    #[test]
    fn detects_codex_jwt_and_extracts_claims() {
        let tok = make_codex_jwt("acct_xyz", Some("eu"));
        assert!(is_openai_codex_oauth_token(&tok));
        assert_eq!(extract_codex_account_id(&tok).as_deref(), Some("acct_xyz"));
        assert_eq!(extract_codex_residency(&tok).as_deref(), Some("eu"));
        assert!(!is_openai_codex_oauth_token("sk-proj-123456"));
    }

    #[test]
    fn resolves_codex_responses_url_variants() {
        assert_eq!(
            resolve_codex_responses_url("https://chatgpt.com/backend-api"),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_responses_url("https://chatgpt.com/backend-api/codex"),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_responses_url("https://chatgpt.com/backend-api/codex/responses"),
            "https://chatgpt.com/backend-api/codex/responses"
        );
    }

    #[test]
    fn shapes_headers_and_body_for_codex_backend() {
        let tok = make_codex_jwt("acct_42", Some("us"));
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-grok-session-id"),
            HeaderValue::from_static("s1"),
        );
        headers.insert(
            HeaderName::from_static("x-api-key"),
            HeaderValue::from_static("old"),
        );

        apply_codex_headers(&mut headers, &tok, "gpt-5.4", Some("sess_99"));
        assert!(!headers.contains_key("x-grok-session-id"));
        assert!(!headers.contains_key("x-api-key"));
        assert_eq!(
            headers.get("chatgpt-account-id").and_then(|v| v.to_str().ok()),
            Some("acct_42")
        );
        assert_eq!(
            headers
                .get("x-openai-internal-codex-residency")
                .and_then(|v| v.to_str().ok()),
            Some("us")
        );
        assert_eq!(
            headers
                .get("x-codex-routing-hint")
                .and_then(|v| v.to_str().ok()),
            Some("model=gpt-5.4")
        );
        assert_eq!(
            headers.get("openai-beta").and_then(|v| v.to_str().ok()),
            Some("responses=experimental")
        );
        assert_eq!(
            headers.get("originator").and_then(|v| v.to_str().ok()),
            Some("omp")
        );
        assert_eq!(
            headers.get("session_id").and_then(|v| v.to_str().ok()),
            Some("sess_99")
        );

        let mut body = serde_json::json!({
            "model": "gpt-5.4",
            "max_output_tokens": 32000,
            "temperature": 0.2,
            "stream_tool_calls": true,
            "input": [
                { "type": "message", "role": "system", "content": "System prompt 1" },
                { "type": "message", "role": "system", "content": "System prompt 2" },
                { "id": "msg_1", "type": "message", "role": "user", "content": "Hello" }
            ]
        });
        apply_codex_request_body(&mut body, Some("sess_99"));

        assert_eq!(body.get("store").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(body.get("stream").and_then(|v| v.as_bool()), Some(true));
        assert!(body.get("max_output_tokens").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("stream_tool_calls").is_none());
        assert_eq!(
            body.get("instructions").and_then(|v| v.as_str()),
            Some("System prompt 1")
        );
        let input = body.get("input").and_then(|v| v.as_array()).unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[0].get("role").and_then(|v| v.as_str()), Some("developer"));
        assert_eq!(input[1].get("role").and_then(|v| v.as_str()), Some("user"));
        assert!(input[1].get("id").is_none());
    }
}
