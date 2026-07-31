#!/usr/bin/env python3
"""Branch-test matrix for house stop-gate + session-init hooks.

Reads canned-envelope fixtures under fixtures/{stop-gate,session-init}/,
substitutes tempfile paths for placeholders (__HOUSE__, __BUSY_TRANSCRIPT__,
…), then drives each script as:

  type <materialized>.json | python bin\\house_stop_gate.py

from the hooks directory (equivalent to templates/house with the
.arcus/hooks/ path prefix). Exit 0 only if every case passes.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOKS = Path(__file__).resolve().parent.parent
STOP_PY = HOOKS / "bin" / "house_stop_gate.py"
INIT_PY = HOOKS / "bin" / "house_session_init.py"
FIXTURES_STOP = HOOKS / "fixtures" / "stop-gate"
FIXTURES_INIT = HOOKS / "fixtures" / "session-init"

USERQ = {
    "type": "user",
    "content": [{"type": "text", "text": "hello <user_query>do work</user_query>"}],
}
ASSIST_TOOLS = {
    "type": "assistant",
    "content": "working",
    "tool_calls": [{"id": "a", "name": "run_terminal_command", "arguments": "{}"}],
}
TOOLRES = {"type": "tool_result", "tool_call_id": "a", "content": "ok"}

results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, cond, detail))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}")


def write_jsonl(path: Path, lines: list[dict]) -> str:
    path.write_text("\n".join(json.dumps(l) for l in lines), encoding="utf-8")
    return str(path)


def busy_lines() -> list[dict]:
    return [USERQ] + [ASSIST_TOOLS, TOOLRES] * 5


def capture_lines() -> list[dict]:
    return [
        USERQ,
        ASSIST_TOOLS,
        TOOLRES,
        ASSIST_TOOLS,
        TOOLRES,
        ASSIST_TOOLS,
        TOOLRES,
        {
            "type": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "w",
                    "name": "write",
                    "arguments": json.dumps(
                        {"file_path": "knowledge/terminal/x.md", "content": "y"}
                    ),
                }
            ],
        },
    ]


def make_house(root: Path) -> None:
    (root / "tasks").mkdir(parents=True, exist_ok=True)
    (root / "reminders").mkdir(parents=True, exist_ok=True)
    (root / "context").mkdir(parents=True, exist_ok=True)
    (root / "AGENTS.md").write_text("# House\n", encoding="utf-8")
    (root / "context" / "current-state.md").write_text("# current\n", encoding="utf-8")


def pipe_script(script: Path, envelope: dict, env: dict, materialized: Path) -> tuple[int, str, str]:
    materialized.write_text(json.dumps(envelope), encoding="utf-8")
    if os.name == "nt":
        cmd = f'type "{materialized}" | python "{script}"'
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            env=env,
            cwd=str(HOOKS),
        )
    else:
        proc = subprocess.run(
            [sys.executable, str(script)],
            input=json.dumps(envelope),
            capture_output=True,
            text=True,
            env=env,
            cwd=str(HOOKS),
        )
    return proc.returncode, (proc.stdout or "").strip(), (proc.stderr or "").strip()


def materialize(template_text: str, mapping: dict[str, str]) -> dict:
    """Replace path placeholders with JSON-safe forward-slash paths."""
    safe = template_text
    for key, val in mapping.items():
        safe = safe.replace(key, val.replace("\\", "/"))
    return json.loads(safe)


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        home = td_path / "home"
        home.mkdir()
        house = td_path / "house"
        make_house(house)
        nonorg = td_path / "nonorg"
        nonorg.mkdir()

        house_due = td_path / "house-due"
        make_house(house_due)
        (house_due / "reminders" / "due-item.md").write_text(
            "---\n"
            "type: reminder\n"
            "status: pending\n"
            "created: 2026-07-01\n"
            "remind-at: 2026-07-01T09:00\n"
            "tags: []\n"
            "---\n\n"
            "# Renew certs\n\nDo the thing.\n",
            encoding="utf-8",
        )

        house_bad = td_path / "house-bad"
        make_house(house_bad)
        (house_bad / "reminders" / "broken.md").write_text(
            "not frontmatter at all\n# Broken\n", encoding="utf-8"
        )
        (house_bad / "reminders" / "half.md").write_text(
            "---\nstatus: pending\nremind-at: 2020-01-01T00:00\nno closing fence\n",
            encoding="utf-8",
        )

        house_future = td_path / "house-future"
        make_house(house_future)
        (house_future / "reminders" / "future.md").write_text(
            "---\n"
            "type: reminder\n"
            "status: pending\n"
            "created: 2026-07-01\n"
            "remind-at: 2099-01-01T09:00\n"
            "---\n\n# Far future\n",
            encoding="utf-8",
        )

        fx = td_path / "fx"
        fx.mkdir()
        busy = write_jsonl(fx / "busy.jsonl", busy_lines())
        cap = write_jsonl(fx / "cap.jsonl", capture_lines())
        triv = write_jsonl(fx / "triv.jsonl", [USERQ, ASSIST_TOOLS])
        mat_dir = td_path / "materialized"
        mat_dir.mkdir()

        mapping = {
            "__HOUSE__": str(house).replace("\\", "/"),
            "__NONORG__": str(nonorg).replace("\\", "/"),
            "__BUSY_TRANSCRIPT__": busy.replace("\\", "/"),
            "__CAPTURE_TRANSCRIPT__": cap.replace("\\", "/"),
            "__TRIVIAL_TRANSCRIPT__": triv.replace("\\", "/"),
            "__HOUSE_WITH_DUE__": str(house_due).replace("\\", "/"),
            "__HOUSE_WITH_MALFORMED__": str(house_bad).replace("\\", "/"),
            "__HOUSE_WITH_FUTURE__": str(house_future).replace("\\", "/"),
        }

        env = dict(os.environ)
        env["GROK_HOME"] = str(home)
        env["ARCUS_HOME"] = str(home)
        env.pop("ARCUS_SESSION_INIT_NOW", None)

        # --- Stop gate (order matters for fired-state: 01 then 02 same session) ---
        stop_cases = [
            ("01-first-fire-block.json", "stop: first-fire block",
             lambda rc, out: rc == 0 and '"decision": "block"' in out and "HOUSE STOP GATE" in out),
            ("02-fired-state-release.json", "stop: fired-state release",
             lambda rc, out: rc == 0 and out == ""),
            ("03-release-phrase-release.json", "stop: release-phrase release",
             lambda rc, out: rc == 0 and out == ""),
            ("04-capture-write-release.json", "stop: capture-write release",
             lambda rc, out: rc == 0 and out == ""),
            ("05-trivial-suppression.json", "stop: trivial suppression",
             lambda rc, out: rc == 0 and out == ""),
            ("06-non-org-release.json", "stop: non-org release",
             lambda rc, out: rc == 0 and out == ""),
            ("07-session-end-release.json", "stop: session-end release",
             lambda rc, out: rc == 0 and out == ""),
        ]

        for fname, label, pred in stop_cases:
            raw = (FIXTURES_STOP / fname).read_text(encoding="utf-8")
            envelope = materialize(raw, mapping)
            rc, out, err = pipe_script(STOP_PY, envelope, env, mat_dir / fname)
            check(label, pred(rc, out), f"rc={rc} out={out[:100]!r}")

        # --- Session-init ---
        env_due = dict(env)
        env_due["ARCUS_SESSION_INIT_NOW"] = "2026-07-30T12:00:00"

        init_cases = [
            ("01-no-reminders-silent.json", "init: no reminders → silent", env,
             lambda rc, out: rc == 0 and out == ""),
            ("02-due-reminder-context.json", "init: due reminder → context", env_due,
             lambda rc, out: (
                 rc == 0
                 and "hookSpecificOutput" in out
                 and "additionalContext" in out
                 and "SessionStart" in out
                 and "Renew certs" in out
                 and "Orientation:" in out
             )),
            ("03-malformed-frontmatter-skipped.json",
             "init: malformed frontmatter → skipped/silent", env_due,
             lambda rc, out: rc == 0 and out == ""),
            ("04-non-house-silent.json", "init: non-house cwd → silent", env_due,
             lambda rc, out: rc == 0 and out == ""),
            ("05-future-not-due-silent.json", "init: future reminder not due → silent",
             env_due, lambda rc, out: rc == 0 and out == ""),
        ]

        for fname, label, e, pred in init_cases:
            raw = (FIXTURES_INIT / fname).read_text(encoding="utf-8")
            envelope = materialize(raw, mapping)
            rc, out, err = pipe_script(INIT_PY, envelope, e, mat_dir / fname)
            check(label, pred(rc, out), f"rc={rc} out={out[:120]!r}")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        print("FAILED:")
        for name, _, detail in failed:
            print(f"  - {name}: {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
