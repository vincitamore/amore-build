#!/usr/bin/env python3
"""house session-init — SessionStart hook for Arcus Build houses.

Surfaces due reminders and a one-line orientation pointer at session start.

Wire contract (user-guide 10-hooks.md):
- Event: SessionStart (aliases session_start / sessionStart) — passive Observe
  event; common envelope fields hookEventName, sessionId, cwd, workspaceRoot,
  timestamp, permissionMode; SessionStart payload includes `source`.
- Exit 0 on success; fail-open on any error (hard budget <5s, stdlib only).
- When there is context to inject, emit Claude-compatible / guide-vocabulary
  stdout JSON (same shape as § Stop Decision Control additionalContext):

    {"hookSpecificOutput":{
       "hookEventName":"SessionStart",
       "additionalContext":"..."
    }}

  Silent success (empty stdout, exit 0) when nothing is due or cwd is not a
  house repo. Observe runners may currently ignore stdout; the emission shape
  matches the documented additionalContext vocabulary for forward parity.

v1 behavior:
  (a) enumerate due reminders under reminders/**/*.md — frontmatter with
      status pending|snoozed and remind-at|snoozed-until <= now;
  (b) include a one-line orientation pointer in the same context block.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ORG_MARKERS = ("AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md")
DUE_STATUSES = frozenset({"pending", "snoozed"})
ORIENTATION = (
    "Orientation: read AGENTS.md → context/current-state.md → active task "
    "under tasks/ before starting work."
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
    # Accept trailing Z as UTC.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        # Date-only: treat as start of that local day.
        try:
            dt = datetime.fromisoformat(s + "T00:00:00")
        except ValueError:
            return None
    if dt.tzinfo is None:
        # Compare naively against local-now-as-naive; callers pass consistent now.
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


def reminder_title(path: Path, body_after_fm: str) -> str:
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
    """Return list of (relpath, title, when_iso) for due reminders."""
    rem_dir = root / "reminders"
    if not rem_dir.is_dir():
        return []
    due: list[tuple[Path, str, str]] = []
    try:
        paths = sorted(rem_dir.rglob("*.md"))
    except OSError:
        return []
    for path in paths:
        # Skip schema index and completed tree by convention.
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
        # Normalize comparison: drop tz on both sides if mixed.
        now_cmp = now
        if when.tzinfo is not None and now_cmp.tzinfo is None:
            now_cmp = now_cmp.replace(tzinfo=timezone.utc)
        elif when.tzinfo is None and now_cmp.tzinfo is not None:
            when = when.replace(tzinfo=now_cmp.tzinfo)
        if when > now_cmp:
            continue
        title = reminder_title(path, body_after_frontmatter(text))
        when_s = meta.get("snoozed-until") or meta.get("remind-at") or when.isoformat()
        due.append((rel, title, when_s))
    return due


def build_context(due: list[tuple[Path, str, str]]) -> str:
    lines = ["[HOUSE SESSION INIT]", "", "Due reminders:"]
    for rel, title, when_s in due:
        lines.append(f"- {rel.as_posix()}: {title} (due {when_s})")
    lines.append("")
    lines.append(ORIENTATION)
    return "\n".join(lines)


def emit_context(text: str) -> None:
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
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
        if event not in ("session_start", "SessionStart", "sessionStart"):
            # Not our event — fail open silent.
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

        now = datetime.now().astimezone()
        # Allow tests to pin "now" without touching the clock.
        pinned = os.environ.get("ARCUS_SESSION_INIT_NOW")
        if pinned:
            parsed = parse_when(pinned)
            if parsed is not None:
                now = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

        due = collect_due_reminders(root, now)
        if not due:
            silent()

        emit_context(build_context(due))
    except Exception:
        # Hard fail-open: never block session start.
        silent()


if __name__ == "__main__":
    main()
