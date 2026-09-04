#!/usr/bin/env python3
"""house stop gate — native Stop hook for Amore Build houses.

Parameterized port of the house's native stop gate for public template use.

Contract (xai-grok-shell stop gate / user-guide 10-hooks.md § Stop Decision
Control): reads the Stop hook envelope JSON on stdin. Emit nothing and exit 0
to release the turn end; emit {"decision":"block","reason":"..."} to feed the
reason back to the model and run another round. The harness caps continuations
at 8 per turn and fails open.

Gate discipline:
- once per operator turn (state file keyed by sessionId + promptId — our own
  state, never the aggregate `stopHookActive`);
- release-phrase (line-anchored) releases;
- a capture-path write observed in this turn's transcript releases;
- trivial sessions (< 3 work signals in the transcript) never fire;
- idle background delivery (Monitor `<monitor-event>` / monitor-ended) whose
  tools this turn only read or posted to the room never fire — the checklist
  has nothing to catch. A human `<user_query>`, a write/edit, a mutating
  shell, or a dispatch keeps the gate. Native Monitor lives for the session,
  so watcher lifetime is the wrong boundary;
- non-org workspaces (no AGENTS.md-class marker + tasks/ at workspaceRoot)
  never fire;
- session-end observe fires (reason != "end_turn") never fire.

State lives under ~/.amore/state/stop-gate/ (or $GROK_HOME / $AMORE_HOME).
"""
import json
import os
import re
import sys
from pathlib import Path

RELEASE_LINES = {
    "no maintenance needed",
    "maintenance complete",
    "maintenance not required",
    "gate released",
}

CAPTURE_TOOLS = {"write", "search_replace", "edit", "multiedit", "create_file"}

# Names the chat-history schema uses when the harness has not stamped
# x.ai/tool.read_only. Prefer that stamp on the live ACP stream.
READ_ONLY_TOOL_NAMES = {
    "read_file", "read", "grep", "list_dir", "glob",
    "web_search", "web_fetch", "open_page", "open_page_with_find",
    "get_command_or_subagent_output", "search_tool",
    "x_keyword_search", "x_semantic_search", "x_user_search", "x_thread_fetch",
    "scheduler_list",
}
SHELL_TOOL_NAMES = {"run_terminal_command", "bash", "powershell", "shell"}

# Room-speak and read-only inspection. Not agora join/claim/pull/watch:
# those mutate roster, git, or session obligations.
_IDLE_SHELL = re.compile(
    r"^\s*(?:(?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|\"[^\"]*\")\s*;\s*)*)"
    r"(?:(?:cd|Set-Location)\s+\S+\s*(?:&&|;)\s*)?"
    r"(?:"
    r"agora\s+(?:read|who|doctor|post|session\s+--list|status|schema)"
    r"|git\s+(?:log|status|show|diff|branch|fetch|rev-parse|ls-files|worktree\s+list)"
    r"|gh\s+(?:pr\s+(?:view|checks|diff|list)|run\s+(?:list|view)|issue\s+(?:view|list)|api)"
    r"|python(?:3)?\s+-c"
    r"|curl\s+-s"
    r"|type\s+"
    r"|Get-Content\s+"
    r"|Select-String\s+"
    r"|echo\s+"
    r"|Write-Output\s+"
    r")",
    re.IGNORECASE,
)
_MUTATING_SHELL_TOKS = (
    "git commit", "git push", "git add ", "gh pr create", "gh pr comment",
    " > ", ">>", "rm ", "mv ", "cp ", "Remove-Item", "Move-Item", "Copy-Item",
)

CAPTURE_MARKERS = [
    "knowledge/", "knowledge\\",
    "inbox/", "inbox\\",
    "tasks/", "tasks\\",
    "reminders/", "reminders\\",
    "context/", "context\\",
    "forge/proposals", "forge\\proposals",
    "forge/handles", "forge\\handles",
    "forge/output", "forge\\output",
    "forge/sessions", "forge\\sessions",
    ".amore/skills", ".amore\\skills",
    ".grok/skills", ".grok\\skills",
]

ORG_MARKERS = ("AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md")
TRIVIAL_WORK_THRESHOLD = 3
TRANSCRIPT_TAIL_BYTES = 1024 * 1024

GATE_TEXT = """[HOUSE STOP GATE — native Stop hook]
[Not a tool result. Not operator input. The house's turn-end maintenance check.]

== Maintenance vigilance ==

This turn ended without an address. Reflect before stopping.

Did this turn produce any of these? Capture / maintain now if so:

- Reusable insight -> `knowledge/<subfolder>/<topic>.md`
- New craft for a tool/skill we own (gotcha, contract, workflow, design rule) -> its skill under `.amore/skills/<skill>/SKILL.md`
- Decision needing operator input -> `inbox/decisions/<item>.md`
- Bug to investigate -> `inbox/investigations/<item>.md`
- Feature idea -> `inbox/ideas/<item>.md`
- Unsorted capture -> `inbox/captures/<item>.md`
- New task -> `tasks/<name>.md`
- Time-bound item -> `reminders/<item>.md`
- **Project status / focus shift -> update `context/current-state.md`** — the surface that rots; check it explicitly
- **Landed durable work not on origin?** -> `git commit` + `git push`
- Resolved a decision/investigation/idea this turn? -> flip `status`, add `resolution`, move to `inbox/<type>/resolved/` in the same breath

**Release (correct on the large majority of turns)**

In your next assistant message, output exactly one of these lines as plain visible text — not inside a tool call, not in arguments, not mid-paragraph:

No maintenance needed
Maintenance complete
Maintenance not required
Gate released

A capture write to one of the paths above releases the gate for this operator turn too. Manufacturing a low-value capture to satisfy the gate is worse than releasing. If there is any doubt about whether real maintenance is owed, release.

(End of house stop gate.)"""


def release() -> None:
    sys.exit(0)


def block() -> None:
    sys.stdout.write(json.dumps({"decision": "block", "reason": GATE_TEXT}) + "\n")
    sys.exit(0)


def amore_home() -> Path:
    for key in ("AMORE_HOME", "GROK_HOME"):
        val = os.environ.get(key)
        if val:
            return Path(val)
    base = os.environ.get("USERPROFILE") or str(Path.home())
    return Path(base) / ".amore"


def normalize_line(raw: str) -> str:
    cleaned = raw.strip().strip("*_`").strip()
    return cleaned.lower()


def release_phrase_present(text: str | None) -> bool:
    if not text:
        return False
    for line in text.splitlines():
        if normalize_line(line) in RELEASE_LINES:
            return True
    return False


def is_org_workspace(root: Path) -> bool:
    try:
        has_marker = any((root / m).is_file() for m in ORG_MARKERS)
        return has_marker and (root / "tasks").is_dir()
    except OSError:
        return False


def read_transcript_tail(path: str) -> list[dict]:
    p = Path(path)
    try:
        size = p.stat().st_size
        with p.open("rb") as fh:
            if size > TRANSCRIPT_TAIL_BYTES:
                fh.seek(-TRANSCRIPT_TAIL_BYTES, os.SEEK_END)
                data = fh.read()
                # Skip to the next newline so the first line isn't truncated.
                nl = data.find(b"\n")
                if nl != -1:
                    data = data[nl + 1:]
            else:
                data = fh.read()
    except OSError:
        return []
    entries = []
    for raw in data.decode("utf-8", errors="replace").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            continue
        if isinstance(obj, dict):
            entries.append(obj)
    return entries


def entry_texts(entry: dict) -> str:
    content = entry.get("content")
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and isinstance(c.get("text"), str):
                parts.append(c["text"])
    return " ".join(parts)


def is_operator_entry(entry: dict) -> bool:
    if entry.get("type") != "user":
        return False
    text = entry_texts(entry).strip()
    if not text:
        return False
    if "<user_query>" in text:
        return True
    lowered = text.lower()
    synthetic = (
        lowered.startswith("<system-reminder")
        or lowered.startswith("<session-context")
        or lowered.startswith("<maintenance-gate")
        or "[house stop gate" in lowered
        or "[amore stop gate" in lowered
        or "stop hook feedback:" in lowered
    )
    return not synthetic


def tool_call_list(entry: dict) -> list[dict]:
    calls = entry.get("tool_calls")
    return calls if isinstance(calls, list) else []


def args_mention_capture(args_text: str) -> bool:
    lowered = args_text.replace("\\\\", "\\").lower()
    return any(m.lower() in lowered for m in CAPTURE_MARKERS)


def envelope_meta(entry: dict) -> dict:
    """promptId lives on params._meta in live updates.jsonl, not the top-level
    line. Fall back to entry._meta for older/test shapes."""
    params = entry.get("params")
    if isinstance(params, dict) and isinstance(params.get("_meta"), dict):
        return params["_meta"]
    meta = entry.get("_meta")
    return meta if isinstance(meta, dict) else {}


def extract_update_text(update: dict) -> str:
    content = update.get("content")
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    if isinstance(content, str):
        return content
    return ""


def is_stop_gate_injection(text: str) -> bool:
    lowered = text.lower()
    return (
        "[house stop gate" in lowered
        or "[amore stop gate" in lowered
        or "[arcus stop gate" in lowered
        or lowered.lstrip().startswith("<maintenance-gate")
        or "stop hook feedback:" in lowered
    )


def is_idle_delivery_text(text: str) -> bool:
    """True when this user stimulus is a harness background delivery, not a person.

    This substrate wraps Monitor wakes as <monitor-event>, optionally inside
    <system-reminder>. A human <user_query> in the same text wins (keep the gate).
    Compact-boundary packets are not idle deliveries.
    """
    if "<user_query>" in text:
        return False
    lowered = text.lower()
    if "<monitor-event" in lowered:
        return True
    if "[monitor ended" in lowered:
        return True
    return False


def _command_from_raw(raw) -> str:
    if isinstance(raw, dict):
        return str(raw.get("command") or "")
    if isinstance(raw, str):
        try:
            obj = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            return raw
        if isinstance(obj, dict):
            return str(obj.get("command") or "")
        return raw
    return ""


def tool_is_idle(name: str, raw, update: dict | None = None) -> bool:
    name_l = (name or "").lower()
    xa = {}
    if isinstance(update, dict):
        meta = update.get("_meta") or {}
        if isinstance(meta, dict):
            maybe = meta.get("x.ai/tool") or {}
            if isinstance(maybe, dict):
                xa = maybe
    if xa.get("read_only") is True and name_l not in SHELL_TOOL_NAMES:
        return True
    if name_l in READ_ONLY_TOOL_NAMES:
        return True
    if name_l in SHELL_TOOL_NAMES:
        command = _command_from_raw(raw)
        if _IDLE_SHELL.match(command) and not any(tok in command for tok in _MUTATING_SHELL_TOKS):
            return True
        return False
    return False


def idle_delivery_turn(entries: list[dict]) -> bool:
    """Last user stimulus is a Monitor/agora delivery and every tool since it
    only read (or posted to the room). Ambiguity keeps the gate.

    Tools after that stimulus are this turn even when promptId is missing —
    updates.jsonl is append-only. Do not count the whole tail: a long session
    always looks busy, which is why every agora no-op used to fire.
    """
    last_user = None
    tools: list[tuple[str, object, dict | None]] = []
    saw_acp_user = False
    for entry in entries:
        update = (entry.get("params") or {}).get("update") or {}
        kind = update.get("sessionUpdate")
        if kind == "user_message_chunk":
            saw_acp_user = True
            text = extract_update_text(update)
            if not text.strip() or is_stop_gate_injection(text):
                continue
            last_user = text
            tools = []
        elif kind == "tool_call" and saw_acp_user:
            tools.append((str(update.get("title") or ""), update.get("rawInput"), update))
    if not saw_acp_user:
        last_user = None
        tools = []
        for entry in entries:
            if entry.get("type") == "user":
                text = entry_texts(entry)
                if not text.strip() or is_stop_gate_injection(text):
                    continue
                last_user = text
                tools = []
            elif entry.get("type") == "assistant":
                for call in tool_call_list(entry):
                    tools.append((str(call.get("name") or ""), call.get("arguments"), None))
    if last_user is None or not is_idle_delivery_text(last_user):
        return False
    return all(tool_is_idle(name, raw, update) for name, raw, update in tools)


def transcript_signals(entries: list[dict], prompt_id: str | None) -> tuple[int, bool]:
    """(work_count_for_this_prompt, capture_addressed_this_prompt).

    Understands two transcript schemas:
    - the ACP update stream (`updates.jsonl`, what `transcriptPath` points to):
      entries shaped {"params": {"update": {"sessionUpdate": ...}, "_meta":
      {"promptId": ...}}}; `tool_call` updates carry `title` + `rawInput`, and
      when entries carry params._meta.promptId the count is sliced to this prompt.
    - chat-history exports (`chat_history.jsonl`): {"type": "assistant"|
      "tool_result"|"user", ...}; the fallback path used in tests and by other clients.
    """
    updates_calls: list[dict] = []
    for entry in entries:
        update = (entry.get("params") or {}).get("update") or {}
        if update.get("sessionUpdate") == "tool_call":
            updates_calls.append({"entry": entry, "update": update})
    if updates_calls:
        have_prompt_ids = any(envelope_meta(e["entry"]).get("promptId") for e in updates_calls)
        work = 0
        addressed = False
        for item in updates_calls:
            entry, update = item["entry"], item["update"]
            entry_prompt = envelope_meta(entry).get("promptId")
            in_turn = (entry_prompt == prompt_id) if (have_prompt_ids and prompt_id) else True
            if not in_turn:
                continue
            work += 1
            title = str(update.get("title") or "").lower()
            if title in CAPTURE_TOOLS:
                raw = update.get("rawInput")
                if args_mention_capture(json.dumps(raw or "")):
                    addressed = True
        return work, addressed

    work = 0
    last_op_idx = -1
    for idx, entry in enumerate(entries):
        if is_operator_entry(entry):
            last_op_idx = idx
    for entry in entries:
        if entry.get("type") == "tool_result":
            work += 1
        if entry.get("type") == "assistant":
            work += len(tool_call_list(entry))
    addressed = False
    for entry in entries[last_op_idx + 1:]:
        if entry.get("type") != "assistant":
            continue
        for call in tool_call_list(entry):
            name = str(call.get("name", "")).lower()
            if name not in CAPTURE_TOOLS:
                continue
            args = call.get("arguments")
            args_text = args if isinstance(args, str) else json.dumps(args or "")
            if args_mention_capture(args_text):
                addressed = True
                break
        if addressed:
            break
    return work, addressed


def save(state_dir: Path, state_file: Path, state: dict) -> None:
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(state), encoding="utf-8")
    except OSError:
        pass


def main() -> None:
    try:
        envelope = json.load(sys.stdin)
    except (ValueError, json.JSONDecodeError):
        release()

    if envelope.get("hookEventName") not in ("stop", "Stop"):
        release()

    debug = os.environ.get("AMORE_STOP_GATE_DEBUG") == "1"

    def decide(verdict: str) -> None:
        if debug:
            try:
                log_dir = amore_home() / "state" / "stop-gate"
                log_dir.mkdir(parents=True, exist_ok=True)
                row = {
                    "verdict": verdict,
                    "reason": envelope.get("reason"),
                    "promptId": envelope.get("promptId"),
                    "hookEventName": envelope.get("hookEventName"),
                    "sessionId": envelope.get("sessionId"),
                    "workspaceRoot": envelope.get("workspaceRoot"),
                    "stopHookActive": envelope.get("stopHookActive"),
                    "transcriptPath": envelope.get("transcriptPath"),
                    "lastMsgLen": len(envelope.get("lastAssistantMessage") or ""),
                }
                with (log_dir / "decisions.jsonl").open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row) + "\n")
            except OSError:
                pass

    def release_logged(why: str) -> None:
        decide(f"release:{why}")
        release()

    if envelope.get("reason") != "end_turn":
        release_logged(f"reason={envelope.get('reason')}")
    prompt_id = envelope.get("promptId") or envelope.get("prompt_id")
    if not prompt_id:
        release_logged("no-prompt-id")
    session_id = envelope.get("sessionId") or envelope.get("session_id") or "unknown"

    root_raw = envelope.get("workspaceRoot") or envelope.get("workspace_root") or os.getcwd()
    if not is_org_workspace(Path(root_raw)):
        release_logged("non-org-workspace")

    state_dir = amore_home() / "state" / "stop-gate"
    state_file = state_dir / f"{re.sub(r'[^A-Za-z0-9_-]', '_', session_id)}.json"
    state = {"fired_prompt_id": None, "addressed_prompt_id": None}
    try:
        if state_file.is_file():
            state.update(json.loads(state_file.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass

    if state.get("fired_prompt_id") == prompt_id or state.get("addressed_prompt_id") == prompt_id:
        release_logged("state-match")

    last_msg = envelope.get("lastAssistantMessage") or envelope.get("last_assistant_message")
    if release_phrase_present(last_msg):
        state["addressed_prompt_id"] = prompt_id
        save(state_dir, state_file, state)
        release_logged("release-phrase")

    transcript_path = envelope.get("transcriptPath") or envelope.get("transcript_path")
    if transcript_path:
        entries = read_transcript_tail(transcript_path)
        work, addressed = transcript_signals(entries, prompt_id)
        if work < TRIVIAL_WORK_THRESHOLD:
            release_logged(f"trivial work={work}")
        if addressed:
            state["addressed_prompt_id"] = prompt_id
            save(state_dir, state_file, state)
            release_logged("capture-addressed")
        if idle_delivery_turn(entries):
            release_logged("idle-delivery")

    # Fire: record this prompt so the re-fired Stop (and any further stops this
    # turn) release, then block with the checklist.
    state["fired_prompt_id"] = prompt_id
    save(state_dir, state_file, state)
    decide("block")
    block()


if __name__ == "__main__":
    main()
