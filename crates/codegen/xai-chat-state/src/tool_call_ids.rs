//! Collision repair for client-executed tool calls and their result references.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use xai_grok_sampling_types::ConversationItem;

#[derive(Default)]
pub(crate) struct ToolCallIdIngest {
    pending: HashMap<String, VecDeque<String>>,
}

impl ToolCallIdIngest {
    /// Normalize before persistence; acknowledged callers dispatch the returned IDs.
    pub(crate) fn normalize(&mut self, history: &[ConversationItem], item: &mut ConversationItem) {
        match item {
            ConversationItem::Assistant(_) => {
                let mut reserved = all_ids(history);
                reserved.extend(all_ids(std::slice::from_ref(item)));
                let mut used = call_ids(history);
                self.pending = normalize_calls(item, &mut used, &mut reserved).0;
            }
            ConversationItem::ToolResult(result) => {
                rewrite_result(&mut self.pending, &mut result.tool_call_id);
            }
            _ => self.pending.clear(),
        }
    }

    pub(crate) fn clear(&mut self) {
        self.pending.clear();
    }
}

/// Re-mint collisions before result deduplication can discard a distinct call's output.
/// Results join the immediately preceding assistant batch by their original ID.
/// Indistinguishable legacy results with the same ID are assigned in recorded order.
/// Returns the number of re-minted calls. Re-running the repair is a no-op.
pub(crate) fn repair_tool_call_ids(items: &mut [ConversationItem]) -> usize {
    let mut reserved = all_ids(items);
    let mut used = HashSet::new();
    let mut pending = HashMap::new();
    let mut reminted = 0;
    for item in items {
        match item {
            ConversationItem::Assistant(_) => {
                let (bindings, count) = normalize_calls(item, &mut used, &mut reserved);
                pending = bindings;
                reminted += count;
            }
            ConversationItem::ToolResult(result) => {
                rewrite_result(&mut pending, &mut result.tool_call_id);
            }
            _ => pending.clear(),
        }
    }
    if reminted > 0 {
        tracing::info!(reminted, "Re-minted colliding tool-call IDs");
    }
    reminted
}

fn call_ids(items: &[ConversationItem]) -> HashSet<String> {
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

fn all_ids(items: &[ConversationItem]) -> HashSet<String> {
    let mut ids = call_ids(items);
    for item in items {
        if let ConversationItem::ToolResult(result) = item {
            ids.insert(result.tool_call_id.clone());
        }
    }
    ids
}

fn normalize_calls(
    item: &mut ConversationItem,
    used: &mut HashSet<String>,
    reserved: &mut HashSet<String>,
) -> (HashMap<String, VecDeque<String>>, usize) {
    let ConversationItem::Assistant(assistant) = item else {
        return (HashMap::new(), 0);
    };
    let mut bindings = HashMap::<String, VecDeque<String>>::new();
    let mut reminted = 0;
    let mut next = 1_u64;
    for call in &mut assistant.tool_calls {
        let original = call.id.to_string();
        if !used.insert(original.clone()) {
            loop {
                let candidate = format!("call_amore_{next}");
                next += 1;
                if reserved.insert(candidate.clone()) {
                    used.insert(candidate.clone());
                    call.id = Arc::from(candidate);
                    reminted += 1;
                    break;
                }
            }
        }
        bindings
            .entry(original)
            .or_default()
            .push_back(call.id.to_string());
    }
    (bindings, reminted)
}

fn rewrite_result(pending: &mut HashMap<String, VecDeque<String>>, id: &mut String) {
    // Acknowledged calls already use canonical IDs, including out-of-order results.
    for queue in pending.values_mut() {
        if let Some(position) = queue.iter().position(|canonical| canonical == id) {
            if queue.len() > 1 {
                queue.remove(position);
            }
            return;
        }
    }
    if let Some(queue) = pending.get_mut(id) {
        if queue.len() > 1 {
            if let Some(canonical) = queue.pop_front() {
                *id = canonical;
            }
        } else if let Some(canonical) = queue.front() {
            // Retain the final binding so duplicate result delivery stays deduplicable.
            *id = canonical.clone();
        }
    }
}

#[cfg(test)]
#[path = "tool_call_ids_tests.rs"]
mod tests;
