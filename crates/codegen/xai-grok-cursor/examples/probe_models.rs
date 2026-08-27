//! Live probe for the unary `GetUsableModels` RPC and minimal Run
//! bisection. Reads the stored Cursor OAuth credential from the grok
//! home's `oauth-credentials.json`.
//!
//! `cargo run --release -p xai-grok-cursor --example probe_models -- [models]`
//! With no args: list models (id, maxMode, aliases, thinking). With args:
//! fire a minimal Run turn per listed model and print the first frame's
//! verdict (auth passed vs rejected) instead of completing it.

use std::io::Write;

fn read_access_token() -> String {
    let store_path = std::path::Path::new(&std::env::var("USERPROFILE").unwrap())
        .join(".amore")
        .join("oauth-credentials.json");
    let store: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&store_path).expect("oauth store")).expect("json");
    store["providers"]["cursor"]["access"]
        .as_str()
        .expect("cursor access token")
        .to_owned()
}

#[tokio::main]
async fn main() {
    let access = read_access_token();
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() {
        let models = xai_grok_cursor::transport::get_usable_models(
            xai_grok_cursor::transport::UnaryConfig {
                access_token: access,
                base_url: None,
            },
        )
        .await
        .expect("GetUsableModels");
        let mut out = std::io::stdout().lock();
        writeln!(out, "total models: {}", models.len()).ok();
        writeln!(out, "{:<44} {:>9} {:>8} thinking", "id", "maxMode", "aliases").ok();
        for m in &models {
            writeln!(
                out,
                "{:<44} {:>9} {:>8} {}",
                m.model_id,
                m.max_mode.map(|v| v.to_string()).unwrap_or_default(),
                m.aliases.len(),
                m.thinking_details.is_some(),
            )
            .ok();
        }
        return;
    }

    for model in &args {
        let verdict = probe_run(&access, model).await;
        writeln!(std::io::stdout(), "{model}: {verdict}").ok();
    }
}

/// Fire a minimal Run turn and drive it to the first terminal verdict
/// (frame flow, error, or turn end) instead of stopping at the first frame.
async fn probe_run(access: &str, model: &str) -> String {
    use futures_util::StreamExt;
    let items = vec![xai_grok_sampling_types::conversation::ConversationItem::user("hi")];
    let config = xai_grok_cursor::transport::RunStreamConfig {
        access_token: access.to_owned(),
        base_url: None,
        model: model.to_owned(),
        reasoning_effort: None,
        items,
        base_conversation_id: Some(uuid::Uuid::new_v4().to_string()),
    };
    let mut stream = match xai_grok_cursor::transport::run_stream(config).await {
        Ok(stream) => stream,
        Err(e) => return format!("open failed: {e}"),
    };
    let mut frames = 0usize;
    let mut saw_turn_ended = false;
    while let Some(item) = tokio::time::timeout(std::time::Duration::from_secs(60), stream.next())
        .await
        .unwrap_or(None)
    {
        match item {
            Ok(msg) => {
                frames += 1;
                let ended = msg
                    .message
                    .as_ref()
                    .is_some_and(|m| {
                        matches!(
                            m,
                            xai_grok_cursor::proto::agent_server_message::Message::InteractionUpdate(
                                update,
                            ) if matches!(
                                update.message,
                                Some(
                                    xai_grok_cursor::proto::interaction_update::Message::TurnEnded(
                                        _,
                                    )
                                )
                            )
                        )
                    });
                if ended {
                    return format!("turn completed cleanly ({frames} frames)");
                }
            }
            Err(e) => return format!("failed after {frames} frames: {e}"),
        }
    }
    format!("stream ended after {frames} frames without turnEnded")
}