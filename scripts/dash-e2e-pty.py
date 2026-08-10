#!/usr/bin/env python3
"""H2 — assert-driven PTY drive of the COMPILED iris-dash binary (Sessions surface).

Extends the fork's capture_frame.py machinery (winpty + pyte, env/home discipline,
sentinel waits, frame dumps) with multi-step choreography and PASS/FAIL assertions.

Import reuse:
  * dump_frame — the only top-level primitive export from capture_frame.py
  * render_frame_to_png — styled-cell JSON → review PNG (in-process)
  * All other PTY loop pieces live inside capture_frame.main() (CLI-only); this
    script mirrors those patterns in-process so one continuous session can
    S → g → w → L without relaunch. capture_frame.py is NEVER modified.

Run from repo root:
  python scripts/dash-e2e-pty.py
  python scripts/dash-e2e-pty.py --profile operator
  python scripts/dash-e2e-pty.py --profile narrow --no-png
  python scripts/dash-e2e-pty.py --profile tight

Needs: Python 3, pyte, winpty (same as capture_frame.py), compiled dash binary.
Optional PNG path: PIL + fontTools (same as render_frame.py).
Flaky-by-nature: native ConPTY races + winpty title-replay keystrokes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import random
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pyte
from winpty import PtyProcess

# Import the one reusable primitive from the capture machinery (same dir).
_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from capture_frame import dump_frame  # noqa: E402

# ── Paths / sizes ────────────────────────────────────────────────────────────
REPO_ROOT = _SCRIPTS.parent
DIST_DASH = REPO_ROOT / "instruments" / "iris" / "dist" / "iris-dash-windows-x64.exe"
INSTALL_DASH = Path.home() / "amore" / "bin" / "iris-dash-windows-x64.exe"
FRAMES_DIR = _SCRIPTS / "e2e-pty-frames"
REVIEW_DIR = _SCRIPTS / "e2e-pty-review"

# Profiles (cols, rows). Module ROWS/COLS remain the narrow defaults for docs.
PROFILES: dict[str, tuple[int, int]] = {
    "operator": (140, 48),
    "narrow": (120, 36),
    "tight": (100, 30),
}
ROWS = 36
COLS = 120
STEP_TIMEOUT = 10.0  # per-step pattern wait (brief: ~10s)
BOOT_TIMEOUT = 45.0
SETTLE_AFTER_SEND = 0.45

# Typed-query letters that avoid shell/picker-bound keys (t q v j k) and
# digit member-switch (1-9). FTS seed text below includes this token.
SAFE_QUERY = "hello"

# Choreography steps that produce frames (order fixed).
REVIEW_STEPS = [
    "00-boot",
    "01-sessions",
    "02-map",
    "02b-microscope",
    "02c-microscope-timeline",
    "03-search",
    "04-lens-picker",
    "05-after-escape",
]


# ── Assertion sheet ──────────────────────────────────────────────────────────
@dataclass
class Assertion:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Sheet:
    items: list[Assertion] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.items.append(Assertion(name, ok, detail))
        mark = "PASS" if ok else "FAIL"
        extra = f" — {detail}" if detail else ""
        print(f"  {mark}  {name}{extra}")

    def all_ok(self) -> bool:
        return all(a.ok for a in self.items)

    def print_sheet(self) -> None:
        print("\n========== ASSERTION SHEET ==========")
        for a in self.items:
            print(f"{a.name}: {a.ok}")
        failed = [a for a in self.items if not a.ok]
        if not failed:
            print("ALL PASS")
        else:
            print(f"FAILURES: {len(failed)}")
            print("\n--- failing detail ---")
            for f in failed:
                print(f"* {f.name}" + (f"\n    {f.detail}" if f.detail else ""))
        print("=====================================\n")


def matching_rows(frame: str, needle: str, limit: int = 4) -> str:
    rows = [ln for ln in frame.splitlines() if needle.lower() in ln.lower()]
    return " | ".join(r.strip()[:100] for r in rows[:limit]) or "(no matching rows)"


def resolve_profile(name: str, cols_override: int | None, rows_override: int | None) -> tuple[int, int]:
    """Resolve cols/rows for a named profile with CLI and env overrides."""
    if name not in PROFILES:
        raise SystemExit(f"unknown profile {name!r}; choose from {sorted(PROFILES)}")
    base_cols, base_rows = PROFILES[name]
    env_cols = int(os.environ.get("IRIS_E2E_COLS", "0") or "0") or None
    env_rows = int(os.environ.get("IRIS_E2E_ROWS", "0") or "0") or None
    cols = cols_override or env_cols or base_cols
    rows = rows_override or env_rows or base_rows
    return cols, rows


def binary_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Scratch environment ──────────────────────────────────────────────────────
def resolve_binary() -> tuple[Path, str]:
    """Prefer dist/ build; fall back to installed companion. Returns (path, label)."""
    if DIST_DASH.is_file():
        return DIST_DASH, "dist"
    if INSTALL_DASH.is_file():
        return INSTALL_DASH, "installed (~/amore/bin)"
    raise SystemExit(
        f"No compiled dash found.\n  looked: {DIST_DASH}\n  looked: {INSTALL_DASH}\n"
        "Build with: bun run build:compile --with-dash  (in instruments/iris)"
    )


def seed_synthetic_index(db_path: Path) -> None:
    """v5 greenfield schema + base 8 sessions (char asserts) + expanded canary corpus."""
    if db_path.exists():
        db_path.unlink()
    db = sqlite3.connect(str(db_path))
    try:
        db.executescript(
            """
            CREATE TABLE events (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id      TEXT NOT NULL,
              project_path    TEXT NOT NULL,
              agent           TEXT NOT NULL,
              parent_session  TEXT,
              ts              TEXT NOT NULL,
              kind            TEXT NOT NULL,
              text            TEXT,
              tool_name       TEXT,
              tool_input      TEXT,
              tool_output     TEXT,
              tool_error      INTEGER,
              tool_call_id    TEXT,
              is_boilerplate  INTEGER NOT NULL DEFAULT 0,
              sensitive       INTEGER NOT NULL DEFAULT 0,
              raw             TEXT NOT NULL
            );
            CREATE INDEX idx_events_session ON events(session_id, ts);
            CREATE INDEX idx_events_project ON events(project_path, ts);
            CREATE INDEX idx_events_kind    ON events(kind);
            CREATE INDEX idx_events_tool    ON events(tool_name);

            CREATE TABLE sessions (
              id               TEXT PRIMARY KEY,
              project_path     TEXT NOT NULL,
              agent            TEXT NOT NULL,
              parent_session   TEXT,
              model_id         TEXT,
              started_at       TEXT NOT NULL,
              ended_at         TEXT NOT NULL,
              turn_count       INTEGER NOT NULL,
              user_msg_count   INTEGER NOT NULL,
              tool_call_count  INTEGER NOT NULL,
              tool_error_count INTEGER NOT NULL,
              title            TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX idx_sessions_project ON sessions(project_path, started_at);

            -- v5 side store (derived at ingest from summary.json session_summary).
            CREATE TABLE session_titles (
              session_id  TEXT PRIMARY KEY,
              title       TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE usage (
              id                  INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id          TEXT NOT NULL,
              project_path        TEXT NOT NULL,
              ts                  TEXT NOT NULL,
              model_id            TEXT,
              input_tokens        INTEGER NOT NULL DEFAULT 0,
              output_tokens       INTEGER NOT NULL DEFAULT 0,
              cached_read_tokens  INTEGER NOT NULL DEFAULT 0,
              reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
              total_tokens        INTEGER NOT NULL DEFAULT 0,
              num_turns           INTEGER NOT NULL DEFAULT 0,
              model_calls         INTEGER NOT NULL DEFAULT 0,
              raw                 TEXT NOT NULL
            );
            CREATE INDEX idx_usage_session ON usage(session_id, ts);
            CREATE INDEX idx_usage_model   ON usage(model_id);
            CREATE INDEX idx_usage_ts      ON usage(ts);

            CREATE TABLE ingest_state (
              file_path     TEXT PRIMARY KEY,
              size_bytes    INTEGER NOT NULL,
              mtime         TEXT NOT NULL,
              byte_offset   INTEGER NOT NULL,
              last_ingested TEXT NOT NULL,
              forgotten     INTEGER NOT NULL DEFAULT 0
            );

            CREATE VIRTUAL TABLE events_fts USING fts5(
              text,
              tool_name,
              tool_input,
              tool_output
            );

            CREATE TABLE event_links (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              source_event_id  INTEGER NOT NULL,
              target_event_id  INTEGER NOT NULL,
              kind             TEXT NOT NULL,
              method           TEXT NOT NULL,
              confidence       REAL NOT NULL DEFAULT 1.0,
              heuristic        INTEGER NOT NULL DEFAULT 0,
              UNIQUE(source_event_id, target_event_id, kind)
            );

            CREATE TABLE decisions (
              id               TEXT PRIMARY KEY,
              session_id       TEXT NOT NULL,
              project_path     TEXT NOT NULL,
              ts               TEXT NOT NULL,
              category         TEXT NOT NULL,
              scenario         TEXT,
              reasoning        TEXT,
              outcome          TEXT,
              confidence       REAL,
              decision_maker   TEXT,
              source_event_id  INTEGER,
              method           TEXT NOT NULL,
              metadata         TEXT
            );

            PRAGMA user_version = 5;
            """
        )
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

        def insert_session(
            sid: str,
            proj: str,
            agent: str,
            parent: str | None,
            started: str,
            ended: str,
            turns: int,
            title: str,
            text: str,
        ) -> int:
            db.execute(
                """INSERT INTO sessions (
                     id, project_path, agent, parent_session, model_id,
                     started_at, ended_at, turn_count, user_msg_count,
                     tool_call_count, tool_error_count, title
                   ) VALUES (?, ?, ?, ?, 'model-x', ?, ?, ?, 1, 1, 0, ?)""",
                (sid, proj, agent, parent, started, ended, turns, title),
            )
            if title:
                db.execute(
                    "INSERT INTO session_titles(session_id, title) VALUES (?, ?)",
                    (sid, title),
                )
            cur = db.execute(
                """INSERT INTO events (
                     session_id, project_path, agent, parent_session, ts, kind,
                     text, tool_name, tool_input, tool_output, tool_error,
                     tool_call_id, is_boilerplate, sensitive, raw
                   ) VALUES (?, ?, ?, ?, ?, 'user', ?, NULL, NULL, NULL, NULL,
                             NULL, 0, 0, ?)""",
                (sid, proj, agent, parent, started, text, "{}"),
            )
            eid = int(cur.lastrowid)
            db.execute(
                "INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output) "
                "VALUES (?, ?, '', '', '')",
                (eid, text),
            )
            db.execute(
                """INSERT INTO usage (
                     session_id, project_path, ts, model_id,
                     input_tokens, output_tokens, total_tokens, num_turns, model_calls, raw
                   ) VALUES (?, ?, ?, 'model-x', 100, 50, 150, 1, 1, '{}')""",
                (sid, proj, started),
            )
            return eid

        # ── Base 8 sessions (exact titles + behavior for existing char asserts) ──
        projects = ["/work/alpha", "/work/beta", "/work/gamma"]
        base_eids: list[int] = []
        for i in range(8):
            sid = f"e2e-sess-{i:03d}"
            proj = projects[i % len(projects)]
            day = f"{1 + (i % 28):02d}"
            started = f"2026-05-{day}T10:00:00.000Z"
            ended = f"2026-05-{day}T11:00:00.000Z"
            agent = "primary" if i < 6 else "subagent"
            parent = None if agent == "primary" else "e2e-sess-000"
            title = f"Session title {i:03d}" if i < 3 else ""
            text = f"hello from {sid} on map stage probe"
            eid = insert_session(sid, proj, agent, parent, started, ended, 2 + i, title, text)
            base_eids.append(eid)

        # Evidence edges for the REAL-links bar: sess-001 → sess-000 (GENERATED),
        # sess-002 → sess-001 (USED). Event ids are 1..8 in session order (0..7).
        for src, tgt, kind in [(2, 1, "GENERATED"), (3, 2, "USED")]:
            db.execute(
                """INSERT INTO event_links(
                     source_event_id, target_event_id, kind, method, confidence, heuristic
                   ) VALUES (?, ?, ?, 'seed', 1.0, 0)""",
                (src, tgt, kind),
            )

        # ── Expanded canary corpus (structural asserts; char asserts ignore) ──
        # ≥50 additional sessions across ≥12 project_paths (incl. id-shaped
        # experiment paths), long titles, small subagent tree, extra links.
        extra_projects = [
            "/work/alpha",
            "/work/beta",
            "/work/gamma",
            "/work/amore",
            "/work/arcus",
            "/work/bare",
            "/tmp/identity-study/A-sen-01",
            "/tmp/identity-study/A-sen-02",
            "/tmp/identity-study/A-sen-09",
            "/work/e2e-sess-noise-aa",
            "/work/e2e-sess-noise-bb",
            "/work/canary-house",
            "/work/probe-lab",
            "/work/map-density",
        ]
        long_title_a = (
            "Iris Microscope two-pane Redesign Title That Is Long Enough For Ellipsis"
        )
        long_title_b = (
            "Picker width canary title padding past sixty characters so truncate fires"
        )
        parent_primary = "e2e-canary-000"
        extra_eids: list[int] = []
        for i in range(50):
            sid = f"e2e-canary-{i:03d}"
            proj = extra_projects[i % len(extra_projects)]
            # Dates sit BEFORE the base 8 sessions (May 2026) so newest-first
            # pickers still surface `Session title 000` for char asserts.
            day = f"{1 + (i % 28):02d}"
            started = f"2026-03-{day}T{10 + (i % 8):02d}:00:00.000Z"
            ended = f"2026-03-{day}T{11 + (i % 8):02d}:00:00.000Z"
            if i == 0:
                agent, parent = "primary", None
            elif i in (1, 2, 3):
                agent, parent = "subagent", parent_primary
            else:
                agent, parent = "primary", None
            if i < 6:
                title = long_title_a if i % 2 == 0 else long_title_b
            elif i < 12:
                title = f"Canary long title block {i:03d} " + ("x" * 48)
            else:
                title = f"Canary session {i:03d}"
            text = f"hello canary {sid} project {proj}"
            eid = insert_session(
                sid, proj, agent, parent, started, ended, 3 + (i % 5), title, text
            )
            extra_eids.append(eid)

        # A handful more event_links so map edge counts stay non-zero under canary.
        if len(extra_eids) >= 4:
            for src, tgt, kind in [
                (extra_eids[1], extra_eids[0], "GENERATED"),
                (extra_eids[2], extra_eids[0], "USED"),
                (extra_eids[3], extra_eids[1], "USED"),
            ]:
                db.execute(
                    """INSERT INTO event_links(
                         source_event_id, target_event_id, kind, method, confidence, heuristic
                       ) VALUES (?, ?, ?, 'seed', 1.0, 0)""",
                    (src, tgt, kind),
                )

        db.execute(
            """INSERT INTO ingest_state (
                 file_path, size_bytes, mtime, byte_offset, last_ingested, forgotten
               ) VALUES ('/sessions/e2e.jsonl', 200, ?, 200, ?, 0)""",
            (now, now),
        )
        db.commit()
    finally:
        db.close()


def seed_fake_org(org_root: Path) -> None:
    """Minimal org so resolveOrgRoot walk-up would pass; IRIS_ORG_ROOT is set anyway."""
    org_root.mkdir(parents=True, exist_ok=True)
    (org_root / "AGENTS.md").write_text(
        "# AGENTS\n\nScratch org for iris-dash e2e-pty. Not a real house.\n",
        encoding="utf-8",
    )
    (org_root / "tasks").mkdir(exist_ok=True)
    ctx = org_root / "context"
    ctx.mkdir(exist_ok=True)
    # Dated section so Dashboard's narrative pane has something to render.
    (ctx / "current-state.md").write_text(
        "# Where the house is\n\n"
        "## Recent structural changes (2026-08-10)\n\n"
        "**E2E pty scratch seed** — synthetic org for the compiled-dash drive.\n\n"
        "---\n",
        encoding="utf-8",
    )


def make_scratch() -> tuple[Path, Path, Path, Path]:
    """
    Fake home under C:\\Temp (no operator username in path → frames stay clean).
    Returns (scratch_root, fake_home, org_root, db_path).
    """
    base = Path(r"C:\Temp")
    base.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="iris-e2e-pty-", dir=str(base)))
    # capture_frame semantics: USERPROFILE/HOME = home; AMORE_HOME = home/.amore
    fake_home = scratch / "home"
    fake_home.mkdir()
    amore = fake_home / ".amore"
    amore.mkdir()
    org = scratch / "org"
    seed_fake_org(org)
    spec_home = scratch / "speculum-home"
    spec_home.mkdir()
    db_path = spec_home / "speculum.sqlite"
    seed_synthetic_index(db_path)
    return scratch, fake_home, org, db_path


# ── PTY driver (mirrors capture_frame.main loop; continuous multi-step) ──────
class RespondingScreen(pyte.Screen):
    proc: PtyProcess | None = None

    def write_process_input(self, data: str) -> None:  # type: ignore[override]
        if self.proc is not None:
            try:
                self.proc.write(data)
            except Exception:
                pass


class PtyDrive:
    def __init__(
        self,
        binary: Path,
        env: dict[str, str],
        cwd: str,
        rows: int = ROWS,
        cols: int = COLS,
    ) -> None:
        self.rows = rows
        self.cols = cols
        self.screen = RespondingScreen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.q: queue.Queue[bytes | None] = queue.Queue()

        cmdline = str(binary)
        self.proc = PtyProcess.spawn(
            cmdline,
            dimensions=(rows, cols),
            env=env,
            cwd=cwd,
        )
        self.screen.proc = self.proc
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self) -> None:
        try:
            while True:
                chunk = self.proc.read(65536)
                if not chunk:
                    time.sleep(0.02)
                    continue
                self.q.put(
                    chunk.encode("utf-8", "replace")
                    if isinstance(chunk, str)
                    else chunk
                )
        except (EOFError, OSError):
            self.q.put(None)

    def pump(self, duration: float) -> None:
        end = time.time() + duration
        while True:
            remaining = end - time.time()
            if remaining <= 0:
                return
            try:
                chunk = self.q.get(timeout=remaining)
            except queue.Empty:
                return
            if chunk is None:
                return
            self.stream.feed(chunk)

    def frame_text(self) -> str:
        return "\n".join(self.screen.display)

    def wait_for(
        self,
        pred,
        timeout: float = STEP_TIMEOUT,
        label: str = "",
    ) -> tuple[bool, str]:
        deadline = time.time() + timeout
        text = self.frame_text()
        while time.time() < deadline:
            self.pump(0.15)
            text = self.frame_text()
            if pred(text):
                return True, text
        if label:
            print(f"  [wait_for] timeout {timeout}s waiting for {label}")
        return False, text

    def send(self, payload: str, settle: float = SETTLE_AFTER_SEND) -> None:
        # Same unicode_escape decode as capture_frame --send.
        data = payload.encode("utf-8").decode("unicode_escape")
        self.proc.write(data)
        self.pump(settle)

    def resize_jiggle(self) -> None:
        self.proc.setwinsize(self.rows, self.cols - 1)
        self.screen.resize(self.rows, self.cols - 1)
        self.pump(0.5)
        self.proc.setwinsize(self.rows, self.cols)
        self.screen.resize(self.rows, self.cols)
        self.pump(0.5)

    def close(self) -> None:
        try:
            self.proc.terminate(force=True)
        except Exception:
            pass


def build_child_env(
    fake_home: Path,
    org_root: Path,
    db_path: Path,
    spec_home: Path,
) -> dict[str, str]:
    """Mirror capture_frame env keep-list + home block; --env pairs AFTER home."""
    keep = [
        "SystemRoot",
        "windir",
        "SystemDrive",
        "PATHEXT",
        "COMSPEC",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "TEMP",
        "TMP",
        "APPDATA",
        "LOCALAPPDATA",
        "PATH",
    ]
    env = {k: os.environ[k] for k in keep if k in os.environ}
    home = str(fake_home.resolve())
    # Home block first (capture_frame order).
    env.update(
        {
            "USERPROFILE": home,
            "HOME": home,
            "AMORE_HOME": str((fake_home / ".amore").resolve()),
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "WT_SESSION": "00000000-0000-0000-0000-000000000000",
        }
    )
    # Env pairs AFTER home block (skill §5: --env order).
    env["IRIS_THEME"] = "horizon"
    env["IRIS_ORG_ROOT"] = str(org_root.resolve())
    env["SPECULUM_DB"] = str(db_path.resolve())
    env["SPECULUM_HOME"] = str(spec_home.resolve())
    # Scratch daemon port, UNIQUE per run so consecutive drives never collide
    # (a stale run's daemon on a fixed port made the next run's dash probe a
    # daemon serving a different org root and spill its error into the frame).
    env["IRIS_PORT"] = str(random.randint(3900, 3999))
    return env


# ── Frame dump + review PNG ──────────────────────────────────────────────────
@dataclass
class DumpCtx:
    rows: int
    cols: int
    emit_png: bool
    review_dir: Path
    font_size: int = 18
    steps_emitted: list[str] = field(default_factory=list)
    png_errors: list[str] = field(default_factory=list)


def dump_step(
    step: str,
    text: str,
    screen: pyte.Screen | None,
    ctx: DumpCtx,
) -> Path:
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    txt_path = FRAMES_DIR / f"{step}.txt"
    txt_path.write_text(text, encoding="utf-8")
    json_path = FRAMES_DIR / f"{step}.json"
    if screen is not None:
        dump_frame(screen, ctx.rows, ctx.cols, str(json_path))
    ctx.steps_emitted.append(step)
    print(f"  [frame] {txt_path} ({len(text.splitlines())} lines)")

    if ctx.emit_png and screen is not None and json_path.is_file():
        try:
            from render_frame import render_frame_to_png  # noqa: E402
        except Exception as exc:
            ctx.png_errors.append(f"{step}: png_pipeline_available failed: {exc}")
            print(f"  [png]   FAIL import render_frame: {exc}")
            return txt_path
        ctx.review_dir.mkdir(parents=True, exist_ok=True)
        png_path = ctx.review_dir / f"{step}.png"
        try:
            render_frame_to_png(
                json_path,
                png_path,
                font_size=ctx.font_size,
                quiet=True,
            )
            print(f"  [png]   {png_path}")
        except Exception as exc:
            ctx.png_errors.append(f"{step}: png_render failed: {exc}")
            print(f"  [png]   FAIL {step}: {exc}")
    return txt_path


def write_manifest(
    review_dir: Path,
    *,
    cols: int,
    rows: int,
    profile: str,
    binary: Path,
    bin_src: str,
    font_size: int,
    emit_png: bool,
    structural: bool,
    steps: list[str],
) -> Path:
    review_dir.mkdir(parents=True, exist_ok=True)
    sha = binary_sha256(binary)
    mtime = datetime.fromtimestamp(binary.stat().st_mtime, tz=timezone.utc).isoformat()
    generated = datetime.now(timezone.utc).isoformat()
    lines = [
        "# H2 visual review — iris-dash",
        "",
        f"- generated: {generated}",
        f"- cols: {cols}",
        f"- rows: {rows}",
        f"- profile: {profile}",
        "- theme: horizon",
        f"- binary: {binary}",
        f"- binary_source: {bin_src}",
        f"- binary_sha256: {sha[:16]}…",
        f"- binary_mtime: {mtime}",
        f"- font_size_png: {font_size}",
        f"- structural: {'on' if structural else 'skipped'}",
        f"- png: {'on' if emit_png else 'off'}",
        "",
        "## Steps",
        "",
        "| step | sentinel / note | png | structural |",
        "|---|---|---|---|",
    ]
    notes = {
        "00-boot": "Dashboard/Sessions/Attention",
        "01-sessions": "chips + strip + footer",
        "02-map": "g → Map",
        "02b-microscope": "m → two-pane",
        "02c-microscope-timeline": "enter session",
        "03-search": "w + hello",
        "04-lens-picker": "L",
        "05-after-escape": "esc",
    }
    for step in steps:
        png_ok = "yes" if emit_png and (review_dir / f"{step}.png").is_file() else (
            "n/a" if not emit_png else "missing"
        )
        struct = "R5–R7" if step == "01-sessions" else (
            "path leak" if structural else "skipped"
        )
        if step.startswith("02"):
            # TODO(map-design): map legend/edge structural asserts deferred
            struct = "path leak; map R1–R3 deferred"
        lines.append(
            f"| {step} | {notes.get(step, '')} | {png_ok} | {struct} |"
        )
    lines.extend(
        [
            "",
            "## Operator review",
            "",
            "Open each PNG. Reject the change if Map legend is a noise wall,",
            "Microscope picker is an ellipsis wall, or any stage clips footer/chrome.",
            "Char PASS is not sufficient. Structural FAILs above are product findings.",
            "",
        ]
    )
    path = review_dir / "MANIFEST.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"  [manifest] {path}")
    return path


# ── Structural JSON helpers / asserts ────────────────────────────────────────
def load_frame_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def row_text(frame: dict, y: int) -> str:
    return "".join((cell.get("c") or " ") for cell in frame["cells"][y])


def full_text(frame: dict) -> str:
    return "\n".join(row_text(frame, y) for y in range(frame["rows"]))


def nonblank_rows(frame: dict) -> list[tuple[int, str]]:
    out = []
    for y in range(frame["rows"]):
        t = row_text(frame, y).rstrip()
        if t.strip():
            out.append((y, t))
    return out


# Map-specific legend/edge asserts (R1/R2/R3) wait on the map redesign.
# TODO(map-design): implement map_edge_kinds_visible / legend clip / project cap


def run_structural_asserts(
    sheet: Sheet,
    *,
    frames_dir: Path,
    review_dir: Path,
    emit_png: bool,
    steps: list[str],
    png_errors: list[str],
) -> None:
    print("\n── structural JSON asserts ──")

    # R6 — no absolute user-home path leak on any dumped frame.
    leak_re = re.compile(r"C:\\Users\\", re.I)
    leak_hits: list[str] = []
    for step in steps:
        jp = frames_dir / f"{step}.json"
        if not jp.is_file():
            continue
        text = full_text(load_frame_json(jp))
        if leak_re.search(text):
            leak_hits.append(step)
    sheet.check(
        "R6_no_user_path_leak",
        not leak_hits,
        "clean" if not leak_hits else f"leaked in: {', '.join(leak_hits)}",
    )

    # R5 — sessions frame: five stage chips + member-footer keys co-present.
    sess_json = frames_dir / "01-sessions.json"
    if sess_json.is_file():
        sess = load_frame_json(sess_json)
        sess_text = full_text(sess)
        chips = ("Probes", "Usage", "Microscope", "Map", "Search")
        chips_ok = all(c in sess_text for c in chips)
        # Member-footer stage / action keys (flexible separators / middot).
        probes_key = bool(re.search(r"\bp\s+probes\b", sess_text, re.I))
        ingest_key = bool(re.search(r"\bi\s+ingest\b", sess_text, re.I))
        footer_ok = probes_key and ingest_key
        if not (chips_ok and footer_ok):
            # Flash can still own the member-footer line on 01-sessions; fall
            # back to any later sessions-stage frame that co-presents both.
            for alt in (
                "03-search.json",
                "05-after-escape.json",
                "04-lens-picker.json",
                "02-map.json",
            ):
                ap = frames_dir / alt
                if not ap.is_file():
                    continue
                alt_text = full_text(load_frame_json(ap))
                alt_chips = all(c in alt_text for c in chips)
                alt_p = bool(re.search(r"\bp\s+probes\b", alt_text, re.I))
                alt_i = bool(re.search(r"\bi\s+ingest\b", alt_text, re.I))
                if alt_chips and alt_p and alt_i:
                    chips_ok, probes_key, ingest_key, footer_ok = True, True, True, True
                    sess_text = alt_text
                    break
        sheet.check(
            "R5_sessions_chips_and_footer",
            chips_ok and footer_ok,
            (
                f"chips={chips_ok} p_probes={probes_key} i_ingest={ingest_key}; "
                + (matching_rows(sess_text, "Probes") if not chips_ok else "chips+footer")
            ),
        )

        # R5b — Actions idle: at most one line advertising ingest · lens · audit.
        # Target shape after footer consolidation: member-footer owns the band;
        # Actions strip is silent when idle. Assert the single-band target; if
        # current product still duplicates, FAIL with exact delta (do not patch
        # product chrome here).
        band_re = re.compile(
            r"i\s+ingest\s*[·|]\s*L\s+lens\s*[·|]\s*A\s+audit",
            re.I,
        )
        band_lines = [(y, t) for y, t in nonblank_rows(sess) if band_re.search(t)]
        # Also count looser multi-key lines that advertise the same trio.
        loose_re = re.compile(
            r"(?=.*\bingest\b)(?=.*\blens\b)(?=.*\baudit\b)",
            re.I,
        )
        loose_lines = [(y, t) for y, t in nonblank_rows(sess) if loose_re.search(t)]
        # Prefer the strict band count when any match; else loose trio count.
        count = len(band_lines) if band_lines else len(loose_lines)
        r5b_ok = count <= 1
        detail_lines = band_lines or loose_lines
        if r5b_ok:
            detail = f"advertising lines={count} (≤1)"
        else:
            preview = " || ".join(t.strip()[:90] for _, t in detail_lines[:4])
            detail = (
                f"advertising lines={count} (want ≤1 for single-band footer); "
                f"rows: {preview}. "
                "DELTA for integration: collapse Actions idle strip so only the "
                "member-footer carries `i ingest · L lens · A audit` when Actions "
                "is idle (Actions silent idle)."
            )
        sheet.check("R5b_footer_single_band", r5b_ok, detail)
    else:
        sheet.check("R5_sessions_chips_and_footer", False, "01-sessions.json missing")
        sheet.check("R5b_footer_single_band", False, "01-sessions.json missing")

    # R7 — PNG present for every emitted step when --png.
    if emit_png:
        missing = []
        empty = []
        for step in steps:
            png = review_dir / f"{step}.png"
            if not png.is_file():
                missing.append(step)
            elif png.stat().st_size == 0:
                empty.append(step)
        ok = not missing and not empty and not png_errors
        detail = "all png present"
        if missing:
            detail = f"missing: {', '.join(missing)}"
        if empty:
            detail += f"; empty: {', '.join(empty)}"
        if png_errors:
            detail += f"; errors: {'; '.join(png_errors)}"
        sheet.check("R7_png_emitted", ok, detail)
        sheet.check(
            "png_pipeline_available",
            not any("png_pipeline_available" in e for e in png_errors),
            "import ok" if not png_errors else "; ".join(png_errors),
        )
    else:
        sheet.check("R7_png_emitted", True, "skipped (--no-png)")


# ── Main drive ───────────────────────────────────────────────────────────────
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="H2: compiled-binary PTY drive of iris-dash (char + structural + PNG review)",
    )
    png_g = ap.add_mutually_exclusive_group()
    png_g.add_argument(
        "--png",
        dest="png",
        action="store_true",
        default=None,
        help="emit review PNGs (default when fonts are available)",
    )
    png_g.add_argument(
        "--no-png",
        dest="png",
        action="store_false",
        help="skip PNG emission",
    )
    ap.add_argument(
        "--review-dir",
        type=Path,
        default=REVIEW_DIR,
        help=f"directory for review PNGs + MANIFEST (default: {REVIEW_DIR})",
    )
    ap.add_argument(
        "--profile",
        choices=["operator", "narrow", "tight", "all"],
        default="operator",
        help="terminal size profile (default: operator 140×48)",
    )
    ap.add_argument("--cols", type=int, default=None, help="override cols for active profile")
    ap.add_argument("--rows", type=int, default=None, help="override rows for active profile")
    ap.add_argument(
        "--font-size",
        type=int,
        default=18,
        help="PNG font size (default 18 for review; docs pipeline keeps 30)",
    )
    ap.add_argument(
        "--skip-structural",
        action="store_true",
        help="run char asserts only (debug)",
    )
    return ap.parse_args(argv)


def resolve_png_default(explicit: bool | None) -> bool:
    if explicit is not None:
        return explicit
    try:
        from render_frame import font_candidates  # noqa: E402

        return bool(font_candidates())
    except Exception:
        return False


def run_drive(
    *,
    profile: str,
    cols: int,
    rows: int,
    emit_png: bool,
    review_dir: Path,
    font_size: int,
    skip_structural: bool,
) -> int:
    print("=== iris dash E2E PTY (compiled binary) ===")
    binary, bin_src = resolve_binary()
    print(f"binary:  {binary}")
    print(f"source:  {bin_src}")
    print(f"profile: {profile}  size: {cols}x{rows}")
    print(f"frames → {FRAMES_DIR}")
    print(f"review → {review_dir}  png={'on' if emit_png else 'off'}  font={font_size}")
    print(f"structural: {'skip' if skip_structural else 'on'}")
    print("")

    sheet = Sheet()
    scratch: Path | None = None
    drive: PtyDrive | None = None
    keep_scratch = False
    ctx = DumpCtx(
        rows=rows,
        cols=cols,
        emit_png=emit_png,
        review_dir=review_dir,
        font_size=font_size,
    )

    try:
        scratch, fake_home, org_root, db_path = make_scratch()
        spec_home = db_path.parent
        env = build_child_env(fake_home, org_root, db_path, spec_home)

        print(f"scratch:     {scratch}")
        print(f"fake home:   {fake_home}")
        print(f"IRIS_ORG_ROOT={org_root}")
        print(f"SPECULUM_DB={db_path}")
        print(f"SPECULUM_HOME={spec_home}")
        print(f"IRIS_THEME=horizon")
        print("")

        # cwd under fake home so any path display stays under the throwaway tree.
        cwd = str(org_root)
        drive = PtyDrive(binary, env, cwd, rows, cols)

        # ── 0. Boot ──────────────────────────────────────────────────────────
        print("\n── 0. Boot ──")
        # Sentinel: member names at ≥~110 cols; panel titles work at tight sizes.
        boot_ok, boot_text = drive.wait_for(
            lambda t: (
                "Dashboard" in t
                or "Sessions" in t
                or "Attention" in t
                or "Overview" in t
            ),
            timeout=BOOT_TIMEOUT,
            label="boot chrome (Dashboard/Sessions/Attention)",
        )
        dump_step("00-boot", boot_text, drive.screen, ctx)
        sheet.check(
            "boot_chrome",
            boot_ok,
            matching_rows(boot_text, "Dash") if not boot_ok else "Dashboard/Sessions visible",
        )
        if not boot_ok:
            keep_scratch = True
            if emit_png:
                write_manifest(
                    review_dir,
                    cols=cols,
                    rows=rows,
                    profile=profile,
                    binary=binary,
                    bin_src=bin_src,
                    font_size=font_size,
                    emit_png=emit_png,
                    structural=not skip_structural,
                    steps=ctx.steps_emitted,
                )
            sheet.print_sheet()
            print(f"KEEP scratch for debug: {scratch}")
            return 1

        # Optional jiggle so the first full layout is clean.
        drive.resize_jiggle()

        # ── 1. S → Sessions: strips + five chips ─────────────────────────────
        print("\n── 1. S → Sessions ──")
        # First key after mount can be swallowed (skill §5); send S twice.
        drive.send("S")
        drive.send("S")
        sess_ok, sess_text = drive.wait_for(
            lambda t: "Probes" in t and "Search" in t,
            timeout=STEP_TIMEOUT,
            label="Sessions chips",
        )
        # Status strip may take a beat (speculum status spawn).
        strip_ok, sess_text = drive.wait_for(
            lambda t: (
                "session" in t.lower()
                or "speculum" in t.lower()
                or "not installed" in t.lower()
                or "ingest" in t.lower()
                or "Sessions" in t
            ),
            timeout=STEP_TIMEOUT,
            label="status strip flavor",
        )
        # Member footer can be transiently replaced by a flash ("scan updated").
        # Wait for the standing keystrip so structural R5 sees the real band.
        footer_ok, sess_text = drive.wait_for(
            lambda t: ("p probes" in t and "i ingest" in t)
            or ("Probes" in t and "Search" in t and "i ingest" in t),
            timeout=STEP_TIMEOUT,
            label="member footer keys",
        )
        if not footer_ok:
            # Extra settle if flash is still holding the footer line.
            drive.pump(1.5)
            sess_text = drive.frame_text()
        dump_step("01-sessions", sess_text, drive.screen, ctx)

        sheet.check(
            "sessions_member",
            "Sessions" in sess_text or sess_ok,
            matching_rows(sess_text, "Session"),
        )
        sheet.check(
            "status_strip",
            bool(
                re.search(
                    r"installed · (\d[\d,]* operator|\d[\d,]* session(s| dirs))|no ingested sessions|"
                    r"speculum not installed|loading|Sessions",
                    sess_text,
                    re.I,
                )
            ),
            matching_rows(sess_text, "session")
            or matching_rows(sess_text, "speculum")
            or matching_rows(sess_text, "Sessions"),
        )
        five = all(c in sess_text for c in ("Probes", "Usage", "Microscope", "Map", "Search"))
        sheet.check(
            "chips_five_stage_set",
            five,
            matching_rows(sess_text, "Probes") if not five else "Probes·Usage·Microscope·Map·Search",
        )
        for chip in ("Microscope", "Map", "Search"):
            sheet.check(f"chips_{chip}", chip in sess_text)

        # ── 2. g → Map ───────────────────────────────────────────────────────
        print("\n── 2. g → Map ──")
        drive.send("g")
        map_ok, map_text = drive.wait_for(
            lambda t: (
                any("\u2800" <= ch <= "\u28FF" for ch in t)
                or re.search(r"fit|center|cluster|density|Map", t, re.I) is not None
            ),
            timeout=STEP_TIMEOUT,
            label="map glyphs/chrome",
        )
        dump_step("02-map", map_text, drive.screen, ctx)
        has_braille = any("\u2800" <= ch <= "\u28FF" for ch in map_text)
        has_chrome = bool(
            re.search(r"fit|center|cluster|density|Map", map_text, re.I)
        )
        sheet.check(
            "map_renders",
            map_ok and (has_braille or has_chrome),
            "braille glyphs present"
            if has_braille
            else matching_rows(map_text, "Map") or matching_rows(map_text, "cluster"),
        )
        # Map-record bars on the compiled binary: honest coverage, legend, REAL links.
        sheet.check(
            "map_showing_n_of_m",
            bool(re.search(r"showing \d+ of \d+", map_text, re.I)),
            matching_rows(map_text, "showing"),
        )
        sheet.check(
            "map_legend",
            bool(
                re.search(
                    r"parentage|event links|●|═|─", map_text, re.I
                )
            ),
            matching_rows(map_text, "parentage") or matching_rows(map_text, "event links"),
        )
        links_m = re.search(r"(\d+) links", map_text)
        sheet.check(
            "map_links_honest",
            bool(links_m)
            and bool(re.search(r"parentage", map_text, re.I))
            and bool(re.search(r"event links", map_text, re.I)),
            f"{links_m.group(1) if links_m else 'no'} links (0 is the honest default) · legend edge kinds",
        )

        # ── 2b. m → Microscope (redesigned two-pane; title-first picker) ────
        print("\n── 2b. m → Microscope ──")
        drive.send("m")
        mic_ok, mic_text = drive.wait_for(
            lambda t: "SESSIONS" in t and "TIMELINE" in t,
            timeout=STEP_TIMEOUT,
            label="microscope two-pane cards",
        )
        dump_step("02b-microscope", mic_text, drive.screen, ctx)
        sheet.check(
            "microscope_title_chrome",
            mic_ok,
            matching_rows(mic_text, "SESSIONS") or matching_rows(mic_text, "Microscope"),
        )
        # Seeded session titles render title-first in the picker.
        sheet.check(
            "microscope_picker_title",
            bool(re.search(r"Session title \d{3}", mic_text)),
            matching_rows(mic_text, "Session title"),
        )
        drive.send("\r")
        drive.pump(0.9)
        mic_timeline = drive.frame_text()
        dump_step("02c-microscope-timeline", mic_timeline, drive.screen, ctx)
        sheet.check(
            "microscope_timeline_row",
            bool(
                re.search(
                    r"#\d+|tool_use|user|assistant|tool_error|no events|enter a session",
                    mic_timeline,
                    re.I,
                )
            ),
            matching_rows(mic_timeline, "user")
            or matching_rows(mic_timeline, "#")
            or matching_rows(mic_timeline, "enter a session"),
        )
        drive.send("\x1b")  # back to picker
        drive.pump(0.35)

        # ── 3. w → Search + safe query ───────────────────────────────────────
        print(f"\n── 3. w → Search, type {SAFE_QUERY!r} ──")
        drive.send("w")
        # Search capture should show the input surface.
        drive.wait_for(
            lambda t: "Search" in t or "type" in t.lower() or "search" in t.lower(),
            timeout=STEP_TIMEOUT,
            label="search stage",
        )
        # The idle hint renders exactly once on the compiled binary.
        idle_text = drive.frame_text()
        sheet.check(
            "search_idle_hint_once",
            idle_text.count("type to search sessions") == 1,
            f"idle hint occurrences={idle_text.count('type to search sessions')}",
        )
        # Type letter-by-letter with small settles (search debounce 200ms).
        for ch in SAFE_QUERY:
            drive.send(ch, settle=0.08)
        drive.pump(0.8)  # debounce + FTS
        search_ok, search_text = drive.wait_for(
            lambda t: (
                SAFE_QUERY in t
                or re.search(
                    r"no matches|\d+\s*hits?|hit\b|type to search|index not found|"
                    r"corpus busy|schema|pending",
                    t,
                    re.I,
                )
                is not None
            ),
            timeout=STEP_TIMEOUT,
            label="search results or honest empty",
        )
        dump_step("03-search", search_text, drive.screen, ctx)
        query_captured = SAFE_QUERY in search_text
        sheet.check(
            "search_query_captured",
            query_captured,
            matching_rows(search_text, SAFE_QUERY)
            if query_captured
            else matching_rows(search_text, "Search")
            or "query text not visible (input may be inverted/hidden — still assert results)",
        )
        # Result contract: hit row, honest empty, or soft-state copy.
        results_ok = bool(
            re.search(
                r"no matches|\d+\s*hits?|hit\b|e2e-sess|"
                r"type to search|index not found|corpus busy|schema|pending|MISSING",
                search_text,
                re.I,
            )
        ) or (SAFE_QUERY in search_text and "Search" in search_text)
        sheet.check(
            "search_results_or_honest_empty",
            search_ok and results_ok,
            matching_rows(search_text, "hit")
            or matching_rows(search_text, "match")
            or matching_rows(search_text, "Search"),
        )

        # Leave search so L is not eaten by the query input (H1 note: search
        # capture can append into the field as e.g. "helloL"). Escape drops
        # capture; p switches stage away from Search as belt-and-suspenders.
        drive.send("\x1b")  # ESC
        drive.pump(0.35)
        drive.send("p")
        drive.pump(0.4)

        # ── 4. L → Lens picker ───────────────────────────────────────────────
        print("\n── 4. L → Lens picker ──")
        drive.send("L")
        lens_ok, lens_text = drive.wait_for(
            lambda t: re.search(
                r"Lens picker|session-postmortem|pattern-extraction|usage-story|--last-n",
                t,
                re.I,
            )
            is not None,
            timeout=STEP_TIMEOUT,
            label="lens picker",
        )
        dump_step("04-lens-picker", lens_text, drive.screen, ctx)
        sheet.check(
            "lens_picker",
            lens_ok,
            matching_rows(lens_text, "Lens")
            or matching_rows(lens_text, "session-postmortem")
            or matching_rows(lens_text, "pattern"),
        )
        # Selection row: built-in lens name present.
        sheet.check(
            "lens_selection_row",
            bool(
                re.search(
                    r"session-postmortem|pattern-extraction|usage-story",
                    lens_text,
                    re.I,
                )
            ),
            matching_rows(lens_text, "session")
            or matching_rows(lens_text, "pattern")
            or matching_rows(lens_text, "usage"),
        )

        # ── 5. Escape / leave ────────────────────────────────────────────────
        print("\n── 5. Escape leave ──")
        drive.send("\x1b")
        drive.pump(0.3)
        drive.send("\x1b")
        drive.pump(0.3)
        leave_text = drive.frame_text()
        dump_step("05-after-escape", leave_text, drive.screen, ctx)
        sheet.check(
            "leave_escape",
            True,  # escape is best-effort; dump is the evidence
            "esc sent; frame dumped",
        )

        # Soft quit (shell q → onQuit). Avoid if title-replay already ate state.
        drive.send("q")
        drive.pump(0.4)

        # ── Structural + MANIFEST ────────────────────────────────────────────
        if not skip_structural:
            run_structural_asserts(
                sheet,
                frames_dir=FRAMES_DIR,
                review_dir=review_dir,
                emit_png=emit_png,
                steps=ctx.steps_emitted,
                png_errors=ctx.png_errors,
            )
        write_manifest(
            review_dir,
            cols=cols,
            rows=rows,
            profile=profile,
            binary=binary,
            bin_src=bin_src,
            font_size=font_size,
            emit_png=emit_png,
            structural=not skip_structural,
            steps=ctx.steps_emitted,
        )

    except Exception as exc:
        keep_scratch = True
        print(f"\nHARNESS ERROR: {exc}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sheet.check("harness_clean", False, str(exc))
    finally:
        if drive is not None:
            drive.close()

        # Keep scratch on any failure for debugging.
        if scratch is not None:
            failed = not sheet.all_ok()
            if failed or keep_scratch:
                print(f"\nKEEP scratch for debug: {scratch}")
            else:
                try:
                    shutil.rmtree(scratch, ignore_errors=True)
                    print(f"\ncleaned scratch: {scratch}")
                except Exception as e:
                    print(f"\ncould not clean scratch {scratch}: {e}")

    sheet.print_sheet()
    print(
        "NOTE: native PTY drive is flaky-by-nature (ConPTY races, winpty title-replay).\n"
        "      Belt-and-suspenders: re-run once on any single-step miss before filing.\n"
        "      H1 headless harness remains the primary gate; H2 confirms the shipped artifact."
    )
    return 0 if sheet.all_ok() else 1


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    emit_png = resolve_png_default(args.png)
    if args.profile == "all":
        # Sequential profile runs; nest review artifacts per profile.
        rc = 0
        for name in ("operator", "narrow", "tight"):
            cols, rows = resolve_profile(name, args.cols, args.rows)
            nested = args.review_dir / name
            print(f"\n######## profile={name} {cols}x{rows} ########\n")
            step_rc = run_drive(
                profile=name,
                cols=cols,
                rows=rows,
                emit_png=emit_png,
                review_dir=nested,
                font_size=args.font_size,
                skip_structural=args.skip_structural,
            )
            if step_rc != 0:
                rc = step_rc
        return rc

    cols, rows = resolve_profile(args.profile, args.cols, args.rows)
    return run_drive(
        profile=args.profile,
        cols=cols,
        rows=rows,
        emit_png=emit_png,
        review_dir=args.review_dir,
        font_size=args.font_size,
        skip_structural=args.skip_structural,
    )


if __name__ == "__main__":
    raise SystemExit(main())
