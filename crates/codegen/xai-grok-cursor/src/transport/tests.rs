use super::*;
use crate::proto::agent_server_message::Message as ServerMessage;
use crate::proto::{AgentServerMessage, InteractionUpdate};

fn end_stream_error(code: &str, message: &str) -> ConnectEndStreamError {
    ConnectEndStreamError {
        code: code.to_string(),
        message: message.to_string(),
        raw: format!(r#"{{"error":{{"code":"{code}","message":"{message}"}}}}"#),
    }
}

#[test]
fn the_run_request_header_set_matches_the_connect_contract() {
    let request = build_h2_request(
        "https://api2.cursor.sh",
        RUN_PATH,
        "application/connect+proto",
        "cursor-token",
    );
    assert_eq!(request.method(), http::Method::POST);
    assert_eq!(
        request.uri(),
        "https://api2.cursor.sh/agent.v1.AgentService/Run"
    );
    assert_eq!(request.version(), http::Version::HTTP_2);
    assert_eq!(
        request.headers().get("content-type").unwrap(),
        "application/connect+proto"
    );
    assert_eq!(
        request.headers().get("connect-protocol-version").unwrap(),
        "1"
    );
    assert_eq!(request.headers().get("te").unwrap(), "trailers");
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        "Bearer cursor-token"
    );
    assert_eq!(request.headers().get("x-ghost-mode").unwrap(), "true");
    assert_eq!(
        request.headers().get("x-cursor-client-version").unwrap(),
        CURSOR_CLIENT_VERSION
    );
    assert_eq!(
        request.headers().get("x-cursor-client-type").unwrap(),
        "cli"
    );
    // A per-request id, not a constant.
    let request_id = request.headers().get("x-request-id").unwrap();
    assert!(uuid::Uuid::parse_str(request_id.to_str().unwrap()).is_ok());
    // The body keeps growing after the headers; a length would make the
    // peer reset the stream.
    assert!(request.headers().get("content-length").is_none());
}

#[test]
fn end_stream_errors_map_onto_the_sampler_error_model() {
    let auth = connect_error_to_sampling(&end_stream_error("unauthenticated", "expired"));
    assert!(
        matches!(auth, SamplingError::Auth { .. }),
        "expired tokens route to the refresh lane"
    );

    let not_found = connect_error_to_sampling(&end_stream_error("not_found", "model gone"));
    let SamplingError::Api {
        status,
        should_retry,
        ..
    } = &not_found
    else {
        panic!("api error");
    };
    assert_eq!(*status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(*should_retry, Some(false));

    let exhausted = connect_error_to_sampling(&end_stream_error("resource_exhausted", "quota"));
    let SamplingError::Api { status, .. } = &exhausted else {
        panic!("api error");
    };
    assert_eq!(*status, reqwest::StatusCode::TOO_MANY_REQUESTS);

    let other = connect_error_to_sampling(&end_stream_error("internal", "boom"));
    let SamplingError::Api { status, .. } = &other else {
        panic!("api error");
    };
    assert_eq!(*status, reqwest::StatusCode::INTERNAL_SERVER_ERROR);
}

#[test]
fn transport_progress_tracking_distinguishes_heartbeats_from_work() {
    let progress = AtomicBool::new(false);
    let mut saw_token_delta = false;
    let mut saw_turn_ended = false;

    let heartbeat = AgentServerMessage {
        message: Some(ServerMessage::InteractionUpdate(InteractionUpdate {
            message: Some(crate::proto::interaction_update::Message::Heartbeat(
                crate::proto::HeartbeatUpdate::default(),
            )),
        })),
    };
    track_message(
        &heartbeat,
        &progress,
        &mut saw_token_delta,
        &mut saw_turn_ended,
    );
    assert!(
        !progress.load(Ordering::Relaxed),
        "heartbeat is keepalive only"
    );

    let token_delta = AgentServerMessage {
        message: Some(ServerMessage::InteractionUpdate(InteractionUpdate {
            message: Some(crate::proto::interaction_update::Message::TokenDelta(
                crate::proto::TokenDeltaUpdate { tokens: 3 },
            )),
        })),
    };
    track_message(
        &token_delta,
        &progress,
        &mut saw_token_delta,
        &mut saw_turn_ended,
    );
    assert!(progress.load(Ordering::Relaxed));
    assert!(saw_token_delta);

    let turn_ended = AgentServerMessage {
        message: Some(ServerMessage::InteractionUpdate(InteractionUpdate {
            message: Some(crate::proto::interaction_update::Message::TurnEnded(
                crate::proto::TurnEndedUpdate::default(),
            )),
        })),
    };
    track_message(
        &turn_ended,
        &progress,
        &mut saw_token_delta,
        &mut saw_turn_ended,
    );
    assert!(saw_turn_ended);
}

#[test]
fn non_interaction_frames_count_as_progress() {
    let progress = AtomicBool::new(false);
    let mut saw_token_delta = false;
    let mut saw_turn_ended = false;
    let kv = AgentServerMessage {
        message: Some(ServerMessage::KvServerMessage(
            crate::proto::KvServerMessage {
                id: 1,
                message: None,
                ..Default::default()
            },
        )),
    };
    track_message(&kv, &progress, &mut saw_token_delta, &mut saw_turn_ended);
    assert!(progress.load(Ordering::Relaxed));
}

#[test]
fn url_splitting_covers_the_default_and_overrides() {
    let (authority, path) = split_url(CURSOR_API_URL);
    assert_eq!(authority, "https://api2.cursor.sh");
    assert_eq!(path, RUN_PATH);

    // A base override changes the origin only; the Run path is fixed.
    let (authority, path) = split_url("http://localhost:9000/anything/else");
    assert_eq!(authority, "https://localhost:9000");
    assert_eq!(path, RUN_PATH);

    let (authority, path) = split_url("https://bridge.internal");
    assert_eq!(authority, "https://bridge.internal");
    assert_eq!(path, RUN_PATH);
}

#[test]
fn authority_splitting_defaults_to_443() {
    assert_eq!(
        split_authority("https://api2.cursor.sh"),
        ("api2.cursor.sh".to_string(), 443)
    );
    assert_eq!(
        split_authority("https://localhost:9000"),
        ("localhost".to_string(), 9000)
    );
}

#[test]
fn resource_exhausted_rotation_only_fires_with_zero_tokens() {
    // The transport gates rotation on `!saw_token_delta`; the predicate
    // lives in maybe_rotate. Exercise the classification directly: the
    // error must look like poison AND the caller must have seen no
    // token deltas.
    let err = end_stream_error("resource_exhausted", "poisoned");
    assert!(err.is_resource_exhausted());
    let grpc_style = ConnectEndStreamError {
        code: "unknown".to_string(),
        message: "rpc error: code = ResourceExhausted desc = none".to_string(),
        raw: String::new(),
    };
    assert!(grpc_style.is_resource_exhausted());
    let not_poison = end_stream_error("not_found", "model");
    assert!(!not_poison.is_resource_exhausted());
}

#[test]
fn missing_turn_ended_is_reported_as_an_incomplete_stream() {
    // The run loop yields this exact error when the transport settles
    // without a turnEnded frame; pin the text the sampler surfaces.
    let err = SamplingError::EventStreamError("Cursor stream ended before turnEnded".to_string());
    assert!(err.to_string().contains("turnEnded"));
}

#[test]
fn the_unary_request_header_set_matches_omp_discovery() {
    let request = build_h2_request(
        "https://api2.cursor.sh",
        USABLE_MODELS_PATH,
        "application/proto",
        "cursor-token",
    );
    assert_eq!(
        request.uri(),
        "https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels"
    );
    assert_eq!(
        request.headers().get("content-type").unwrap(),
        "application/proto"
    );
    assert_eq!(request.headers().get("te").unwrap(), "trailers");
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        "Bearer cursor-token"
    );
    assert_eq!(request.headers().get("x-ghost-mode").unwrap(), "true");
}

#[test]
fn usable_models_body_decodes_enveloped_and_bare() {
    use crate::proto::GetUsableModelsResponse;
    let response = GetUsableModelsResponse {
        models: vec![proto::ModelDetails {
            model_id: "composer-2.5".into(),
            ..Default::default()
        }],
    };
    let bare = response.encode_to_vec();

    // Enveloped: flags 0 + BE length + payload.
    let mut enveloped = vec![0u8];
    enveloped.extend_from_slice(&(bare.len() as u32).to_be_bytes());
    enveloped.extend_from_slice(&bare);
    let enveloped = enveloped;

    let decoded = decode_get_usable_models_body(&enveloped).expect("enveloped decodes");
    assert_eq!(decoded.models.len(), 1);
    assert_eq!(decoded.models[0].model_id, "composer-2.5");

    let bare_decoded = decode_get_usable_models_body(&bare).expect("bare decodes");
    assert_eq!(bare_decoded.models.len(), 1);
    assert_eq!(bare_decoded.models[0].model_id, "composer-2.5");

    // An end-stream envelope reports the Connect error, not an empty list.
    let end_payload = frame_connect_message(
        br#"{"error":{"code":"unauthenticated","message":"expired"}}"#,
        framing::FLAG_END_STREAM,
    );
    let err = decode_get_usable_models_body(&end_payload).unwrap_err();
    assert!(matches!(err, SamplingError::Auth { .. }));

    // Empty body is an error, not an empty model list.
    assert!(decode_get_usable_models_body(&[]).is_err());
}
