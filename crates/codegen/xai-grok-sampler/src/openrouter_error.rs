//! OpenRouter upstream error details for HTTP 400 responses.

use reqwest::StatusCode;
use serde_json::Value;
use xai_grok_sampling_types::error::{
    MAX_USER_ERROR_BODY_CHARS, user_facing_api_error_message as standard_error_message,
};
use xai_grok_sampling_types::provider_error::{ProviderError, parse_provider_error};

pub(crate) fn user_facing_api_error_message(status: StatusCode, bytes: &[u8]) -> String {
    let fallback = standard_error_message(status, bytes);
    if status != StatusCode::BAD_REQUEST {
        return fallback;
    }
    metadata_message(bytes, &fallback).unwrap_or(fallback)
}

fn metadata_message(bytes: &[u8], fallback: &str) -> Option<String> {
    let body: Value = serde_json::from_slice(bytes).ok()?;
    let metadata = body.pointer("/error/metadata")?.as_object()?;
    let provider = metadata
        .get("provider_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let detail = metadata.get("raw").and_then(raw_message);
    if provider.is_none() && detail.is_none() {
        return None;
    }
    let detail = detail.as_deref().unwrap_or(fallback);
    let message = match provider {
        Some(provider) => {
            // Reserve space for the upstream reason when the provider name is long.
            let provider = truncate(provider, MAX_USER_ERROR_BODY_CHARS / 4);
            format!("[provider: {provider}] {detail}")
        }
        None => detail.to_owned(),
    };
    Some(truncate(&message, MAX_USER_ERROR_BODY_CHARS))
}

fn raw_message(raw: &Value) -> Option<String> {
    match raw {
        Value::String(text) if !text.trim().is_empty() => {}
        Value::Object(object) if !object.is_empty() => {}
        _ => return None,
    }
    let encoded = raw.to_string();
    let parsed = parse_provider_error(encoded.as_bytes()).unwrap_or_else(|| ProviderError {
        message: encoded,
        ..Default::default()
    });
    if parsed.message_is_markup() {
        return None;
    }
    Some(parsed.display_message())
}

fn truncate(text: &str, limit: usize) -> String {
    let text = text.trim();
    let mut chars = text.chars();
    let mut output: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        output.push('\u{2026}');
    }
    output
}

#[cfg(test)]
#[path = "openrouter_error_tests.rs"]
mod tests;
