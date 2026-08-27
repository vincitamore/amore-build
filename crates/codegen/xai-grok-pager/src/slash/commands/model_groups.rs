//! Fork-owned section headers for the `/model` ArgPicker.
//!
//! Header rows are `ArgItem`s with empty `insert_text` AND `match_text`:
//! never insertable, never matched. Detection is centralized here so the
//! sentinel stays coherent between the builder, the modal filter, and the
//! slash dropdown.

use crate::acp::model_state::ModelState;
use crate::slash::command::ArgItem;

/// The picker's provider group for a model, from the ACP `provider` meta
/// key (shell-derived from the route, not the model name).
pub(crate) fn provider_label(info: &agent_client_protocol::ModelInfo) -> Option<&str> {
    info.meta
        .as_ref()?
        .get("provider")
        .and_then(|value| value.as_str())
}

/// Section-header row for one provider group. Sentinel: empty
/// `insert_text` + empty `match_text` (a real row always inserts
/// something).
pub(crate) fn section_header(label: &str) -> ArgItem {
    ArgItem {
        display: label.to_owned(),
        match_text: String::new(),
        insert_text: String::new(),
        description: String::new(),
    }
}

/// Sentinel check: header rows are never selectable or insertable.
pub(crate) fn is_section_header(item: &ArgItem) -> bool {
    item.insert_text.is_empty() && item.match_text.is_empty()
}

/// Dropdown twin of [`is_section_header`]: a suggestion row with nothing
/// to insert is a visual section header — rendered dimmed, skipped by
/// selection, never accepted.
pub(crate) fn is_suggestion_header(row: &crate::slash::SuggestionRow) -> bool {
    row.insert_text.is_empty()
}

/// Group flat model rows under provider headers when the catalog mixes
/// providers (≥2 groups). Single-group catalogs render flat — the default
/// look for existing setups. Group order: the current model's group
/// first, then groups in first-occurrence order; rows keep catalog order
/// within a group. Catalog entries without recognizable hosts bucket
/// under "Other" only when other groups exist.
pub(crate) fn group_model_items(
    models: &ModelState,
    labeled: Vec<(ArgItem, Option<String>)>,
) -> Vec<ArgItem> {
    let current_label = models
        .current
        .as_ref()
        .and_then(|id| models.available.get(id))
        .and_then(provider_label)
        .map(str::to_owned);

    let mut group_order: Vec<String> = Vec::new();
    if let Some(current) = current_label.clone() {
        group_order.push(current);
    }
    for (_, label) in &labeled {
        if let Some(label) = label
            && !group_order.iter().any(|existing| existing == label)
        {
            group_order.push(label.clone());
        }
    }
    // Catalog entries without recognizable hosts bucket under "Other",
    // which counts toward the group threshold.
    let has_ungrouped = labeled.iter().any(|(_, label)| label.is_none());
    if group_order.len() + usize::from(has_ungrouped) < 2 {
        // One provider (or no metadata at all): flat list, unchanged.
        return labeled.into_iter().map(|(item, _)| item).collect();
    }

    let mut out: Vec<ArgItem> = Vec::with_capacity(labeled.len() + group_order.len() + 1);
    for group in &group_order {
        out.push(section_header(group));
        out.extend(
            labeled
                .iter()
                .filter(|(_, label)| label.as_deref() == Some(group.as_str()))
                .map(|(item, _)| item.clone()),
        );
    }
    if has_ungrouped {
        out.push(section_header("Other"));
        out.extend(
            labeled
                .iter()
                .filter(|(_, label)| label.is_none())
                .map(|(item, _)| item.clone()),
        );
    }
    out
}

/// Substring filter that preserves section headers of matching sections
/// (mirrors the command palette's filter). Empty query returns everything.
pub(crate) fn filter_preserving_sections(query: &str, items: &[ArgItem]) -> Vec<ArgItem> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return items.to_vec();
    }
    let matches = |item: &ArgItem| {
        item.match_text.to_lowercase().contains(&q)
            || item.display.to_lowercase().contains(&q)
            || item.description.to_lowercase().contains(&q)
    };
    let mut out = Vec::with_capacity(items.len());
    let mut pending_header: Option<&ArgItem> = None;
    let mut section_has_match = false;
    for item in items {
        if is_section_header(item) {
            if let Some(header) = pending_header.take() {
                if section_has_match {
                    out.push(header.clone());
                }
            }
            pending_header = Some(item);
            section_has_match = false;
            continue;
        }
        if matches(item) {
            if let Some(header) = pending_header.take() {
                out.push(header.clone());
            }
            section_has_match = true;
            out.push(item.clone());
        }
    }
    if let Some(header) = pending_header {
        if section_has_match {
            out.push(header.clone());
        }
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::slash::SlashController;
    use agent_client_protocol as acp;
    use std::sync::Arc;

    fn info_with_provider(id: &str, name: &str, provider: Option<&str>) -> acp::ModelInfo {
        let model_id = acp::ModelId::new(Arc::from(id));
        let meta = provider.map(|p| {
            serde_json::json!({ "provider": p })
                .as_object()
                .cloned()
                .expect("object meta")
        });
        acp::ModelInfo::new(model_id, name.to_owned()).meta(meta)
    }

    fn state_with(entries: Vec<(&str, &str, Option<&str>)>, current: Option<&str>) -> ModelState {
        let mut state = ModelState::default();
        for (id, name, provider) in entries {
            let model_id = acp::ModelId::new(Arc::from(id));
            state
                .available
                .insert(model_id.clone(), info_with_provider(id, name, provider));
            if current == Some(id) {
                state.current = Some(model_id);
            }
        }
        state
    }

    fn row(display: &str, provider: Option<String>) -> (ArgItem, Option<String>) {
        (
            ArgItem {
                display: display.to_owned(),
                match_text: display.to_owned(),
                insert_text: display.to_owned(),
                description: String::new(),
            },
            provider,
        )
    }

    #[test]
    fn provider_label_reads_the_meta_key() {
        assert_eq!(
            provider_label(&info_with_provider("x", "X", Some("xAI"))),
            Some("xAI")
        );
        assert_eq!(provider_label(&info_with_provider("x", "X", None)), None);
    }

    #[test]
    fn single_provider_catalogs_render_flat() {
        let state = state_with(vec![("a", "A", Some("xAI"))], None);
        let labeled = vec![
            row("A", Some("xAI".to_owned())),
            row("B", Some("xAI".to_owned())),
        ];
        let items = group_model_items(&state, labeled);
        assert_eq!(items.len(), 2, "no headers for a single provider");
        assert!(items.iter().all(|item| !is_section_header(item)));
    }

    #[test]
    fn mixed_provider_catalogs_group_with_headers_and_current_first() {
        // Current model is an OpenRouter entry: its group leads.
        let state = state_with(
            vec![
                ("grok", "Grok 5", Some("xAI")),
                (
                    "deepseek/deepseek-v4",
                    "DeepSeek V4 Flash",
                    Some("OpenRouter"),
                ),
            ],
            Some("deepseek/deepseek-v4"),
        );
        let labeled = vec![
            row("Grok 5", Some("xAI".to_owned())),
            row("DeepSeek V4 Flash", Some("OpenRouter".to_owned())),
        ];
        let items = group_model_items(&state, labeled);
        assert_eq!(items.len(), 4, "two headers + two rows");
        assert_eq!(
            items[0].display, "OpenRouter",
            "current model's group first"
        );
        assert!(is_section_header(&items[0]));
        assert_eq!(items[1].display, "DeepSeek V4 Flash");
        assert_eq!(items[2].display, "xAI");
        assert_eq!(items[3].display, "Grok 5");
    }

    #[test]
    fn metadata_less_rows_bucket_under_other_only_when_other_groups_exist() {
        let state = state_with(vec![("a", "A", None), ("b", "B", Some("xAI"))], None);
        let labeled = vec![row("A", None), row("B", Some("xAI".to_owned()))];
        let items = group_model_items(&state, labeled);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].display, "xAI");
        assert_eq!(items[2].display, "Other");
        assert_eq!(items[3].display, "A");
    }

    #[test]
    fn section_filter_preserves_headers_of_matching_sections() {
        let items = vec![
            section_header("xAI"),
            row("Grok 5", None).0,
            section_header("OpenRouter"),
            row("DeepSeek", None).0,
        ];
        let hit = filter_preserving_sections("deep", &items);
        assert_eq!(hit.len(), 2, "header + matching row only");
        assert!(is_section_header(&hit[0]));
        assert_eq!(hit[1].display, "DeepSeek");

        let all = filter_preserving_sections("", &items);
        assert_eq!(all.len(), items.len());
        let none = filter_preserving_sections("zzz", &items);
        assert!(none.is_empty());
    }

    #[test]
    fn suggestion_header_sentinel_tracks_empty_insert_text() {
        let header_row = crate::slash::SuggestionRow {
            display: section_header("xAI").display,
            description: String::new(),
            insert_text: String::new(),
            indices: Vec::new(),
            tag: None,
            provenance: None,
        };
        assert!(is_suggestion_header(&header_row));

        let value_row = crate::slash::SuggestionRow {
            display: "Grok 5".to_owned(),
            description: String::new(),
            insert_text: "Grok 5".to_owned(),
            indices: Vec::new(),
            tag: None,
            provenance: None,
        };
        assert!(!is_suggestion_header(&value_row));
    }

    #[test]
    fn selection_snapping_skips_leading_headers() {
        // Simulates the grouped model dropdown: header rows interleaved
        // with value rows (same sentinel: empty insert_text).
        let make = |display: &str, insert: &str| crate::slash::SuggestionRow {
            display: display.to_owned(),
            description: String::new(),
            insert_text: insert.to_owned(),
            indices: Vec::new(),
            tag: None,
            provenance: None,
        };
        let matches = vec![
            make("xAI", ""),
            make("Grok 5", "Grok 5"),
            make("OpenRouter", ""),
            make("DeepSeek", "DeepSeek"),
        ];
        // A fresh selection (0) lands past the leading header.
        assert_eq!(SlashController::snap_to_selectable(&matches, 0), 1);
        // An carried selection landing on a header moves forward.
        assert_eq!(SlashController::snap_to_selectable(&matches, 2), 3);
        // A value row stays put.
        assert_eq!(SlashController::snap_to_selectable(&matches, 1), 1);
    }
}
