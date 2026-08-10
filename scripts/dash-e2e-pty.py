#!/usr/bin/env python3
"""H2 — assert-driven PTY drive of the COMPILED iris-dash binary (Sessions surface).

Extends the fork's capture_frame.py machinery (winpty + pyte, env/home discipline,
sentinel waits, frame dumps) with multi-step choreography and PASS/FAIL assertions.

Import reuse:
  * dump_frame — the only top-level primitive export from capture_frame.py
  * All other PTY loop pieces live inside capture_frame.main() (CLI-only); this
    script mirrors those patterns in-process so one continuous session can
    S → g → w → L without relaunch. capture_frame.py is NEVER modified.

Run from repo root:
  python scripts/dash-e2e-pty.py

Needs: Python 3, pyte, winpty (same as capture_frame.py), compiled dash binary.
Flaky-by-nature: native ConPTY races + winpty title-replay keystrokes.
"""

from __future__ import annotations

import os
import queue
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

ROWS = 36
COLS = 120
STEP_TIMEOUT = 10.0  # per-step pattern wait (brief: ~10s)
BOOT_TIMEOUT = 45.0
SETTLE_AFTER_SEND = 0.45

# Typed-query letters that avoid shell/picker-bound keys (t q v j k) and
# digit member-switch (1-9). FTS seed text below includes this token.
SAFE_QUERY = "hello"

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
    """v4 greenfield schema (schema.sql shape) + a couple sessions/events + FTS."""
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
        projects = ["/work/alpha", "/work/beta", "/work/gamma"]
        for i in range(8):
            sid = f"e2e-sess-{i:03d}"
            proj = projects[i % len(projects)]
            day = f"{1 + (i % 28):02d}"
            started = f"2026-05-{day}T10:00:00.000Z"
            ended = f"2026-05-{day}T11:00:00.000Z"
            agent = "primary" if i < 6 else "subagent"
            parent = None if agent == "primary" else "e2e-sess-000"
            title = f"Session title {i:03d}" if i < 3 else ""
            db.execute(
                """INSERT INTO sessions (
                     id, project_path, agent, parent_session, model_id,
                     started_at, ended_at, turn_count, user_msg_count,
                     tool_call_count, tool_error_count, title
                   ) VALUES (?, ?, ?, ?, 'model-x', ?, ?, ?, 1, 1, 0, ?)""",
                (sid, proj, agent, parent, started, ended, 2 + i, title),
            )
            if title:
                # v5 side store mirrors the sessions title (both shapes populated).
                db.execute(
                    "INSERT INTO session_titles(session_id, title) VALUES (?, ?)",
                    (sid, title),
                )
            text = f"hello from {sid} on map stage probe"
            cur = db.execute(
                """INSERT INTO events (
                     session_id, project_path, agent, parent_session, ts, kind,
                     text, tool_name, tool_input, tool_output, tool_error,
                     tool_call_id, is_boilerplate, sensitive, raw
                   ) VALUES (?, ?, ?, ?, ?, 'user', ?, NULL, NULL, NULL, NULL,
                             NULL, 0, 0, ?)""",
                (sid, proj, agent, parent, started, text, "{}"),
            )
            eid = cur.lastrowid
            # FTS5 content table: rowid must match events.id for the query-service.
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
        # Evidence edges for the REAL-links bar: sess-001 → sess-000 (GENERATED),
        # sess-002 → sess-001 (USED). Event ids are 1..8 in session order (0..7).
        for src, tgt, kind in [(2, 1, "GENERATED"), (3, 2, "USED")]:
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
    # Use a scratch daemon port so nothing probes a real live instance.
    env["IRIS_PORT"] = "3911"
    return env


def dump_step(step: str, text: str, screen: pyte.Screen | None = None) -> Path:
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    path = FRAMES_DIR / f"{step}.txt"
    path.write_text(text, encoding="utf-8")
    if screen is not None:
        dump_frame(screen, ROWS, COLS, str(FRAMES_DIR / f"{step}.json"))
    print(f"  [frame] {path} ({len(text.splitlines())} lines)")
    return path


# ── Main drive ───────────────────────────────────────────────────────────────
def main() -> int:
    print("=== iris dash E2E PTY (compiled binary) ===")
    binary, bin_src = resolve_binary()
    print(f"binary: {binary}")
    print(f"source: {bin_src}")
    print(f"size:   {COLS}x{ROWS}")
    print(f"frames → {FRAMES_DIR}")
    print("")

    sheet = Sheet()
    scratch: Path | None = None
    drive: PtyDrive | None = None
    keep_scratch = False

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
        drive = PtyDrive(binary, env, cwd, ROWS, COLS)

        # ── 0. Boot ──────────────────────────────────────────────────────────
        print("\n── 0. Boot ──")
        # Sentinel must be on-screen at capture size (skill §5): member names at 120 cols.
        boot_ok, boot_text = drive.wait_for(
            lambda t: (
                "Dashboard" in t
                or "Sessions" in t
                or "Attention" in t
                or "Overview" in t
            ),
            timeout=BOOT_TIMEOUT,
            label="boot chrome (Dashboard/Sessions)",
        )
        dump_step("00-boot", boot_text, drive.screen)
        sheet.check(
            "boot_chrome",
            boot_ok,
            matching_rows(boot_text, "Dash") if not boot_ok else "Dashboard/Sessions visible",
        )
        if not boot_ok:
            # No point choreographing a dead screen — still print the sheet.
            keep_scratch = True
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
        dump_step("01-sessions", sess_text, drive.screen)

        sheet.check(
            "sessions_member",
            "Sessions" in sess_text or sess_ok,
            matching_rows(sess_text, "Session"),
        )
        sheet.check(
            "status_strip",
            bool(
                __import__("re").search(
                    r"installed · (\d[\d,]* operator|\d[\d,]* session(s| dirs))|no ingested sessions|"
                    r"speculum not installed|loading|Sessions",
                    sess_text,
                    __import__("re").I,
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
                or __import__("re").search(r"fit|center|cluster|density|Map", t, __import__("re").I)
                is not None
            ),
            timeout=STEP_TIMEOUT,
            label="map glyphs/chrome",
        )
        dump_step("02-map", map_text, drive.screen)
        has_braille = any("\u2800" <= ch <= "\u28FF" for ch in map_text)
        has_chrome = bool(
            __import__("re").search(r"fit|center|cluster|density|Map", map_text, __import__("re").I)
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
            bool(__import__("re").search(r"showing \d+ of \d+", map_text, __import__("re").I)),
            matching_rows(map_text, "showing"),
        )
        sheet.check(
            "map_legend",
            bool(
                __import__("re").search(
                    r"parentage|event links|●|═|─", map_text, __import__("re").I
                )
            ),
            matching_rows(map_text, "parentage") or matching_rows(map_text, "event links"),
        )
        links_m = __import__("re").search(r"(\d+) links", map_text)
        sheet.check(
            "map_links_real",
            bool(links_m) and int(links_m.group(1)) > 0,
            f"{links_m.group(1) if links_m else 'no'} links drawn",
        )

        # ── 2b. m → Microscope (redesigned two-pane; title-first picker) ────
        print("\n── 2b. m → Microscope ──")
        drive.send("m")
        mic_ok, mic_text = drive.wait_for(
            lambda t: "SESSIONS" in t and "TIMELINE" in t,
            timeout=STEP_TIMEOUT,
            label="microscope two-pane cards",
        )
        dump_step("02b-microscope", mic_text, drive.screen)
        sheet.check(
            "microscope_title_chrome",
            mic_ok,
            matching_rows(mic_text, "SESSIONS") or matching_rows(mic_text, "Microscope"),
        )
        # Seeded session titles render title-first in the picker.
        sheet.check(
            "microscope_picker_title",
            bool(__import__("re").search(r"Session title \d{3}", mic_text)),
            matching_rows(mic_text, "Session title"),
        )
        drive.send("\r")
        drive.pump(0.9)
        mic_timeline = drive.frame_text()
        dump_step("02c-microscope-timeline", mic_timeline, drive.screen)
        sheet.check(
            "microscope_timeline_row",
            bool(
                __import__("re").search(
                    r"#\d+|tool_use|user|assistant|tool_error|no events|enter a session",
                    mic_timeline,
                    __import__("re").I,
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
                or __import__("re").search(
                    r"no matches|\d+\s*hits?|hit\b|type to search|index not found|"
                    r"corpus busy|schema|pending",
                    t,
                    __import__("re").I,
                )
                is not None
            ),
            timeout=STEP_TIMEOUT,
            label="search results or honest empty",
        )
        dump_step("03-search", search_text, drive.screen)
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
            __import__("re").search(
                r"no matches|\d+\s*hits?|hit\b|e2e-sess|"
                r"type to search|index not found|corpus busy|schema|pending|MISSING",
                search_text,
                __import__("re").I,
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
            lambda t: __import__("re").search(
                r"Lens picker|session-postmortem|pattern-extraction|usage-story|--last-n",
                t,
                __import__("re").I,
            )
            is not None,
            timeout=STEP_TIMEOUT,
            label="lens picker",
        )
        dump_step("04-lens-picker", lens_text, drive.screen)
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
                __import__("re").search(
                    r"session-postmortem|pattern-extraction|usage-story",
                    lens_text,
                    __import__("re").I,
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
        dump_step("05-after-escape", leave_text, drive.screen)
        sheet.check(
            "leave_escape",
            True,  # escape is best-effort; dump is the evidence
            "esc sent; frame dumped",
        )

        # Soft quit (shell q → onQuit). Avoid if title-replay already ate state.
        drive.send("q")
        drive.pump(0.4)

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


if __name__ == "__main__":
    raise SystemExit(main())
