//! Layer-2 stream transform for the Cursor agent wire.
//!
//! Consumes the raw `AgentServerMessage` stream produced by the
//! Connect transport (which answers the KV / request-context / exec
//! frames itself) and produces [`SamplingEvent`]s. Pure: no I/O, no
//! shell coupling.
//!
//! Text, thinking, token deltas and the turn end map directly; native
//! tool-call announcements are not carried (the transport rejects the
//! backing exec frames in band, and the turn still ends cleanly with
//! `turnEnded`).

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use futures_util::stream::{BoxStream, Stream};

use xai_grok_cursor::proto::{
    agent_server_message, interaction_update, AgentServerMessage, ConversationStateStructure,
};
use xai_grok_sampling_types::{
    AssistantItem, ConversationItem, ConversationResponse, ResponseModelMetadata, SamplingError,
    StopReason, TokenUsage, rs,
};

use crate::events::{SamplingChannel, SamplingErrorInfo, SamplingEvent};
use crate::metrics::InferenceLatencyStats;
use crate::types::RequestId;

/// Whether a raw server message reflects real model progress rather
/// than a keepalive heartbeat (used for the idle timeout).
pub(crate) fn cursor_message_has_meaningful_content(message: &AgentServerMessage) -> bool {
    !matches!(
        message.message.as_ref(),
        Some(agent_server_message::Message::InteractionUpdate(update))
            if matches!(
                update.message.as_ref(),
                Some(interaction_update::Message::Heartbeat(_))
            )
    )
}

/// Transform a raw Cursor Run stream into a stream of
/// [`SamplingEvent`]s.
///
/// Yields exactly one terminal event ([`SamplingEvent::Completed`] or
/// [`SamplingEvent::Failed`]) per request. The transport's verdict
/// (end-of-stream error, trailer status, "ended before turnEnded")
/// arrives as the stream's terminal error.
pub fn stream_cursor<'a>(
    raw_stream: BoxStream<'a, Result<AgentServerMessage, SamplingError>>,
    model_metadata: Option<ResponseModelMetadata>,
    request_id: RequestId,
    idle_timeout: Duration,
) -> impl Stream<Item = SamplingEvent> + Send + 'a {
    async_stream::stream! {
        let stream_start = Instant::now();
        let mut chunk_timestamps: Vec<Instant> = Vec::new();

        yield SamplingEvent::StreamStarted {
            request_id: request_id.clone(),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        };

        if let Some(metadata) = model_metadata {
            yield SamplingEvent::ModelMetadata {
                request_id: request_id.clone(),
                metadata,
            };
        }

        // Assistant-response accumulators.
        let mut assistant_text = String::new();
        let mut assistant_reasoning: Option<rs::ReasoningItem> = None;

        // Usage: output tokens accumulate per `tokenDelta`; the context
        // size rides the checkpoint's `tokenDetails.usedTokens`.
        let mut output_tokens: u32 = 0;
        let mut context_tokens: u32 = 0;
        let mut saw_usage = false;

        let mut saw_turn_ended = false;
        let mut final_message_id: Option<String> = None;

        let mut chunk_index: u64 = 0;
        let mut message_chunk_count: u64 = 0;
        let mut first_token_emitted = false;

        let mut stream = raw_stream;
        loop {
            let event_result = match tokio::time::timeout(idle_timeout, stream.next()).await {
                Ok(Some(event_result)) => event_result,
                Ok(None) => break,
                Err(_elapsed) => {
                    let err = SamplingError::IdleTimeout {
                        elapsed_secs: idle_timeout.as_secs(),
                    };
                    yield SamplingEvent::Failed {
                        request_id: request_id.clone(),
                        error: SamplingErrorInfo::from(&err),
                    };
                    return;
                }
            };

            let message = match event_result {
                Ok(message) => message,
                Err(err) => {
                    yield SamplingEvent::Failed {
                        request_id: request_id.clone(),
                        error: SamplingErrorInfo::from(&err),
                    };
                    return;
                }
            };

            let event_has_content = cursor_message_has_meaningful_content(&message);

            match message.message.as_ref() {
                Some(agent_server_message::Message::InteractionUpdate(update)) => {
                    match update.message.as_ref() {
                        Some(interaction_update::Message::TextDelta(delta)) => {
                            let delta = delta.text.as_str();
                            if !delta.is_empty() {
                                if !first_token_emitted {
                                    first_token_emitted = true;
                                    yield SamplingEvent::FirstToken {
                                        request_id: request_id.clone(),
                                    };
                                }
                                assistant_text.push_str(delta);
                                chunk_timestamps.push(Instant::now());
                                chunk_index += 1;
                                message_chunk_count += 1;
                                yield SamplingEvent::ChannelToken {
                                    request_id: request_id.clone(),
                                    channel: SamplingChannel::Text,
                                    text: delta.to_string(),
                                    chunk_index,
                                };
                            }
                        }
                        Some(interaction_update::Message::ThinkingDelta(delta)) => {
                            let delta = delta.text.as_str();
                            if !delta.is_empty() {
                                if !first_token_emitted {
                                    first_token_emitted = true;
                                    yield SamplingEvent::FirstToken {
                                        request_id: request_id.clone(),
                                    };
                                }
                                chunk_index += 1;
                                yield SamplingEvent::ChannelToken {
                                    request_id: request_id.clone(),
                                    channel: SamplingChannel::Reasoning,
                                    text: delta.to_string(),
                                    chunk_index,
                                };
                                push_thinking(&mut assistant_reasoning, delta);
                            }
                        }
                        // Cursor carries no thinking signature; the block
                        // boundary needs no event here.
                        Some(interaction_update::Message::ThinkingCompleted(_)) => {}
                        Some(interaction_update::Message::TokenDelta(delta)) => {
                            saw_usage = true;
                            // Negative deltas are server corrections; floor
                            // the accumulator at zero rather than wrapping.
                            output_tokens =
                                output_tokens.saturating_add(delta.tokens.max(0) as u32);
                        }
                        Some(interaction_update::Message::TurnEnded(_)) => {
                            saw_turn_ended = true;
                        }
                        // Tool-call announcements are display-only on
                        // this backend; the exec channel is answered by
                        // the transport's responders.
                        Some(
                            interaction_update::Message::PartialToolCall(_)
                            | interaction_update::Message::ToolCallDelta(_)
                            | interaction_update::Message::ToolCallStarted(_)
                            | interaction_update::Message::ToolCallCompleted(_),
                        ) => {}
                        Some(interaction_update::Message::UserMessageAppended(update)) => {
                            final_message_id =
                                update.user_message.as_ref().map(|m| m.message_id.clone());
                        }
                        // Heartbeat / summary / shell-output / step events
                        // carry nothing this transform surfaces.
                        _ => {}
                    }
                }
                Some(agent_server_message::Message::ConversationCheckpointUpdate(
                    checkpoint,
                )) => {
                    if let Some(details) = checkpoint.token_details.as_ref()
                        && details.used_tokens > 0
                    {
                        context_tokens = details.used_tokens;
                        saw_usage = true;
                    }
                }
                _ => {}
            }

            if event_has_content {
                // The idle window resets on every received chunk above;
                // nothing further to track here.
            }
        }

        if !saw_turn_ended {
            // The transport already emits the precise verdict for a
            // stream that ends without one; reaching here means the raw
            // stream completed cleanly but never turned.
            let err = SamplingError::EventStreamError(
                "Cursor stream ended before turnEnded".to_string(),
            );
            yield SamplingEvent::Failed {
                request_id: request_id.clone(),
                error: SamplingErrorInfo::from(&err),
            };
            return;
        }

        // ── Build the final response ─────────────────────────────────
        let usage = if saw_usage && (context_tokens > 0 || output_tokens > 0) {
            Some(TokenUsage {
                prompt_tokens: context_tokens,
                completion_tokens: output_tokens,
                total_tokens: context_tokens.saturating_add(output_tokens),
                reasoning_tokens: 0,
                cached_prompt_tokens: 0,
                cache_creation_prompt_tokens: 0,
            })
        } else {
            None
        };

        let assistant_item = ConversationItem::Assistant(AssistantItem {
            content: std::sync::Arc::<str>::from(assistant_text),
            tool_calls: Vec::new(),
            model_id: None,
            model_fingerprint: None,
            // Cursor does not echo the applied effort.
            reasoning_effort: None,
        });

        let mut items: Vec<ConversationItem> = Vec::new();
        if let Some(r) = assistant_reasoning {
            items.push(ConversationItem::Reasoning(r));
        }
        items.push(assistant_item);

        let stream_end = Instant::now();
        let metrics =
            InferenceLatencyStats::from_timestamps(stream_start, &chunk_timestamps, stream_end);

        let response = ConversationResponse {
            items,
            stop_reason: Some(StopReason::Stop),
            usage,
            cost_usd_ticks: None,
            message_chunks_emitted: message_chunk_count,
            doom_loop_signals: Vec::new(),
            stop_message: None,
            message_id: final_message_id,
            raw_stop_reason: Some("turnEnded".to_string()),
            stop_sequence: None,
        };

        yield SamplingEvent::Completed {
            request_id: request_id.clone(),
            response: Box::new(response),
            metrics,
        };
    }
}

fn push_thinking(reasoning: &mut Option<rs::ReasoningItem>, delta: &str) {
    let item = reasoning.get_or_insert_with(|| rs::ReasoningItem {
        id: String::new(),
        summary: Vec::new(),
        content: None,
        encrypted_content: None,
        status: None,
    });
    if let Some(rs::SummaryPart::SummaryText(text)) = item.summary.last_mut() {
        text.text.push_str(delta);
    } else {
        item.summary.push(rs::SummaryPart::SummaryText(
            rs::SummaryTextContent {
                text: delta.to_string(),
            },
        ));
    }
}

/// Exposed for tests: the usage numbers the transform derives from a
/// checkpoint + token deltas.
pub(crate) fn usage_from_checkpoint(checkpoint: &ConversationStateStructure, output_tokens: u32) -> Option<TokenUsage> {
    let context_tokens = checkpoint.token_details.as_ref()?.used_tokens;
    (context_tokens > 0 || output_tokens > 0).then_some(TokenUsage {
        prompt_tokens: context_tokens,
        completion_tokens: output_tokens,
        total_tokens: context_tokens.saturating_add(output_tokens),
        reasoning_tokens: 0,
        cached_prompt_tokens: 0,
        cache_creation_prompt_tokens: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_grok_cursor::proto::{
        ConversationStateStructure, ConversationTokenDetails, InteractionUpdate, TextDeltaUpdate,
        ThinkingDeltaUpdate, TokenDeltaUpdate, TurnEndedUpdate,
    };

    const IDLE: Duration = Duration::from_secs(60);

    fn interaction(update: interaction_update::Message) -> AgentServerMessage {
        AgentServerMessage {
            message: Some(agent_server_message::Message::InteractionUpdate(
                InteractionUpdate {
                    message: Some(update),
                },
            )),
        }
    }

    fn text_delta(text: &str) -> AgentServerMessage {
        interaction(interaction_update::Message::TextDelta(TextDeltaUpdate {
            text: text.to_string(),
        }))
    }

    fn thinking_delta(text: &str) -> AgentServerMessage {
        interaction(interaction_update::Message::ThinkingDelta(
            ThinkingDeltaUpdate {
                text: text.to_string(),
            },
        ))
    }

    fn turn_ended() -> AgentServerMessage {
        interaction(interaction_update::Message::TurnEnded(TurnEndedUpdate {}))
    }

    fn checkpoint(used_tokens: u32) -> AgentServerMessage {
        AgentServerMessage {
            message: Some(agent_server_message::Message::ConversationCheckpointUpdate(
                ConversationStateStructure {
                    token_details: Some(ConversationTokenDetails {
                        used_tokens,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        }
    }

    fn from_messages(
        messages: Vec<Result<AgentServerMessage, SamplingError>>,
    ) -> BoxStream<'static, Result<AgentServerMessage, SamplingError>> {
        futures_util::stream::iter(messages).boxed()
    }

    async fn collect_terminal<S>(events: S) -> SamplingEvent
    where
        S: Stream<Item = SamplingEvent>,
    {
        let mut events = std::pin::pin!(events);
        let mut terminal = None;
        while let Some(event) = events.next().await {
            if matches!(
                event,
                SamplingEvent::Completed { .. } | SamplingEvent::Failed { .. }
            ) {
                terminal = Some(event);
            }
        }
        terminal.expect("exactly one terminal event")
    }

    #[tokio::test]
    async fn text_deltas_stream_as_text_tokens_and_complete() {
        let raw = from_messages(vec![
            Ok(text_delta("hel")),
            Ok(text_delta("lo")),
            Ok(turn_ended()),
        ]);
        let events = stream_cursor(
            raw,
            None,
            RequestId::random(),
            IDLE,
        );
        let mut pin = std::pin::pin!(events);
        let mut text = String::new();
        loop {
            match pin.next().await {
                Some(SamplingEvent::ChannelToken {
                    channel: SamplingChannel::Text,
                    text: chunk,
                    ..
                }) => text.push_str(&chunk),
                Some(SamplingEvent::Completed { response, .. }) => {
                    assert_eq!(text, "hello");
                    let items = &response.items;
                    assert_eq!(items.len(), 1);
                    let ConversationItem::Assistant(assistant) = &items[0] else {
                        panic!("assistant item");
                    };
                    assert_eq!(assistant.content.as_ref(), "hello");
                    assert_eq!(response.stop_reason, Some(StopReason::Stop));
                    assert_eq!(response.raw_stop_reason.as_deref(), Some("turnEnded"));
                    return;
                }
                Some(_) => {}
                None => panic!("stream ended without a terminal event"),
            }
        }
    }

    #[tokio::test]
    async fn thinking_deltas_stream_as_reasoning_and_land_in_the_response() {
        let raw = from_messages(vec![
            Ok(thinking_delta("ponder")),
            Ok(thinking_delta("ing")),
            Ok(text_delta("answer")),
            Ok(turn_ended()),
        ]);
        let events = stream_cursor(raw, None, RequestId::random(), IDLE);
        let mut pin = std::pin::pin!(events);
        let mut reasoning = String::new();
        let mut saw_reasoning_channel = false;
        loop {
            match pin.next().await {
                Some(SamplingEvent::ChannelToken {
                    channel: SamplingChannel::Reasoning,
                    text,
                    ..
                }) => {
                    saw_reasoning_channel = true;
                    reasoning.push_str(&text);
                }
                Some(SamplingEvent::Completed { response, .. }) => {
                    assert!(saw_reasoning_channel);
                    assert_eq!(reasoning, "pondering");
                    assert_eq!(response.items.len(), 2, "reasoning item + assistant");
                    let ConversationItem::Reasoning(item) = &response.items[0] else {
                        panic!("reasoning item");
                    };
                    let Some(rs::SummaryPart::SummaryText(summary)) = item.summary.first() else {
                        panic!("summary text");
                    };
                    assert_eq!(summary.text, "pondering");
                    return;
                }
                Some(_) => {}
                None => panic!("stream ended without a terminal event"),
            }
        }
    }

    #[tokio::test]
    async fn token_deltas_and_checkpoint_build_the_usage() {
        let raw = from_messages(vec![
            Ok(text_delta("hi")),
            Ok(interaction(interaction_update::Message::TokenDelta(
                TokenDeltaUpdate { tokens: 3 },
            ))),
            Ok(interaction(interaction_update::Message::TokenDelta(
                TokenDeltaUpdate { tokens: 4 },
            ))),
            Ok(checkpoint(120)),
            Ok(turn_ended()),
        ]);
        let events = stream_cursor(raw, None, RequestId::random(), IDLE);
        let mut pin = std::pin::pin!(events);
        while let Some(event) = pin.next().await {
            if let SamplingEvent::Completed { response, .. } = event {
                let usage = response.usage.expect("usage present");
                assert_eq!(usage.prompt_tokens, 120, "checkpoint usedTokens = context");
                assert_eq!(usage.completion_tokens, 7, "tokenDelta sum = output");
                assert_eq!(usage.total_tokens, 127);
                return;
            }
        }
        panic!("no terminal event");
    }

    #[tokio::test]
    async fn heartbeats_do_not_count_or_break_the_stream() {
        let raw = from_messages(vec![
            Ok(interaction(interaction_update::Message::Heartbeat(
                xai_grok_cursor::proto::HeartbeatUpdate::default(),
            ))),
            Ok(text_delta("ok")),
            Ok(turn_ended()),
        ]);
        let events = stream_cursor(raw, None, RequestId::random(), IDLE);
        let terminal = collect_terminal(events).await;
        assert!(matches!(terminal, SamplingEvent::Completed { .. }));
    }

    #[tokio::test]
    async fn a_stream_ending_without_turn_ended_fails() {
        let raw = from_messages(vec![Ok(text_delta("partial"))]);
        let events = stream_cursor(raw, None, RequestId::random(), IDLE);
        let terminal = collect_terminal(events).await;
        let SamplingEvent::Failed { error, .. } = terminal else {
            panic!("expected failure");
        };
        assert!(error.message.contains("turnEnded"));
    }

    #[tokio::test]
    async fn a_transport_error_surfaces_as_failed() {
        let raw = from_messages(vec![Err(SamplingError::EventStreamError(
            "Cursor Run stream reset".to_string(),
        ))]);
        let events = stream_cursor(raw, None, RequestId::random(), IDLE);
        let terminal = collect_terminal(events).await;
        let SamplingEvent::Failed { error, .. } = terminal else {
            panic!("expected failure");
        };
        assert!(error.message.contains("reset"));
    }

    #[test]
    fn usage_helper_maps_checkpoint_details() {
        let checkpoint = ConversationStateStructure {
            token_details: Some(ConversationTokenDetails {
                used_tokens: 50,
                ..Default::default()
            }),
            ..Default::default()
        };
        let usage = usage_from_checkpoint(&checkpoint, 5).expect("usage");
        assert_eq!(usage.prompt_tokens, 50);
        assert_eq!(usage.completion_tokens, 5);
        // Zero on both sides = no usage at all.
        let empty = ConversationStateStructure::default();
        assert!(usage_from_checkpoint(&empty, 0).is_none());
    }
}