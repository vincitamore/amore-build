use super::*;
use crate::{ChatStateActor, MockChatPersistence, PersistenceRecord};
use xai_grok_sampling_types::{SamplingConfig, ToolCall};

fn calls(ids: &[&str]) -> ConversationItem {
    ConversationItem::assistant_tool_calls(
        ids.iter()
            .enumerate()
            .map(|(i, id)| ToolCall {
                id: Arc::from(*id),
                name: format!("tool_{i}"),
                arguments: Arc::from("{}"),
            })
            .collect(),
    )
}

fn ids(items: &[ConversationItem]) -> Vec<String> {
    items
        .iter()
        .flat_map(|item| match item {
            ConversationItem::Assistant(a) => {
                a.tool_calls.iter().map(|tc| tc.id.to_string()).collect()
            }
            _ => Vec::new(),
        })
        .collect()
}

fn results(items: &[ConversationItem]) -> Vec<(String, String)> {
    items
        .iter()
        .filter_map(|item| match item {
            ConversationItem::ToolResult(r) => {
                Some((r.tool_call_id.clone(), r.content.to_string()))
            }
            _ => None,
        })
        .collect()
}

fn history() -> Vec<ConversationItem> {
    vec![
        calls(&["a", "b"]),
        ConversationItem::tool_result("b", "first b"),
        ConversationItem::tool_result("a", "first a"),
        ConversationItem::user("continue"),
        calls(&["a", "b", "unique"]),
        ConversationItem::tool_result("b", "second b"),
        ConversationItem::tool_result("unique", "unique result"),
        ConversationItem::tool_result("a", "second a"),
    ]
}

#[test]
fn history_pairs_parallel_out_of_order_results_across_colliding_batches() {
    let mut items = history();
    assert_eq!(repair_tool_call_ids(&mut items), 2);
    let calls = ids(&items);
    assert_eq!(calls, ["a", "b", "call_amore_1", "call_amore_2", "unique"]);
    assert_eq!(
        results(&items),
        [
            ("b".into(), "first b".into()),
            ("a".into(), "first a".into()),
            ("call_amore_2".into(), "second b".into()),
            ("unique".into(), "unique result".into()),
            ("call_amore_1".into(), "second a".into()),
        ]
    );
    assert_eq!(repair_tool_call_ids(&mut items), 0);
}

#[test]
fn repeated_ids_within_item_keep_both_results_before_integrity_dedup() {
    let mut items = vec![
        calls(&["dup", "dup"]),
        ConversationItem::tool_result("dup", "one"),
        ConversationItem::tool_result("dup", "two"),
    ];
    let report = crate::compaction_utils::repair_history(&mut items);
    assert_eq!(report.tool_call_ids_reminted, 1);
    assert!(report.changed());
    assert_eq!(report.duplicates_removed, 0);
    assert_eq!(report.synthetic_results_inserted, 0);
    assert_eq!(items.len(), 3);
    assert_eq!(
        results(&items),
        [
            ("dup".into(), "one".into()),
            ("call_amore_1".into(), "two".into())
        ]
    );
    assert!(!crate::compaction_utils::repair_history(&mut items).changed());
}

#[test]
fn remint_reserves_future_calls_and_orphan_result_ids() {
    let mut items = vec![
        calls(&["dup", "dup"]),
        ConversationItem::tool_result("dup", "one"),
        ConversationItem::tool_result("dup", "two"),
        ConversationItem::user("next"),
        calls(&["call_amore_1"]),
        ConversationItem::tool_result("call_amore_2", "orphan"),
    ];
    assert_eq!(repair_tool_call_ids(&mut items), 1);
    assert_eq!(ids(&items), ["dup", "call_amore_3", "call_amore_1"]);
}

#[test]
fn unique_history_is_byte_stable() {
    let mut items = vec![
        calls(&["a", "b"]),
        ConversationItem::tool_result("b", "b"),
        ConversationItem::tool_result("a", "a"),
    ];
    let before = serde_json::to_vec(&items).unwrap();
    assert_eq!(repair_tool_call_ids(&mut items), 0);
    assert_eq!(serde_json::to_vec(&items).unwrap(), before);
}

#[test]
fn duplicate_delivery_for_one_call_still_deduplicates() {
    let mut items = vec![
        calls(&["dup"]),
        ConversationItem::tool_result("dup", "first"),
        ConversationItem::tool_result("dup", "last"),
        ConversationItem::user("next"),
        calls(&["dup"]),
        ConversationItem::tool_result("dup", "first again"),
        ConversationItem::tool_result("dup", "last again"),
    ];
    let report = crate::compaction_utils::repair_history(&mut items);
    assert_eq!(report.tool_call_ids_reminted, 1);
    assert_eq!(report.duplicates_removed, 2);
    assert_eq!(
        results(&items),
        [
            ("dup".into(), "last".into()),
            ("call_amore_1".into(), "last again".into())
        ]
    );
}

#[test]
fn dangling_colliding_call_gets_its_own_synthetic_result() {
    let mut items = vec![
        calls(&["dup"]),
        ConversationItem::tool_result("dup", "old"),
        ConversationItem::user("next"),
        calls(&["dup"]),
    ];
    let report = crate::compaction_utils::repair_history(&mut items);
    assert_eq!(report.tool_call_ids_reminted, 1);
    assert_eq!(report.synthetic_results_inserted, 1);
    let outputs = results(&items);
    assert_eq!(outputs.get(1).unwrap().0, "call_amore_1");
}

fn actor(items: Vec<ConversationItem>) -> (crate::ChatStateHandle, crate::MockPersistenceReceiver) {
    let (persistence, receiver) = MockChatPersistence::new();
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    let handle = ChatStateActor::spawn(
        items,
        SamplingConfig::default(),
        Box::new(persistence),
        events,
        tokio_util::sync::CancellationToken::new(),
    );
    (handle, receiver)
}

#[tokio::test]
async fn loaded_session_repairs_and_persists_before_result_dedup() {
    let (handle, mut persistence) = actor(history());
    let conversation = handle.get_conversation().await;
    assert_eq!(conversation.len(), 8);
    assert_eq!(
        ids(&conversation),
        ["a", "b", "call_amore_1", "call_amore_2", "unique"]
    );
    let records = persistence.drain();
    let [PersistenceRecord::ReplaceHistory(saved)] = records.as_slice() else {
        panic!("expected persisted load repair: {records:?}");
    };
    assert_eq!(
        serde_json::to_vec(saved).unwrap(),
        serde_json::to_vec(&conversation).unwrap()
    );
}

#[tokio::test]
async fn live_acknowledged_batch_dispatches_unique_ids_with_reversed_results() {
    let (handle, mut persistence) = actor(vec![
        calls(&["dup"]),
        ConversationItem::tool_result("dup", "old"),
    ]);
    handle.begin_turn_capture();
    let committed = handle
        .push_model_output_and_ack(calls(&["dup", "dup", "unique"]), true)
        .await
        .unwrap();
    let committed_ids = ids(std::slice::from_ref(&committed));
    assert_eq!(committed_ids, ["call_amore_1", "call_amore_2", "unique"]);
    for (id, output) in committed_ids.iter().zip(["one", "two", "three"]).rev() {
        handle.push_tool_result(ConversationItem::tool_result(id, output));
    }
    let conversation = handle.get_conversation().await;
    assert_eq!(
        results(&conversation),
        [
            ("dup".into(), "old".into()),
            ("unique".into(), "three".into()),
            ("call_amore_2".into(), "two".into()),
            ("call_amore_1".into(), "one".into())
        ]
    );
    handle
        .build_request(vec![], None, false, None, "conv".into(), "req".into())
        .await
        .unwrap();
    assert_eq!(handle.get_conversation().await.len(), 6);
    let capture = handle.take_turn_messages().await.unwrap();
    assert_eq!(ids(&capture.messages), committed_ids);
    assert_eq!(persistence.drain().len(), 4);
}

#[tokio::test]
async fn fire_and_forget_ingest_rewrites_old_result_ids_by_batch() {
    let (handle, mut persistence) = actor(vec![
        calls(&["a", "b"]),
        ConversationItem::tool_result("a", "old a"),
        ConversationItem::tool_result("b", "old b"),
    ]);
    handle.push_assistant_response(calls(&["a", "b"]));
    handle.push_tool_result(ConversationItem::tool_result("b", "new b"));
    handle.push_tool_result(ConversationItem::tool_result("a", "new a"));
    let items = handle.get_conversation().await;
    assert_eq!(ids(&items), ["a", "b", "call_amore_1", "call_amore_2"]);
    assert_eq!(
        results(&items).last().unwrap(),
        &("call_amore_1".into(), "new a".into())
    );
    assert_eq!(persistence.drain().len(), 3);
}

#[tokio::test]
async fn replacing_and_restoring_history_repair_collisions() {
    let (handle, mut persistence) = actor(vec![]);
    handle.replace_conversation(history());
    let repaired = handle.get_conversation().await;
    assert_eq!(ids(&repaired).len(), 5);
    assert_eq!(call_ids(&repaired).len(), 5);
    let mut snapshot = handle.snapshot().await.unwrap();
    snapshot.conversation = history();
    handle.restore_snapshot(snapshot);
    let restored = handle.get_conversation().await;
    assert_eq!(
        serde_json::to_vec(&restored).unwrap(),
        serde_json::to_vec(&repaired).unwrap()
    );
    assert_eq!(persistence.drain().len(), 2);
}

#[tokio::test]
async fn canonical_result_redelivery_cannot_answer_its_colliding_sibling() {
    let (handle, _) = actor(vec![]);
    let committed = handle
        .push_model_output_and_ack(calls(&["dup", "dup"]), true)
        .await
        .unwrap();
    let committed_ids = ids(std::slice::from_ref(&committed));
    handle.push_tool_result(ConversationItem::tool_result("dup", "first"));
    handle.push_tool_result(ConversationItem::tool_result("dup", "redelivered"));
    handle.push_tool_result(ConversationItem::tool_result(
        committed_ids.get(1).unwrap(),
        "second",
    ));
    let before = handle.get_conversation().await;
    assert_eq!(
        results(&before),
        [
            ("dup".into(), "first".into()),
            ("dup".into(), "redelivered".into()),
            ("call_amore_1".into(), "second".into())
        ]
    );
    handle
        .build_request(vec![], None, false, None, "conv".into(), "req".into())
        .await
        .unwrap();
    let after = handle.get_conversation().await;
    assert_eq!(
        results(&after),
        [
            ("dup".into(), "redelivered".into()),
            ("call_amore_1".into(), "second".into())
        ]
    );
}

#[tokio::test]
async fn resume_same_item_collisions_preserves_both_outputs() {
    let (handle, _) = actor(vec![
        calls(&["dup", "dup"]),
        ConversationItem::tool_result("dup", "one"),
        ConversationItem::tool_result("dup", "two"),
    ]);
    let items = handle.get_conversation().await;
    assert_eq!(items.len(), 3);
    assert_eq!(
        results(&items),
        [
            ("dup".into(), "one".into()),
            ("call_amore_1".into(), "two".into())
        ]
    );
}

#[tokio::test]
async fn rewind_then_replacement_rebuilds_ingest_aliases() {
    let (handle, _) = actor(vec![
        ConversationItem::system("sys"),
        ConversationItem::user("q"),
        calls(&["dup"]),
        ConversationItem::tool_result("dup", "old"),
    ]);
    handle.increment_prompt_index();
    handle.push_assistant_response(calls(&["dup"]));
    let _ = handle.get_conversation().await;
    handle.truncate_to_prompt_index(0).await;
    let canonical = handle
        .push_model_output_and_ack(calls(&["dup"]), true)
        .await
        .unwrap();
    assert_eq!(ids(std::slice::from_ref(&canonical)), ["dup"]);
    handle.push_tool_result(ConversationItem::tool_result("dup", "after rewind"));
    assert_eq!(
        results(&handle.get_conversation().await),
        [("dup".into(), "after rewind".into())]
    );
}

#[tokio::test]
async fn closed_actor_refuses_unacknowledged_tool_dispatch() {
    let handle = crate::ChatStateHandle::noop();
    assert!(
        handle
            .push_model_output_and_ack(calls(&["a"]), true)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn acknowledged_usage_preserves_reported_and_estimated_token_accounting() {
    let (handle, _) = actor(vec![]);
    handle.record_token_usage(100_000);
    handle
        .push_model_output_and_ack(ConversationItem::assistant("x".repeat(4_000)), true)
        .await
        .unwrap();
    assert_eq!(handle.get_estimated_total_tokens().await, 100_000);
    handle
        .push_model_output_and_ack(ConversationItem::assistant("x".repeat(4_000)), false)
        .await
        .unwrap();
    assert_eq!(handle.get_estimated_total_tokens().await, 101_000);
}
