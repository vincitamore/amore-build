#!/usr/bin/env python3
"""house compact — PreCompact / PostCompact hook for Amore Build houses.

Emits a disk-orientation packet at the compact boundary. Pointers only —
does not dump current-state or task bodies, and does not write tips
(tip-write stays agent-owned).

Wire contract (user-guide 10-hooks.md):
- Events: PreCompact / PostCompact (aliases pre_compact / preCompact,
  post_compact / postCompact). Passive Observe; matcher is the trigger
  (`manual` or `auto`) in `source`.
- Exit 0 on success; fail-open on any error (hard budget <5s, stdlib only).
- When the workspace is a house, emit Claude-compatible stdout JSON:

    {"hookSpecificOutput":{
       "hookEventName":"PreCompact"|"PostCompact",
       "additionalContext":"..."
    }}

  Silent success (empty stdout, exit 0) when cwd is not a house or the
  event is not ours.

  The harness currently discards compact additionalContext (SessionStart
  is the consume pattern to copy). The emit is the contract so a consume
  path can land without changing this script.

v1 behavior:
  (a) always emit in a house (unlike session-init, which is silent when
      nothing is due) — the refuse-summary-as-warrant line is the load;
  (b) snapshot active tasks under tasks/**/*.md (status: active; skip
      completed/backlog/incubating/paused/review);
  (c) list due reminders (same contract as house_session_init);
  (d) PreCompact frames the snapshot for the summarizer; PostCompact
      frames the orientation packet for the successor.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ORG_MARKERS = ("AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md")
DUE_STATUSES = frozenset({"pending", "snoozed"})
TASK_SKIP_DIRS = frozenset(
    {"completed", "backlog", "incubating", "paused", "review"}
)
MAX_TASKS = 8
MAX_REMINDERS = 8
PRE_EVENTS = frozenset({"pre_compact", "PreCompact", "preCompact"})
POST_EVENTS = frozenset({"post_compact", "PostCompact", "postCompact"})
WIKI_TASK = re.compile(r"\[\[tasks/([^\]|#]+)")

PRE_LEAD = (
    "[HOUSE COMPACT BOUNDARY]\n"
    "\n"
    "Preserve these disk surfaces in the summary. They are the source of "
    "record, not the chat. Do not invent bars or standing blocks the task "
    "file does not carry."
)
POST_LEAD = (
    "[HOUSE COMPACT BOUNDARY]\n"
    "\n"
    "Soft compact. The summary is forensics, not warrant.\n"
    "Before continuing, re-read from disk:\n"
    "  1. context/current-state.md\n"
    "  2. the active task it names\n"
    "  3. any tip surfaces that task names\n"
    "Do not treat the summary as evidence that a bar is met, that a "
    "standing block still holds, or that tips are current."
)


def silent() -> None:
    sys.exit(0)


def is_house_workspace(root: Path) -> bool:
    try:
        has_marker = any((root / m).is_file() for m in ORG_MARKERS)
        return has_marker and (root / "tasks").is_dir()
    except OSError:
        return False


def parse_frontmatter(text: str) -> dict[str, str] | None:
    """Minimal YAML-ish frontmatter parser (stdlib only). Keys we care about
    are scalars; malformed or missing fences return None."""
    if not text.startswith("---"):
        return None
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return None
    meta: dict[str, str] = {}
    for line in lines[1:end]:
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        if ":" not in raw:
            continue
        key, _, val = raw.partition(":")
        key = key.strip()
        val = val.strip().strip("\"'")
        if val.lower() in ("null", "~", ""):
            val = ""
        meta[key] = val
    return meta


def parse_when(raw: str) -> datetime | None:
    if not raw:
        return None
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.fromisoformat(s + "T00:00:00")
        except ValueError:
            return None
    if dt.tzinfo is None:
        return dt
    return dt


def due_at(meta: dict[str, str]) -> datetime | None:
    status = (meta.get("status") or "").strip().lower()
    if status not in DUE_STATUSES:
        return None
    if status == "snoozed":
        return parse_when(meta.get("snoozed-until") or "") or parse_when(
            meta.get("remind-at") or ""
        )
    return parse_when(meta.get("remind-at") or "") or parse_when(
        meta.get("snoozed-until") or ""
    )


def first_heading(path: Path, body_after_fm: str) -> str:
    for line in body_after_fm.splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip() or path.stem
    return path.stem


def body_after_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text
    lines = text.splitlines()
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[i + 1 :])
    return text


def collect_due_reminders(root: Path, now: datetime) -> list[tuple[Path, str, str]]:
    rem_dir = root / "reminders"
    if not rem_dir.is_dir():
        return []
    due: list[tuple[Path, str, str]] = []
    try:
        paths = sorted(rem_dir.rglob("*.md"))
    except OSError:
        return []
    for path in paths:
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        parts_lower = [p.lower() for p in rel.parts]
        if "completed" in parts_lower:
            continue
        if path.name.lower() == "readme.md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta = parse_frontmatter(text)
        if meta is None:
            continue
        when = due_at(meta)
        if when is None:
            continue
        now_cmp = now
        if when.tzinfo is not None and now_cmp.tzinfo is None:
            now_cmp = now_cmp.replace(tzinfo=timezone.utc)
        elif when.tzinfo is None and now_cmp.tzinfo is not None:
            when = when.replace(tzinfo=now_cmp.tzinfo)
        if when > now_cmp:
            continue
        title = first_heading(path, body_after_frontmatter(text))
        when_s = meta.get("snoozed-until") or meta.get("remind-at") or when.isoformat()
        due.append((rel, title, when_s))
    return due


def collect_active_tasks(root: Path) -> list[tuple[Path, str]]:
    tasks_dir = root / "tasks"
    if not tasks_dir.is_dir():
        return []
    found: list[tuple[Path, str]] = []
    try:
        paths = sorted(tasks_dir.rglob("*.md"))
    except OSError:
        return []
    for path in paths:
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        parts_lower = [p.lower() for p in rel.parts]
        if any(part in TASK_SKIP_DIRS for part in parts_lower):
            continue
        if path.name.lower() == "readme.md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta = parse_frontmatter(text)
        if meta is None:
            continue
        if (meta.get("status") or "").strip().lower() != "active":
            continue
        title = first_heading(path, body_after_frontmatter(text))
        found.append((rel, title))
    return found


def cited_task_stems(root: Path) -> set[str]:
    cs = root / "context" / "current-state.md"
    try:
        text = cs.read_text(encoding="utf-8")
    except OSError:
        return set()
    return {m.group(1).strip().rstrip("/") for m in WIKI_TASK.finditer(text)}


def pin_now() -> datetime:
    now = datetime.now().astimezone()
    pinned = (
        os.environ.get("AMORE_HOUSE_NOW")
        or os.environ.get("AMORE_COMPACT_NOW")
        or os.environ.get("ARCUS_SESSION_INIT_NOW")
    )
    if not pinned:
        return now
    parsed = parse_when(pinned)
    if parsed is None:
        return now
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def build_context(
    *,
    pre: bool,
    tasks: list[tuple[Path, str]],
    due: list[tuple[Path, str, str]],
    current_state: bool,
    cited: set[str],
) -> str:
    lines = [PRE_LEAD if pre else POST_LEAD, ""]
    if current_state:
        lines.append("Standing reality: context/current-state.md")
    else:
        lines.append("Standing reality: context/current-state.md is missing.")

    if tasks:
        lines.append("Active tasks on disk:")
        shown = tasks[:MAX_TASKS]
        for rel, title in shown:
            mark = ""
            stem = rel.as_posix()
            if stem.startswith("tasks/"):
                key = stem[len("tasks/") :].rsplit(".", 1)[0]
            else:
                key = rel.stem
            if key in cited or rel.stem in cited:
                mark = " (cited by current-state)"
            lines.append(f"- {rel.as_posix()}: {title}{mark}")
        extra = len(tasks) - len(shown)
        if extra > 0:
            lines.append(f"- +{extra} more")
    else:
        lines.append(
            "Active tasks on disk: none — check context/current-state.md"
        )

    if due:
        lines.append("Due reminders:")
        shown_r = due[:MAX_REMINDERS]
        for rel, title, when_s in shown_r:
            lines.append(f"- {rel.as_posix()}: {title} (due {when_s})")
        extra_r = len(due) - len(shown_r)
        if extra_r > 0:
            lines.append(f"- +{extra_r} more")

    return "\n".join(lines)


def emit_context(text: str, event_label: str) -> None:
    payload = {
        "hookSpecificOutput": {
            "hookEventName": event_label,
            "additionalContext": text,
        }
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.exit(0)


def main() -> None:
    try:
        try:
            envelope = json.load(sys.stdin)
        except (ValueError, json.JSONDecodeError):
            silent()

        event = envelope.get("hookEventName") or ""
        if event in PRE_EVENTS:
            pre = True
            label = "PreCompact"
        elif event in POST_EVENTS:
            pre = False
            label = "PostCompact"
        else:
            silent()

        root_raw = (
            envelope.get("workspaceRoot")
            or envelope.get("workspace_root")
            or envelope.get("cwd")
            or os.getcwd()
        )
        root = Path(root_raw)
        if not is_house_workspace(root):
            silent()

        now = pin_now()
        tasks = collect_active_tasks(root)
        due = collect_due_reminders(root, now)
        current_state = (root / "context" / "current-state.md").is_file()
        cited = cited_task_stems(root) if current_state else set()
        emit_context(
            build_context(
                pre=pre,
                tasks=tasks,
                due=due,
                current_state=current_state,
                cited=cited,
            ),
            label,
        )
    except Exception:
        silent()


if __name__ == "__main__":
    main()
