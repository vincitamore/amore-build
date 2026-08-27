//! Connect-over-HTTP/2 transport for the Run RPC.
//!
//! One TLS + HTTP/2 session per turn, one request stream on it. The
//! client writes the Run request frame first, then heartbeats every
//! five seconds and any mid-stream replies the responders produce.
//! Success requires ALL of: `turnEnded` seen, no end-of-stream error,
//! trailers `grpc-status` 0 (or absent), and a clean stream end.
//!
//! A model-resolution failure (`not_found`) that lands before any
//! output is retried once with the configured model id verbatim — the
//! effort-slug normalization that split the id is the likely cause.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use http::Request;

use prost::Message;

use xai_grok_sampling_types::conversation::ConversationItem;
use xai_grok_sampling_types::{ReasoningEffort, SamplingError};

use crate::framing::{self, ConnectEndStreamError, frame_connect_message, parse_end_stream};
use crate::proto::agent_client_message::Message as ClientMessage;
use crate::proto::{AgentClientMessage, AgentServerMessage};
use crate::request::{
    BuiltRunRequest, RunRequestInput, build_run_request, normalize_system_prompts,
};
use crate::responder::{self, ResponderState};
use crate::{
    can_rotate, conversation_id_for, mark_conversation_completed, proto, rotate_conversation_id,
};

/// Base URL of Cursor's agent API.
pub const CURSOR_API_URL: &str = "https://api2.cursor.sh";
/// Run RPC path.
pub const RUN_PATH: &str = "/agent.v1.AgentService/Run";
/// GetUsableModels RPC path (unary; model discovery).
pub const USABLE_MODELS_PATH: &str = "/agent.v1.AgentService/GetUsableModels";
/// Client fingerprint the endpoint expects.
pub const CURSOR_CLIENT_VERSION: &str = "cli-2026.07.23-e383d2b";
/// Heartbeat cadence on the open Run stream.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

/// Everything one Run turn needs.
pub struct RunStreamConfig {
    /// Cursor access token (bearer).
    pub access_token: String,
    /// Base URL override (tests / bridges); defaults to
    /// [`CURSOR_API_URL`].
    pub base_url: Option<String>,
    /// Configured model id (the discovery id).
    pub model: String,
    /// Configured reasoning effort, applied when the model id carries
    /// no effort suffix.
    pub reasoning_effort: Option<ReasoningEffort>,
    /// Full conversation history (system entries included; they are
    /// extracted into the request-context rules).
    pub items: Vec<ConversationItem>,
    /// Session-stable conversation id. Rotation keys off it across
    /// attempts; a fresh uuid when None.
    pub base_conversation_id: Option<String>,
}

/// Open the Run stream and return the raw server-message stream.
///
/// The stream is self-contained: heartbeats and responder replies are
/// written from inside it, and its terminal item carries the transport
/// verdict (end-stream error, trailer status, or "ended before
/// turnEnded"). Dropping it closes the request stream and stops the
/// heartbeat task.
pub async fn run_stream(
    config: RunStreamConfig,
) -> Result<
    futures_util::stream::BoxStream<'static, Result<AgentServerMessage, SamplingError>>,
    SamplingError,
> {
    let base_url = config
        .base_url
        .unwrap_or_else(|| CURSOR_API_URL.to_string());
    let base_conversation_id = config
        .base_conversation_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // The stream only opens lazily with the first poll, so the
    // verbatim-id retry decision has to live inside it.
    let access_token = config.access_token;
    let model = config.model;
    let reasoning_effort = config.reasoning_effort;
    let items = config.items;
    Ok(async_stream::stream! {
        let mut force_discovered = false;
        let progress = Arc::new(AtomicBool::new(false));
        loop {
            let mut attempt_input = RunRequestInput {
                system_prompts: normalize_system_prompts(&items),
                items: items.clone(),
                model: model.clone(),
                reasoning_effort,
                base_conversation_id: base_conversation_id.clone(),
                conversation_id: conversation_id_for(&base_conversation_id),
                rotated_fresh: rotation_is_fresh(&base_conversation_id),
                force_discovered,
            };
            let built = build_run_request(&attempt_input);
            let was_normalized = built.normalized_effort;
            match run_once(
                &base_url,
                &access_token,
                &mut attempt_input,
                built,
                Arc::clone(&progress),
            )
            .await
            {
                Ok(attempt) => {
                    let mut retry_warranted = false;
                    futures_util::pin_mut!(attempt);
                    while let Some(item) = attempt.next().await {
                        if let Err(err) = &item {
                            retry_warranted = !force_discovered
                                && was_normalized
                                && is_model_not_found(err)
                                && !progress.load(Ordering::Relaxed);
                        }
                        yield item;
                    }
                    if !retry_warranted {
                        return;
                    }
                    tracing::warn!(
                        configured_model = %model,
                        "Cursor Run rejected the normalized model id before any output; retrying with the configured id verbatim"
                    );
                    force_discovered = true;
                }
                Err(err) => {
                    yield Err(err);
                    return;
                }
            }
        }
    }
    .boxed())
}

/// Whether the wire id for `base` is a rotation that has not yet
/// completed a turn (fresh rotations rebuild the conversation from
/// history instead of any cached state).
fn rotation_is_fresh(base: &str) -> bool {
    let wire = conversation_id_for(base);
    wire != base && !crate::rotation_completed(wire.as_str())
}

/// One Run attempt: open the h2 stream, write the request, and drive
/// frames until the transport settles. The returned stream's terminal
/// item is the transport verdict.
async fn run_once(
    base_url: &str,
    access_token: &str,
    input: &mut RunRequestInput,
    built: BuiltRunRequest,
    progress: Arc<AtomicBool>,
) -> Result<
    impl futures_util::Stream<Item = Result<AgentServerMessage, SamplingError>> + Send,
    SamplingError,
> {
    let (authority, path) = split_url(base_url);
    // The responder serves blob reads from a copy; the built request
    // keeps its own store for diagnostics.
    let responder_state = ResponderState::new(
        built.blob_store.clone(),
        responder::request_context_rules(&input.system_prompts),
    );

    let mut h2 = connect_h2(&authority).await?;
    let request = build_h2_request(&authority, &path, "application/connect+proto", access_token);
    let (response_fut, send_stream) = h2.send_request(request, false).map_err(h2_send_error)?;
    let response = response_fut.await.map_err(h2_send_error)?;
    let status = response.status();
    if !status.is_success() {
        // The Run RPC answers protocol failures at the HTTP layer too
        // (e.g. 464 when a proxy downgrades to HTTP/1.1).
        return Err(SamplingError::Api {
            status: reqwest_status(status),
            message: format!("Cursor Run endpoint returned HTTP {status}"),
            model_metadata: None,
            retry_after_secs: None,
            should_retry: None,
            error_code: None,
        });
    }
    let recv = response.into_body();

    // All client writes (request frame, heartbeats, responder replies)
    // go through one channel to the single writer that owns the h2
    // send stream. The request frame is queued first so the wire order
    // is right.
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    frame_tx
        .send(encode_envelope(&built.client_message))
        .expect("frame channel is open");

    // The writer half-closes the stream when every sender is gone
    // (normal completion); a write error ends it early.
    tokio::spawn(async move {
        let mut send = send_stream;
        while let Some(frame) = frame_rx.recv().await {
            if send.send_data(frame, false).is_err() {
                return;
            }
        }
        let _ = send.send_data(Bytes::new(), true);
    });

    // Heartbeats keep the idle server from closing the stream while the
    // model is thinking. The token cancels the task when this stream is
    // dropped or completes.
    let heartbeat_cancel = tokio_util::sync::CancellationToken::new();
    let heartbeat_token = heartbeat_cancel.clone();
    let heartbeat_tx = frame_tx.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // the first tick fires immediately; skip it
        let heartbeat = AgentClientMessage {
            message: Some(ClientMessage::ClientHeartbeat(proto::ClientHeartbeat {})),
        };
        loop {
            tokio::select! {
                biased;
                _ = heartbeat_token.cancelled() => return,
                _ = ticker.tick() => {
                    if heartbeat_tx.send(encode_envelope(&heartbeat)).is_err() {
                        return;
                    }
                }
            }
        }
    });

    Ok(run_loop(
        frame_tx,
        recv,
        responder_state,
        heartbeat_cancel,
        built,
        progress,
    ))
}

/// Encode one client message as a Connect envelope.
fn encode_envelope(message: &AgentClientMessage) -> Bytes {
    frame_connect_message(&AgentClientMessage::encode_to_vec(message), 0)
}

#[allow(clippy::too_many_arguments)]
fn run_loop(
    frame_tx: tokio::sync::mpsc::UnboundedSender<Bytes>,
    mut recv: h2::RecvStream,
    mut state: ResponderState,
    heartbeat_cancel: tokio_util::sync::CancellationToken,
    built: BuiltRunRequest,
    progress: Arc<AtomicBool>,
) -> impl futures_util::Stream<Item = Result<AgentServerMessage, SamplingError>> + Send {
    async_stream::stream! {
        let _frame_tx = frame_tx;
        let mut buffer: Vec<u8> = Vec::new();
        let mut saw_turn_ended = false;
        let mut saw_token_delta = false;
        let mut end_stream_error: Option<ConnectEndStreamError> = None;
        let mut trailer_grpc_status: Option<i64> = None;
        let mut transport_error: Option<SamplingError> = None;

        loop {
            // Drain whatever frames are complete in the buffer.
            loop {
                match framing::parse_frame(&buffer) {
                    Ok(Some((frame, consumed))) => {
                        buffer.drain(..consumed);
                        match frame {
                            framing::Frame::Message(payload) => {
                                match AgentServerMessage::decode(&payload[..]) {
                                    Ok(message) => {
                                        track_message(
                                            &message,
                                            progress.as_ref(),
                                            &mut saw_token_delta,
                                            &mut saw_turn_ended,
                                        );
                                        for reply in responder::reply_for(&message, &mut state) {
                                            let _ = _frame_tx.send(encode_envelope(&reply));
                                        }
                                        yield Ok(message);
                                    }
                                    Err(err) => {
                                        transport_error = Some(SamplingError::EventStreamError(
                                            format!("Cursor Run frame failed to decode: {err}"),
                                        ));
                                        break;
                                    }
                                }
                            }
                            framing::Frame::EndStream(payload) => {
                                match parse_end_stream(&payload) {
                                    Ok(Some(err)) => end_stream_error = Some(err),
                                    Ok(None) => {}
                                    Err(()) => {
                                        end_stream_error = Some(ConnectEndStreamError {
                                            code: "internal".to_string(),
                                            message: "unparseable Connect end stream".to_string(),
                                            raw: String::from_utf8_lossy(&payload).into_owned(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        transport_error = Some(SamplingError::EventStreamError(format!(
                            "Cursor Run stream framing desynchronized: {err:?}"
                        )));
                        break;
                    }
                }
            }
            if transport_error.is_some() {
                break;
            }

            // Pull the next data chunk from the stream.
            let next = tokio::select! {
                biased;
                _ = heartbeat_cancel.cancelled() => None,
                item = recv.data() => item,
            };
            match next {
                Some(Ok(data)) => {
                    // Received bytes consume the flow-control window;
                    // releasing it is what lets the server keep sending.
                    let _ = recv.flow_control().release_capacity(data.len());
                    if buffer.len().saturating_add(data.len()) > framing::MAX_FRAME_LEN as usize * 2 {
                        transport_error = Some(SamplingError::EventStreamError(
                            "Cursor Run stream framing desynchronized".to_string(),
                        ));
                        break;
                    }
                    buffer.extend_from_slice(&data);
                }
                Some(Err(err)) => {
                    transport_error = Some(h2_error(err));
                    break;
                }
                None => {
                    // Body ended; trailers may carry the final status.
                    match recv.trailers().await {
                        Ok(Some(trailers)) => {
                            trailer_grpc_status = trailers
                                .get("grpc-status")
                                .and_then(|v| v.to_str().ok())
                                .and_then(|v| v.parse::<i64>().ok());
                        }
                        Ok(None) => {}
                        Err(err) => transport_error = Some(h2_error(err)),
                    }
                    break;
                }
            }
        }

        heartbeat_cancel.cancel();
        if let Some(err) = transport_error {
            yield Err(err);
            return;
        }
        if let Some(err) = end_stream_error {
            maybe_rotate(&built, &err, saw_token_delta);
            yield Err(connect_error_to_sampling(&err));
            return;
        }
        if trailer_grpc_status.is_some_and(|status| status != 0) {
            let err = ConnectEndStreamError {
                code: grpc_code_name(trailer_grpc_status.expect("status checked above")).to_string(),
                message: "Run stream failed in trailers".to_string(),
                raw: String::new(),
            };
            maybe_rotate(&built, &err, saw_token_delta);
            yield Err(connect_error_to_sampling(&err));
            return;
        }
        if saw_turn_ended {
            mark_conversation_completed(&built.base_conversation_id);
            return;
        }
        yield Err(SamplingError::EventStreamError(
            "Cursor stream ended before turnEnded".to_string(),
        ));
    }
}

/// Track the transport-level signals the verdicts need.
fn track_message(
    message: &AgentServerMessage,
    progress: &AtomicBool,
    saw_token_delta: &mut bool,
    saw_turn_ended: &mut bool,
) {
    if let Some(proto::agent_server_message::Message::InteractionUpdate(update)) =
        message.message.as_ref()
    {
        match update.message.as_ref() {
            // A heartbeat is pure keepalive, never progress.
            Some(proto::interaction_update::Message::Heartbeat(_)) => {}
            Some(proto::interaction_update::Message::TokenDelta(_)) => {
                progress.store(true, Ordering::Relaxed);
                *saw_token_delta = true;
            }
            Some(proto::interaction_update::Message::TurnEnded(_)) => {
                progress.store(true, Ordering::Relaxed);
                *saw_turn_ended = true;
            }
            _ => progress.store(true, Ordering::Relaxed),
        }
    } else {
        // Any non-interaction frame (exec, KV, checkpoint) is progress.
        progress.store(true, Ordering::Relaxed);
    }
}

/// Conversation poison: a bare `resource_exhausted` with zero tokens
/// pins the rejection to the conversation id. Rotate once per failure
/// streak; the next attempt rebuilds from history.
fn maybe_rotate(built: &BuiltRunRequest, err: &ConnectEndStreamError, saw_token_delta: bool) {
    if saw_token_delta || !err.is_resource_exhausted() {
        return;
    }
    let base = built.base_conversation_id.clone();
    if base.is_empty() || !can_rotate(&base) {
        return;
    }
    let rotated = rotate_conversation_id(&base);
    tracing::warn!(
        base_conversation_id = %base,
        rotated_conversation_id = %rotated,
        "Cursor conversation rejected as resource_exhausted with no tokens; rotating conversation id"
    );
}

/// True when the error is the model-resolution failure retried with
/// the configured id verbatim (Connect `not_found` / gRPC 5, mapped to
/// HTTP 404 in [`connect_error_to_sampling`]).
fn is_model_not_found(err: &SamplingError) -> bool {
    matches!(
        err,
        SamplingError::Api {
            status: reqwest::StatusCode::NOT_FOUND,
            ..
        }
    )
}

/// Open the TLS + HTTP/2 session. The endpoint serves the Run RPC over
/// HTTP/2 only; TLS-ALPN must negotiate `h2`.
async fn connect_h2(authority: &str) -> Result<h2::client::SendRequest<Bytes>, SamplingError> {
    let (host, port) = split_authority(authority);
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|err| SamplingError::EventStreamError(format!("connect to {authority}: {err}")))?;

    let mut roots = rustls::RootCertStore::empty();
    // rustls-native-certs 0.8 returns a result struct with the certs
    // plus any OS-level load errors.
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = roots.add(cert);
    }
    for err in &native.errors {
        tracing::warn!("native certificate load issue: {err}");
    }
    let builder = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|err| SamplingError::EventStreamError(format!("tls setup: {err}")))?;
    let mut tls_config = builder.with_root_certificates(roots).with_no_client_auth();
    tls_config.alpn_protocols = vec![b"h2".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));

    let server_name = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|err| SamplingError::EventStreamError(format!("tls name {host}: {err}")))?;
    let tls = connector.connect(server_name, tcp).await.map_err(|err| {
        SamplingError::EventStreamError(format!(
            "Cursor run transport could not negotiate HTTP/2 with {authority} (TLS/ALPN failure; \
             the endpoint serves the Run RPC over HTTP/2 only): {err}"
        ))
    })?;

    let (send_request, connection) = h2::client::handshake(tls).await.map_err(|err| {
        SamplingError::EventStreamError(format!(
            "Cursor run transport could not negotiate HTTP/2 with {authority}: {err}"
        ))
    })?;
    tokio::spawn(async move {
        if let Err(err) = connection.await {
            tracing::debug!("Cursor h2 connection ended: {err}");
        }
    });
    Ok(send_request)
}

fn build_h2_request(
    authority: &str,
    path: &str,
    content_type: &str,
    access_token: &str,
) -> Request<()> {
    // No content-length: the request body keeps growing (heartbeats,
    // KV replies, exec responses) after the headers are sent.
    Request::builder()
        .method(http::Method::POST)
        .version(http::Version::HTTP_2)
        .uri(format!("{authority}{path}"))
        .header("content-type", content_type)
        .header("connect-protocol-version", "1")
        .header("te", "trailers")
        .header("authorization", format!("Bearer {access_token}"))
        .header("x-ghost-mode", "true")
        .header("x-cursor-client-version", CURSOR_CLIENT_VERSION)
        .header("x-cursor-client-type", "cli")
        .header("x-request-id", uuid::Uuid::new_v4().to_string())
        .body(())
        .expect("static Run request builds")
}

/// Map an end-of-stream error onto the sampler's error model.
fn connect_error_to_sampling(err: &ConnectEndStreamError) -> SamplingError {
    if err.is_unauthenticated() {
        return SamplingError::Auth {
            message: err.to_string(),
            credential: Default::default(),
        };
    }
    if err.is_model_not_found() {
        return SamplingError::Api {
            status: reqwest::StatusCode::NOT_FOUND,
            message: err.to_string(),
            model_metadata: None,
            retry_after_secs: None,
            should_retry: Some(false),
            error_code: None,
        };
    }
    if err.is_resource_exhausted() {
        return SamplingError::Api {
            status: reqwest::StatusCode::TOO_MANY_REQUESTS,
            message: err.to_string(),
            model_metadata: None,
            retry_after_secs: None,
            should_retry: None,
            error_code: None,
        };
    }
    SamplingError::Api {
        status: reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        message: err.to_string(),
        model_metadata: None,
        retry_after_secs: None,
        should_retry: None,
        error_code: None,
    }
}

fn grpc_code_name(status: i64) -> &'static str {
    match status {
        1 => "canceled",
        3 => "invalid_argument",
        4 => "deadline_exceeded",
        5 => "not_found",
        7 => "permission_denied",
        8 => "resource_exhausted",
        9 => "failed_precondition",
        10 => "aborted",
        14 => "unavailable",
        16 => "unauthenticated",
        _ => "unknown",
    }
}

fn h2_send_error(err: impl std::fmt::Display) -> SamplingError {
    SamplingError::EventStreamError(format!("Cursor Run stream write failed: {err}"))
}

fn h2_error(err: h2::Error) -> SamplingError {
    if let Some(reason) = err.reason() {
        SamplingError::EventStreamError(format!("Cursor Run stream reset: {reason}"))
    } else {
        SamplingError::EventStreamError(format!("Cursor Run stream error: {err}"))
    }
}

/// `reqwest::StatusCode` from the `http` crate's status (SamplingError
/// carries the reqwest type; the mapping is 1:1 on the u16).
fn reqwest_status(status: http::StatusCode) -> reqwest::StatusCode {
    reqwest::StatusCode::from_u16(status.as_u16())
        .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
}

// ── Unary Connect RPCs ──────────────────────────────────────────────────────

/// Everything one unary agent-service RPC needs.
pub struct UnaryConfig {
    /// Cursor access token (bearer).
    pub access_token: String,
    /// Base URL override (tests / bridges); defaults to
    /// [`CURSOR_API_URL`].
    pub base_url: Option<String>,
}

/// Fetch the account's usable models via the unary
/// `POST /agent.v1.AgentService/GetUsableModels` RPC.
///
/// Unlike [`run_stream`] this is a one-shot call: the request body is
/// the bare proto message under `content-type: application/proto` (the
/// endpoint serves HTTP/2 only), and the response is one proto message
/// that may arrive inside a 5-byte Connect envelope — both quirks the
/// endpoint is known to produce, so the envelope unwrap falls back to a
/// bare-body decode. No mid-stream writes are needed, so there is no
/// heartbeat or responder loop.
pub async fn get_usable_models(
    config: UnaryConfig,
) -> Result<Vec<proto::ModelDetails>, SamplingError> {
    let base_url = config
        .base_url
        .unwrap_or_else(|| CURSOR_API_URL.to_string());
    let authority = split_url(&base_url).0;
    let mut h2 = connect_h2(&authority).await?;
    let request = build_h2_request(
        &authority,
        USABLE_MODELS_PATH,
        "application/proto",
        &config.access_token,
    );
    let (response_fut, _send_stream) = h2.send_request(request, true).map_err(h2_send_error)?;
    let response = response_fut.await.map_err(h2_send_error)?;
    let status = response.status();
    let mut recv = response.into_body();
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = recv.data().await {
        let chunk = chunk.map_err(h2_error)?;
        let _ = recv.flow_control().release_capacity(chunk.len());
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        // Connect-level failures can arrive as an end-stream JSON error
        // document; map those through the shared verdicts when present.
        if let Ok(Some(err)) = framing::parse_end_stream(&body) {
            return Err(connect_error_to_sampling(&err));
        }
        return Err(SamplingError::Api {
            status: reqwest_status(status),
            message: format!("Cursor GetUsableModels endpoint returned HTTP {status}"),
            model_metadata: None,
            retry_after_secs: None,
            should_retry: None,
            error_code: None,
        });
    }
    decode_get_usable_models_body(&body).map(|decoded| decoded.models)
}

/// Decode the GetUsableModels response body. The endpoint envelopes the
/// unary response (observed), so an envelope message frame wins when
/// the body parses as one; otherwise the body is a bare proto message.
/// A bare body's first field tag can double as an envelope flag byte,
/// so a wrong envelope decode falls through to the bare decode.
fn decode_get_usable_models_body(
    body: &[u8],
) -> Result<proto::GetUsableModelsResponse, SamplingError> {
    if body.is_empty() {
        // An empty body is a transport failure, not "no usable models".
        return Err(SamplingError::EventStreamError(
            "Cursor GetUsableModels returned an empty response".to_owned(),
        ));
    }
    if let Ok(Some((frame, _))) = framing::parse_frame(body) {
        match frame {
            framing::Frame::Message(payload) => {
                if let Ok(decoded) = proto::GetUsableModelsResponse::decode(&payload[..]) {
                    return Ok(decoded);
                }
            }
            framing::Frame::EndStream(payload) => {
                // A real end-stream document maps through the shared
                // verdicts; an unparseable one is the bare-body false
                // positive (a proto field tag reads as the end-stream
                // flag) and falls through to the bare decode.
                if let Ok(Some(err)) = framing::parse_end_stream(&payload) {
                    return Err(connect_error_to_sampling(&err));
                }
            }
        }
    }
    proto::GetUsableModelsResponse::decode(body).map_err(|err| {
        SamplingError::EventStreamError(format!("Cursor GetUsableModels decode: {err}"))
    })
}

/// Split a base URL into the TLS authority and nothing else — the Run
/// RPC path is fixed ([`RUN_PATH`]); a base override changes the origin
/// only.
fn split_url(base_url: &str) -> (String, String) {
    let mut parts = base_url.splitn(2, "://");
    let _scheme = parts.next().unwrap_or("https");
    let rest = parts.next().unwrap_or(base_url);
    let authority = match rest.find('/') {
        Some(idx) => rest[..idx].to_string(),
        None => rest.to_string(),
    };
    (format!("https://{authority}"), RUN_PATH.to_string())
}

fn split_authority(authority: &str) -> (String, u16) {
    let authority = authority
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    if let Some((host, port)) = authority.rsplit_once(':')
        && let Ok(port) = port.parse()
    {
        return (host.to_string(), port);
    }
    (authority.to_string(), 443)
}

#[cfg(test)]
mod tests;
