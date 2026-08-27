//! Mandatory mid-stream responders.
//!
//! The server blocks generation on these frames and waits forever
//! without an answer, so every one of them must be replied to on the
//! same request stream:
//! - `kvServerMessage.getBlobArgs` / `setBlobArgs` — the blob KV
//!   (there is no upload endpoint on the Run path).
//! - `execServerMessage.requestContextArgs` — the request context; the
//!   SYSTEM PROMPT must ride as global rules here because the server
//!   reconstructs the model prompt from `requestContext.rules`, not
//!   from the system blobs in `rootPromptMessagesJson`.
//! - any other `execServerMessage` — the server is asking for a tool
//!   this client does not run; the exec channel's throw + streamClose
//!   is the protocol's answer for that, and the server surfaces the
//!   error to the model instead of waiting.
//! - `interactionQuery` — hosted-tool permission gates block the turn
//!   until answered.

use crate::proto as pb;
use crate::proto::{
    agent_client_message, exec_client_control_message, exec_client_message, interaction_response,
    request_context_result,
};
use crate::request::BlobStore;

/// Error text for exec frames this client does not run. Phrased as a
/// client capability statement, not a tool failure: the model reads it
/// and should route around the capability, not retry the call.
pub const TOOL_NOT_AVAILABLE: &str = "Tool not available";

/// Everything a responder needs to answer a server frame.
pub struct ResponderState {
    pub blob_store: BlobStore,
    /// System prompt entries as global rules (see module docs).
    pub rules: Vec<pb::CursorRule>,
    /// Advertised MCP tool definitions.
    pub tools: Vec<pb::McpToolDefinition>,
}

impl ResponderState {
    pub fn new(blob_store: BlobStore, rules: Vec<pb::CursorRule>) -> Self {
        Self {
            blob_store,
            rules,
            tools: Vec::new(),
        }
    }
}

/// Build the global rules carrying the system prompt into the request
/// context. One rule per ordered prompt entry so always-apply rules
/// survive the server's prompt reconstruction.
pub fn request_context_rules(system_prompts: &[String]) -> Vec<pb::CursorRule> {
    system_prompts
        .iter()
        .enumerate()
        .map(|(index, content)| pb::CursorRule {
            full_path: format!("/amore/system-prompt/{index}.mdc"),
            content: content.clone(),
            r#type: Some(pb::CursorRuleType {
                r#type: Some(pb::cursor_rule_type::Type::Global(
                    pb::CursorRuleTypeGlobal {},
                )),
            }),
            source: pb::CursorRuleSource::User as i32,
            ..Default::default()
        })
        .collect()
}

/// Reply frames for one server message. Empty = nothing to answer.
pub fn reply_for(
    message: &pb::AgentServerMessage,
    state: &mut ResponderState,
) -> Vec<pb::AgentClientMessage> {
    match message.message.as_ref() {
        Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
            vec![kv_reply(kv, state)]
        }
        Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
            exec_reply(exec, state)
        }
        Some(pb::agent_server_message::Message::InteractionQuery(query)) => {
            interaction_reply(query)
        }
        _ => Vec::new(),
    }
}

/// KV get/set — the only transport for request blobs on the Run path.
pub fn kv_reply(kv: &pb::KvServerMessage, state: &mut ResponderState) -> pb::AgentClientMessage {
    let result = match kv.message.as_ref() {
        Some(pb::kv_server_message::Message::GetBlobArgs(args)) => {
            let blob_data = state.blob_store.get(&args.blob_id).cloned();
            pb::kv_client_message::Message::GetBlobResult(pb::GetBlobResult { blob_data })
        }
        Some(pb::kv_server_message::Message::SetBlobArgs(args)) => {
            state
                .blob_store
                .store_under(&args.blob_id, args.blob_data.to_vec());
            pb::kv_client_message::Message::SetBlobResult(pb::SetBlobResult::default())
        }
        None => pb::kv_client_message::Message::GetBlobResult(pb::GetBlobResult::default()),
    };
    pb::AgentClientMessage {
        message: Some(agent_client_message::Message::KvClientMessage(
            pb::KvClientMessage {
                id: kv.id,
                message: Some(result),
            },
        )),
    }
}

/// requestContext gets answered with the system prompt as global rules
/// and zero tools; every other exec frame is rejected in band.
fn exec_reply(exec: &pb::ExecServerMessage, state: &ResponderState) -> Vec<pb::AgentClientMessage> {
    match exec.message.as_ref() {
        Some(pb::exec_server_message::Message::RequestContextArgs(_)) => {
            let request_context = pb::RequestContext {
                rules: state.rules.clone(),
                tools: state.tools.clone(),
                ..Default::default()
            };
            let result = pb::RequestContextResult {
                result: Some(request_context_result::Result::Success(
                    pb::RequestContextSuccess {
                        request_context: Some(request_context),
                        ..Default::default()
                    },
                )),
            };
            vec![
                pb::AgentClientMessage {
                    message: Some(agent_client_message::Message::ExecClientMessage(
                        pb::ExecClientMessage {
                            id: exec.id,
                            exec_id: exec.exec_id.clone(),
                            message: Some(exec_client_message::Message::RequestContextResult(
                                result,
                            )),
                            ..Default::default()
                        },
                    )),
                },
            ]
        }
        Some(_) => vec![exec_throw(exec, TOOL_NOT_AVAILABLE), exec_stream_close(exec)],
        None => vec![
            exec_throw(exec, "Unknown exec message variant"),
            exec_stream_close(exec),
        ],
    }
}

/// Reject one exec frame: throw (the server surfaces the error to the
/// model) followed by streamClose (the frame's stream is done).
pub fn exec_throw(exec: &pb::ExecServerMessage, error: &str) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(agent_client_message::Message::ExecClientControlMessage(
            pb::ExecClientControlMessage {
                message: Some(exec_client_control_message::Message::Throw(
                    pb::ExecClientThrow {
                        id: exec.id,
                        error: error.to_string(),
                        ..Default::default()
                    },
                )),
            },
        )),
    }
}

/// Follow-up close for a rejected exec stream.
pub fn exec_stream_close(exec: &pb::ExecServerMessage) -> pb::AgentClientMessage {
    pb::AgentClientMessage {
        message: Some(agent_client_message::Message::ExecClientControlMessage(
            pb::ExecClientControlMessage {
                message: Some(exec_client_control_message::Message::StreamClose(
                    pb::ExecClientStreamClose { id: exec.id },
                )),
            },
        )),
    }
}

fn response(id: u32, result: interaction_response::Result) -> pb::AgentClientMessage {
    let mut response = pb::InteractionResponse { id, result: None };
    response.result = Some(result);
    pb::AgentClientMessage {
        message: Some(agent_client_message::Message::InteractionResponse(response)),
    }
}

/// Hosted-tool permission gates: server-side search/fetch approvals let
/// the turn continue (the tools execute server-side); interactive
/// questions and mode switches are rejected; VM setup is left
/// unanswered rather than reporting a fake success.
fn interaction_reply(query: &pb::InteractionQuery) -> Vec<pb::AgentClientMessage> {
    let result = match query.query.as_ref() {
        Some(pb::interaction_query::Query::WebSearchRequestQuery(_)) => {
            Some(interaction_response::Result::WebSearchRequestResponse(
                pb::WebSearchRequestResponse {
                    result: Some(pb::web_search_request_response::Result::Approved(
                        pb::WebSearchRequestResponseApproved::default(),
                    )),
                },
            ))
        }
        Some(pb::interaction_query::Query::ExaSearchRequestQuery(_)) => {
            Some(interaction_response::Result::ExaSearchRequestResponse(
                pb::ExaSearchRequestResponse {
                    result: Some(pb::exa_search_request_response::Result::Approved(
                        pb::ExaSearchRequestResponseApproved::default(),
                    )),
                },
            ))
        }
        Some(pb::interaction_query::Query::ExaFetchRequestQuery(_)) => {
            Some(interaction_response::Result::ExaFetchRequestResponse(
                pb::ExaFetchRequestResponse {
                    result: Some(pb::exa_fetch_request_response::Result::Approved(
                        pb::ExaFetchRequestResponseApproved::default(),
                    )),
                },
            ))
        }
        Some(pb::interaction_query::Query::WebFetchRequestQuery(_)) => {
            Some(interaction_response::Result::WebFetchRequestResponse(
                pb::WebFetchRequestResponse {
                    result: Some(pb::web_fetch_request_response::Result::Approved(
                        pb::WebFetchRequestResponseApproved::default(),
                    )),
                },
            ))
        }
        Some(pb::interaction_query::Query::AskQuestionInteractionQuery(_)) => {
            Some(interaction_response::Result::AskQuestionInteractionResponse(
                pb::AskQuestionInteractionResponse {
                    result: Some(pb::AskQuestionResult {
                        result: Some(pb::ask_question_result::Result::Rejected(
                            pb::AskQuestionRejected {
                                reason: "Interactive questions are not implemented by this client"
                                    .to_string(),
                            },
                        )),
                    }),
                },
            ))
        }
        Some(pb::interaction_query::Query::SwitchModeRequestQuery(_)) => {
            Some(interaction_response::Result::SwitchModeRequestResponse(
                pb::SwitchModeRequestResponse {
                    result: Some(pb::switch_mode_request_response::Result::Rejected(
                        pb::SwitchModeRequestResponseRejected {
                            reason: "Mode switches are not implemented by this client".to_string(),
                        },
                    )),
                },
            ))
        }
        _ => None,
    };
    result.map(|result| vec![response(query.id, result)]).unwrap_or_default()
}

#[cfg(test)]
mod tests;
