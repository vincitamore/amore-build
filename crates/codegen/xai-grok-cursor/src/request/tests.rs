use super::*;
use crate::proto::agent_client_message::Message as ClientMessage;

fn user_item(text: &str) -> ConversationItem {
    ConversationItem::User(xai_grok_sampling_types::UserItem {
        content: vec![xai_grok_sampling_types::conversation::ContentPart::Text {
            text: text.into(),
        }],
        ..Default::default()
    })
}

fn assistant_item(text: &str) -> ConversationItem {
    ConversationItem::Assistant(xai_grok_sampling_types::AssistantItem {
        content: text.into(),
        tool_calls: Vec::new(),
        model_id: None,
        model_fingerprint: None,
        reasoning_effort: None,
    })
}

fn assistant_with_call(call: ToolCall) -> ConversationItem {
    ConversationItem::Assistant(xai_grok_sampling_types::AssistantItem {
        content: "".into(),
        tool_calls: vec![call],
        model_id: None,
        model_fingerprint: None,
        reasoning_effort: None,
    })
}

fn system_item(text: &str) -> ConversationItem {
    ConversationItem::System(xai_grok_sampling_types::SystemItem {
        content: text.into(),
    })
}

fn tool_result_item(id: &str, text: &str) -> ConversationItem {
    ConversationItem::ToolResult(xai_grok_sampling_types::ToolResultItem {
        tool_call_id: id.to_string(),
        content: text.into(),
        images: Vec::new(),
    })
}

fn input(items: Vec<ConversationItem>) -> RunRequestInput {
    RunRequestInput {
        system_prompts: vec!["be brief".to_string()],
        items,
        model: "gpt-5.4-mini".to_string(),
        reasoning_effort: None,
        base_conversation_id: "conv-base".to_string(),
        conversation_id: "conv-base".to_string(),
        rotated_fresh: false,
        force_discovered: false,
    }
}

/// Read one root-prompt JSON blob back out of the store.
fn root_prompt_jsons(built: &BuiltRunRequest) -> Vec<serde_json::Value> {
    built
        .conversation_state
        .root_prompt_messages_json
        .iter()
        .map(|id| {
            let data = built.blob_store.get(id).expect("blob present");
            serde_json::from_slice(data).expect("valid json blob")
        })
        .collect()
}

#[test]
fn blob_ids_are_sha256_of_contents() {
    // sha256("hello")
    let expected: [u8; 32] = [
        0x2c, 0xf2, 0x4d, 0xba, 0x5f, 0xb0, 0xa3, 0x0e, 0x26, 0xe8, 0x3b, 0x2a, 0xc5, 0xb9,
        0xe2, 0x9e, 0x1b, 0x16, 0x1e, 0x5c, 0x1f, 0xa7, 0x42, 0x5e, 0x73, 0x04, 0x33, 0x62,
        0x93, 0x8b, 0x98, 0x24,
    ];
    assert_eq!(blob_id(b"hello"), expected);
    assert_ne!(blob_id(b"hello"), blob_id(b"hellp"));
}

#[test]
fn blob_store_round_trips_by_id_and_merges_server_pushes() {
    let mut store = BlobStore::default();
    let data = b"payload".to_vec();
    let id = store.store(data.clone());
    assert_eq!(store.get(&id).map(|b| b.as_ref()), Some(data.as_slice()));

    let pushed = b"server-pushed".to_vec();
    let pushed_id = blob_id(&pushed);
    store.store_under(&pushed_id, pushed.clone());
    assert_eq!(store.get(&pushed_id).map(|b| b.as_ref()), Some(pushed.as_slice()));
    assert_eq!(store.len(), 2);
}

#[test]
fn tool_call_ids_are_sanitized_to_the_wire_charset() {
    assert_eq!(normalize_tool_call_id("call_123-abc"), "call_123-abc");
    assert_eq!(
        normalize_tool_call_id("fc_0123|item_0456"),
        "fc_0123_item_0456"
    );
    let long = "a".repeat(100);
    assert_eq!(normalize_tool_call_id(&long).len(), 64);
}

#[test]
fn openai_effort_slugs_split_into_base_id_plus_reasoning_parameter() {
    let (id, params) = resolve_wire_model("gpt-5.4-mini-low");
    assert_eq!(id, "gpt-5.4-mini");
    assert_eq!(params.len(), 1);
    assert_eq!(params[0].id, "reasoning");
    assert_eq!(params[0].value, "low");

    let (id, params) = resolve_wire_model("gpt-5.6-sol-xhigh");
    assert_eq!(id, "gpt-5.6-sol");
    assert_eq!(params[0].value, "xhigh");

    let (id, params) = resolve_wire_model("gpt-daybreak-blue-latest-high");
    assert_eq!(id, "gpt-daybreak-blue-latest");
    assert_eq!(params[0].value, "high");
}

#[test]
fn fast_lane_suffix_survives_the_effort_split() {
    let (id, params) = resolve_wire_model("gpt-5.4-high-fast");
    assert_eq!(id, "gpt-5.4-fast");
    assert_eq!(params[0].value, "high");
}

#[test]
fn non_openai_ids_pass_through_unchanged() {
    let (id, params) = resolve_wire_model("composer-1.5-max");
    assert_eq!(id, "composer-1.5-max");
    assert!(params.is_empty(), "sibling slugs of other families are not split");

    let (id, params) = resolve_wire_model("cursor-grok-4");
    assert_eq!(id, "cursor-grok-4");
    assert!(params.is_empty());
}

#[test]
fn composer_fast_tier_is_pinned_standard() {
    let (id, params) = resolve_wire_model("composer-2.5");
    assert_eq!(id, "composer-2.5");
    assert_eq!(params.len(), 1);
    assert_eq!(params[0].id, "fast");
    assert_eq!(params[0].value, "false");
}

#[test]
fn configured_effort_applies_to_openai_ids_without_a_slug() {
    let mut input = input(vec![user_item("hi")]);
    input.reasoning_effort = Some(xai_grok_sampling_types::ReasoningEffort::High);
    let built = build_run_request(&input);
    assert_eq!(built.wire_model_id, "gpt-5.4-mini");
    let requested = built
        .client_message
        .message
        .as_ref()
        .unwrap();
    let ClientMessage::RunRequest(run) = requested else {
        panic!("run request");
    };
    let parameters = &run.requested_model.as_ref().unwrap().parameters;
    assert_eq!(parameters.len(), 1);
    assert_eq!(parameters[0].value, "high");
    assert!(built.normalized_effort);
}

#[test]
fn run_request_carries_conversation_state_action_and_model() {
    let built = build_run_request(&input(vec![
        system_item("be brief"),
        user_item("first question"),
        assistant_item("first answer"),
        user_item("second question"),
    ]));

    let ClientMessage::RunRequest(run) = built.client_message.message.as_ref().unwrap() else {
        panic!("run request");
    };
    assert_eq!(run.conversation_id.as_deref(), Some("conv-base"));

    // Active message rides the action; history ends before it.
    let action = run.action.as_ref().unwrap().action.as_ref().unwrap();
    let conversation_action::Action::UserMessageAction(user_action) = action else {
        panic!("user message action");
    };
    let user_message = user_action.user_message.as_ref().unwrap();
    assert_eq!(user_message.text, "second question");
    assert!(!user_message.message_id.is_empty());

    // The model prompt: system blob + prior user + prior assistant.
    // The active message is NOT in the prompt history.
    let prompts = root_prompt_jsons(&built);
    assert_eq!(prompts.len(), 3);
    assert_eq!(prompts[0]["role"], "system");
    assert_eq!(prompts[0]["content"], "be brief");
    assert_eq!(prompts[1]["role"], "user");
    assert_eq!(prompts[1]["content"][0]["text"], "first question");
    assert_eq!(prompts[2]["role"], "assistant");
    assert_eq!(prompts[2]["content"][0]["text"], "first answer");
    assert!(!serde_json::to_string(&prompts)
        .unwrap()
        .contains("second question"));

    let state = &built.conversation_state;
    assert_eq!(state.root_prompt_messages_json.len(), 3);
    assert_eq!(state.turns.len(), 1, "one completed turn before the active message");
}

#[test]
fn history_ending_on_tool_results_resumes_instead_of_resending() {
    let built = build_run_request(&input(vec![
        user_item("do the thing"),
        tool_result_item("call-1", "done"),
    ]));
    let ClientMessage::RunRequest(run) = built.client_message.message.as_ref().unwrap() else {
        panic!("run request");
    };
    let action = run.action.as_ref().unwrap().action.as_ref().unwrap();
    let conversation_action::Action::ResumeAction(_) = action else {
        panic!("resume action expected");
    };
    // The tool result stays in the prompt history on a resume.
    let prompts = root_prompt_jsons(&built);
    assert_eq!(prompts.len(), 3);
    assert_eq!(prompts[2]["role"], "tool");
    assert_eq!(prompts[2]["content"][0]["type"], "tool-result");
    assert_eq!(prompts[2]["content"][0]["result"], "done");
}

#[test]
fn fresh_rotation_re_sends_the_last_user_message() {
    let mut rotated = input(vec![
        user_item("retry me"),
        tool_result_item("call-1", "partial"),
    ]);
    rotated.rotated_fresh = true;
    let built = build_run_request(&rotated);
    let ClientMessage::RunRequest(run) = built.client_message.message.as_ref().unwrap() else {
        panic!("run request");
    };
    let action = run.action.as_ref().unwrap().action.as_ref().unwrap();
    let conversation_action::Action::UserMessageAction(user_action) = action else {
        panic!("user message action expected on fresh rotation");
    };
    assert_eq!(user_action.user_message.as_ref().unwrap().text, "retry me");
    // History is rebuilt from before the re-sent message.
    let prompts = root_prompt_jsons(&built);
    assert_eq!(prompts.len(), 1, "system only");
}

#[test]
fn empty_history_still_sends_a_system_greeting_blob() {
    let built = build_run_request(&input(vec![user_item("hello")]));
    let prompts = root_prompt_jsons(&built);
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["role"], "system");
}

#[test]
fn empty_system_prompt_list_falls_back_to_the_default_greeting() {
    let mut empty = input(vec![user_item("hello")]);
    empty.system_prompts = Vec::new();
    let built = build_run_request(&empty);
    let prompts = root_prompt_jsons(&built);
    assert_eq!(prompts[0]["content"], "You are a helpful assistant.");
}

#[test]
fn assistant_tool_calls_replay_as_tool_call_parts_with_sanitized_ids() {
    let built = build_run_request(&{
        let mut with_call = input(vec![
            user_item("list files"),
            assistant_with_call(ToolCall {
                id: "call|weird id".into(),
                name: "ls".into(),
                arguments: r#"{"path":"/tmp"}"#.into(),
            }),
            tool_result_item("call|weird id", "file.txt"),
        ]);
        with_call.system_prompts = vec!["be brief".to_string()];
        with_call
    });
    let prompts = root_prompt_jsons(&built);
    let assistant = &prompts[2];
    assert_eq!(assistant["content"][0]["type"], "tool-call");
    assert_eq!(assistant["content"][0]["toolCallId"], "call_weird_id");
    assert_eq!(assistant["content"][0]["toolName"], "ls");
    assert_eq!(assistant["content"][0]["args"]["path"], "/tmp");
    // The paired result carries the same sanitized id and the name.
    let tool = &prompts[3];
    assert_eq!(tool["id"], "call_weird_id");
    assert_eq!(tool["content"][0]["toolName"], "ls");
}

#[test]
fn turns_decode_to_user_message_and_step_blobs() {
    let built = build_run_request(&input(vec![
        user_item("turn one"),
        assistant_item("answer one"),
        user_item("turn two"),
        assistant_item("answer two"),
        user_item("turn three"),
    ]));
    // The active (tail) user message is excluded; two prior turns.
    assert_eq!(built.conversation_state.turns.len(), 2);
    // Turns entries are blob ids; the encoded turn lives in the store.
    let first_id = &built.conversation_state.turns[0];
    let turn_blob = built.blob_store.get(first_id).expect("turn blob stored");
    let turn = pb::ConversationTurnStructure::decode(turn_blob.as_slice()).unwrap();
    let pb::conversation_turn_structure::Turn::AgentConversationTurn(agent_turn) =
        turn.turn.unwrap()
    else {
        panic!("agent turn");
    };
    let user_blob = built.blob_store.get(&agent_turn.user_message).unwrap();
    let user = pb::UserMessage::decode(user_blob.as_slice()).unwrap();
    assert_eq!(user.text, "turn one");
    assert_eq!(agent_turn.steps.len(), 1);
    let step = pb::ConversationStep::decode(
        built.blob_store.get(&agent_turn.steps[0]).unwrap().as_slice(),
    )
    .unwrap();
    let pb::conversation_step::Message::AssistantMessage(text) = step.message.unwrap() else {
        panic!("assistant step");
    };
    assert_eq!(text.text, "answer one");
}

#[test]
fn history_user_message_ids_are_deterministic_across_rebuilds() {
    let items = vec![user_item("stable"), assistant_item("reply"), user_item("active")];
    let first = build_run_request(&input(items.clone()));
    let second = build_run_request(&input(items));
    let ids = |built: &BuiltRunRequest| -> Vec<String> {
        built
            .conversation_state
            .turns
            .iter()
            .map(|turn_id| {
                let blob = built.blob_store.get(turn_id).expect("turn blob stored");
                let turn = pb::ConversationTurnStructure::decode(blob.as_slice()).unwrap();
                let pb::conversation_turn_structure::Turn::AgentConversationTurn(agent_turn) =
                    turn.turn.unwrap()
                else {
                    panic!("agent turn");
                };
                let user = pb::UserMessage::decode(
                    built.blob_store.get(&agent_turn.user_message).unwrap().as_slice(),
                )
                .unwrap();
                user.message_id
            })
            .collect()
    };
    assert_eq!(ids(&first), ids(&second));
}

#[test]
fn force_discovered_sends_the_configured_id_verbatim() {
    let mut discovered = input(vec![user_item("hi")]);
    discovered.model = "gpt-5.4-mini-low".to_string();
    discovered.force_discovered = true;
    let built = build_run_request(&discovered);
    assert_eq!(built.wire_model_id, "gpt-5.4-mini-low");
    assert!(!built.normalized_effort);
    let ClientMessage::RunRequest(run) = built.client_message.message.as_ref().unwrap() else {
        panic!("run request");
    };
    assert_eq!(
        run.requested_model.as_ref().unwrap().model_id,
        "gpt-5.4-mini-low"
    );
    assert!(run.requested_model.as_ref().unwrap().parameters.is_empty());
}

