//! Run-request construction: conversation state blobs, the active user
//! message action, model-id normalization.
//!
//! Cursor's server builds the model prompt from
//! `rootPromptMessagesJson` (JSON-message blobs) plus the mandatory
//! request-context rules; `turns` is display metadata. Both ride as
//! blob ids into the KV store the server reads back over the stream.

use std::collections::{HashMap, HashSet};

use prost::Message;
use sha2::{Digest, Sha256};

use xai_grok_sampling_types::conversation::ContentPart;
use xai_grok_sampling_types::conversation::ConversationItem;
use xai_grok_sampling_types::{ReasoningEffort, ToolCall};

use crate::json_value;
use crate::proto as pb;
use crate::proto::{
    agent_client_message, conversation_action, conversation_step, conversation_turn_structure,
    tool_call,
};

/// A blob id: the raw 32-byte sha256 of the blob contents.
pub fn blob_id(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Client-side blob store backing the Run request. Blobs the server
/// asks for are answered from here over the stream's KV channel; blobs
/// the server pushes are merged in.
#[derive(Default, Clone)]
pub struct BlobStore {
    blobs: HashMap<String, Vec<u8>>,
}

impl BlobStore {
    /// Store `data` under its sha256 id; returns the raw id bytes.
    pub fn store(&mut self, data: Vec<u8>) -> [u8; 32] {
        let id = blob_id(&data);
        self.blobs.insert(hex(&id), data);
        id
    }

    /// Merge a server-pushed blob (KV `setBlobArgs`).
    pub fn store_under(&mut self, id: &[u8], data: Vec<u8>) {
        self.blobs.insert(hex(id), data);
    }

    pub fn get(&self, id: &[u8]) -> Option<&Vec<u8>> {
        self.blobs.get(&hex(id))
    }

    pub fn len(&self) -> usize {
        self.blobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.blobs.is_empty()
    }
}

/// Tool-call ids reaching Cursor's wire must match `^[a-zA-Z0-9_-]+$`
/// and fit 64 chars; foreign history carries composite ids that would
/// otherwise have the whole Run rejected as `resource_exhausted`.
pub fn normalize_tool_call_id(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.len() > 64 {
        sanitized[..64].to_string()
    } else {
        sanitized
    }
}

/// Leading 128 bits of sha256(seed) as a v4-shape uuid string.
/// Deterministic ids keep history message ids stable across rebuilds.
fn deterministic_uuid(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let h = hex(&digest);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Model ids whose effort suffix splits into a `reasoning` parameter.
/// Cursor's Run endpoint rejects a bare sibling slug (`gpt-5.4-mini-low`)
/// as `resource_exhausted`; only the OpenAI family carries the effort
/// suffix that way. Matches `gpt-<digits…>` ids and the rolling
/// daybreak aliases.
fn is_openai_family(model_id: &str) -> bool {
    if model_id == "gpt-daybreak-blue-latest" || model_id == "gpt-daybreak-red-latest" {
        return true;
    }
    let Some(rest) = model_id.strip_prefix("gpt-") else {
        return false;
    };
    let version: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if version.is_empty() {
        return false;
    }
    let after = &rest[version.len()..];
    after.is_empty() || after.starts_with('-')
}

fn reasoning_param(effort: &str) -> pb::RequestedModelModelParameterbytes {
    pb::RequestedModelModelParameterbytes {
        id: "reasoning".to_string(),
        value: effort.to_string(),
    }
}

/// Wire model id + parameters for a configured model id.
///
/// Cursor's fast lane follows the effort token (`-high-fast`), while
/// the standard lane ends at it (`-high`), so the lane suffix survives
/// the split. `composer-2.5` resolves to the Fast variant server-side
/// unless the Standard tier is pinned explicitly; `-fast` selections
/// keep the Fast lane by omitting the parameter.
pub fn resolve_wire_model(model: &str) -> (String, Vec<pb::RequestedModelModelParameterbytes>) {
    const EFFORTS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
    if let Some(stripped) = model.strip_suffix("-fast") {
        for effort in EFFORTS {
            if let Some(base) = stripped.strip_suffix(&format!("-{effort}"))
                && is_openai_family(base)
            {
                return (format!("{base}-fast"), vec![reasoning_param(effort)]);
            }
        }
    }
    for effort in EFFORTS {
        if let Some(base) = model.strip_suffix(&format!("-{effort}"))
            && is_openai_family(base)
        {
            return (base.to_string(), vec![reasoning_param(effort)]);
        }
    }
    if model == "composer-2.5" {
        return (
            model.to_string(),
            vec![pb::RequestedModelModelParameterbytes {
                id: "fast".to_string(),
                value: "false".to_string(),
            }],
        );
    }
    (model.to_string(), Vec::new())
}

/// Collect the system prompt entries from history, in order, trimmed
/// and skipping empties.
pub fn normalize_system_prompts(items: &[ConversationItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| match item {
            ConversationItem::System(system) => {
                let content = system.content.trim();
                (!content.is_empty()).then(|| content.to_string())
            }
            _ => None,
        })
        .collect()
}

/// One JSON prompt-message entry, matching Cursor's internal
/// Vercel-AI-SDK-shaped message format.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PromptMessage {
    System(String),
    User { content: Vec<PromptContentPart> },
    Assistant { content: Vec<PromptContentPart> },
    Tool {
        id: String,
        tool_name: String,
        result: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PromptContentPart {
    Text(String),
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        args: serde_json::Value,
    },
}

impl PromptMessage {
    pub(crate) fn to_json(&self) -> serde_json::Value {
        match self {
            PromptMessage::System(content) => {
                serde_json::json!({ "role": "system", "content": content })
            }
            PromptMessage::User { content } => serde_json::json!({
                "role": "user",
                "content": content.iter().map(prompt_part_json).collect::<Vec<_>>(),
            }),
            PromptMessage::Assistant { content } => serde_json::json!({
                "role": "assistant",
                "content": content.iter().map(prompt_part_json).collect::<Vec<_>>(),
            }),
            PromptMessage::Tool {
                id,
                tool_name,
                result,
                is_error,
            } => {
                let mut part = serde_json::json!({
                    "type": "tool-result",
                    "toolName": tool_name,
                    "toolCallId": id,
                    "result": result,
                });
                if *is_error {
                    part["isError"] = serde_json::Value::Bool(true);
                }
                serde_json::json!({ "role": "tool", "id": id, "content": [part] })
            }
        }
    }
}

fn prompt_part_json(part: &PromptContentPart) -> serde_json::Value {
    match part {
        PromptContentPart::Text(text) => serde_json::json!({ "type": "text", "text": text }),
        PromptContentPart::ToolCall {
            tool_call_id,
            tool_name,
            args,
        } => serde_json::json!({
            "type": "tool-call",
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "args": args,
        }),
    }
}

/// Everything the Run request needs, already resolved.
pub struct RunRequestInput {
    /// Normalized, non-empty system prompt entries, in order.
    pub system_prompts: Vec<String>,
    /// Full conversation history (system entries included).
    pub items: Vec<ConversationItem>,
    /// Configured model id (the discovery id).
    pub model: String,
    /// Configured reasoning effort, applied when the model id carries
    /// no effort suffix.
    pub reasoning_effort: Option<ReasoningEffort>,
    /// Base conversation id (session-stable).
    pub base_conversation_id: String,
    /// Wire conversation id (possibly rotated).
    pub conversation_id: String,
    /// The wire id is freshly rotated: rebuild the conversation from
    /// history with the last user message re-sent as the active
    /// message, never from cached server state.
    pub rotated_fresh: bool,
    /// Skip model-id normalization and send the configured id verbatim
    /// (the verbatim-id retry after a `not_found`).
    pub force_discovered: bool,
}

pub struct BuiltRunRequest {
    /// The first frame to write on the Run stream.
    pub client_message: pb::AgentClientMessage,
    pub blob_store: BlobStore,
    /// State structure sent in the request.
    pub conversation_state: pb::ConversationStateStructure,
    /// Wire model id after normalization.
    pub wire_model_id: String,
    /// The session-stable conversation id the wire id rotates from.
    pub base_conversation_id: String,
    /// The wire id is a normalized effort payload (slug split into a
    /// parameter) — eligible for one retry with the configured id
    /// verbatim when the server rejects it before any output.
    pub normalized_effort: bool,
}

/// Build the Run request for one turn.
pub fn build_run_request(input: &RunRequestInput) -> BuiltRunRequest {
    let mut blob_store = BlobStore::default();

    // One system blob per ordered prompt entry: changing only the last
    // entry leaves earlier blob ids (and the server's prefix cache)
    // intact. An empty prompt head still emits a default greeting so
    // rootPromptMessagesJson is never empty.
    let system_messages: Vec<String> = if input.system_prompts.is_empty() {
        vec![serde_json::to_string(&serde_json::json!({
            "role": "system",
            "content": "You are a helpful assistant."
        }))
        .expect("static json serializes")]
    } else {
        input
            .system_prompts
            .iter()
            .map(|content| {
                serde_json::to_string(&serde_json::json!({ "role": "system", "content": content }))
                    .expect("system prompt json serializes")
            })
            .collect()
    };
    let system_prompt_ids: Vec<Vec<u8>> = system_messages
        .iter()
        .map(|json| blob_store.store(json.clone().into_bytes()).to_vec())
        .collect();

    // Active user message: the last item when history ends on a user
    // message; otherwise the turn resumes. On a fresh rotation the last
    // user message is always re-sent so the new conversation is rebuilt
    // from history rather than from poisoned cached state.
    let active_index = last_user_index(&input.items);
    let tail_is_user =
        matches!(input.items.last(), Some(ConversationItem::User(_)));
    let (action_index, history_end) = if tail_is_user {
        (Some(input.items.len() - 1), input.items.len() - 1)
    } else if input.rotated_fresh && active_index.is_some() {
        (active_index, active_index.unwrap())
    } else {
        (None, input.items.len())
    };

    let (action, history) = match action_index {
        Some(index) => {
            let message = pb::UserMessage {
                text: user_item_text(&input.items[index]).trim().to_string(),
                message_id: uuid::Uuid::new_v4().to_string(),
                ..Default::default()
            };
            (
                conversation_action::Action::UserMessageAction(pb::UserMessageAction {
                    user_message: Some(message),
                    ..Default::default()
                }),
                &input.items[..history_end],
            )
        }
        None => (
            conversation_action::Action::ResumeAction(pb::ResumeAction::default()),
            &input.items[..history_end],
        ),
    };

    // Tool names for result entries: ToolResult carries only the call
    // id, so the name is looked up from the assistant call it answers.
    let mut tool_names: HashMap<String, String> = HashMap::new();
    for item in history {
        if let ConversationItem::Assistant(assistant) = item {
            for call in &assistant.tool_calls {
                tool_names.insert(call.id.to_string(), call.name.to_string());
            }
        }
    }

    // rootPromptMessagesJson: system blobs + every prior message as a
    // JSON blob. Tool result entries are emitted even when empty so a
    // replayed assistant tool call is never orphaned.
    let mut root_prompt_ids = system_prompt_ids.clone();
    for item in history {
        // System entries are already carried by `system_prompts`
        // (extracted by the caller); emitting them again here would
        // duplicate the prompt head.
        if matches!(item, ConversationItem::System(_)) {
            continue;
        }
        for message in item_prompt_messages(item, &tool_names) {
            let json =
                serde_json::to_vec(&message.to_json()).expect("prompt message json serializes");
            let id = blob_store.store(json);
            root_prompt_ids.push(id.to_vec());
        }
    }

    // turns: user message + assistant steps per turn, as protobuf blobs.
    let turns = build_turns(history, &mut blob_store);

    let conversation_state = pb::ConversationStateStructure {
        root_prompt_messages_json: root_prompt_ids,
        turns,
        ..Default::default()
    };

    // Model: normalized wire id + parameters. A configured reasoning
    // effort applies to the OpenAI family when the id itself carries no
    // effort suffix; other families take no reasoning parameter.
    let (wire_model_id, parameters, normalized_effort) = if input.force_discovered {
        (input.model.clone(), Vec::new(), false)
    } else {
        let (wire_model_id, parameters) = resolve_wire_model(&input.model);
        if parameters.is_empty()
            && let Some(effort) = input.reasoning_effort
            && !matches!(effort, ReasoningEffort::None)
            && is_openai_family(&wire_model_id)
        {
            (wire_model_id.clone(), vec![reasoning_param(effort.as_str())], true)
        } else {
            let normalized = !parameters.is_empty() && wire_model_id != input.model;
            (wire_model_id.clone(), parameters.clone(), normalized)
        }
    };

    let model_details = pb::ModelDetails {
        model_id: wire_model_id.clone(),
        display_model_id: input.model.clone(),
        display_name: input.model.clone(),
        ..Default::default()
    };
    let requested_model = pb::RequestedModel {
        model_id: wire_model_id.clone(),
        max_mode: false,
        parameters: parameters.clone(),
        ..Default::default()
    };

    let run_request = pb::AgentRunRequest {
        conversation_state: Some(conversation_state.clone()),
        action: Some(pb::ConversationAction {
            action: Some(action),
        }),
        model_details: Some(model_details),
        requested_model: Some(requested_model),
        conversation_id: Some(input.conversation_id.clone()),
        ..Default::default()
    };

    BuiltRunRequest {
        client_message: pb::AgentClientMessage {
            message: Some(agent_client_message::Message::RunRequest(run_request)),
        },
        blob_store,
        conversation_state,
        wire_model_id,
        base_conversation_id: input.base_conversation_id.clone(),
        normalized_effort,
    }
}

fn last_user_index(items: &[ConversationItem]) -> Option<usize> {
    items
        .iter()
        .rposition(|item| matches!(item, ConversationItem::User(_)))
}

fn user_item_text(item: &ConversationItem) -> String {
    let ConversationItem::User(user) = item else {
        return String::new();
    };
    let mut text = String::new();
    for part in &user.content {
        if let ContentPart::Text { text: t } = part {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(t);
        }
    }
    text
}

/// Map one history item to its root-prompt JSON message(s).
fn item_prompt_messages(
    item: &ConversationItem,
    tool_names: &HashMap<String, String>,
) -> Vec<PromptMessage> {
    match item {
        ConversationItem::System(system) => vec![PromptMessage::System(system.content.to_string())],
        ConversationItem::User(user) => {
            let content: Vec<PromptContentPart> = user
                .content
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => {
                        let text = text.trim().to_string();
                        (!text.is_empty()).then_some(PromptContentPart::Text(text))
                    }
                    // Images are not carried on this backend's text path.
                    ContentPart::Image { .. } => None,
                })
                .collect();
            (!content.is_empty())
                .then_some(PromptMessage::User { content })
                .into_iter()
                .collect()
        }
        ConversationItem::Assistant(assistant) => {
            let mut content: Vec<PromptContentPart> = Vec::new();
            let text = assistant.content.trim().to_string();
            if !text.is_empty() {
                content.push(PromptContentPart::Text(text));
            }
            for call in &assistant.tool_calls {
                content.push(PromptContentPart::ToolCall {
                    tool_call_id: normalize_tool_call_id(&call.id),
                    tool_name: call.name.to_string(),
                    args: normalized_tool_args(&call.arguments),
                });
            }
            (!content.is_empty())
                .then_some(PromptMessage::Assistant { content })
                .into_iter()
                .collect()
        }
        ConversationItem::ToolResult(result) => {
            vec![PromptMessage::Tool {
                id: normalize_tool_call_id(&result.tool_call_id),
                tool_name: tool_names
                    .get(result.tool_call_id.as_str())
                    .cloned()
                    .unwrap_or_default(),
                result: result.content.to_string(),
                is_error: false,
            }]
        }
        // Cursor only replays its own same-model thinking; reasoning is
        // skipped here. Backend tool calls (server-executed) render as
        // their text summary so their context survives the rebuild.
        ConversationItem::Reasoning(_) => Vec::new(),
        ConversationItem::BackendToolCall(backend) => {
            let summary = backend.text_summary();
            (!summary.is_empty())
                .then_some(PromptMessage::Assistant {
                    content: vec![PromptContentPart::Text(summary)],
                })
                .into_iter()
                .collect()
        }
    }
}

/// Tool-call arguments arrive as a JSON string; the wire wants the
/// parsed object (invalid JSON degrades to `{}`).
fn normalized_tool_args(arguments: &str) -> serde_json::Value {
    serde_json::from_str(arguments).unwrap_or(serde_json::Value::Object(Default::default()))
}

/// Build `turns` blobs: one agent turn per user message, steps = the
/// assistant content that follows it. Every `user_message`, `steps[]`,
/// and `turns[]` entry is a blob ID into the store (not the encoded
/// bytes).
fn build_turns(history: &[ConversationItem], blob_store: &mut BlobStore) -> Vec<Vec<u8>> {
    let mut paired_tool_call_ids: HashSet<String> = HashSet::new();
    for item in history {
        if let ConversationItem::Assistant(assistant) = item {
            for call in &assistant.tool_calls {
                paired_tool_call_ids.insert(call.id.to_string());
            }
        }
    }

    let mut turns: Vec<Vec<u8>> = Vec::new();
    let mut index = 0;
    while index < history.len() {
        let ConversationItem::User(_) = &history[index] else {
            index += 1;
            continue;
        };
        let text = user_item_text(&history[index]);
        let mut step_blobs: Vec<Vec<u8>> = Vec::new();
        index += 1;
        while index < history.len() {
            match &history[index] {
                ConversationItem::Assistant(assistant) => {
                    let text = assistant.content.trim().to_string();
                    if !text.is_empty() {
                        let step = pb::ConversationStep {
                            message: Some(conversation_step::Message::AssistantMessage(
                                pb::AssistantMessage { text },
                            )),
                        };
                        let id = blob_store.store(pb::ConversationStep::encode_to_vec(&step));
                        step_blobs.push(id.to_vec());
                    }
                    for call in &assistant.tool_calls {
                        let step = tool_call_step(call);
                        let id = blob_store.store(pb::ConversationStep::encode_to_vec(&step));
                        step_blobs.push(id.to_vec());
                    }
                    index += 1;
                }
                ConversationItem::ToolResult(result) => {
                    // Results paired with a call in the same turn ride
                    // inside the call's step; an unpaired result renders
                    // as assistant text so it is not lost.
                    if !paired_tool_call_ids.contains(result.tool_call_id.as_str()) {
                        let content = result.content.trim();
                        if !content.is_empty() {
                            let step = pb::ConversationStep {
                                message: Some(conversation_step::Message::AssistantMessage(
                                    pb::AssistantMessage {
                                        text: format!("[Tool Result]\n{content}"),
                                    },
                                )),
                            };
                            let id = blob_store.store(pb::ConversationStep::encode_to_vec(&step));
                            step_blobs.push(id.to_vec());
                        }
                    }
                    index += 1;
                }
                ConversationItem::System(_)
                | ConversationItem::Reasoning(_)
                | ConversationItem::BackendToolCall(_) => {
                    index += 1;
                }
                ConversationItem::User(_) => break,
            }
        }

        let user_message = pb::UserMessage {
            message_id: deterministic_uuid(&format!("u:{}:{}", turns.len(), text)),
            text,
            ..Default::default()
        };
        let user_blob = blob_store.store(pb::UserMessage::encode_to_vec(&user_message));
        let turn = pb::ConversationTurnStructure {
            turn: Some(conversation_turn_structure::Turn::AgentConversationTurn(
                pb::AgentConversationTurnStructure {
                    user_message: user_blob.to_vec(),
                    steps: step_blobs,
                    ..Default::default()
                },
            )),
        };
        let turn_blob = blob_store.store(pb::ConversationTurnStructure::encode_to_vec(&turn));
        turns.push(turn_blob.to_vec());
    }
    turns
}

fn tool_call_step(call: &ToolCall) -> pb::ConversationStep {
    let tool_call_id = normalize_tool_call_id(&call.id);
    let mut args = HashMap::new();
    if let serde_json::Value::Object(map) = normalized_tool_args(&call.arguments) {
        for (name, value) in map {
            args.insert(
                name,
                json_value::encode_proto_value(&value),
            );
        }
    }
    let mcp_call = pb::McpToolCall {
        args: Some(pb::McpArgs {
            name: call.name.to_string(),
            args,
            tool_call_id: tool_call_id.clone(),
            provider_identifier: "pi-agent".to_string(),
            tool_name: call.name.to_string(),
            ..Default::default()
        }),
        ..Default::default()
    };
    pb::ConversationStep {
        message: Some(conversation_step::Message::ToolCall(pb::ToolCall {
            tool: Some(tool_call::Tool::McpToolCall(mcp_call)),
            tool_call_id: Some(tool_call_id),
        })),
    }
}

#[cfg(test)]
mod tests;
