//! Provider control frames outside the typed Responses content protocol.

use serde_json::Value;

/// An explicit payload type takes precedence over the SSE event name.
pub(crate) fn is_keepalive(event_name: &str, data: &str) -> bool {
    match serde_json::from_str::<Value>(data) {
        Ok(Value::Object(object)) => match object.get("type") {
            Some(Value::String(kind)) => kind == "keepalive",
            Some(_) => false,
            None => event_name == "keepalive",
        },
        _ => event_name == "keepalive",
    }
}

/// Yield while consuming control frames so deadlines and cancellation can be polled.
pub(crate) async fn finish_scan_item<T>(item: Option<Option<T>>) -> Option<Option<T>> {
    if matches!(item, Some(None)) {
        tokio::task::yield_now().await;
    }
    item
}

#[cfg(test)]
#[path = "responses_control_tests.rs"]
mod tests;
