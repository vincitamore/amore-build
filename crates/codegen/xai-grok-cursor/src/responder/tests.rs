use super::*;
use crate::proto::{
    exec_server_message, interaction_query, kv_server_message, KvServerMessage, SetBlobArgs,
};
use crate::request::blob_id;

fn responder_state() -> ResponderState {
    ResponderState::new(BlobStore::default(), request_context_rules(&[
        "prompt one".to_string(),
        "prompt two".to_string(),
    ]))
}

fn server_message(message: pb::agent_server_message::Message) -> pb::AgentServerMessage {
    pb::AgentServerMessage {
        message: Some(message),
    }
}

#[test]
fn rules_carry_each_system_prompt_as_a_global_user_rule() {
    let rules = request_context_rules(&["first".to_string(), "second".to_string()]);
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0].full_path, "/amore/system-prompt/0.mdc");
    assert_eq!(rules[1].full_path, "/amore/system-prompt/1.mdc");
    assert_eq!(rules[0].content, "first");
    assert_eq!(rules[0].source, pb::CursorRuleSource::User as i32);
    for rule in &rules {
        let Some(pb::CursorRuleType { r#type: Some(pb::cursor_rule_type::Type::Global(_)) }) =
            rule.r#type.as_ref()
        else {
            panic!("every prompt rule is a global rule");
        };
    }
}

#[test]
fn get_blob_hit_returns_the_data_under_the_request_id() {
    let mut state = responder_state();
    let data = b"blob-bytes".to_vec();
    let id = state.blob_store.store(data.clone());

    let kv = KvServerMessage {
        id: 42,
        message: Some(kv_server_message::Message::GetBlobArgs(pb::GetBlobArgs {
            blob_id: id.to_vec().into(),
        })),
        ..Default::default()
    };
    let reply = kv_reply(&kv, &mut state);
    let Some(pb::agent_client_message::Message::KvClientMessage(client)) = reply.message else {
        panic!("kv reply");
    };
    assert_eq!(client.id, 42);
    let Some(pb::kv_client_message::Message::GetBlobResult(result)) = client.message else {
        panic!("get result");
    };
    assert_eq!(result.blob_data.as_deref(), Some(data.as_slice()));
}

#[test]
fn get_blob_miss_answers_with_an_empty_result_not_a_hang() {
    let mut state = responder_state();
    let kv = KvServerMessage {
        id: 7,
        message: Some(kv_server_message::Message::GetBlobArgs(pb::GetBlobArgs {
            blob_id: vec![0u8; 32].into(),
        })),
        ..Default::default()
    };
    let reply = kv_reply(&kv, &mut state);
    let Some(pb::agent_client_message::Message::KvClientMessage(client)) = reply.message else {
        panic!("kv reply");
    };
    let Some(pb::kv_client_message::Message::GetBlobResult(result)) = client.message else {
        panic!("get result");
    };
    assert_eq!(result.blob_data, None);
}

#[test]
fn set_blob_stores_the_pushed_data_and_answers_set_result() {
    let mut state = responder_state();
    let pushed = b"server pushed this".to_vec();
    let kv = KvServerMessage {
        id: 9,
        message: Some(kv_server_message::Message::SetBlobArgs(SetBlobArgs {
            blob_id: blob_id(&pushed).to_vec().into(),
            blob_data: pushed.clone().into(),
        })),
        ..Default::default()
    };
    let reply = kv_reply(&kv, &mut state);
    let Some(pb::agent_client_message::Message::KvClientMessage(client)) = reply.message else {
        panic!("kv reply");
    };
    let Some(pb::kv_client_message::Message::SetBlobResult(_)) = client.message else {
        panic!("set result");
    };
    assert_eq!(
        state.blob_store.get(&blob_id(&pushed)).map(|b| b.as_ref()),
        Some(pushed.as_slice())
    );
}

#[test]
fn request_context_args_is_answered_with_rules_and_no_tools() {
    let mut state = responder_state();
    let exec = pb::ExecServerMessage {
        id: 3,
        exec_id: "exec-1".to_string(),
        message: Some(exec_server_message::Message::RequestContextArgs(
            pb::RequestContextArgs::default(),
        )),
        ..Default::default()
    };
    let replies = reply_for(
        &server_message(pb::agent_server_message::Message::ExecServerMessage(exec)),
        &mut state,
    );
    assert_eq!(replies.len(), 1);
    let Some(pb::agent_client_message::Message::ExecClientMessage(client)) =
        replies[0].message.as_ref()
    else {
        panic!("exec reply");
    };
    assert_eq!(client.id, 3);
    assert_eq!(client.exec_id, "exec-1");
    let Some(exec_client_message::Message::RequestContextResult(result)) = client.message.as_ref()
    else {
        panic!("request context result");
    };
    let Some(request_context_result::Result::Success(success)) = result.result.as_ref() else {
        panic!("success result");
    };
    let context = success.request_context.as_ref().unwrap();
    assert_eq!(context.rules.len(), 2);
    assert_eq!(context.rules[0].content, "prompt one");
    assert!(context.tools.is_empty(), "no tools advertised on this backend");
}

#[test]
fn native_tool_frames_are_rejected_with_throw_then_stream_close() {
    let mut state = responder_state();
    let exec = pb::ExecServerMessage {
        id: 11,
        message: Some(exec_server_message::Message::ShellArgs(pb::ShellArgs {
            command: "rm -rf /".to_string(),
            ..Default::default()
        })),
        ..Default::default()
    };
    let replies = reply_for(
        &server_message(pb::agent_server_message::Message::ExecServerMessage(exec)),
        &mut state,
    );
    assert_eq!(replies.len(), 2);
    let Some(pb::agent_client_message::Message::ExecClientControlMessage(control)) =
        replies[0].message.as_ref()
    else {
        panic!("control reply");
    };
    let Some(exec_client_control_message::Message::Throw(throw)) = control.message.as_ref() else {
        panic!("throw");
    };
    assert_eq!(throw.id, 11);
    assert_eq!(throw.error, TOOL_NOT_AVAILABLE);
    let Some(pb::agent_client_message::Message::ExecClientControlMessage(control)) =
        replies[1].message.as_ref()
    else {
        panic!("control reply");
    };
    let Some(exec_client_control_message::Message::StreamClose(close)) = control.message.as_ref()
    else {
        panic!("stream close");
    };
    assert_eq!(close.id, 11);
}

#[test]
fn frames_this_proto_does_not_model_are_rejected_not_stranded() {
    let mut state = responder_state();
    let exec = pb::ExecServerMessage {
        id: 12,
        message: None,
        ..Default::default()
    };
    let replies = reply_for(
        &server_message(pb::agent_server_message::Message::ExecServerMessage(exec)),
        &mut state,
    );
    assert_eq!(replies.len(), 2);
    let Some(pb::agent_client_message::Message::ExecClientControlMessage(control)) =
        replies[0].message.as_ref()
    else {
        panic!("control reply");
    };
    let Some(exec_client_control_message::Message::Throw(throw)) = control.message.as_ref() else {
        panic!("throw");
    };
    assert_eq!(throw.error, "Unknown exec message variant");
}

#[test]
fn hosted_fetch_permission_gates_are_approved() {
    let mut state = responder_state();
    for query_case in [
        interaction_query::Query::WebFetchRequestQuery(pb::WebFetchRequestQuery::default()),
        interaction_query::Query::WebSearchRequestQuery(pb::WebSearchRequestQuery::default()),
        interaction_query::Query::ExaFetchRequestQuery(pb::ExaFetchRequestQuery::default()),
        interaction_query::Query::ExaSearchRequestQuery(pb::ExaSearchRequestQuery::default()),
    ] {
        let query = pb::InteractionQuery {
            id: 5,
            query: Some(query_case),
        };
        let replies = reply_for(
            &server_message(pb::agent_server_message::Message::InteractionQuery(query)),
            &mut state,
        );
        assert_eq!(replies.len(), 1, "gate must be answered or the turn stalls");
        let Some(pb::agent_client_message::Message::InteractionResponse(resp)) =
            replies[0].message.as_ref()
        else {
            panic!("interaction reply");
        };
        assert_eq!(resp.id, 5);
        let approved = matches!(
            resp.result,
            Some(interaction_response::Result::WebFetchRequestResponse(_))
                | Some(interaction_response::Result::WebSearchRequestResponse(_))
                | Some(interaction_response::Result::ExaFetchRequestResponse(_))
                | Some(interaction_response::Result::ExaSearchRequestResponse(_))
        );
        assert!(approved, "search/fetch gates are approved");
    }
}

#[test]
fn interactive_questions_and_mode_switches_are_rejected() {
    let mut state = responder_state();
    let query = pb::InteractionQuery {
        id: 6,
        query: Some(interaction_query::Query::AskQuestionInteractionQuery(
            pb::AskQuestionInteractionQuery::default(),
        )),
    };
    let replies = reply_for(
        &server_message(pb::agent_server_message::Message::InteractionQuery(query)),
        &mut state,
    );
    let Some(pb::agent_client_message::Message::InteractionResponse(resp)) =
        replies[0].message.as_ref()
    else {
        panic!("interaction reply");
    };
    let Some(interaction_response::Result::AskQuestionInteractionResponse(answer)) =
        resp.result.as_ref()
    else {
        panic!("ask reply");
    };
    let Some(pb::ask_question_result::Result::Rejected(rejected)) =
        answer.result.as_ref().unwrap().result.as_ref()
    else {
        panic!("rejected answer");
    };
    assert!(rejected.reason.contains("not implemented"));

    let query = pb::InteractionQuery {
        id: 7,
        query: Some(interaction_query::Query::SwitchModeRequestQuery(
            pb::SwitchModeRequestQuery::default(),
        )),
    };
    let replies = reply_for(
        &server_message(pb::agent_server_message::Message::InteractionQuery(query)),
        &mut state,
    );
    assert_eq!(replies.len(), 1);
}

#[test]
fn vm_setup_is_left_unanswered_rather_than_faked() {
    let mut state = responder_state();
    let query = pb::InteractionQuery {
        id: 8,
        query: Some(interaction_query::Query::SetupVmEnvironmentArgs(
            pb::SetupVmEnvironmentArgs::default(),
        )),
    };
    let replies = reply_for(
        &server_message(pb::agent_server_message::Message::InteractionQuery(query)),
        &mut state,
    );
    assert!(replies.is_empty());
}

#[test]
fn interaction_and_checkpoint_frames_need_no_reply() {
    let mut state = responder_state();
    let update = pb::AgentServerMessage {
        message: Some(pb::agent_server_message::Message::InteractionUpdate(
            pb::InteractionUpdate {
                message: Some(pb::interaction_update::Message::TextDelta(
                    pb::TextDeltaUpdate { text: "hi".to_string() },
                )),
            },
        )),
    };
    assert!(reply_for(&update, &mut state).is_empty());
    let checkpoint = pb::AgentServerMessage {
        message: Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(
            pb::ConversationStateStructure::default(),
        )),
    };
    assert!(reply_for(&checkpoint, &mut state).is_empty());
}
