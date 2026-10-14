use super::*;
use serde_json::json;

fn body(raw: Value) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"error": {"message": "Provider returned error", "code": 400,
        "metadata": {"provider_name": "Google", "raw": raw}}}),
    )
    .unwrap()
}

#[test]
fn encoded_json_raw_exposes_upstream_message_and_provider() {
    let bytes = body(json!(
        r#"{"error":{"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT","code":400}}"#
    ));
    assert_eq!(
        user_facing_api_error_message(StatusCode::BAD_REQUEST, &bytes),
        "[provider: Google] Request contains an invalid argument."
    );
}

#[test]
fn plain_text_and_object_raw_are_supported() {
    for raw in [
        json!("Duplicate tool-call ID"),
        json!({"message": "Duplicate tool-call ID"}),
    ] {
        assert_eq!(
            user_facing_api_error_message(StatusCode::BAD_REQUEST, &body(raw)),
            "[provider: Google] Duplicate tool-call ID"
        );
    }
}

#[test]
fn absent_empty_and_markup_raw_keep_gateway_message_and_provider() {
    for raw in [Value::Null, json!(" "), json!("<html>Gateway error</html>")] {
        assert_eq!(
            user_facing_api_error_message(StatusCode::BAD_REQUEST, &body(raw)),
            "[provider: Google] Provider returned error"
        );
    }
}

#[test]
fn missing_metadata_and_other_http_statuses_preserve_standard_errors() {
    for bytes in [
        br#"{"error":{"message":"Standard error"}}"#.to_vec(),
        b"invalid JSON".to_vec(),
    ] {
        assert_eq!(
            user_facing_api_error_message(StatusCode::BAD_REQUEST, &bytes),
            standard_error_message(StatusCode::BAD_REQUEST, &bytes)
        );
    }
    let bytes = body(json!("upstream detail"));
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::BAD_GATEWAY,
    ] {
        assert_eq!(
            user_facing_api_error_message(status, &bytes),
            standard_error_message(status, &bytes)
        );
    }
}

#[test]
fn raw_without_provider_is_visible_and_messages_are_unicode_bounded() {
    let bytes = serde_json::to_vec(&json!({"error":{"message":"Provider returned error",
        "metadata":{"raw":{"message":"duplicate"}}}}))
    .unwrap();
    assert_eq!(
        user_facing_api_error_message(StatusCode::BAD_REQUEST, &bytes),
        "duplicate"
    );
    let bytes = body(json!("界".repeat(MAX_USER_ERROR_BODY_CHARS * 2)));
    let message = user_facing_api_error_message(StatusCode::BAD_REQUEST, &bytes);
    assert!(message.starts_with("[provider: Google] "));
    assert!(message.ends_with('…'));
    assert_eq!(message.chars().count(), MAX_USER_ERROR_BODY_CHARS + 1);
}

#[tokio::test]
async fn http_400_streaming_and_nonstreaming_clients_carry_provider_details() {
    use crate::{SamplerConfig, SamplingClient};
    use axum::{Router, routing::post};
    use xai_grok_sampling_types::{ChatCompletionRequest, SamplingError};

    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({"error": {
                    "message": "Provider returned error", "code": 400, "metadata": {
                        "provider_name": "Google", "raw": {"message": "Duplicate tool-call ID"}
                    }
                }})),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = SamplingClient::new(SamplerConfig {
        base_url: format!("http://{address}/v1"),
        model: "test-model".into(),
        context_window: 8192,
        ..Default::default()
    })
    .unwrap();
    let request = || {
        serde_json::from_value::<ChatCompletionRequest>(json!({
            "model": "test-model", "messages": [{"role": "user", "content": "hello"}]
        }))
        .unwrap()
    };
    let errors = [
        client.chat_completion(request()).await.err().unwrap(),
        client
            .chat_completion_stream(request())
            .await
            .err()
            .unwrap(),
    ];
    server.abort();
    let _ = server.await;
    for error in errors {
        let SamplingError::Api {
            status,
            message,
            error_code,
            ..
        } = &error
        else {
            panic!("expected API error: {error}");
        };
        assert_eq!(*status, StatusCode::BAD_REQUEST);
        assert_eq!(message, "[provider: Google] Duplicate tool-call ID");
        assert!(error_code.is_none());
        let display = crate::format_sampling_error(&error, None);
        assert!(display.contains("Google"));
        assert!(display.contains("Duplicate tool-call ID"));
    }
}
