use super::*;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Router, response::IntoResponse, routing::post};
use futures_util::StreamExt;
use tracing::field::{Field, Visit};
use tracing_subscriber::{Layer, layer::SubscriberExt};
use xai_grok_sampling_types::{CreateResponseWrapper, SamplingError, rs};

use crate::{ApiBackend, SamplerConfig, SamplingClient, SamplingErrorKind};

#[test]
fn exact_top_level_keepalive_is_a_control_frame() {
    for data in [
        r#"{"type":"keepalive"}"#,
        r#"{"type":"keepalive","timestamp":123}"#,
        r#"{ "type": "keep\u0061live" }"#,
    ] {
        assert!(is_keepalive("message", data), "{data}");
    }
}

#[test]
fn named_keepalive_accepts_untyped_payloads() {
    for data in ["", "still here", "{}", r#"{"timestamp":123}"#] {
        assert!(is_keepalive("keepalive", data), "{data}");
    }
}

#[test]
fn explicit_types_override_the_event_name_and_unknown_content_stays_strict() {
    for data in [
        r#"{"type":"response.output_text.delta"}"#,
        r#"{"type":"error"}"#,
        r#"{"type":"future.event"}"#,
        r#"{"type":null}"#,
        r#"{"type":123}"#,
    ] {
        assert!(!is_keepalive("keepalive", data), "{data}");
    }
    for data in [
        r#"{"type":"KEEPALIVE"}"#,
        r#"{"type":"keepalive.extra"}"#,
        r#"{"type":"response.output_text.delta","delta":"keepalive"}"#,
        r#"{"nested":{"type":"keepalive"}}"#,
        "not JSON",
        "[]",
        "null",
    ] {
        assert!(!is_keepalive("message", data), "{data}");
    }
    assert!(!is_keepalive("KEEPALIVE", ""));
    assert!(!is_keepalive("ping", "{}"));
}

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn client(app: Router) -> (SamplingClient, Server) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap()
    }));
    let client = SamplingClient::new(SamplerConfig {
        base_url: format!("http://{address}/v1"),
        api_backend: ApiBackend::Responses,
        model: "test-model".into(),
        context_window: 8192,
        ..Default::default()
    })
    .unwrap();
    (client, server)
}

async fn fixed(body: String) -> (SamplingClient, Server) {
    client(Router::new().route(
        "/v1/responses",
        post(move || {
            let body = body.clone();
            async move { ([("content-type", "text/event-stream")], body) }
        }),
    ))
    .await
}

fn request() -> CreateResponseWrapper {
    CreateResponseWrapper::new(rs::CreateResponse {
        input: rs::InputParam::Text("hello".into()),
        ..Default::default()
    })
}

fn frame(name: &str, data: &str) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

#[derive(Clone, Default)]
struct Capture {
    events: Arc<Mutex<Vec<BTreeMap<String, String>>>>,
    records: Arc<Mutex<Vec<BTreeMap<String, String>>>>,
}

#[derive(Default)]
struct Fields(BTreeMap<String, String>);
impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().into(), format!("{value:?}"));
    }
}
impl<S: tracing::Subscriber> Layer<S> for Capture {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if event.metadata().target() == crate::sampling_log::TARGET {
            let mut fields = Fields::default();
            event.record(&mut fields);
            self.events.lock().unwrap().push(fields.0);
        }
    }
    fn on_record(
        &self,
        _: &tracing::span::Id,
        values: &tracing::span::Record<'_>,
        _: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut fields = Fields::default();
        values.record(&mut fields);
        self.records.lock().unwrap().push(fields.0);
    }
}

#[tokio::test]
async fn heartbeats_preserve_content_usage_order_logs_and_first_content_timing() {
    let capture = Capture::default();
    let subscriber = tracing_subscriber::registry().with(capture.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    // Observe the returned stream through an explicitly enabled, test-local timing span.
    let mut timing = crate::span_timing::StreamSpanTiming::start(crate::span_timing::stream_span!(
        "responses_heartbeat_test"
    ));
    timing.record_request_build();
    let mut body = ": heartbeat comment\n\n".to_owned();
    body += &frame("keepalive", "still here");
    body += &frame("message", r#"{"type":"keepalive"}"#);
    for event in
        xai_grok_test_support::sse::responses_api_script_chunks(&["Hello ", "world"], "test-model")
    {
        // The JSON content type remains authoritative under a misleading SSE label.
        body += &frame("keepalive", &event.data);
        body += &frame("message", r#"{"type":"keepalive"}"#);
    }
    let (client, _server) = fixed(body).await;
    let (raw, metadata, doom_loop) = client.create_response_stream(request()).await.unwrap();
    timing.record_response_headers();
    let mut raw =
        timing.hold_until_first_content(raw, crate::stream_classify::responses_event_class);
    let created = raw.next().await.unwrap().unwrap();
    assert!(matches!(
        &created,
        rs::ResponseStreamEvent::ResponseCreated(_)
    ));
    assert!(
        !capture
            .records
            .lock()
            .unwrap()
            .iter()
            .any(|record| record.contains_key("ttft_ms") || record.contains_key("ttft_outcome"))
    );
    let delta = raw.next().await.unwrap().unwrap();
    assert!(matches!(
        &delta,
        rs::ResponseStreamEvent::ResponseOutputTextDelta(_)
    ));
    assert!(
        capture
            .records
            .lock()
            .unwrap()
            .iter()
            .any(|record| record.get("ttft_outcome").map(String::as_str) == Some("content"))
    );
    let raw = futures_util::stream::iter([Ok(created), Ok(delta)])
        .chain(raw)
        .boxed();
    let events = crate::stream::stream_responses(
        raw,
        metadata,
        crate::RequestId::from("heartbeat-content"),
        Duration::from_secs(2),
        doom_loop,
    );
    let (response, metrics) = crate::stream::collect_response(events).await.unwrap();
    assert_eq!(response.assistant_text(), "Hello world");
    assert_eq!(response.usage.as_ref().unwrap().total_tokens, 15);
    assert_eq!(response.message_chunks_emitted, 2);
    assert_eq!(metrics.chunk_count, 2);
    let logs = capture.events.lock().unwrap();
    assert!(
        logs.iter().any(
            |event| event.get("event_name").map(String::as_str) == Some("keepalive")
                && event.get("data").map(String::as_str) == Some("still here")
        )
    );
    assert!(logs.iter().any(|event| {
        event
            .get("data")
            .is_some_and(|data| data.contains("\"type\":\"keepalive\""))
    }));
}

#[tokio::test]
async fn continuous_heartbeats_do_not_extend_model_progress_timeout() {
    let app = Router::new().route(
        "/v1/responses",
        post(|| async {
            let events = futures_util::stream::unfold((), |()| async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Some((
                    Ok::<_, std::convert::Infallible>(
                        axum::response::sse::Event::default()
                            .event("keepalive")
                            .data(r#"{"type":"keepalive"}"#),
                    ),
                    (),
                ))
            });
            axum::response::Sse::new(events).into_response()
        }),
    );
    let (client, _server) = client(app).await;
    let (raw, metadata, doom_loop) = client.create_response_stream(request()).await.unwrap();
    let events = crate::stream::stream_responses(
        raw,
        metadata,
        crate::RequestId::from("heartbeat-idle"),
        Duration::from_millis(100),
        doom_loop,
    );
    let failure = tokio::time::timeout(
        Duration::from_secs(2),
        crate::stream::collect_response(events),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(failure.kind, SamplingErrorKind::IdleTimeout);
}

#[tokio::test]
async fn heartbeat_labels_preserve_provider_errors_unknown_types_and_malformed_content() {
    for (name, data, provider_error) in [
        (
            "keepalive",
            r#"{"type":"error","error":{"type":"server_error","message":"upstream failed"}}"#,
            true,
        ),
        (
            "keepalive",
            r#"{"type":"keepalive","error":{"type":"server_error","message":"upstream failed"}}"#,
            true,
        ),
        ("keepalive", r#"{"type":"future.event"}"#, false),
        ("keepalive", r#"{"type":null}"#, false),
        ("message", "{invalid", false),
    ] {
        let body = frame("message", r#"{"type":"keepalive"}"#) + &frame(name, data);
        let (client, _server) = fixed(body).await;
        let (mut raw, _, _) = client.create_response_stream(request()).await.unwrap();
        let error = raw.next().await.unwrap().unwrap_err();
        if provider_error {
            assert!(matches!(&error, SamplingError::StreamError { .. }));
            assert!(error.to_string().contains("upstream failed"));
        } else {
            assert!(matches!(error, SamplingError::Serialization(_)));
        }
    }
}

#[tokio::test]
async fn control_consumption_yields_and_preserves_scan_termination() {
    use futures_util::FutureExt;
    assert!(finish_scan_item::<u8>(Some(None)).now_or_never().is_none());
    assert_eq!(finish_scan_item::<u8>(Some(None)).await, Some(None));
    assert_eq!(
        finish_scan_item(Some(Some(7_u8))).now_or_never(),
        Some(Some(Some(7)))
    );
    assert_eq!(finish_scan_item::<u8>(None).now_or_never(), Some(None));
}

#[tokio::test]
async fn buffered_control_frames_allow_cancellation_before_the_burst_is_drained() {
    let stream = futures_util::stream::iter(0..10_000)
        .scan((), |_, _| {
            assert!(is_keepalive("message", r#"{"type":"keepalive"}"#));
            finish_scan_item::<u8>(Some(None))
        })
        .filter_map(std::future::ready);
    tokio::pin!(stream);
    let cancel = tokio_util::sync::CancellationToken::new();
    let signal = cancel.clone();
    let task = tokio::spawn(async move {
        signal.cancel();
    });
    tokio::select! {
        biased;
        () = cancel.cancelled() => {}
        item = stream.next() => panic!("buffered control frames blocked cancellation: {item:?}"),
    }
    task.await.unwrap();
}

#[tokio::test]
async fn typed_provider_error_after_heartbeat_reaches_the_failure_consumer() {
    let body = frame("message", r#"{"type":"keepalive"}"#)
        + &frame(
            "keepalive",
            r#"{"type":"error","code":"server_error","message":"upstream failed","param":null,"sequence_number":0}"#,
        );
    let (client, _server) = fixed(body).await;
    let (raw, metadata, doom_loop) = client.create_response_stream(request()).await.unwrap();
    let events = crate::stream::stream_responses(
        raw,
        metadata,
        crate::RequestId::from("heartbeat-error"),
        Duration::from_secs(2),
        doom_loop,
    );
    let error = crate::stream::collect_response(events).await.unwrap_err();
    assert_eq!(error.kind, SamplingErrorKind::Api);
    assert!(error.message.contains("upstream failed"));
}

#[tokio::test]
async fn done_and_eof_still_end_heartbeat_streams() {
    for body in [
        frame("message", r#"{"type":"keepalive"}"#),
        frame("keepalive", "[DONE]") + &frame("message", r#"{"type":"future.event"}"#),
    ] {
        let (client, _server) = fixed(body).await;
        let (mut raw, _, _) = client.create_response_stream(request()).await.unwrap();
        assert!(raw.next().await.is_none());
    }
}
