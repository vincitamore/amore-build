//! Fork-owned house-context splash announcement.
//!
//! The welcome screen's announcement slot is remote-served from `/v1/settings`
//! (`RemoteAnnouncement`) — a promotional surface ("Grok 4.5 is here!",
//! "Workflows are now here!"). When the pager launches *inside a house*, this
//! module synthesizes the splash from the house tree instead: active task
//! count + top title, due reminders, and — when nothing is due — the
//! `## Where the house is` opening of `context/current-state.md`. The house
//! is the announcement source of truth when present: remote Grok promos never
//! show there ([`apply_house_override`]).
//!
//! The parsing contract deliberately mirrors the house session-init hook
//! (`house_session_init.py`, live in the house tree): org-marker + `tasks/`
//! dir gate, minimal scalar-only YAML-ish frontmatter (no `toml` dependency;
//! hand-rolled to the hook's contract), `status: pending|snoozed` +
//! `remind-at`/`snoozed-until` due reminders, and title = first `#` heading
//! in the body, else the file stem.
//!
//! Load-bearing constraints:
//! - **Stdlib + this crate's existing `chrono` only** — no new dependencies.
//! - **`severity: "house"`** is a fork-owned severity the welcome hero render
//!   maps to `theme.gray` (quiet, standing house state) instead of the promo
//!   warning color. It is not `critical`/`promo`, so it never opens the
//!   in-session banner slot.
//! - **`id: "arcus-house"` is stable** so a dismissal persists and dedup is
//!   by this key; `dismissible: true`, `persistent: false`, no `expires_at`
//!   (house state is standing, not a promo).
//! - **`GROK_ANNOUNCEMENTS_OVERRIDE` still wins over everything**: the escape
//!   hatch's presence (whatever its JSON) skips this override entirely.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, FixedOffset, Local, NaiveDate, NaiveDateTime, Utc};
use xai_grok_announcements::RemoteAnnouncement;

/// Fork-owned severity for house-state splashes. The hero box maps it to
/// `theme.gray` rather than the promo warning color, and — being neither
/// `critical` nor `promo` — it stays welcome-only: it never opens the
/// in-session banner slot.
pub const HOUSE_SEVERITY: &str = "house";

/// Stable announcement id, so dismissal persists and dedup is by this key.
pub const HOUSE_ANNOUNCEMENT_ID: &str = "arcus-house";

/// The house-name fallback when no org marker carries an H1.
pub const DEFAULT_HOUSE_NAME: &str = "The house";

/// Org marker files — the same set the session-init hook checks.
const ORG_MARKERS: &[&str] = &["AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md"];

/// Reminder statuses that can be due. Mirrors the hook's `DUE_STATUSES`.
const DUE_STATUSES: &[&str] = &["pending", "snoozed"];

/// Whether `root` looks like a house: an org marker file **and** a `tasks/`
/// directory — the same gate as the session-init hook.
pub fn is_house_root(root: &Path) -> bool {
    let has_marker = ORG_MARKERS.iter().any(|m| root.join(m).is_file());
    has_marker && root.join("tasks").is_dir()
}

/// Active-task summary: the count of `status: active` tasks directly under
/// `tasks/*.md` (README aside), plus the first such task's title. The scan
/// is lexicographic by file name — the hook's determinism convention. Returns
/// `None` when the tasks directory is absent or unreadable.
pub fn active_task_summary(root: &Path) -> Option<(usize, String)> {
    let tasks_dir = root.join("tasks");
    if !tasks_dir.is_dir() {
        return None;
    }
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&tasks_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().eq_ignore_ascii_case("readme.md"))
                != Some(true)
        })
        .collect();
    files.sort();

    let mut active: Vec<String> = Vec::new();
    for p in files {
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue; // one unreadable file must not abort the summary
        };
        let Some(meta) = parse_frontmatter(&text) else {
            continue;
        };
        if meta
            .get("status")
            .map(|s| s.trim().eq_ignore_ascii_case("active"))
            != Some(true)
        {
            continue;
        }
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        active.push(heading_title(&body_after_frontmatter(&text), &stem));
    }
    let count = active.len();
    active.into_iter().next().map(|title| (count, title))
}

/// Due reminders under `reminders/**/*.md`, mirroring the hook's
/// `collect_due_reminders`: frontmatter `status: pending|snoozed` with
/// `remind-at`/`snoozed-until` at or before `now`, skipping `README.md` and
/// anything under a `completed/` tree. Returns `(title, when)` pairs in path
/// order, where `when` is the raw `snoozed-until`/`remind-at` value (else a
/// serialized form).
pub fn due_reminder_summary(root: &Path, now: DateTime<Utc>) -> Vec<(String, String)> {
    let rem_dir = root.join("reminders");
    if !rem_dir.is_dir() {
        return Vec::new();
    }
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    collect_markdown(&rem_dir, &mut paths);
    paths.sort();

    let local_now = now.with_timezone(&Local);
    let mut due: Vec<(String, String)> = Vec::new();
    for path in paths {
        // Skip the schema index and the completed tree, by convention.
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        if rel.components().any(|c| {
            c.as_os_str().to_string_lossy().eq_ignore_ascii_case("completed")
        }) {
            continue;
        }
        if path
            .file_name()
            .map(|n| n.to_string_lossy().eq_ignore_ascii_case("readme.md"))
            == Some(true)
        {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(meta) = parse_frontmatter(&text) else {
            continue;
        };
        let Some(when) = due_at(&meta) else {
            continue;
        };
        if !is_due(&when, &local_now) {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let title = heading_title(&body_after_frontmatter(&text), &stem);
        let when_s = meta
            .get("snoozed-until")
            .or_else(|| meta.get("remind-at"))
            .cloned()
            .unwrap_or_else(|| when.to_string());
        due.push((title, when_s));
    }
    due
}

/// Synthesize the house splash announcement for `root` at `now`, or `None`
/// when `root` is not a house. When it is a house the announcement is always
/// `Some`: active-task/reminder state when either exists, else the
/// `## Where the house is` opening of `context/current-state.md`, else a
/// minimal standing line — the splash always reflects the house.
pub fn house_announcement(root: &Path, now: DateTime<Utc>) -> Option<RemoteAnnouncement> {
    if !is_house_root(root) {
        return None;
    }
    Some(RemoteAnnouncement {
        id: Some(HOUSE_ANNOUNCEMENT_ID.to_string()),
        title: Some(house_name(root)),
        message: Some(compose_message(root, now)),
        severity: Some(HOUSE_SEVERITY.to_string()),
        dismissible: Some(true),
        persistent: Some(false),
        expires_at: None,
        ..Default::default()
    })
}

/// Startup resolution with the house override, pure and unit-testable.
///
/// `resolved` is the list `resolve_announcements` produced (the
/// `GROK_ANNOUNCEMENTS_OVERRIDE` env already won inside it **and** is what
/// `override_active` reports). A present house announcement *replaces* the
/// list — the house is the announcement source of truth when present, so
/// remote Grok promos never show there. When the mode is off (override env,
/// a non-house tree), `resolved` passes through unchanged.
pub fn apply_house_override(
    resolved: Vec<RemoteAnnouncement>,
    root: &Path,
    now: DateTime<Utc>,
    override_active: bool,
) -> Vec<RemoteAnnouncement> {
    if override_active {
        return resolved;
    }
    match house_announcement(root, now) {
        Some(house) => vec![house],
        None => resolved,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// House state readers (mirrors of the session-init hook)
// ─────────────────────────────────────────────────────────────────────────────

/// The house name: the first `# ` H1 line of the first present org marker,
/// else [`DEFAULT_HOUSE_NAME`].
fn house_name(root: &Path) -> String {
    for marker in ORG_MARKERS {
        let Ok(text) = std::fs::read_to_string(root.join(marker)) else {
            continue;
        };
        for line in text.lines() {
            let s = line.trim();
            if s.starts_with('#') && !s.starts_with("##") {
                let t = s.trim_start_matches('#').trim();
                if !t.is_empty() {
                    return t.to_string();
                }
            }
        }
    }
    DEFAULT_HOUSE_NAME.to_string()
}

/// Compose the announcement message from house state.
fn compose_message(root: &Path, now: DateTime<Utc>) -> String {
    let active = active_task_summary(root);
    let due = due_reminder_summary(root, now);

    let mut counts: Vec<String> = Vec::new();
    if let Some((n, _)) = &active {
        counts.push(format!("{n} active task{}", if *n == 1 { "" } else { "s" }));
    }
    if !due.is_empty() {
        counts.push(format!(
            "{} reminder{} due",
            due.len(),
            if due.len() == 1 { "" } else { "s" }
        ));
    }
    if !counts.is_empty() {
        let mut lines = vec![counts.join(" · ")];
        // The top line names the focus: the highest-priority active task, or
        // the first due reminder when no task is active.
        if let Some((_, title)) = &active {
            lines.push(title.clone());
        } else if let Some((title, _)) = due.first() {
            lines.push(title.clone());
        }
        return lines.join("\n");
    }

    // Nothing active or due — always reflect the house: the standing-reality
    // opener of `context/current-state.md`.
    if let Some(para) = current_state_opening(root) {
        return para;
    }
    format!("No active tasks · no reminders due — {DEFAULT_HOUSE_NAME} stands")
}

/// The first paragraph after the `## Where the house is` heading in
/// `context/current-state.md` (its "standing reality" opener), or `None`
/// when the file or heading is missing.
fn current_state_opening(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("context/current-state.md")).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let idx = lines.iter().position(|l| l.trim() == "## Where the house is")?;
    let mut para: Vec<&str> = Vec::new();
    for line in &lines[idx + 1..] {
        let s = line.trim();
        if s.is_empty() {
            if !para.is_empty() {
                break;
            }
            continue;
        }
        if s.starts_with('#') {
            break; // a later section
        }
        para.push(s);
    }
    if para.is_empty() {
        None
    } else {
        Some(para.join(" "))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter / datetime parsing (hand-rolled, scalars only — hook contract)
// ─────────────────────────────────────────────────────────────────────────────

/// Minimal YAML-ish frontmatter parser. Keys we care about are scalars;
/// malformed or missing fences return `None`. Values strip one layer of
/// surrounding quotes; `null`/`~`/empty collapse to the empty string.
/// Mirrors the hook's `parse_frontmatter`.
fn parse_frontmatter(text: &str) -> Option<HashMap<String, String>> {
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim() != "---").unwrap_or(true) {
        return None;
    }
    let mut meta = HashMap::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(meta);
        }
        let raw = line.trim();
        if raw.is_empty() || raw.starts_with('#') {
            continue;
        }
        let Some((key, val)) = raw.split_once(':') else {
            continue;
        };
        let mut val = val.trim();
        if val.len() >= 2
            && ((val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\'')))
        {
            val = &val[1..val.len() - 1];
        }
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if matches!(val.to_ascii_lowercase().as_str(), "null" | "~" | "") {
            val = "";
        }
        meta.insert(key.to_string(), val.to_string());
    }
    None // no closing fence
}

/// Body after a well-formed frontmatter block; the whole text when none is
/// present or no closing fence is found. Mirrors the hook's
/// `body_after_frontmatter`.
fn body_after_frontmatter(text: &str) -> String {
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim() != "---").unwrap_or(true) {
        return text.to_string();
    }
    let rest: Vec<&str> = lines.collect();
    match rest.iter().position(|l| l.trim() == "---") {
        Some(closed_at) => rest[closed_at + 1..].join("\n"),
        None => text.to_string(),
    }
}

/// Title = first `#` heading in the body, else `fallback` (the file stem).
/// Mirrors the hook's `reminder_title`.
fn heading_title(body: &str, fallback: &str) -> String {
    for line in body.lines() {
        let s = line.trim();
        if s.starts_with('#') {
            let t = s.trim_start_matches('#').trim();
            return if t.is_empty() {
                fallback.to_string()
            } else {
                t.to_string()
            };
        }
    }
    fallback.to_string()
}

/// A parsed "when": either a timezone-aware instant or a naive local
/// datetime. Naive follows the hook's semantics — local wall-clock.
enum When {
    Aware(DateTime<FixedOffset>),
    Naive(NaiveDateTime),
}

impl When {
    fn to_string(&self) -> String {
        match self {
            When::Aware(dt) => dt.to_rfc3339(),
            When::Naive(dt) => dt.format("%Y-%m-%dT%H:%M:%S").to_string(),
        }
    }
}

/// Parse the reminder's due instant. Mirrors the hook's `parse_when`:
/// trailing `Z`, RFC3339 offsets, naive datetimes (with or without seconds,
/// `T` or space separator), and bare dates (start of local day).
fn parse_when(raw: &str) -> Option<When> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let s = match s.strip_suffix('Z') {
        Some(rest) => format!("{rest}+00:00"),
        None => s.to_string(),
    };
    if let Ok(dt) = DateTime::parse_from_rfc3339(&s) {
        return Some(When::Aware(dt));
    }
    const NAIVE_FORMATS: &[&str] = &[
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ];
    for f in NAIVE_FORMATS {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&s, f) {
            return Some(When::Naive(dt));
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(&s, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(When::Naive);
    }
    None
}

/// The `due_at` mirror: `pending` looks at `remind-at` then
/// `snoozed-until`; `snoozed` tries `snoozed-until` first.
fn due_at(meta: &HashMap<String, String>) -> Option<When> {
    let status = meta
        .get("status")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !DUE_STATUSES.contains(&status.as_str()) {
        return None;
    }
    let when = if status == "snoozed" {
        meta.get("snoozed-until").or_else(|| meta.get("remind-at"))
    } else {
        meta.get("remind-at").or_else(|| meta.get("snoozed-until"))
    }?;
    parse_when(when)
}

/// Due at `now` (local wall-clock): a naive `when` compares against the local
/// wall-clock, an aware one against the instant — the hook's normalization.
fn is_due(when: &When, local_now: &DateTime<Local>) -> bool {
    match when {
        When::Aware(dt) => dt.with_timezone(&Utc) <= local_now.with_timezone(&Utc),
        When::Naive(ndt) => ndt <= &local_now.naive_local(),
    }
}

/// Recursively collect `*.md` paths under `dir` (the `rglob` mirror).
fn collect_markdown(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_markdown(&p, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(p);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

/// Test-only fixture helpers shared across the crate's test modules (the
/// pager's acp_handler tests exercise the live re-resolve gate with a real
/// house tree, so the shapes must not drift from the module's own tests).
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A std-only temp tree (no new dependency) removed on drop. Shapes mirror
    /// the session-init hook's own fixtures.
    pub(crate) struct TempTree {
        pub(crate) path: PathBuf,
    }

    impl TempTree {
        pub(crate) fn new() -> Self {
            let mut path = std::env::temp_dir();
            let unique = format!(
                "arcus-house-test-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            );
            path.push(unique);
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        pub(crate) fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }

        pub(crate) fn root(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A minimal house: AGENTS.md with an H1, tasks/ (README only), a
    /// current-state with the standing-reality heading, and a reminders
    /// index — the shapes the live house carries.
    pub(crate) fn make_house(t: &TempTree) {
        t.write("AGENTS.md", "# Test House\n\n> The house.\n");
        t.write(
            "tasks/README.md",
            "---\ntype: task\n---\n\n# Task index\n\nSchema only.\n",
        );
        t.write(
            "context/current-state.md",
            "---\ntype: context\n---\n\n# Current state\n\n## Where the house is\n\n**Founded 2026-07-31.** Standing opener.\n",
        );
        t.write("reminders/README.md", "---\ntype: reminder\n---\n\n# Reminder index\n");
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{make_house, TempTree};
    use super::*;

    fn make_task(t: &TempTree, name: &str, status: &str, title: &str) {
        t.write(
            &format!("tasks/{name}.md"),
            &format!(
                "---\ntype: task\nstatus: {status}\ncreated: 2026-07-01\n---\n\n# {title}\n\nBody.\n"
            ),
        );
    }

    fn make_reminder(t: &TempTree, rel: &str, status: &str, when_key: &str, when: &str, title: &str) {
        t.write(
            &format!("reminders/{rel}"),
            &format!(
                "---\ntype: reminder\nstatus: {status}\ncreated: 2026-07-01\n{when_key}: {when}\n---\n\n# {title}\n\nDo it.\n"
            ),
        );
    }

    #[test]
    fn is_house_root_requires_marker_and_tasks_dir() {
        let t = TempTree::new();
        // neither
        assert!(!is_house_root(t.root()));
        // marker only → not a house (mirrors the hook gate)
        t.write("AGENTS.md", "# Test House\n");
        assert!(!is_house_root(t.root()));
        // marker + tasks/ → house
        t.write("tasks/README.md", "---\ntype: task\n---\n");
        assert!(is_house_root(t.root()));
        // marker case variants are honored
        let t2 = TempTree::new();
        t2.write("CLAUDE.md", "# Test House\n");
        t2.write("tasks/x.md", "---\nstatus: active\n---\n# X\n");
        assert!(is_house_root(t2.root()));
    }

    #[test]
    fn frontmatter_parses_real_task_shape() {
        let t = TempTree::new();
        make_house(&t);
        make_task(&t, "active-one", "active", "First active");
        make_task(&t, "backlog-two", "backlog", "Not today");
        let (count, title) = active_task_summary(t.root()).expect("summary");
        assert_eq!(count, 1);
        assert_eq!(title, "First active");
    }

    #[test]
    fn active_task_summary_counts_and_orders_by_filename() {
        let t = TempTree::new();
        make_house(&t);
        make_task(&t, "beta", "active", "Beta task");
        make_task(&t, "alpha", "active", "Alpha task");
        make_task(&t, "gamma", "complete", "Done");
        let (count, title) = active_task_summary(t.root()).expect("summary");
        assert_eq!(count, 2);
        // Lexicographic scan → "alpha" first.
        assert_eq!(title, "Alpha task");
    }

    #[test]
    fn active_task_summary_returns_none_without_tasks_dir() {
        let t = TempTree::new();
        t.write("AGENTS.md", "# Test House\n");
        assert!(active_task_summary(t.root()).is_none());
    }

    #[test]
    fn due_reminder_collection_skips_future_completed_and_readme() {
        let t = TempTree::new();
        make_house(&t);
        // due pending — naive local 2026-07-01T09:00
        make_reminder(&t, "due-item.md", "pending", "remind-at", "2026-07-01T09:00", "Renew certs");
        // snoozed whose snoozed-until is still future
        make_reminder(&t, "snoozed.md", "snoozed", "snoozed-until", "2999-01-01T09:00", "Later");
        // snoozed prefers snoozed-until over a past remind-at (hook contract)
        t.write(
            "reminders/snoozed-past.md",
            "---\ntype: reminder\nstatus: snoozed\ncreated: 2026-07-01\nsnoozed-until: 2999-01-01T09:00\nremind-at: 2020-01-01T09:00\n---\n\n# Still later\n",
        );
        // completed tree is skipped by convention
        make_reminder(&t, "completed/old.md", "pending", "remind-at", "2020-01-01T09:00", "Archived");
        // pending but future
        make_reminder(&t, "future.md", "pending", "remind-at", "2999-01-01T09:00", "Far future");
        // README is skipped even when pending + past
        t.write(
            "reminders/README.md",
            "---\ntype: reminder\nstatus: pending\nremind-at: 2020-01-01T09:00\n---\n\n# Index\n",
        );

        let due = due_reminder_summary(t.root(), now());
        assert_eq!(
            due.iter().map(|(title, _)| title.as_str()).collect::<Vec<_>>(),
            vec!["Renew certs"]
        );
        assert_eq!(due[0].1, "2026-07-01T09:00");
    }

    #[test]
    fn due_reminder_handles_rfc3339_and_date_only() {
        let t = TempTree::new();
        make_house(&t);
        make_reminder(&t, "aware.md", "pending", "remind-at", "2026-07-01T09:00:00+02:00", "Aware");
        make_reminder(&t, "dated.md", "pending", "remind-at", "2026-07-01", "Date only");
        let due = due_reminder_summary(t.root(), now());
        let titles: Vec<&str> = due.iter().map(|(title, _)| title.as_str()).collect();
        assert_eq!(titles, vec!["Aware", "Date only"]);
    }

    /// 2026-08-03 local — the same test seam the hook's `ARCUS_SESSION_INIT_NOW`
    /// pins (any fixed instant works; fixtures are chosen far from it).
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-03T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn house_announcement_composes_active_and_due() {
        let t = TempTree::new();
        make_house(&t);
        make_task(&t, "alpha", "active", "Alpha task");
        make_task(&t, "beta", "active", "Beta task");
        make_reminder(&t, "due.md", "pending", "remind-at", "2026-07-01T09:00", "Renew certs");

        let ann = house_announcement(t.root(), now()).expect("house announcement");
        assert_eq!(ann.id.as_deref(), Some("arcus-house"));
        assert_eq!(ann.title.as_deref(), Some("Test House"));
        assert_eq!(ann.severity.as_deref(), Some("house"));
        assert_eq!(ann.dismissible, Some(true));
        assert_eq!(ann.persistent, Some(false));
        assert_eq!(ann.expires_at, None);
        assert_eq!(
            ann.message.as_deref(),
            Some("2 active tasks · 1 reminder due\nAlpha task")
        );
    }

    #[test]
    fn house_announcement_prefers_task_title_over_reminder_title() {
        let t = TempTree::new();
        make_house(&t);
        make_reminder(&t, "due.md", "pending", "remind-at", "2026-07-01T09:00", "Renew certs");
        make_task(&t, "alpha", "active", "Alpha task");
        let ann = house_announcement(t.root(), now()).expect("house announcement");
        assert_eq!(ann.message.as_deref(), Some("1 active task · 1 reminder due\nAlpha task"));
    }

    #[test]
    fn house_announcement_shows_reminder_only_and_nothing_active() {
        let t = TempTree::new();
        make_house(&t);
        make_reminder(&t, "due.md", "pending", "remind-at", "2026-07-01T09:00", "Renew certs");
        let ann = house_announcement(t.root(), now()).expect("house announcement");
        assert_eq!(ann.message.as_deref(), Some("1 reminder due\nRenew certs"));
    }

    #[test]
    fn house_announcement_falls_back_to_current_state_when_idle() {
        let t = TempTree::new();
        make_house(&t); // no active tasks, no due reminders
        let ann = house_announcement(t.root(), now()).expect("house announcement");
        assert_eq!(
            ann.message.as_deref(),
            Some("**Founded 2026-07-31.** Standing opener.")
        );
    }

    #[test]
    fn house_announcement_falls_back_to_house_line_without_current_state() {
        let t = TempTree::new();
        t.write("AGENTS.md", "# Test House\n");
        t.write("tasks/README.md", "---\ntype: task\n---\n");
        let ann = house_announcement(t.root(), now()).expect("house announcement");
        assert_eq!(
            ann.message.as_deref(),
            Some("No active tasks · no reminders due — The house stands")
        );
    }

    #[test]
    fn house_announcement_is_none_outside_a_house() {
        let t = TempTree::new();
        t.write("AGENTS.md", "# Not a house\n"); // no tasks/ dir
        assert!(house_announcement(t.root(), now()).is_none());
        let t2 = TempTree::new();
        t2.write("tasks/README.md", "---\ntype: task\n---\n"); // no marker
        assert!(house_announcement(t2.root(), now()).is_none());
    }

    #[test]
    fn house_name_falls_back_to_the_house() {
        let t = TempTree::new();
        t.write("tasks/README.md", "---\ntype: task\n---\n");
        assert_eq!(house_name(t.root()), "The house");
        // An H2 alone does not name the house.
        t.write("AGENTS.md", "## Not the house\n");
        assert_eq!(house_name(t.root()), "The house");
    }

    #[test]
    fn house_name_takes_first_h1_of_agents_md() {
        let t = TempTree::new();
        t.write("AGENTS.md", "Intro line\n\n# The real house\n\nBody.\n");
        assert_eq!(house_name(t.root()), "The real house");
    }

    /// `apply_house_override` drops remote announcements at the site when a
    /// house is present — remote Grok promos never show there.
    #[test]
    fn remote_announcements_are_suppressed_when_house_present() {
        let t = TempTree::new();
        make_house(&t);
        let remote = vec![
            RemoteAnnouncement {
                id: Some("promo".into()),
                severity: Some("promo".into()),
                title: Some("Grok 4.5 is here!".into()),
                message: Some("Try it now.".into()),
                ..Default::default()
            },
            RemoteAnnouncement {
                id: Some("critical".into()),
                severity: Some("critical".into()),
                message: Some("Outage".into()),
                ..Default::default()
            },
        ];
        let out = apply_house_override(remote, t.root(), now(), false);
        assert_eq!(out.len(), 1, "only the house announcement survives");
        assert_eq!(out[0].id.as_deref(), Some("arcus-house"));
    }

    /// `GROK_ANNOUNCEMENTS_OVERRIDE` still wins: with the override active,
    /// the resolved list passes through untouched even inside a house.
    #[test]
    fn override_env_wins_over_house() {
        let t = TempTree::new();
        make_house(&t);
        let remote = vec![RemoteAnnouncement {
            id: Some("override-item".into()),
            message: Some("dev override".into()),
            ..Default::default()
        }];
        let out = apply_house_override(remote.clone(), t.root(), now(), true);
        assert_eq!(out, remote, "override list must pass through a house");
    }

    #[test]
    fn override_not_active_outside_house_keeps_resolved_list() {
        let t = TempTree::new();
        let remote = vec![RemoteAnnouncement {
            id: Some("remote-item".into()),
            message: Some("remote".into()),
            ..Default::default()
        }];
        let out = apply_house_override(remote.clone(), t.root(), now(), false);
        assert_eq!(out, remote);
    }
}
