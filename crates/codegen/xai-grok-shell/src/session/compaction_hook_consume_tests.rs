use super::{merge_precompact_user_context, postcompact_hook_reminders};
use std::time::Duration;
use xai_grok_hooks::result::HookRunResult;
use xai_grok_sampling_types::{ConversationItem, SyntheticReason};

fn success_ctx(name: &str, ctx: impl Into<String>) -> HookRunResult {
    HookRunResult::Success {
        hook_name: name.into(),
        elapsed: Duration::from_millis(1),
        http_info: None,
        additional_context: Some(ctx.into()),
    }
}

fn success_empty(name: &str) -> HookRunResult {
    HookRunResult::Success {
        hook_name: name.into(),
        elapsed: Duration::from_millis(1),
        http_info: None,
        additional_context: None,
    }
}

fn failed(name: &str) -> HookRunResult {
    HookRunResult::Failed {
        hook_name: name.into(),
        error: "timeout".into(),
        elapsed: Duration::from_millis(1),
        http_info: None,
    }
}

fn assert_system_reminder(item: &ConversationItem, expected: &str) {
    assert_eq!(item.text_content(), expected);
    match item {
        ConversationItem::User(u) => {
            assert_eq!(u.synthetic_reason, Some(SyntheticReason::SystemReminder));
        }
        other => panic!("expected system-reminder user item, got {other:?}"),
    }
}

#[test]
fn postcompact_additional_context_is_system_reminder() {
    let results = vec![success_ctx("post", "successor orientation")];
    let items = postcompact_hook_reminders(&results);
    assert_eq!(items.len(), 1);
    assert_system_reminder(&items[0], "successor orientation");
}

#[test]
fn postcompact_emits_one_reminder_per_context() {
    let results = vec![
        success_ctx("a", "first packet"),
        success_ctx("b", "second packet"),
    ];
    let items = postcompact_hook_reminders(&results);
    assert_eq!(items.len(), 2);
    assert_system_reminder(&items[0], "first packet");
    assert_system_reminder(&items[1], "second packet");
}

#[test]
fn precompact_additional_context_joins_keep_line() {
    let merged = merge_precompact_user_context(
        Some("keep the auth work".into()),
        &["precompact snapshot".into()],
    );
    assert_eq!(
        merged.as_deref(),
        Some("keep the auth work\n\nprecompact snapshot")
    );
}

#[test]
fn precompact_hook_context_alone_becomes_user_context() {
    let merged = merge_precompact_user_context(None, &["precompact snapshot".into()]);
    assert_eq!(merged.as_deref(), Some("precompact snapshot"));
}

#[test]
fn precompact_keep_line_unchanged_without_hook_context() {
    let merged = merge_precompact_user_context(Some("keep the auth work".into()), &[]);
    assert_eq!(merged.as_deref(), Some("keep the auth work"));
}

#[test]
fn precompact_empty_keep_with_hook_is_hook_text() {
    let merged = merge_precompact_user_context(Some(String::new()), &["snapshot".into()]);
    assert_eq!(merged.as_deref(), Some("snapshot"));
}

#[test]
fn precompact_concatenates_multiple_hook_contexts_after_keep() {
    let merged = merge_precompact_user_context(
        Some("keep".into()),
        &["one".into(), "two".into()],
    );
    assert_eq!(merged.as_deref(), Some("keep\n\none\n\ntwo"));
}

#[test]
fn failing_hook_fail_opens_no_consume() {
    let results = vec![failed("compact-hook")];
    assert!(HookRunResult::additional_contexts(&results).is_empty());
    assert!(postcompact_hook_reminders(&results).is_empty());
    assert_eq!(
        merge_precompact_user_context(Some("keep the auth work".into()), &[]),
        Some("keep the auth work".into())
    );
    assert_eq!(merge_precompact_user_context(None, &[]), None);
}

#[test]
fn blocked_skipped_and_empty_success_do_not_consume() {
    let results = vec![
        HookRunResult::Blocked {
            hook_name: "blocked".into(),
            detail: "no".into(),
            elapsed: Duration::from_millis(1),
            http_info: None,
        },
        HookRunResult::Skipped {
            hook_name: "skipped".into(),
        },
        success_empty("silent"),
        HookRunResult::Success {
            hook_name: "whitespace".into(),
            elapsed: Duration::from_millis(1),
            http_info: None,
            additional_context: Some("  \n".into()),
        },
    ];
    assert!(HookRunResult::additional_contexts(&results).is_empty());
    assert!(postcompact_hook_reminders(&results).is_empty());
}

#[test]
fn mixed_success_and_failure_consumes_only_success() {
    let results = vec![failed("boom"), success_ctx("ok", "snapshot")];
    let contexts = HookRunResult::additional_contexts(&results);
    assert_eq!(contexts, vec!["snapshot".to_string()]);
    let items = postcompact_hook_reminders(&results);
    assert_eq!(items.len(), 1);
    assert_system_reminder(&items[0], "snapshot");
    let merged = merge_precompact_user_context(Some("keep".into()), &contexts);
    assert_eq!(merged.as_deref(), Some("keep\n\nsnapshot"));
}
